// TradeVault pill (src/core/tradevault.ts and its alert in src/island/integrations.ts).
// The numbers are TradeVault's own; these tests only cover reading them and
// deciding when they are worth an alert.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "./tauri.mjs";
import {
  LOSS_STREAK_ALERT, TRADEVAULT, formatMoney, readSummary, tradevaultAlert,
} from "../src/core/tradevault.ts";
import { registerIntegrationHandlers } from "../src/island/integrations.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";

const acct = (id, todayPnl, currentStreak = 0, extra = {}) => ({
  id, name: id === "A" ? "Futures" : "Crypto", currency: "USD", todayPnl, netPnl: 1000, winRate: 50,
  profitFactor: 1.4, avgR: 0.3, totalTrades: 40, openTrades: 0, currentDrawdown: 0, maxDrawdownPct: 2,
  currentStreak, ...extra,
});
const summary = (date, ...accounts) => ({ date, accounts });

test("a summary is read field by field, and junk is not a summary", () => {
  const s = readSummary({ date: "2026-10-08", accounts: [{ id: "A", todayPnl: -50, profitFactor: null }, { name: "no id" }, null] });
  assert.equal(s.accounts.length, 1);
  assert.equal(s.accounts[0].todayPnl, -50);
  assert.equal(s.accounts[0].name, "A", "an account without a name shows its id");
  assert.equal(s.accounts[0].currency, "USD");
  assert.equal(s.accounts[0].profitFactor, null);
  assert.equal(readSummary(null), null);
  assert.equal(readSummary({}), null);
  assert.equal(readSummary({ date: "2026-10-08", accounts: "x" }), null);
});

test("the loss limit alerts once, on the poll where it is reached", () => {
  const before = summary("2026-10-08", acct("A", -400));
  const hit = summary("2026-10-08", acct("A", -520));
  const alert = tradevaultAlert(before, hit, 500);
  assert.equal(alert.label, "Daily loss limit reached");
  assert.match(alert.detail, /^Futures · /);
  assert.match(alert.detail, /520/);
  assert.equal(tradevaultAlert(hit, summary("2026-10-08", acct("A", -600)), 500), null, "still past it: quiet");
});

test("exactly at the limit counts as reaching it", () => {
  assert.ok(tradevaultAlert(null, summary("2026-10-08", acct("A", -500)), 500));
  assert.equal(tradevaultAlert(null, summary("2026-10-08", acct("A", -499.99)), 500), null);
});

test("a new day starts over", () => {
  const yesterday = summary("2026-10-07", acct("A", -700));
  assert.ok(tradevaultAlert(yesterday, summary("2026-10-08", acct("A", -510)), 500));
});

test("no limit set, no loss alert", () => {
  assert.equal(tradevaultAlert(null, summary("2026-10-08", acct("A", -9999)), 0), null);
  assert.equal(tradevaultAlert(null, summary("2026-10-08", acct("A", -9999)), Number.NaN), null);
});

test("each account is watched on its own", () => {
  const before = summary("2026-10-08", acct("A", -600), acct("B", -100));
  const after = summary("2026-10-08", acct("A", -650), acct("B", -550));
  assert.match(tradevaultAlert(before, after, 500).detail, /^Crypto/);
});

test("a losing streak alerts when it reaches the threshold, and only then", () => {
  const n = LOSS_STREAK_ALERT;
  const almost = summary("2026-10-08", acct("A", -10, -(n - 1)));
  const reached = summary("2026-10-08", acct("A", -20, -n));
  assert.equal(tradevaultAlert(almost, reached, 0).label, `${n} losses in a row`);
  assert.equal(tradevaultAlert(reached, summary("2026-10-08", acct("A", -30, -(n + 1))), 0), null);
  // A streak runs across midnight: the new day doesn't repeat it.
  assert.equal(tradevaultAlert(reached, summary("2026-10-09", acct("A", 0, -n)), 0), null);
});

test("the loss limit wins over a streak in the same poll", () => {
  const alert = tradevaultAlert(null, summary("2026-10-08", acct("A", -600, -5)), 500);
  assert.equal(alert.label, "Daily loss limit reached");
});

test("money is signed when asked, so a loss never relies on colour", () => {
  assert.match(formatMoney(-150, "USD", true), /^-\$150\.00$|^−\$150\.00$/);
  assert.match(formatMoney(80, "USD", true), /^\+\$80\.00$/);
  assert.equal(formatMoney(0, "USD", true), "$0.00");
  assert.match(formatMoney(12, "XYZ1"), /12\.00 XYZ1/, "a code Intl refuses falls back to plain text");
});

// ── In the island ─────────────────────────────────────────────────────────────

registerIntegrationHandlers({ reveal: () => {} });
const pill = () => State.tasks.find((t) => t.id === TRADEVAULT);

beforeEach(() => {
  State.tasks = [];
  State.focusId = null;
  State.paused = false;
  State.integrations = {};
  State.settings = { ...DEFAULT_SETTINGS, activeIntegrations: [TRADEVAULT], tradevaultLossLimit: 500 };
  State.loadIntegrationTasks();
});

test("reaching the limit badges the pill with an error", () => {
  emit("integration", { id: TRADEVAULT, data: summary("2026-10-08", acct("A", -200)), error: null, event: null });
  assert.equal(pill().pillBadge ?? null, null);
  emit("integration", { id: TRADEVAULT, data: summary("2026-10-08", acct("A", -510)), error: null, event: null });
  assert.equal(pill().pillBadge, "error");
  assert.equal(pill().steps[0], "Daily loss limit reached");
});

test("a failed poll raises nothing and keeps the last numbers", () => {
  emit("integration", { id: TRADEVAULT, data: summary("2026-10-08", acct("A", -200)), error: null, event: null });
  emit("integration", { id: TRADEVAULT, data: {}, error: "TradeVault is unreachable", event: null });
  assert.equal(pill().pillBadge ?? null, null);
  assert.equal(State.integrations[TRADEVAULT].data.accounts[0].todayPnl, -200);
});
