// TradeVault quick-log (src/core/quicklog.ts and src/views/quicklog.ts).
// The HTTP side — status → failure kind, submission-id shape — is tested in
// src-tauri/src/quicklog.rs; the server rules in TradeVault's
// `npm run check:coucou` (checkQuickLog) and `check:trade-row`.

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { internals } from "./tauri.mjs";
import {
  QuickLogSession, SEND_TIMEOUT_MS, describeFailure, parseQuickLine, readNumber, riskReward, tradePayload,
  validateQuickLog,
} from "../src/core/quicklog.ts";
import { buildQuickLog, previewLine } from "../src/views/quicklog.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";

const errorsOf = (draft) => {
  const r = validateQuickLog(draft);
  return "errors" in r ? r.errors : {};
};
const tradeOf = (line) => {
  const r = validateQuickLog(parseQuickLine(line).draft);
  assert.ok("trade" in r, `"${line}" should be a valid trade: ${JSON.stringify(r)}`);
  return r.trade;
};

// ── Reading a line ────────────────────────────────────────────────────────────

test("a full line gives every field", () => {
  assert.deepEqual(parseQuickLine("long NQ 2 @ 18250 sl 18230 tp 18290 exit 18270"), {
    draft: { side: "long", symbol: "NQ", quantity: "2", entry: "18250", stop: "18230", target: "18290", exit: "18270" },
    unknown: [],
  });
});

test("the shortest line is side, symbol, size and entry", () => {
  assert.deepEqual(parseQuickLine("short ES 1 @ 5400").draft, { side: "short", symbol: "ES", quantity: "1", entry: "5400" });
});

test("case, synonyms and spacing don't matter", () => {
  const { draft } = parseQuickLine("  BUY   aapl 10x @187.5  STOP 185  Target 195  OUT 190 ");
  assert.deepEqual(draft, { side: "long", symbol: "aapl", quantity: "10", entry: "187.5", stop: "185", target: "195", exit: "190" });
  assert.equal(parseQuickLine("sell x 1 at 2").draft.side, "short");
  assert.equal(parseQuickLine("l BTC 1 @ 1").draft.side, "long");
  assert.equal(parseQuickLine("s BTC 1 @ 1").draft.side, "short");
  assert.equal(parseQuickLine("long NQ 1 at 100").draft.entry, "100");
  assert.equal(parseQuickLine("long NQ 1 @ 100 tg 120").draft.target, "120");
  assert.equal(parseQuickLine("long NQ 1 @ 100 x 110").draft.exit, "110");
});

test("stop, target and exit may come in any order", () => {
  const { draft } = parseQuickLine("long NQ 1 @ 100 exit 104 tp 110 sl 95");
  assert.deepEqual([draft.stop, draft.target, draft.exit], ["95", "110", "104"]);
});

test("grouped numbers and fractions are read", () => {
  const { draft } = parseQuickLine("long BTCUSDT 0.25 @ 62,000.5 sl 61,500");
  assert.deepEqual([draft.quantity, draft.entry, draft.stop], ["0.25", "62,000.5", "61,500"]);
  assert.equal(parseQuickLine("long BTC .5 @ 1").draft.quantity, ".5");
});

test("nothing typed is dropped silently", () => {
  assert.deepEqual(parseQuickLine("long NQ 2 @ 18250 because vibes").unknown, ["because", "vibes"]);
  assert.deepEqual(parseQuickLine("long NQ 2 @ 18250 sl").unknown, ["sl"], "a keyword without its value");
  assert.deepEqual(parseQuickLine("long NQ 2 @ abc").unknown, ["@", "abc"]);
});

test("a ticker that spells a keyword is still the symbol", () => {
  assert.deepEqual(parseQuickLine("long X 100 @ 25 x 26").draft, { side: "long", symbol: "X", quantity: "100", entry: "25", exit: "26" });
  assert.equal(parseQuickLine("short SL 5 @ 10").draft.symbol, "SL");
});

