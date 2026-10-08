// TradeVault quick-log — the island's "Log trade": reading what was typed,
// checking it, showing risk/reward before it is sent, and sending it once.
// No DOM. The trade goes through Rust (quicklog.rs) to the user's TradeVault,
// which builds the row exactly as its web form does (lib/trade-row.ts).
//
// Risk/reward is never typed: TradeVault's rule is that R comes from the stop
// distance × quantity, so the stop (and target) are entered and R:R is shown.

import { t } from "../i18n/i18n";

export type Side = "long" | "short";
export type Field = "side" | "symbol" | "quantity" | "entry" | "stop" | "target" | "exit" | "account";

/** What was typed, before it is checked. */
export interface QuickDraft {
  side?: string;
  symbol?: string;
  quantity?: string;
  entry?: string;
  stop?: string;
  target?: string;
  exit?: string;
}

export interface QuickTrade {
  side: Side;
  symbol: string;
  quantity: number;
  entry: number;
  stop: number | null;
  target: number | null;
  exit: number | null;
}

// ── Reading one line ──────────────────────────────────────────────────────────

const SIDES: Record<string, Side> = { long: "long", buy: "long", l: "long", short: "short", sell: "short", s: "short" };
const KEYWORDS: Record<string, "stop" | "target" | "exit"> = {
  sl: "stop", stop: "stop",
  tp: "target", target: "target", tg: "target",
  exit: "exit", out: "exit", x: "exit",
};
const NUMBER = /^[0-9][0-9,]*(\.[0-9]+)?$|^\.[0-9]+$/;

/**
 * `long NQ 2 @ 18250 sl 18230 tp 18290 exit 18270` → a draft. Side, symbol,
 * quantity, then `@`/`at` entry, then stop, target and exit in any order;
 * case doesn't matter, "2x" and "@18250" are fine. Words it can't place are
 * returned in `unknown`, so nothing typed is silently dropped.
 */
export function parseQuickLine(text: string): { draft: QuickDraft; unknown: string[] } {
  const tokens = text
    .trim()
    .replace(/@/g, " @ ")
    .split(/\s+/)
    .filter(Boolean);
  const draft: QuickDraft = {};
  const unknown: string[] = [];
  let i = 0;
  const peek = () => tokens[i]?.toLowerCase();

  if (peek() && SIDES[peek()!]) draft.side = SIDES[tokens[i++].toLowerCase()];
  // The second word is the symbol even when it spells a keyword: X (US Steel)
  // is a ticker before it is "exit".
  if (tokens[i] && !NUMBER.test(tokens[i]) && tokens[i] !== "@") draft.symbol = tokens[i++];
  const qty = tokens[i]?.replace(/x$/i, "");
  if (qty && NUMBER.test(qty)) {
    draft.quantity = qty;
    i++;
  }
  while (i < tokens.length) {
    const word = tokens[i].toLowerCase();
    const value = tokens[i + 1];
    if ((word === "@" || word === "at") && value != null && NUMBER.test(value)) {
      draft.entry = value;
      i += 2;
    } else if (KEYWORDS[word] && value != null && NUMBER.test(value)) {
      draft[KEYWORDS[word]] = value;
      i += 2;
    } else {
      unknown.push(tokens[i]);
      i++;
    }
  }
  return { draft, unknown };
}

// ── Checking ──────────────────────────────────────────────────────────────────

