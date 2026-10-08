// Project time tracking — the writing side (the arithmetic is in
// src/core/timetrack.ts). Every agent hook event is a heartbeat for the git
// repository its session runs in, appended to time/YYYY-MM.jsonl under
// local_dir() — at most one per project every 30 s. Only the folder, the time
// and the agent are kept: never a prompt, a command or a file name.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::{log, platform, settings};

/// One heartbeat per project per this long is plenty for a 15-minute idle gap.
const MIN_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Default)]
struct Tracker {
    /// cwd → its project root. ponytail: never invalidated, so a folder that
    /// gets `git init` later keeps its old root until Coucou restarts.
    roots: HashMap<String, String>,
    /// Project root → when its last heartbeat was written.
    last: HashMap<String, Instant>,
}

static TRACKER: LazyLock<Mutex<Tracker>> = LazyLock::new(Default::default);

fn dir() -> PathBuf {
    settings::local_dir().join("time")
}

fn month_file(year: u32, month: u32) -> String {
    format!("{year:04}-{month:02}.jsonl")
}

/// The nearest folder at or above `cwd` holding `.git` (a folder, or a file in
/// worktrees and submodules); `cwd` itself when there is none.
pub fn project_root(cwd: &Path) -> PathBuf {
    cwd.ancestors().find(|d| d.join(".git").exists()).unwrap_or(cwd).to_path_buf()
}

/// Called by pipe.rs for every hook event.
pub fn observe(payload: &Value, event: &str) {
    // The status line relay calls in on every Claude Code redraw, idle or not.
    if event == "StatusLine" {
        return;
    }
    let Some(cwd) = payload.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) else { return };
    let agent = payload.get("coucou_agent").and_then(Value::as_str).unwrap_or("claude");
    let project = {
        let mut t = TRACKER.lock().unwrap_or_else(|e| e.into_inner());
        let project = t
            .roots
            .entry(cwd.to_string())
            .or_insert_with(|| project_root(Path::new(cwd)).to_string_lossy().into_owned())
            .clone();
        let now = Instant::now();
        if t.last.get(&project).is_some_and(|at| now.duration_since(*at) < MIN_INTERVAL) {
            return;
        }
        t.last.insert(project.clone(), now);
        project
    };
    let now = platform::local_time();
    let file = dir().join(month_file(now.year, now.month));
    if let Err(err) = append(&file, &project, agent) {
        log::line(format!("timetrack: {err}"));
    }
}

fn append(file: &Path, project: &str, agent: &str) -> std::io::Result<()> {
    platform::ensure_private_dir(&settings::local_dir())?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    // One write per line, so a crash leaves at most one half line (the reader skips it).
    let line = format!("{}\n", json!({ "t": t, "project": project, "agent": agent }));
    std::fs::OpenOptions::new().create(true).append(true).open(file)?.write_all(line.as_bytes())
}

/// Last month's heartbeats then this month's, as JSONL: a week always fits.
#[tauri::command]
pub fn time_read() -> String {
    let now = platform::local_time();
    let previous = if now.month == 1 { (now.year - 1, 12) } else { (now.year, now.month - 1) };
    let mut out = String::new();
    for (year, month) in [previous, (now.year, now.month)] {
        if let Ok(text) = std::fs::read_to_string(dir().join(month_file(year, month))) {
            out.push_str(&text);
            if !out.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    out
}

/// Settings → Time → Export: writes the CSV the page built into Downloads,
/// under a name chosen here (never by the page), and shows it in the file manager.
#[tauri::command]
pub fn time_save_csv(app: tauri::AppHandle, csv: String) -> Result<String, String> {
    use tauri::Manager;
    if csv.len() > 20 * 1024 * 1024 {
        return Err("too large".into());
    }
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let now = platform::local_time();
    let path = dir.join(format!("Coucou time {:04}-{:02}-{:02}.csv", now.year, now.month, now.day));
    // The BOM is what makes Excel read client names with accents as UTF-8.
    std::fs::write(&path, format!("\u{feff}{csv}")).map_err(|e| e.to_string())?;
    platform::reveal_folder(&dir.to_string_lossy());
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_project_is_the_nearest_git_root_or_the_folder_itself() {
        let base = std::env::temp_dir().join(format!("coucou-timetrack-{}", std::process::id()));
        let repo = base.join("repo");
        let deep = repo.join("src").join("deep");
        let loose = base.join("loose");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(&loose).unwrap();

        assert_eq!(project_root(&deep), repo);
        assert_eq!(project_root(&repo), repo);
        assert_eq!(project_root(&loose), loose);

        // A worktree's `.git` is a file, not a folder.
        let worktree = base.join("worktree");
        std::fs::create_dir_all(worktree.join("x")).unwrap();
        std::fs::write(worktree.join(".git"), "gitdir: elsewhere").unwrap();
        assert_eq!(project_root(&worktree.join("x")), worktree);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn heartbeats_are_appended_one_line_each() {
        let base = std::env::temp_dir().join(format!("coucou-timetrack-append-{}", std::process::id()));
        let file = base.join("time").join(month_file(2026, 10));
        append(&file, "C:\\code\\a", "claude").unwrap();
        append(&file, "C:\\code\\b", "codex").unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1]["project"], "C:\\code\\b");
        assert_eq!(lines[1]["agent"], "codex");
        assert!(lines[0]["t"].as_u64().unwrap() > 0);
        assert_eq!(month_file(2026, 1), "2026-01.jsonl");
        let _ = std::fs::remove_dir_all(&base);
    }
}
