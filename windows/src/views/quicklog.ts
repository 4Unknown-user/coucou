// Quick-log card: one line typed on the island, checked and previewed with
// its risk/reward, sent to TradeVault only on "Log trade" (src/core/quicklog.ts).
// Opened from the TradeVault card; Escape or Cancel goes back.

import { h, clear } from "./dom";
import { Bridge } from "../core/bridge";
import { washRGBA } from "../core/layout";
import {
  QuickLogSession, describeFailure, parseQuickLine, riskReward, tradePayload, validateQuickLog,
  type QuickTrade,
} from "../core/quicklog";
import { State } from "../core/state";
import { formatMoney } from "../core/tradevault";
import { formatPrice } from "../core/watchlist";
import type { ViewActions, ViewHost } from "./views";
import { t, tl } from "../i18n/i18n";

interface Account {
  id: string;
  name: string;
  currency: string;
}

/** The account picked last, kept for the next trade while Coucou runs. */
let lastAccount = "";

/** "LONG NQ ×2 @ 18,250.00 · stop 18,230.00 · R:R 2.00 · risk $40.00" */
export function previewLine(trade: QuickTrade, currency: string): string {
  const rr = riskReward(trade);
  const parts = [`${trade.side === "long" ? "▲ LONG" : "▼ SHORT"} ${trade.symbol} ×${trade.quantity} @ ${formatPrice(trade.entry)}`];
  if (trade.stop != null) parts.push(t("stop {price}", { price: formatPrice(trade.stop) }));
  if (trade.target != null) parts.push(t("target {price}", { price: formatPrice(trade.target) }));
  if (rr.rr != null) parts.push(`R:R ${rr.rr.toFixed(2)}`);
  if (rr.risk != null) parts.push(t("risk {amount}", { amount: formatMoney(rr.risk, currency) }));
  if (rr.pnl != null) {
    const r = rr.pnlR != null ? ` (${rr.pnlR >= 0 ? "+" : ""}${rr.pnlR.toFixed(2)}R)` : "";
    parts.push(t("P&L {amount}", { amount: formatMoney(rr.pnl, currency, true) }) + r);
  }
  return parts.join(" · ");
}

export function buildQuickLog(actions: ViewActions): ViewHost {
  const account = h("select", { class: "ql-account", "aria-label": tl("Account") }) as HTMLSelectElement;
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "long NQ 2 @ 18250 sl 18230 tp 18290",
    spellcheck: "false",
    "aria-label": tl("Trade"),
  }) as HTMLInputElement;
  input.value = "";
  const preview = h("div", { class: "ql-preview" });
  const status = h("div", { class: "ql-status", role: "status" });
  const submit = h("button", { class: "btn primary", text: tl("Log trade") }) as HTMLButtonElement;
  const retry = h("button", { class: "btn secondary", text: tl("Try again") }) as HTMLButtonElement;
  const cancel = h("button", { class: "btn secondary", text: tl("Cancel") }) as HTMLButtonElement;

  const body = h("div", { class: "stack ql-stack" },
    h("div", { class: "ql-head" }, h("span", { class: "title", text: tl("Log trade") }), account),
    h("div", { class: "chat-bar" }, input),
    preview,
    h("div", { class: "ql-actions" }, status, retry, cancel, submit),
  );
  const card = h("div", { class: "card wash" }, body);
  card.style.setProperty("--wash", washRGBA("indigo"));
  const el = h("div", { class: "view" }, card);

  let accounts: Account[] = [];
  let canWrite = false;
  let current: QuickTrade | null = null;
  const session = new QuickLogSession((submission, trade) => Bridge.tradevaultLogTrade(submission, trade));

  const say = (text: string, kind: "" | "ok" | "err" = "") => {
    status.textContent = text;
    status.className = kind ? `ql-status ${kind}` : "ql-status";
  };

  function currency(): string {
    return accounts.find((a) => a.id === account.value)?.currency ?? "USD";
  }

  /** Re-reads the line: preview or the first thing to fix, and whether it can be sent. */
  function check() {
    retry.style.display = "none";
    const text = input.value.trim();
    current = null;
    preview.className = "ql-preview";
    if (!text) {
      preview.textContent = t("Side, symbol, size, @ entry — then sl, tp and exit if you have them.");
    } else {
      const { draft, unknown } = parseQuickLine(text);
      const checked = validateQuickLog(draft);
      if (unknown.length) {
        preview.textContent = t("Didn't understand “{word}”", { word: unknown[0] });
        preview.classList.add("err");
      } else if ("errors" in checked) {
        preview.textContent = Object.values(checked.errors)[0] ?? "";
        preview.classList.add("err");
      } else {
        current = checked.trade;
        preview.textContent = previewLine(current, currency());
      }
    }
    submit.disabled = !current || !account.value || !canWrite || session.sending;
  }

  async function loadAccounts() {
    clear(account);
    say(t("Loading accounts…"));
    try {
      const info = await Bridge.tradevaultAccounts();
      accounts = info.accounts ?? [];
      canWrite = info.canWrite === true;
      for (const a of accounts) account.append(h("option", { value: a.id, text: `${a.name} · ${a.currency}` }));
      account.value = accounts.some((a) => a.id === lastAccount) ? lastAccount : (accounts[0]?.id ?? "");
      if (!accounts.length) say(t("No accounts in TradeVault yet."), "err");
      else if (!canWrite) say(describeFailure({ kind: "readonly" }).message, "err");
      else say("");
    } catch (err) {
      accounts = [];
      canWrite = false;
      say(describeFailure(err).message, "err");
    }
    check();
  }

  async function send() {
    if (!current || !account.value) return;
    lastAccount = account.value;
    const payload = tradePayload(current, account.value);
    submit.disabled = true;
    retry.style.display = "none";
    say(t("Logging…"));
    const result = await session.submit(payload);
    if (!result) return; // a click while one was on its way
    if (result.ok) {
      say(result.duplicate ? t("Already logged — nothing was added twice.") : t("Logged in TradeVault."), "ok");
      input.value = "";
      check();
      return;
    }
    say(result.message, "err");
    retry.style.display = result.retry ? "" : "none";
    submit.disabled = !current;
  }

  const close = () => actions.setView(State.defaultView());
  input.addEventListener("input", check);
  account.addEventListener("change", check);
  submit.addEventListener("click", () => void send());
  retry.addEventListener("click", () => void send());
  cancel.addEventListener("click", close);
  input.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter" && !submit.disabled) {
      e.preventDefault();
      void send();
    } else if (key === "Escape") {
      e.preventDefault();
      close();
    }
    e.stopPropagation(); // keys typed here are for the form, not the island
  });
  retry.style.display = "none";

  return {
    el,
    sync() {},
    focus() {
      void loadAccounts();
      input.focus();
    },
  };
}