test("missing pieces are just missing, not guessed", () => {
  assert.deepEqual(parseQuickLine("NQ 2 @ 100").draft, { symbol: "NQ", quantity: "2", entry: "100" });
  assert.deepEqual(parseQuickLine("long NQ @ 100").draft, { side: "long", symbol: "NQ", entry: "100" });
  assert.deepEqual(parseQuickLine("long 2 @ 100").draft, { side: "long", quantity: "2", entry: "100" });
  assert.deepEqual(parseQuickLine(""), { draft: {}, unknown: [] });
  assert.deepEqual(parseQuickLine("   ").draft, {});
});

test("numbers: grouped, positive and finite only", () => {
  assert.equal(readNumber("18,250.75"), 18250.75);
  assert.equal(readNumber(" 2 "), 2);
  assert.equal(readNumber(3), 3);
  for (const bad of ["0", "-1", "", "  ", "abc", "1e999", null, undefined, 0, -2, Number.NaN]) {
    assert.equal(readNumber(bad), null, `${String(bad)} is not a price`);
  }
});

// ── Checking ──────────────────────────────────────────────────────────────────

test("a valid line becomes a trade, symbol upper-cased", () => {
  assert.deepEqual(tradeOf("long nq 2 @ 18,250 sl 18230 tp 18290"), {
    side: "long", symbol: "NQ", quantity: 2, entry: 18250, stop: 18230, target: 18290, exit: null,
  });
});

test("every missing required field is reported at once", () => {
  assert.deepEqual(Object.keys(errorsOf({})).sort(), ["entry", "quantity", "side", "symbol"]);
});

test("each required field has its own message", () => {
  const ok = { side: "long", symbol: "NQ", quantity: "1", entry: "100" };
  assert.equal(errorsOf({ ...ok, side: "up" }).side, "Start with long or short");
  assert.equal(errorsOf({ ...ok, symbol: " " }).symbol, "Which symbol?");
  assert.equal(errorsOf({ ...ok, symbol: "NQ;DROP" }).symbol, "“NQ;DROP” doesn't look like a symbol");
  assert.equal(errorsOf({ ...ok, quantity: "0" }).quantity, "Size must be a number above 0");
  assert.equal(errorsOf({ ...ok, entry: "-5" }).entry, "Entry price: @ followed by a number above 0");
  assert.deepEqual(errorsOf(ok), {});
});

test("futures, pairs and exchange-prefixed symbols are accepted", () => {
  for (const s of ["NQ", "ESZ6", "BTC-USD", "EUR/USD", "BINANCE:BTCUSDT", "BRK.B", "NIFTY_50", "ES1!"]) {
    assert.deepEqual(errorsOf({ side: "long", symbol: s, quantity: "1", entry: "1" }), {}, s);
  }
  assert.ok(errorsOf({ side: "long", symbol: "A".repeat(25), quantity: "1", entry: "1" }).symbol, "too long");
});

test("stop and target must be on the right side — same messages as TradeVault", () => {
  const long = { side: "long", symbol: "NQ", quantity: "1", entry: "100" };
  const short = { ...long, side: "short" };
  assert.equal(errorsOf({ ...long, stop: "100" }).stop, "A long stop must be below the entry");
  assert.equal(errorsOf({ ...long, stop: "101" }).stop, "A long stop must be below the entry");
  assert.equal(errorsOf({ ...long, target: "100" }).target, "A long target must be above the entry");
  assert.equal(errorsOf({ ...short, stop: "99" }).stop, "A short stop must be above the entry");
  assert.equal(errorsOf({ ...short, target: "101" }).target, "A short target must be below the entry");
  assert.deepEqual(errorsOf({ ...long, stop: "95", target: "110" }), {});
  assert.deepEqual(errorsOf({ ...short, stop: "105", target: "90" }), {});
});

