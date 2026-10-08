// Settings → Watchlist: the symbols watchlist.rs streams, the levels that
// raise an alert, and the Finnhub key for US stocks. Crypto needs no key.

import { Bridge } from "../core/bridge";
import type { Settings } from "../core/state";
import {
  FINNHUB_KEY, PROVIDERS, isProvider, itemKey, normalizeSymbol, readWatchlist, validSymbol,
  type ProviderId, type WatchItem,
} from "../core/watchlist";
import { h, clear } from "../views/dom";
import { t } from "../i18n/i18n";

/** A level field: empty means none. */
function levelInput(value: number | null, onChange: (v: number | null) => void): HTMLInputElement {
  const input = h("input", {
    type: "number", min: "0", step: "any", style: "width:96px",
    value: value != null ? String(value) : "", placeholder: "—",
  }) as HTMLInputElement;
  input.addEventListener("change", () => {
    const n = Number(input.value);
    const v = input.value.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
    input.value = v != null ? String(v) : "";
    onChange(v);
  });
  return input;
}

function providerSelect(value: string): HTMLSelectElement {
  const select = h("select", {}) as HTMLSelectElement;
  for (const p of PROVIDERS) select.append(h("option", { value: p.id, text: p.name }));
  select.value = value;
  return select;
}

export function watchlistSection(current: () => Settings, save: () => Promise<void>, finnhubKey: boolean): HTMLElement {
  const list = h("div", { style: "display:flex;flex-direction:column;gap:6px" });
  const error = h("div", {});

  const items = () => readWatchlist(current().watchlist);
  const store = (next: WatchItem[]) => {
    current().watchlist = next;
    void save();
    draw();
  };

  function draw() {
    clear(list);
    const all = items();
    if (!all.length) list.append(h("div", { class: "hint", text: t("Nothing watched yet.") }));
    if (all.length) {
      list.append(h("div", { class: "row hint" },
        h("span", { style: "min-width:190px", text: t("Symbol") }),
        h("span", { style: "width:96px", text: t("Alert above") }),
        h("span", { style: "width:96px", text: t("Alert below") }),
      ));
    }
    all.forEach((item, i) => {
      const name = PROVIDERS.find((p) => p.id === item.provider)?.name ?? item.provider;
      const update = (patch: Partial<WatchItem>) => store(all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
      const remove = h("button", { class: "danger", text: t("Remove") });
      remove.addEventListener("click", () => store(all.filter((_, j) => j !== i)));
      list.append(h("div", { class: "row" },
        h("span", { style: "min-width:190px", title: itemKey(item) },
          h("span", { text: item.symbol }), h("span", { class: "hint", text: `  ${name}` })),
        levelInput(item.above, (v) => update({ above: v })),
        levelInput(item.below, (v) => update({ below: v })),
        remove,
      ));
    });
  }

  // ── Adding ──────────────────────────────────────────────────────────────────
  const provider = providerSelect("binance");
  const symbol = h("input", { type: "text", spellcheck: "false", style: "width:120px", placeholder: "BTCUSDT" }) as HTMLInputElement;
  provider.addEventListener("change", () => {
    symbol.placeholder = PROVIDERS.find((p) => p.id === provider.value)?.placeholder ?? "";
  });
  const add = h("button", { class: "primary", text: t("Add") });
  const submit = () => {
    clear(error);
    const id = provider.value;
    if (!isProvider(id)) return;
    const s = normalizeSymbol(id as ProviderId, symbol.value);
    if (!validSymbol(id, s)) {
      error.append(h("div", { class: "notice err", text: t("“{symbol}” isn't a {provider} symbol — try {example}.", {
        symbol: symbol.value.trim(), provider: PROVIDERS.find((p) => p.id === id)!.name, example: symbol.placeholder,
      }) }));
      return;
    }
    const all = items();
    if (all.some((x) => itemKey(x) === `${id}:${s}`)) {
      symbol.value = "";
      return;
    }
    symbol.value = "";
    store([...all, { provider: id, symbol: s, above: null, below: null }]);
  };
  add.addEventListener("click", submit);
  symbol.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") submit();
  });

  // ── Finnhub key ─────────────────────────────────────────────────────────────
  const key = h("input", {
    type: "password", autocomplete: "off", spellcheck: "false", style: "flex:1 1 auto;min-width:0",
    placeholder: finnhubKey ? t("(stored)") : t("Free key from finnhub.io"),
  }) as HTMLInputElement;
  const saveKey = h("button", { text: t("Save") });
  saveKey.addEventListener("click", async () => {
    clear(error);
    try {
      await Bridge.secretSet(FINNHUB_KEY, key.value.trim());
      key.placeholder = key.value.trim() ? t("(stored)") : t("Free key from finnhub.io");
      key.value = "";
    } catch (err) {
      error.append(h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }));
    }
  });

  draw();
  return h("section", {},
    h("h2", {}, h("span", { text: t("Watchlist") })),
    h("div", { class: "hint", text: t("Live prices for the Watchlist pill: crypto from Binance or Coinbase, US stocks from Finnhub. Streams only while the pill is on.") }),
    list,
    h("div", { class: "row" }, provider, symbol, add),
    h("div", { class: "row" }, h("label", { text: "Finnhub" }), key, saveKey),
    error,
  );
}