/** "18,250.5" → 18250.5; anything else, or ≤ 0, → null. */
export function readNumber(raw: string | number | undefined | null): number | null {
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : raw.trim() === "" ? NaN : Number(raw.trim().replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * What a ticker looks like: letters, digits and . : / - _ ! (futures, pairs,
 * options roots). Stricter than TradeVault, which takes any non-empty symbol —
 * this only catches a typo before it lands in the journal.
 */
const SYMBOL = /^[A-Z0-9][A-Z0-9.:/_!-]{0,23}$/;

/**
 * The trade, or what is wrong with each field. Same rules as TradeVault's
 * checkTradeInput() and checkQuickLog(): the server applies them again.
 */
export function validateQuickLog(draft: QuickDraft): { trade: QuickTrade } | { errors: Partial<Record<Field, string>> } {
  const errors: Partial<Record<Field, string>> = {};
  const side = draft.side === "long" || draft.side === "short" ? draft.side : null;
  if (!side) errors.side = t("Start with long or short");
  const symbol = (draft.symbol ?? "").trim().toUpperCase();
  if (!symbol) errors.symbol = t("Which symbol?");
  else if (!SYMBOL.test(symbol)) errors.symbol = t("“{symbol}” doesn't look like a symbol", { symbol });
  const quantity = readNumber(draft.quantity);
  if (quantity == null) errors.quantity = t("Size must be a number above 0");
  const entry = readNumber(draft.entry);
  if (entry == null) errors.entry = t("Entry price: @ followed by a number above 0");

  const optional = (field: "stop" | "target" | "exit") => {
    const raw = draft[field];
    if (raw == null || raw.trim() === "") return null;
    const n = readNumber(raw);
    if (n == null) errors[field] = t("Must be a number above 0");
    return n;
  };
  const stop = optional("stop");
  const target = optional("target");
  const exit = optional("exit");

  if (side && entry != null) {
    const long = side === "long";
    if (stop != null && !errors.stop && (long ? stop >= entry : stop <= entry)) {
      errors.stop = long ? t("A long stop must be below the entry") : t("A short stop must be above the entry");
    }
    if (target != null && !errors.target && (long ? target <= entry : target >= entry)) {
      errors.target = long ? t("A long target must be above the entry") : t("A short target must be below the entry");
    }
  }
  if (Object.keys(errors).length) return { errors };
  return { trade: { side: side!, symbol, quantity: quantity!, entry: entry!, stop, target, exit } };
}

// ── Risk and reward (TradeVault's own formulas, lib/trade-row.ts) ─────────────

export interface RiskReward {
  /** Currency at risk to the stop; null without a stop. */
  risk: number | null;
  /** Currency to the target; null without a target. */
  reward: number | null;
  /** reward / risk; null unless both are there. */
  rr: number | null;
  /** Realised P&L once there is an exit. */
  pnl: number | null;
  /** That P&L in R, when there is a stop. */
  pnlR: number | null;
}

export function riskReward(trade: QuickTrade): RiskReward {
  const dir = trade.side === "long" ? 1 : -1;
  const risk = trade.stop != null ? (trade.entry - trade.stop) * dir * trade.quantity : null;
  const reward = trade.target != null ? (trade.target - trade.entry) * dir * trade.quantity : null;
  const pnl = trade.exit != null ? (trade.exit - trade.entry) * dir * trade.quantity : null;
  return {
    risk,
    reward,
    rr: risk && reward != null ? reward / risk : null,
    pnl,
    pnlR: risk && pnl != null ? pnl / risk : null,
  };
}

/** The body TradeVault's POST /api/coucou/trades expects. */
export function tradePayload(trade: QuickTrade, accountId: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    account_id: accountId,
    symbol: trade.symbol,
    direction: trade.side,
    entry_price: trade.entry,
    quantity: trade.quantity,
    tags: ["coucou"],
  };
  if (trade.stop != null) body.stop_loss = trade.stop;
  if (trade.target != null) body.take_profit = trade.target;
  if (trade.exit != null) {
    body.exit_price = trade.exit;
    body.exit_date = new Date().toISOString();
  }
  return body;
}

// ── Failures ──────────────────────────────────────────────────────────────────

/** What quicklog.rs rejects with. */
export interface QuickLogFailure {
  kind: string;
  message?: string | null;
}

/**
 * What to tell the user, and whether "Try again" makes sense. A retry reuses
 * the same submission id, so it can never log the trade twice — which is why
 * a timeout (did it arrive or not?) is safe to retry.
 */
export function describeFailure(err: unknown): { message: string; retry: boolean } {
  const f = (err && typeof err === "object" ? err : { kind: "unknown", message: String(err ?? "") }) as QuickLogFailure;
  const said = typeof f.message === "string" && f.message.trim() ? f.message.trim() : null;
  switch (f.kind) {
    case "setup":
      return { message: said ?? t("Add TradeVault's address and token in Settings → Integrations."), retry: false };
    case "timeout":
      return { message: t("TradeVault didn't answer in time. Trying again can't log it twice."), retry: true };
    case "offline":
      return { message: t("Couldn't reach TradeVault — check the connection."), retry: true };
    case "auth":
      return { message: t("TradeVault refused the token — create a new one in TradeVault → Settings."), retry: false };
    case "readonly":
      return { message: t("This token is read-only — create one with “Can log trades” ticked."), retry: false };
    case "forbidden":
      return { message: said ?? t("TradeVault refused this account."), retry: false };
    case "rejected":
      return { message: said ?? t("TradeVault rejected the trade."), retry: false };
    case "conflict":
    case "server":
      return { message: t("TradeVault had a problem saving it. Trying again can't log it twice."), retry: true };
    default:
      return { message: said ?? t("Something went wrong."), retry: false };
  }
}

// ── Sending once ──────────────────────────────────────────────────────────────

/** The island's own limit, on top of Rust's 10 s request timeout. */
export const SEND_TIMEOUT_MS = 15_000;

export type SendResult =
  | { ok: true; id: string; duplicate: boolean }
  | { ok: false; message: string; retry: boolean };

type Sender = (submission: string, trade: Record<string, unknown>) => Promise<unknown>;

/**
 * One submission id per trade: kept across retries of the same trade, new as
 * soon as the trade changes or has been logged. A second click while one is
 * on its way is ignored.
 */
export class QuickLogSession {
  sending = false;
  private submission: string | null = null;
  private sentKey: string | null = null;
  private readonly send: Sender;
  private readonly newId: () => string;
  private readonly timeoutMs: number;

  constructor(send: Sender, newId: () => string = () => crypto.randomUUID(), timeoutMs = SEND_TIMEOUT_MS) {
    this.send = send;
    this.newId = newId;
    this.timeoutMs = timeoutMs;
  }

  /** The id the next send would use, if one is being kept (tests, logs). */
  get pendingId(): string | null {
    return this.submission;
  }

  async submit(trade: Record<string, unknown>): Promise<SendResult | null> {
    if (this.sending) return null;
    const key = JSON.stringify(trade, Object.keys(trade).sort().filter((k) => k !== "exit_date"));
    if (this.submission == null || this.sentKey !== key) {
      this.submission = this.newId();
      this.sentKey = key;
    }
    this.sending = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        this.send(this.submission, trade),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject({ kind: "timeout" }), this.timeoutMs);
        }),
      ]);
      const r = (reply ?? {}) as { id?: unknown; duplicate?: unknown };
      if (typeof r.id !== "string") throw { kind: "server" };
      this.submission = null;
      this.sentKey = null;
      return { ok: true, id: r.id, duplicate: r.duplicate === true };
    } catch (err) {
      return { ok: false, ...describeFailure(err) };
    } finally {
      clearTimeout(timer);
      this.sending = false;
    }
  }

  /** Forget the kept id (the user cleared the form). */
  reset() {
    this.submission = null;
    this.sentKey = null;
  }
}
