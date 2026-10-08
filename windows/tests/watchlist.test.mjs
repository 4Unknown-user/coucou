// Watchlist pill (src/core/watchlist.ts, its handler in src/island/integrations.ts
// and its card in src/views/integrations.ts). The feeds themselves —
// URLs, subscriptions, parsing, high/low folding — are tested in
// src-tauri/src/watchlist.rs.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { emit } from "./tauri.mjs";
import {
  ALERT_COOLDOWN_MS, WATCHLIST, alertLabel, formatPrice, itemKey, mergeQuotes, normalizeSymbol,
  readSnapshot, readWatchlist, validSymbol, watchAlerts,
} from "../src/core/watchlist.ts";
import { registerIntegrationHandlers } from "../src/island/integrations.ts";
import { renderIntegrationCard } from "../src/views/integrations.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";

const MIN = 60_000;
const q = (price, high = price, low = price, at = 1) => ({ price, high, low, at });
const btc = (above = null, below = null) => ({ provider: "binance", symbol: "BTCUSDT", above, below });
const KEY = "binance:BTCUSDT";
const alertsOf = (items, before, after, fired = {}, now = 10 * MIN) =>
  watchAlerts(items, before, after, fired, now);

// ── Symbols ───────────────────────────────────────────────────────────────────

test("symbols are spelled the way each provider wants them", () => {
  assert.equal(normalizeSymbol("binance", " btc/usdt "), "BTCUSDT");
  assert.equal(normalizeSymbol("binance", "eth-usdt"), "ETHUSDT");
  assert.equal(normalizeSymbol("coinbase", "btc/usd"), "BTC-USD");
  assert.equal(normalizeSymbol("coinbase", "eth_usd"), "ETH-USD");
  assert.equal(normalizeSymbol("finnhub", " aapl "), "AAPL");
  assert.equal(normalizeSymbol("finnhub", "brk.b"), "BRK.B");
});

test("only symbols the Rust side would accept are valid (same cases as watchlist.rs)", () => {
  assert.ok(validSymbol("binance", "BTCUSDT"));
  assert.ok(!validSymbol("binance", "btcusdt"));
  assert.ok(!validSymbol("binance", "BTC/USDT"));
  assert.ok(!validSymbol("binance", "BTC&streams=x"));
  assert.ok(!validSymbol("binance", "B"));
  assert.ok(validSymbol("coinbase", "BTC-USD"));
  assert.ok(!validSymbol("coinbase", "BTCUSD"));
  assert.ok(!validSymbol("coinbase", "BTC-USD-X"));
  assert.ok(validSymbol("finnhub", "AAPL"));
  assert.ok(validSymbol("finnhub", "BINANCE:BTCUSDT"));
  assert.ok(validSymbol("finnhub", "BRK.B"));
  assert.ok(!validSymbol("finnhub", 'AAPL"}'));
  assert.ok(!validSymbol("finnhub", ""));
});

test("the watchlist from settings keeps known, valid, distinct items only", () => {
  const list = readWatchlist([
    btc(70000, 60000),
    { provider: "binance", symbol: "BTCUSDT", above: 1 }, // duplicate
    { provider: "kraken", symbol: "XBTUSD" }, // unknown provider
    { provider: "coinbase", symbol: "btc-usd" }, // not normalised
    { provider: "finnhub", symbol: "AAPL", above: -5, below: "100" }, // bad levels
    null,
  ]);
  assert.deepEqual(list, [
    btc(70000, 60000),
    { provider: "finnhub", symbol: "AAPL", above: null, below: null },
  ]);
  assert.deepEqual(readWatchlist("nope"), []);
  assert.deepEqual(readWatchlist(undefined), []);
});

test("an item is keyed by provider and symbol, as Rust keys its quotes", () => {
  assert.equal(itemKey(btc()), KEY);
});

// ── Snapshots ─────────────────────────────────────────────────────────────────

test("a snapshot is read field by field, and a bad quote is dropped", () => {
  const s = readSnapshot({
    quotes: {
      [KEY]: { price: 100, high: 110, low: 95, at: 5 },
      "binance:ETHUSDT": { price: 0 },
      "finnhub:AAPL": { price: "190" },
      "coinbase:BTC-USD": { price: 50, high: 40, low: 60 }, // inconsistent: clamped around price
    },
    status: { binance: "live", coinbase: 3 },
  });
  assert.deepEqual(Object.keys(s.quotes).sort(), [KEY, "coinbase:BTC-USD"].sort());
  assert.deepEqual(s.quotes[KEY], q(100, 110, 95, 5));
  assert.deepEqual(s.quotes["coinbase:BTC-USD"], q(50, 50, 50, 0));
  assert.deepEqual(s.status, { binance: "live" });
  assert.deepEqual(readSnapshot(null), { quotes: {}, status: {} });
});