test("optional fields may be empty, but not junk", () => {
  const ok = { side: "long", symbol: "NQ", quantity: "1", entry: "100" };
  assert.deepEqual(errorsOf({ ...ok, stop: "", target: " ", exit: "" }), {});
  assert.equal(errorsOf({ ...ok, exit: "abc" }).exit, "Must be a number above 0");
  assert.equal(errorsOf({ ...ok, stop: "-1" }).stop, "Must be a number above 0", "a bad number isn't also reported as the wrong side");
});

test("an exit on either side of the entry is fine — losses get logged too", () => {
  assert.deepEqual(errorsOf({ side: "long", symbol: "NQ", quantity: "1", entry: "100", exit: "90" }), {});
});

// ── Risk and reward ───────────────────────────────────────────────────────────

test("risk, reward and R:R for a long, from TradeVault's formulas", () => {
  const rr = riskReward(tradeOf("long NQ 2 @ 100 sl 95 tp 115"));
  assert.deepEqual(rr, { risk: 10, reward: 30, rr: 3, pnl: null, pnlR: null });
});

test("risk, reward and R:R for a short", () => {
  const rr = riskReward(tradeOf("short NQ 2 @ 100 sl 105 tp 90"));
  assert.deepEqual(rr, { risk: 10, reward: 20, rr: 2, pnl: null, pnlR: null });
});

test("an exit gives the P&L, and in R when there is a stop", () => {
  assert.deepEqual(riskReward(tradeOf("long NQ 2 @ 100 sl 95 exit 90")), { risk: 10, reward: null, rr: null, pnl: -20, pnlR: -2 });
  assert.deepEqual(riskReward(tradeOf("short NQ 1 @ 100 exit 96")), { risk: null, reward: null, rr: null, pnl: 4, pnlR: null });
});

test("without a stop there is no R:R, whatever the target", () => {
  assert.equal(riskReward(tradeOf("long NQ 1 @ 100 tp 120")).rr, null);
});

test("the payload has TradeVault's field names and only what was typed", () => {
  const body = tradePayload(tradeOf("long nq 2 @ 100 sl 95"), "acc-1");
  assert.deepEqual(body, {
    account_id: "acc-1", symbol: "NQ", direction: "long", entry_price: 100, quantity: 2, tags: ["coucou"], stop_loss: 95,
  });
  const closed = tradePayload(tradeOf("short nq 1 @ 100 tp 90 exit 95"), "acc-1");
  assert.equal(closed.take_profit, 90);
  assert.equal(closed.exit_price, 95);
  assert.match(closed.exit_date, /^\d{4}-\d{2}-\d{2}T/, "an exit is dated now");
  assert.equal("exit_date" in body, false);
});

// ── Failures ──────────────────────────────────────────────────────────────────

test("each failure says what to do, and only the safe ones offer a retry", () => {
  const retryable = ["timeout", "offline", "conflict", "server"];
  const final = ["setup", "auth", "readonly", "forbidden", "rejected"];
  for (const kind of retryable) assert.equal(describeFailure({ kind }).retry, true, kind);
  for (const kind of final) assert.equal(describeFailure({ kind }).retry, false, kind);
  assert.match(describeFailure({ kind: "timeout" }).message, /can't log it twice/);
  assert.match(describeFailure({ kind: "readonly" }).message, /Can log trades/);
  assert.match(describeFailure({ kind: "setup" }).message, /Settings → Integrations/);
});

test("TradeVault's own reason is shown when it gave one", () => {
  assert.equal(describeFailure({ kind: "rejected", message: "Symbol is required" }).message, "Symbol is required");
  assert.equal(describeFailure({ kind: "forbidden", message: "Invalid account or permission denied" }).message,
    "Invalid account or permission denied");
  assert.equal(describeFailure({ kind: "setup", message: "Not a valid address: x" }).message, "Not a valid address: x");
  assert.equal(describeFailure({ kind: "rejected", message: "  " }).message, "TradeVault rejected the trade.");
});

test("errors that aren't from Rust are still explained, never retried blindly", () => {
  assert.deepEqual(describeFailure(new Error("not running inside Coucou")), { message: "not running inside Coucou", retry: false });
  assert.deepEqual(describeFailure("boom"), { message: "boom", retry: false });
  assert.deepEqual(describeFailure(null), { message: "Something went wrong.", retry: false });
  assert.equal(describeFailure({ kind: "martian" }).retry, false);
});

// ── Sending once ──────────────────────────────────────────────────────────────

const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};
const trade = { account_id: "a", symbol: "NQ", direction: "long", entry_price: 100, quantity: 1 };

