// Watchlist pill — symbols, the prices watchlist.rs streams, and when a price
// is worth an alert. No DOM, no Tauri.
//
// Rust sends, at most every 3 s, each symbol's last price plus the high and
// low since the previous send. An alert fires when a level is crossed: the
// last known price was on one side and this window reached the other —
// so a spike between two sends still counts. Then it rests for a few minutes,
// so a price hovering on the level doesn't ring every 3 s.

import { language, t } from "../i18n/i18n";

export const WATCHLIST = "integration_watchlist";
export const FINNHUB_KEY = "finnhub-api-key";

/** One level, one direction: quiet this long after it fires. */
export const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

export type ProviderId = "binance" | "coinbase" | "finnhub";

export interface ProviderDef {
  id: ProviderId;
  name: string;
  /** What a symbol looks like there. */
  placeholder: string;
  /** Needs the Finnhub key. */
  needsKey: boolean;
}

export const PROVIDERS: readonly ProviderDef[] = [
  { id: "binance", name: "Binance", placeholder: "BTCUSDT", needsKey: false },
  { id: "coinbase", name: "Coinbase", placeholder: "BTC-USD", needsKey: false },
  { id: "finnhub", name: "Finnhub", placeholder: "AAPL", needsKey: true },
];

export interface WatchItem {
  provider: string;
  symbol: string;
  above: number | null;
  below: number | null;
}

export interface Quote {
  price: number;
  high: number;
  low: number;
  /** Epoch ms of the last tick. */
  at: number;
}

/** "live", "connecting", "retrying" or "noKey", per provider. */
export type FeedStatus = Record<string, string>;

export interface WatchSnapshot {
  quotes: Record<string, Quote>;
  status: FeedStatus;
}

export const isProvider = (id: unknown): id is ProviderId => PROVIDERS.some((p) => p.id === id);

export function itemKey(item: Pick<WatchItem, "provider" | "symbol">): string {
  return `${item.provider}:${item.symbol}`;
}

/**
 * What the user typed, the way the provider spells it: "btc/usdt" → "BTCUSDT"
 * on Binance, "btc/usd" or "btcusd"-ish → "BTC-USD" on Coinbase, "aapl" → "AAPL".
 */
export function normalizeSymbol(provider: ProviderId, raw: string): string {
  const s = raw.trim().toUpperCase();
  switch (provider) {
    case "binance":
      return s.replace(/[\s/\-_]/g, "");
    case "coinbase":
      return s.replace(/\s/g, "").replace(/[/_]/g, "-");
    case "finnhub":
      return s.replace(/\s/g, "");
  }
}

/** Same rules as valid_symbol() in src-tauri/src/watchlist.rs. */
export function validSymbol(provider: ProviderId, s: string): boolean {
  switch (provider) {
    case "binance":
      return /^[A-Z0-9]{2,20}$/.test(s);
    case "coinbase":
      return /^[A-Z0-9]{1,10}-[A-Z0-9]{1,10}$/.test(s);
    case "finnhub":
      return /^[A-Z0-9.:^-]{1,20}$/.test(s);
  }
}

const level = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/** The watchlist from settings: known providers and valid symbols only, each once. */
export function readWatchlist(raw: unknown): WatchItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: WatchItem[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || !isProvider(r.provider) || typeof r.symbol !== "string") continue;
    if (!validSymbol(r.provider, r.symbol)) continue;
    const item = { provider: r.provider, symbol: r.symbol, above: level(r.above), below: level(r.below) };
    if (seen.has(itemKey(item))) continue;
    seen.add(itemKey(item));
    out.push(item);
  }
  return out;
}

/** A snapshot from Rust, field by field; junk is dropped. */
export function readSnapshot(data: unknown): WatchSnapshot {
  const d = (data ?? {}) as { quotes?: unknown; status?: unknown };
  const quotes: Record<string, Quote> = {};
  if (d.quotes && typeof d.quotes === "object") {
    for (const [key, q] of Object.entries(d.quotes as Record<string, Record<string, unknown>>)) {
      const price = level(q?.price);
      if (price == null) continue;
      quotes[key] = {
        price,
        high: Math.max(price, level(q.high) ?? price),
        low: Math.min(price, level(q.low) ?? price),
        at: typeof q.at === "number" ? q.at : 0,
      };
    }
  }
  const status: FeedStatus = {};
  if (d.status && typeof d.status === "object") {
    for (const [k, v] of Object.entries(d.status as Record<string, unknown>)) if (typeof v === "string") status[k] = v;
  }
  return { quotes, status };
}

/** The latest quote per symbol: a new send replaces, symbols it didn't mention stay. */
export function mergeQuotes(prev: Record<string, Quote>, incoming: Record<string, Quote>): Record<string, Quote> {
  return { ...prev, ...incoming };
}

export interface WatchAlert {
  key: string;
  direction: "above" | "below";
  level: number;
  price: number;
}

/**
 * Levels crossed by `incoming`, given the last prices seen before it. A symbol
 * seen for the first time has no "before", so it can't cross anything yet.
 * `fired` (key|direction → epoch ms) carries the cooldowns; the returned one
 * replaces it.
 */
export function watchAlerts(
  items: readonly WatchItem[],
  previous: Readonly<Record<string, Quote>>,
  incoming: Readonly<Record<string, Quote>>,
  fired: Readonly<Record<string, number>>,
  now: number,
): { alerts: WatchAlert[]; fired: Record<string, number> } {
  const next = { ...fired };
  const alerts: WatchAlert[] = [];
  for (const item of items) {
    const key = itemKey(item);
    const before = previous[key]?.price;
    const q = incoming[key];
    if (before == null || !q) continue;
    const check = (direction: "above" | "below", lvl: number | null, crossed: boolean) => {
      if (lvl == null || !crossed) return;
      const id = `${key}|${direction}`;
      if (next[id] != null && now - next[id] < ALERT_COOLDOWN_MS) return;
      next[id] = now;
      alerts.push({ key, direction, level: lvl, price: q.price });
    };
    check("above", item.above, item.above != null && before < item.above && q.high >= item.above);
    check("below", item.below, item.below != null && before > item.below && q.low <= item.below);
  }
  return { alerts, fired: next };
}

/** Grouped, with as many decimals as the price needs: 62,000.1 · 2.31 · 0.000123. */
export function formatPrice(price: number): string {
  const opts: Intl.NumberFormatOptions = price >= 1
    ? { maximumFractionDigits: price >= 1000 ? 2 : 4, minimumFractionDigits: 2 }
    : { maximumSignificantDigits: 4 };
  try {
    return new Intl.NumberFormat(language(), opts).format(price);
  } catch {
    return String(price);
  }
}

/** "BTCUSDT above 70,000" — the label of the pill's alert. */
export function alertLabel(a: WatchAlert): string {
  const symbol = a.key.slice(a.key.indexOf(":") + 1);
  return a.direction === "above"
    ? t("{symbol} above {level}", { symbol, level: formatPrice(a.level) })
    : t("{symbol} below {level}", { symbol, level: formatPrice(a.level) });
}