test("a new send replaces quotes it mentions and keeps the others", () => {
  const merged = mergeQuotes({ [KEY]: q(100), "binance:ETHUSDT": q(2000) }, { [KEY]: q(101) });
  assert.deepEqual(merged, { [KEY]: q(101), "binance:ETHUSDT": q(2000) });
});

// ── Alerts ────────────────────────────────────────────────────────────────────

test("crossing up through 'above' alerts", () => {
  const { alerts } = alertsOf([btc(70000)], { [KEY]: q(69900) }, { [KEY]: q(70100) });
  assert.deepEqual(alerts, [{ key: KEY, direction: "above", level: 70000, price: 70100 }]);
});

test("crossing down through 'below' alerts", () => {
  const { alerts } = alertsOf([btc(null, 60000)], { [KEY]: q(60100) }, { [KEY]: q(59800) });
  assert.deepEqual(alerts, [{ key: KEY, direction: "below", level: 60000, price: 59800 }]);
});

test("a spike between two sends still counts, through its high or low", () => {
  // Last price back under the level, but the window touched it.
  const up = alertsOf([btc(70000)], { [KEY]: q(69900) }, { [KEY]: q(69950, 70020, 69900) });
  assert.equal(up.alerts.length, 1);
  assert.equal(up.alerts[0].price, 69950, "the alert reports the latest price");
  const down = alertsOf([btc(null, 60000)], { [KEY]: q(60100) }, { [KEY]: q(60050, 60100, 59990) });
  assert.equal(down.alerts.length, 1);
});

test("touching the level exactly is crossing it", () => {
  assert.equal(alertsOf([btc(70000)], { [KEY]: q(69999) }, { [KEY]: q(70000) }).alerts.length, 1);
  assert.equal(alertsOf([btc(null, 60000)], { [KEY]: q(60001) }, { [KEY]: q(60000) }).alerts.length, 1);
});

test("already past the level is not a crossing", () => {
  assert.deepEqual(alertsOf([btc(70000)], { [KEY]: q(70500) }, { [KEY]: q(71000) }).alerts, []);
  assert.deepEqual(alertsOf([btc(null, 60000)], { [KEY]: q(59000) }, { [KEY]: q(58000) }).alerts, []);
  // Sitting exactly on it before doesn't count as below it.
  assert.deepEqual(alertsOf([btc(70000)], { [KEY]: q(70000) }, { [KEY]: q(70100) }).alerts, []);
});

test("moving away from a level is not a crossing", () => {
  assert.deepEqual(alertsOf([btc(70000)], { [KEY]: q(69000) }, { [KEY]: q(68000, 69500, 68000) }).alerts, []);
});

test("a symbol seen for the first time can't have crossed anything yet", () => {
  assert.deepEqual(alertsOf([btc(70000)], {}, { [KEY]: q(80000) }).alerts, []);
});

test("no new quote for a symbol, no alert for it", () => {
  assert.deepEqual(alertsOf([btc(70000)], { [KEY]: q(69000) }, {}).alerts, []);
});

test("an item without levels never alerts", () => {
  assert.deepEqual(alertsOf([btc()], { [KEY]: q(1) }, { [KEY]: q(1e9, 1e9, 0.0001) }).alerts, []);
});

test("one window can cross both levels: both alert, above first", () => {
  const { alerts } = alertsOf([btc(70000, 60000)], { [KEY]: q(65000) }, { [KEY]: q(65000, 71000, 59000) });
  assert.deepEqual(alerts.map((a) => a.direction), ["above", "below"]);
});

test("each symbol is watched on its own", () => {
  const eth = { provider: "binance", symbol: "ETHUSDT", above: 3000, below: null };
  const { alerts } = alertsOf(
    [btc(70000), eth],
    { [KEY]: q(69000), "binance:ETHUSDT": q(2990) },
    { [KEY]: q(69500), "binance:ETHUSDT": q(3010) },
  );
  assert.deepEqual(alerts.map((a) => a.key), ["binance:ETHUSDT"]);
});

test("a symbol no longer watched is ignored, whatever its quotes do", () => {
  assert.deepEqual(alertsOf([], { [KEY]: q(69000) }, { [KEY]: q(80000) }).alerts, []);
});

test("an alert rests for the cooldown, then can fire again", () => {
  const items = [btc(70000)];
  const first = alertsOf(items, { [KEY]: q(69900) }, { [KEY]: q(70100) }, {}, 0);
  assert.equal(first.alerts.length, 1);
  // Back down and up again a minute later: quiet.
  const again = alertsOf(items, { [KEY]: q(69900) }, { [KEY]: q(70100) }, first.fired, MIN);
  assert.deepEqual(again.alerts, []);
  assert.deepEqual(again.fired, first.fired, "a suppressed alert doesn't restart the cooldown");
  // After the cooldown: it fires.
  const later = alertsOf(items, { [KEY]: q(69900) }, { [KEY]: q(70100) }, first.fired, ALERT_COOLDOWN_MS);
  assert.equal(later.alerts.length, 1);
});