test("a logged trade returns its id, and the next trade gets a new submission id", async () => {
  const seen = [];
  const s = new QuickLogSession(async (id, body) => (seen.push([id, body]), { id: "t1", duplicate: false }), ids());
  assert.deepEqual(await s.submit(trade), { ok: true, id: "t1", duplicate: false });
  await s.submit(trade);
  assert.deepEqual(seen.map(([id]) => id), ["id-1", "id-2"]);
  assert.equal(s.pendingId, null);
});

test("a retry after a failure reuses the submission id, so it can't log twice", async () => {
  const seen = [];
  let fail = true;
  const s = new QuickLogSession(async (id) => {
    seen.push(id);
    if (fail) throw { kind: "timeout" };
    return { id: "t1", duplicate: true };
  }, ids());
  const first = await s.submit(trade);
  assert.deepEqual(first, { ok: false, message: describeFailure({ kind: "timeout" }).message, retry: true });
  assert.equal(s.pendingId, "id-1");
  fail = false;
  assert.deepEqual(await s.submit(trade), { ok: true, id: "t1", duplicate: true });
  assert.deepEqual(seen, ["id-1", "id-1"]);
});

test("changing the trade after a failure gets a new submission id", async () => {
  const seen = [];
  const s = new QuickLogSession(async (id) => (seen.push(id), Promise.reject({ kind: "offline" })), ids());
  await s.submit(trade);
  await s.submit({ ...trade, quantity: 2 });
  await s.submit({ ...trade, quantity: 2 });
  assert.deepEqual(seen, ["id-1", "id-2", "id-2"]);
});

test("key order and the exit timestamp don't count as a change", async () => {
  const seen = [];
  const s = new QuickLogSession(async (id) => (seen.push(id), Promise.reject({ kind: "server" })), ids());
  await s.submit({ ...trade, exit_price: 101, exit_date: "2026-10-08T10:00:00.000Z" });
  await s.submit({ exit_date: "2026-10-08T10:00:07.000Z", exit_price: 101, ...trade });
  assert.deepEqual(seen, ["id-1", "id-1"]);
});

test("a second click while one is on its way is ignored", async () => {
  let release;
  const calls = [];
  const s = new QuickLogSession((id) => (calls.push(id), new Promise((r) => (release = r))), ids());
  const first = s.submit(trade);
  assert.equal(s.sending, true);
  assert.equal(await s.submit(trade), null);
  release({ id: "t1" });
  assert.deepEqual(await first, { ok: true, id: "t1", duplicate: false });
  assert.equal(calls.length, 1);
  assert.equal(s.sending, false);
});

test("a send that never answers times out on the island's own clock, and can be retried", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const seen = [];
    const s = new QuickLogSession((id) => (seen.push(id), new Promise(() => {})), ids(), 5_000);
    const pending = s.submit(trade);
    mock.timers.tick(4_999);
    assert.equal(s.sending, true);
    mock.timers.tick(1);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.retry, true);
    assert.match(result.message, /didn't answer in time/);
    assert.equal(s.sending, false);
    assert.equal(s.pendingId, "id-1", "kept for the retry");
  } finally {
    mock.timers.reset();
  }
});

test("the island's timeout is longer than Rust's 10 s request timeout", () => {
  assert.ok(SEND_TIMEOUT_MS > 10_000);
});

