// Settings → Time: the last seven days of agent time per project
// (src/core/timetrack.ts), who each project is billed to and at what rate,
// and a CSV export for invoices. Nothing here leaves the PC.

import { Bridge } from "../core/bridge";
import { fileName } from "../core/diff";
import type { Settings } from "../core/state";
import { dailyTotals, parseBeats, toCsv, weekGrid, type DayTotal } from "../core/timetrack";
import { formatMoney } from "../core/tradevault";
import { formatDuration } from "../recap/summary";
import { h, clear } from "../views/dom";
import { t, weekdayShort } from "../i18n/i18n";

const minutes = (ms: number) => Math.floor(ms / 60_000);

export function timeSection(current: () => Settings, save: () => Promise<void>): HTMLElement {
  const table = h("div", {});
  const status = h("div", {});
  let totals: DayTotal[] = [];

  const currency = h("input", {
    type: "text", maxlength: "3", spellcheck: "false", style: "width:56px;text-transform:uppercase",
    value: current().timeCurrency,
  }) as HTMLInputElement;
  currency.addEventListener("change", () => {
    const code = currency.value.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
      currency.value = current().timeCurrency;
      return;
    }
    current().timeCurrency = code;
    currency.value = code;
    void save();
    draw();
  });

  const refresh = h("button", { text: t("Refresh") });
  refresh.addEventListener("click", () => void load());
  const exportBtn = h("button", { class: "primary", text: t("Export CSV") });
  exportBtn.addEventListener("click", async () => {
    clear(status);
    try {
      const s = current();
      const path = await Bridge.timeSaveCsv(toCsv(totals, s.timeProjects, s.timeCurrency));
      status.append(h("div", { class: "notice ok", text: t("Saved as {name}", { name: fileName(path) }) }));
    } catch (err) {
      status.append(h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }));
    }
  });

  function setBilling(project: string, client: string, rate: number) {
    const s = current();
    s.timeProjects = { ...s.timeProjects, [project]: { client, rate } };
    void save();
  }

  function draw() {
    clear(table);
    const { days, rows } = weekGrid(totals, new Date());
    if (!rows.length) {
      table.append(h("div", { class: "hint", text: t("No agent time logged in the last 7 days.") }));
      return;
    }
    const s = current();
    const head = h("tr", {},
      h("th", { text: t("Project") }),
      h("th", { text: t("Client") }),
      h("th", { text: t("Rate per hour") }),
      // Totals before the days: in a narrow window the days are what scrolls.
      h("th", { class: "num", text: t("Total") }),
      h("th", { class: "num", text: t("Amount") }),
      ...days.map((d) => {
        const [y, m, day] = d.split("-").map(Number);
        return h("th", { class: "num", text: weekdayShort(new Date(y, m - 1, day).getDay()) });
      }),
    );
    const body = rows.map((row) => {
      const billing = s.timeProjects[row.project] ?? { client: "", rate: 0 };
      const client = h("input", { type: "text", value: billing.client, spellcheck: "false" }) as HTMLInputElement;
      const rate = h("input", {
        type: "number", min: "0", step: "1", value: billing.rate ? String(billing.rate) : "",
      }) as HTMLInputElement;
      const amount = h("td", { class: "num" });
      const showAmount = () => {
        const r = Number(rate.value);
        amount.textContent = r > 0 ? formatMoney((row.total / 3_600_000) * r, s.timeCurrency) : "";
      };
      const store = () => {
        const r = Math.max(0, Number(rate.value) || 0);
        setBilling(row.project, client.value.trim(), r);
        showAmount();
      };
      client.addEventListener("change", store);
      rate.addEventListener("change", store);
      showAmount();
      return h("tr", {},
        h("td", { title: row.project, text: fileName(row.project) }),
        h("td", {}, client),
        h("td", {}, rate),
        h("td", { class: "num", text: formatDuration(minutes(row.total)) }),
        amount,
        ...row.perDay.map((ms) => h("td", { class: "num dim", text: ms ? formatDuration(minutes(ms)) : "·" })),
      );
    });
    table.append(h("div", { class: "time-scroll" }, h("table", { class: "time-table" }, h("thead", {}, head), h("tbody", {}, ...body))));
  }

  async function load() {
    totals = dailyTotals(parseBeats((await Bridge.timeRead()) ?? ""));
    draw();
  }
  void load();

  return h("section", {},
    h("h2", {}, h("span", { text: t("Time") })),
    h("div", { class: "hint", text: t("Agent sessions are counted per project (its Git folder), on this PC only. Pauses over 15 minutes don't count.") }),
    table,
    h("div", { class: "row" },
      h("label", { text: t("Currency") }), currency,
      h("div", { style: "flex:1" }),
      refresh, exportBtn,
    ),
    status,
  );
}
