// "Time today" card: the agent time logged per project today
// (src/core/timetrack.ts). Opened from the island's quick settings; the
// full week, clients, rates and CSV export live in Settings → Time.

import { h, clear } from "./dom";
import { Bridge } from "../core/bridge";
import { fileName } from "../core/diff";
import { dailyTotals, parseBeats, type DayTotal } from "../core/timetrack";
import { dayKey, formatDuration } from "../recap/summary";
import type { ViewActions, ViewHost } from "./views";
import { t, tl } from "../i18n/i18n";

/** How many projects fit on the card; the rest are in Settings → Time. */
const MAX_ROWS = 4;
/** The heartbeat log is read again at most this often while the card is open. */
const RELOAD_MS = 30_000;

export function buildTime(actions: ViewActions): ViewHost {
  const total = h("span", { class: "time-total" });
  const rows = h("div", { class: "time-rows" });
  const body = h("div", { class: "stack time-stack" },
    h("div", { class: "time-head" }, h("span", { class: "title", text: tl("Time today") }), total),
    rows,
    h("button", {
      class: "link-btn time-more",
      text: tl("Week, clients and export…"),
      onclick: () => actions.openSettingsWindow(),
    }),
  );
  const el = h("div", { class: "view" }, h("div", { class: "card" }, body));

  let today: DayTotal[] = [];
  let loadedAt = 0;

  function draw() {
    clear(rows);
    const sum = today.reduce((n, r) => n + r.ms, 0);
    total.textContent = sum ? formatDuration(Math.floor(sum / 60_000)) : "";
    if (!today.length) {
      rows.append(h("div", { class: "sub", text: t("No agent time logged yet today.") }));
      return;
    }
    const top = [...today].sort((a, b) => b.ms - a.ms).slice(0, MAX_ROWS);
    const longest = top[0].ms;
    for (const r of top) {
      const bar = h("i", { class: "time-bar" });
      bar.style.width = `${Math.max(4, (r.ms / longest) * 100)}%`;
      rows.append(h("div", { class: "time-row", title: r.project },
        h("span", { class: "time-name", text: fileName(r.project) }),
        h("span", { class: "time-track" }, bar),
        h("span", { class: "time-dur", text: formatDuration(Math.floor(r.ms / 60_000)) }),
      ));
    }
  }

  async function load() {
    loadedAt = Date.now();
    const key = dayKey(new Date());
    today = dailyTotals(parseBeats((await Bridge.timeRead()) ?? "")).filter((r) => r.day === key);
    draw();
  }

  return {
    el,
    sync() {
      if (Date.now() - loadedAt > RELOAD_MS) void load();
    },
  };
}