test("a reply without an id is not taken for success", async () => {
  const s = new QuickLogSession(async () => ({ ok: true }), ids());
  const r = await s.submit(trade);
  assert.equal(r.ok, false);
  assert.equal(r.retry, true, "same id, so retrying is safe");
  assert.equal(s.pendingId, "id-1");
});

test("a rejected trade is not offered a retry, and says why", async () => {
  const s = new QuickLogSession(async () => Promise.reject({ kind: "rejected", message: "Valid quantity is required" }), ids());
  assert.deepEqual(await s.submit(trade), { ok: false, message: "Valid quantity is required", retry: false });
});

test("reset forgets the kept id", async () => {
  const s = new QuickLogSession(async () => Promise.reject({ kind: "offline" }), ids());
  await s.submit(trade);
  s.reset();
  assert.equal(s.pendingId, null);
});

test("the default submission id is a UUID, as TradeVault requires", async () => {
  let sentId = "";
  const s = new QuickLogSession(async (id) => ((sentId = id), { id: "t" }));
  await s.submit(trade);
  assert.match(sentId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

// ── The card ──────────────────────────────────────────────────────────────────

test("the preview shows side, size, levels, R:R and risk in the account's currency", () => {
  assert.equal(previewLine(tradeOf("long NQ 2 @ 100 sl 95 tp 115"), "USD"),
    "▲ LONG NQ ×2 @ 100.00 · stop 95.00 · target 115.00 · R:R 3.00 · risk $10.00");
  assert.equal(previewLine(tradeOf("short NQ 1 @ 100 sl 102 exit 96"), "USD"),
    "▼ SHORT NQ ×1 @ 100.00 · stop 102.00 · risk $2.00 · P&L +$4.00 (+2.00R)");
});

installFakeDom();

/** Answers the island's Rust commands for one test; every call is recorded. */
let answers;
let commands;
const realInvoke = internals.invoke;
beforeEach(() => {
  State.settings = { ...DEFAULT_SETTINGS };
  commands = [];
  answers = {
    tradevault_accounts: async () => ({ canWrite: true, accounts: [{ id: "acc-1", name: "Futures", currency: "USD" }] }),
    tradevault_log_trade: async () => ({ id: "t-1", duplicate: false }),
  };
  internals.invoke = async (cmd, args) => {
    if (cmd === "plugin:event|listen") return realInvoke(cmd, args);
    commands.push([cmd, args]);
    if (!answers[cmd]) return null;
    return answers[cmd](args);
  };
});
afterEach(() => {
  internals.invoke = realInvoke;
});

const flush = () => new Promise((r) => setImmediate(r));
const parts = (view) => {
  const [input] = view.el.find("INPUT");
  const [account] = view.el.find("SELECT");
  const buttons = view.el.find("BUTTON");
  const byText = (text) => buttons.find((b) => b.textContent === text);
  return {
    input, account,
    submit: byText("Log trade"), retry: byText("Try again"), cancel: byText("Cancel"),
    preview: view.el.find(".ql-preview")[0], status: view.el.find(".ql-status")[0],
  };
};
const type = (p, text) => {
  p.input.value = text;
  p.input.fire("input");
};
const open = async () => {
  const views = [];
  const view = buildQuickLog({ setView: (v) => views.push(v) });
  view.focus();
  await flush();
  return { view, p: parts(view), views };
};

test("opening the card loads the accounts and picks the first", async () => {
  const { p } = await open();
  assert.equal(p.account.value, "acc-1");
  assert.equal(p.account.textContent, "Futures · USD");
  assert.equal(p.submit.disabled, true, "nothing typed yet");
});

test("typing shows the preview and enables Log trade only once the line is valid", async () => {
  const { p } = await open();
  type(p, "long NQ 2 @ 100 sl 101");
  assert.equal(p.preview.textContent, "A long stop must be below the entry");
  assert.ok(p.preview.className.includes("err"));
  assert.equal(p.submit.disabled, true);
  type(p, "long NQ 2 @ 100 sl 95");
  assert.match(p.preview.textContent, /^▲ LONG NQ ×2/);
  assert.equal(p.submit.disabled, false);
  type(p, "long NQ 2 @ 100 sl 95 lol");
  assert.equal(p.preview.textContent, "Didn't understand “lol”");
  assert.equal(p.submit.disabled, true);
});

test("Log trade sends the trade once, then clears the line", async () => {
  const { p } = await open();
  type(p, "long nq 2 @ 100 sl 95");
  p.submit.fire("click");
  await flush();
  const sent = commands.filter(([c]) => c === "tradevault_log_trade");
  assert.equal(sent.length, 1);
  assert.match(sent[0][1].submission, /^[0-9a-f-]{36}$/);
  assert.equal(sent[0][1].trade.symbol, "NQ");
  assert.equal(sent[0][1].trade.account_id, "acc-1");
  assert.equal(p.status.textContent, "Logged in TradeVault.");
  assert.equal(p.input.value, "");
});

test("a timeout offers Try again, which resends with the same submission id", async () => {
  let n = 0;
  answers.tradevault_log_trade = async () => (++n === 1 ? Promise.reject({ kind: "timeout" }) : { id: "t-1", duplicate: true });
  const { p } = await open();
  type(p, "long NQ 1 @ 100");
  p.submit.fire("click");
  await flush();
  assert.match(p.status.textContent, /didn't answer in time/);
  assert.equal(p.retry.style.display, "");
  p.retry.fire("click");
  await flush();
  const ids = commands.filter(([c]) => c === "tradevault_log_trade").map(([, a]) => a.submission);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.equal(p.status.textContent, "Already logged — nothing was added twice.");
});

test("a rejected trade shows TradeVault's reason and no Try again", async () => {
  answers.tradevault_log_trade = async () => Promise.reject({ kind: "rejected", message: "Invalid account or permission denied" });
  const { p } = await open();
  type(p, "long NQ 1 @ 100");
  p.submit.fire("click");
  await flush();
  assert.equal(p.status.textContent, "Invalid account or permission denied");
  assert.equal(p.retry.style.display, "none");
  assert.equal(p.input.value, "long NQ 1 @ 100", "the line stays, to be fixed");
});

test("a read-only token is said up front, and nothing can be sent", async () => {
  answers.tradevault_accounts = async () => ({ canWrite: false, accounts: [{ id: "acc-1", name: "Futures", currency: "USD" }] });
  const { p } = await open();
  assert.match(p.status.textContent, /read-only/);
  type(p, "long NQ 1 @ 100");
  assert.equal(p.submit.disabled, true);
});

test("TradeVault not set up: the card says where to do it", async () => {
  answers.tradevault_accounts = async () => Promise.reject({ kind: "setup" });
  const { p } = await open();
  assert.match(p.status.textContent, /Settings → Integrations/);
  type(p, "long NQ 1 @ 100");
  assert.equal(p.submit.disabled, true);
});

test("Enter sends, Escape goes back without sending", async () => {
  const { p, views } = await open();
  type(p, "long NQ 1 @ 100");
  const keydown = (key) => p.input.listeners.get("keydown")[0]({ key, preventDefault() {}, stopPropagation() {} });
  keydown("Escape");
  assert.deepEqual(views, [State.defaultView()]);
  keydown("Enter");
  await flush();
  assert.equal(commands.filter(([c]) => c === "tradevault_log_trade").length, 1);
});

test("Enter on an invalid line sends nothing", async () => {
  const { p } = await open();
  type(p, "long NQ");
  p.input.listeners.get("keydown")[0]({ key: "Enter", preventDefault() {}, stopPropagation() {} });
  await flush();
  assert.equal(commands.filter(([c]) => c === "tradevault_log_trade").length, 0);
});
