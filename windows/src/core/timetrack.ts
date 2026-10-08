// Project time tracking — the calculation side. No DOM, no Tauri.
//
// Rust appends a heartbeat for every agent hook event (at most one per project
// every 30 s) to %LOCALAPPDATA%\Coucou\time\YYYY-MM.jsonl:
//   {"t": <epoch ms>, "project": "<git root of the session's cwd>", "agent": "claude"}
// Time is the WakaTime model: the span between two heartbeats of a project
// counts when it is shorter than the idle gap; a longer one ends the stretch.
// Each project is counted on its own: two agents busy in two projects at once
// bill both in full. Several sessions in one project count once.

import { fileName } from "./diff";
import { dayKey } from "../recap/summary";

export interface Beat {
  /** Epoch milliseconds. */
  t: number;
  /** The project's folder (its git root), as Rust resolved it. */
  project: string;
  agent?: string;
}

export interface DayTotal {
  /** Local calendar day, "YYYY-MM-DD". */
  day: string;
  project: string;
  ms: number;
}

/** A pause longer than this ends a stretch of work. */
export const DEFAULT_IDLE_GAP_MS = 15 * 60 * 1000;

/**
 * Heartbeats from the JSONL file. Lines that don't parse are skipped: the last
 * one may be half written if the app was killed mid-append.
 */
export function parseBeats(jsonl: string): Beat[] {
  const beats: Beat[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const b = JSON.parse(line) as Partial<Beat>;
      if (typeof b.t === "number" && Number.isFinite(b.t) && typeof b.project === "string" && b.project) {
        beats.push({ t: b.t, project: b.project, agent: typeof b.agent === "string" ? b.agent : undefined });
      }
    } catch {
      // half-written or foreign line
    }
  }
  return beats;
}

/** The next local midnight after `t`. */
function nextMidnight(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/**
 * Worked time per project and local day, sorted by day then project. A stretch
 * running past midnight is split between the two days.
 */
export function dailyTotals(beats: readonly Beat[], idleGapMs = DEFAULT_IDLE_GAP_MS): DayTotal[] {
  const byProject = new Map<string, number[]>();
  for (const b of beats) {
    const list = byProject.get(b.project);
    if (list) list.push(b.t);
    else byProject.set(b.project, [b.t]);
  }

  const totals = new Map<string, DayTotal>();
  const add = (project: string, from: number, to: number) => {
    while (from < to) {
      const end = Math.min(to, nextMidnight(from));
      const day = dayKey(new Date(from));
      const key = `${day}\u0000${project}`;
      const entry = totals.get(key);
      if (entry) entry.ms += end - from;
      else totals.set(key, { day, project, ms: end - from });
      from = end;
    }
  };

  for (const [project, times] of byProject) {
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      const span = times[i] - times[i - 1];
      if (span > 0 && span <= idleGapMs) add(project, times[i - 1], times[i]);
    }
  }

  return [...totals.values()].sort((a, b) =>
    a.day === b.day ? a.project.localeCompare(b.project) : a.day < b.day ? -1 : 1,
  );
}

export interface WeekRow {
  project: string;
  /** Milliseconds per day, oldest first, matching `days`. */
  perDay: number[];
  total: number;
}

/** The seven days ending on `today` (local), projects busiest first. */
export function weekGrid(totals: readonly DayTotal[], today: Date): { days: string[]; rows: WeekRow[] } {
  const days = Array.from({ length: 7 }, (_, i) =>
    dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6 + i)),
  );
  const rows = new Map<string, WeekRow>();
  for (const { day, project, ms } of totals) {
    const i = days.indexOf(day);
    if (i < 0) continue;
    let row = rows.get(project);
    if (!row) rows.set(project, (row = { project, perDay: Array(7).fill(0), total: 0 }));
    row.perDay[i] += ms;
    row.total += ms;
  }
  return { days, rows: [...rows.values()].sort((a, b) => b.total - a.total || a.project.localeCompare(b.project)) };
}

export interface ProjectBilling {
  client: string;
  rate: number;
}

/** One cell: quoted when it has to be, and never read as a formula by a spreadsheet. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Day by day, for a spreadsheet or an invoice: hours and amount per project. */
export function toCsv(
  totals: readonly DayTotal[],
  billing: Readonly<Record<string, ProjectBilling>>,
  currency: string,
): string {
  const lines = ["date,project,folder,client,hours,rate,currency,amount"];
  for (const { day, project, ms } of totals) {
    const b = billing[project];
    const hours = ms / 3_600_000;
    const rate = b?.rate && Number.isFinite(b.rate) ? b.rate : 0;
    lines.push([
      day, fileName(project), project, b?.client ?? "",
      hours.toFixed(2), rate ? rate.toFixed(2) : "", rate ? currency : "", rate ? (hours * rate).toFixed(2) : "",
    ].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