test("the cooldown is per level and direction", () => {
  const items = [btc(70000, 60000)];
  const up = alertsOf(items, { [KEY]: q(65000) }, { [KEY]: q(70100) }, {}, 0);
  const down = alertsOf(items, { [KEY]: q(65000) }, { [KEY]: q(59000) }, up.fired, MIN);
  assert.equal(down.alerts[0].direction, "below");
});

test("the cooldowns passed in are never changed in place", () => {
  const fired = Object.freeze({});
  assert.doesNotThrow(() => alertsOf([btc(70000)], { [KEY]: q(69900) }, { [KEY]: q(70100) }, fired));
});

// ── Text ──────────────────────────────────────────────────────────────────────

test("prices show as many decimals as they need", () => {
  assert.equal(formatPrice(62000.123), "62,000.12");
  assert.equal(formatPrice(2.3), "2.30");
  assert.equal(formatPrice(2.34567), "2.3457");
  assert.equal(formatPrice(0.000123456), "0.0001235");
});

test("an alert says which symbol, which way and which level", () => {
  assert.equal(alertLabel({ key: KEY, direction: "above", level: 70000, price: 70100 }), "BTCUSDT above 70,000.00");
  assert.equal(alertLabel({ key: "finnhub:BINANCE:BTCUSDT", direction: "below", level: 1.5, price: 1.4 }),
    "BINANCE:BTCUSDT below 1.50", "a Finnhub symbol with a colon keeps it");
});

// ── In the island ─────────────────────────────────────────────────────────────

installFakeDom();
registerIntegrationHandlers({ reveal: () => {} });
const pill = () => State.tasks.find((t) => t.id === WATCHLIST);
const send = (quotes, status = { binance: "live" }) => emit("watchlist", { quotes, status });

beforeEach(() => {
  State.tasks = [];
  State.focusId = null;
  State.paused = false;
  State.integrations = {};
  State.settings = { ...DEFAULT_SETTINGS, activeIntegrations: [WATCHLIST], watchlist: [btc(70000, 60000)] };
  State.loadIntegrationTasks();
});

test("a crossing up badges the pill green, with the symbol and level", () => {
  send({ [KEY]: q(69900) });
  assert.equal(pill().pillBadge ?? null, null);
  send({ [KEY]: q(70100) });
  assert.equal(pill().pillBadge, "finished");
  assert.equal(pill().steps[0], "BTCUSDT above 70,000.00");
});

test("a crossing down badges it red", () => {
  send({ [KEY]: q(60500) });
  send({ [KEY]: q(59500) });
  assert.equal(pill().pillBadge, "error");
});

test("quotes accumulate across sends, and the feed status follows the last one", () => {
  send({ [KEY]: q(65000) });
  send({ "binance:ETHUSDT": q(2500) }, { binance: "retrying" });
  const data = State.integrations[WATCHLIST].data;
  assert.equal(data.quotes[KEY].price, 65000);
  assert.equal(data.quotes["binance:ETHUSDT"].price, 2500);
  assert.deepEqual(data.status, { binance: "retrying" });
});

test("nothing happens while Coucou is paused", () => {
  State.paused = true;
  send({ [KEY]: q(69900) });
  send({ [KEY]: q(70100) });
  assert.equal(State.integrations[WATCHLIST], undefined);
});

const hooks = { detailOpen: false, openDetail() {}, closeDetail() {}, openSettings() {} };
const card = () => renderIntegrationCard(pill(), hooks);

test("the card lists the watched symbols with their price and levels", () => {
  State.settings.watchlist = [btc(70000, 60000), { provider: "coinbase", symbol: "ETH-USD", above: null, below: null }];
  send({ [KEY]: q(65000) }, { binance: "live", coinbase: "connecting" });
  const text = card().textContent;
  assert.match(text, /BTCUSDT/);
  assert.match(text, /65,000\.00/);
  assert.match(text, /▲ 70,000\.00/);
  assert.match(text, /▼ 60,000\.00/);
  assert.match(text, /ETH-USD/);
  assert.match(text, /Connecting…/, "a symbol with no price yet says why");
  assert.match(text, /—/);
});

test("the card says when the Finnhub key is missing", () => {
  State.settings.watchlist = [{ provider: "finnhub", symbol: "AAPL", above: null, below: null }];
  send({}, { finnhub: "noKey" });
  assert.match(card().textContent, /Finnhub key missing/);
});

test("past three symbols the card counts the rest", () => {
  State.settings.watchlist = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE"].map((s) => ({ provider: "binance", symbol: s, above: null, below: null }));
  send({});
  const text = card().textContent;
  assert.match(text, /CCCC/);
  assert.doesNotMatch(text, /DDDD/);
  assert.match(text, /\+2/);
});
