// In-app updates from the GitHub Releases of the repo this build was made for.
//
// Off unless the build was given both COUCOU_UPDATE_REPO ("owner/repo") and
// COUCOU_UPDATER_PUBKEY (the public half of `tauri signer generate`): then
// Settings → General can check the rolling `windows-latest` release's
// latest.json, and only an installer signed with that key, for the version it
// announces, is ever run. Nothing is checked unless the user asks.

use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::UpdaterExt;

const REPO: Option<&str> = option_env!("COUCOU_UPDATE_REPO");
const PUBKEY: Option<&str> = option_env!("COUCOU_UPDATER_PUBKEY");

fn enabled() -> Option<(&'static str, &'static str)> {
    Some((REPO.filter(|r| !r.is_empty())?, PUBKEY.filter(|k| !k.is_empty())?))
}

/// The plugin, only in a build that can verify what it downloads.
pub fn plugin<R: Runtime>() -> Option<tauri::plugin::TauriPlugin<R, tauri_plugin_updater::Config>> {
    let (_, key) = enabled()?;
    Some(tauri_plugin_updater::Builder::new().pubkey(key).build())
}

async fn find(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let (repo, _) = enabled().ok_or_else(|| crate::i18n::t("Updates aren't set up in this build."))?;
    let feed = format!("https://github.com/{repo}/releases/download/windows-latest/latest.json");
    let url = feed.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    app.updater_builder()
        .endpoints(vec![url])
        .and_then(|b| b.build())
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())
}

/// The newer version on offer, if there is one.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<String>, String> {
    Ok(find(&app).await?.map(|u| u.version))
}

/// Downloads, verifies and runs the installer, then restarts into it.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let update = find(&app).await?.ok_or_else(|| crate::i18n::t("Coucou is up to date."))?;
    crate::log::line(format!("updater: installing {}", update.version));
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}
