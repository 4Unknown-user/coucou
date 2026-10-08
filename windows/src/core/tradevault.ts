// TradeVault pill — what /api/coucou/summary returns, and when it is worth an
// alert. Every number is TradeVault's own (its computeMetrics()); Coucou never
// recomputes a metric, it only compares today's P&L with the user's limit and
// watches the losing streak.

import { language, t } from "../i18n/i18n";

export const TRADEVAULT = "integration_tradevault";

/** A losing streak this long is worth a nudge. */
export const LOSS_STREAK_ALERT = 3;

export interface TvAccount {
  id: string;
  name: string;
  currency: string;
  todayPnl: number;
  netPnl: number;
  winRate: number;
  profitFactor: number | null;
  avgR: number | null;
  totalTrades: number;
  openTrades: number;
  currentDrawdown: number;
  maxDrawdownPct: number | null;
  /** + wins in a row, - losses in a row. */
  currentStreak: number;
}

export interface TvSummary {
  date: string;
  accounts: TvAccount[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The summary as it arrived, or null when it isn't one. */
export function readSummary(data: unknown): TvSummary | null {
  const d = data as { date?: unknown; accounts?: unknown } | null;
  if (!d || typeof d.date !== "string" || !Array.isArray(d.accounts)) return null;
  const accounts = d.accounts
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object" && typeof a.id === "string")
    .map((a) => ({
      id: a.id as string,
      name: str(a.name) || (a.id as string),
      currency: str(a.currency) || "USD",
      todayPnl: num(a.todayPnl),
      netPnl: num(a.netPnl),
      winRate: num(a.winRate),
      profitFactor: numOrNull(a.profitFactor),
      avgR: numOrNull(a.avgR),
      totalTrades: num(a.totalTrades),
      openTrades: num(a.openTrades),
      currentDrawdown: num(a.currentDrawdown),
      maxDrawdownPct: numOrNull(a.maxDrawdownPct),
      currentStreak: num(a.currentStreak),
    }));
  return { date: d.date, accounts };
}

/** "−€1,234.50" / "+$80.00": signed, in the interface language. */
export function formatMoney(amount: number, currency: string, signed = false): string {
  let text: string;
  try {
    text = new Intl.NumberFormat(language(), {
      style: "currency", currency, signDisplay: signed ? "exceptZero" : "auto",
    }).format(amount);
  } catch {
    text = `${signed && amount > 0 ? "+" : ""}${amount.toFixed(2)} ${currency}`;
  }
  return text;
}

export interface TvAlert {
  label: string;
  detail: string;
}

/**
 * The alert this poll raises, if any: an account reaching the daily loss limit,
 * or a losing streak reaching LOSS_STREAK_ALERT. Only on the poll where it
 * happens — the next polls stay quiet while it lasts. A new day starts over.
 */
export function tradevaultAlert(prev: TvSummary | null, next: TvSummary, lossLimit: number): TvAlert | null {
  const before = (id: string) => (prev && prev.date === next.date ? prev.accounts.find((a) => a.id === id) : undefined);
  const limit = Number.isFinite(lossLimit) && lossLimit > 0 ? lossLimit : 0;

  for (const a of next.accounts) {
    const was = before(a.id);
    if (limit && a.todayPnl <= -limit && !(was && was.todayPnl <= -limit)) {
      return {
        label: t("Daily loss limit reached"),
        detail: `${a.name} · ${formatMoney(a.todayPnl, a.currency, true)}`,
      };
    }
  }
  for (const a of next.accounts) {
    // A streak runs across days, so yesterday's last poll counts too.
    const was = prev?.accounts.find((x) => x.id === a.id);
    if (a.currentStreak <= -LOSS_STREAK_ALERT && !(was && was.currentStreak <= -LOSS_STREAK_ALERT)) {
      return {
        label: t("{n} losses in a row", { n: -a.currentStreak }),
        detail: a.name,
      };
    }
  }
  return null;
}
