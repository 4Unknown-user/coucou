// Project time tracking (src/core/timetrack.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_IDLE_GAP_MS, dailyTotals, parseBeats, toCsv, weekGrid } from "../src/core/timetrack.ts";

const MIN = 60_000;
/** Local time on 8 Oct 2026, so day keys hold in any time zone. */
const at = (h, m = 0, day = 8) => new Date(2026, 9, day, h, m).getTime();
const beat = (project, t) => ({ t, project });
const A = "C:\\code\\acme-site";
const B = "C:\\code\\trade-vault";

test("the spans between heartbeats add up, within one stretch", () => {
  const totals = dailyTotals([beat(A, at(10, 0)), beat(A, at(10, 5)), beat(A, at(10, 12))]);
  assert.deepEqual(totals, [{ day: "2026-10-08", project: A, ms: 12 * MIN }]);
});

test("a pause longer than the idle gap is not counted", () => {
  const totals = dailyTotals([
    beat(A, at(9, 0)), beat(A, at(9, 10)), // 10 min
    beat(A, at(11, 0)), beat(A, at(11, 3)), // lunch in between, then 3 min
  ]);
  assert.equal(totals[0].ms, 13 * MIN);
});

test("a pause of exactly the idle gap still counts, one minute more does not", () => {
  const gap = DEFAULT_IDLE_GAP_MS / MIN;
  assert.equal(dailyTotals([beat(A, at(9, 0)), beat(A, at(9, gap))])[0].ms, gap * MIN);
  assert.deepEqual(dailyTotals([beat(A, at(9, 0)), beat(A, at(9, gap + 1))]), []);
});

test("the idle gap can be changed", () => {
  const beats = [beat(A, at(9, 0)), beat(A, at(9, 20))];
  assert.deepEqual(dailyTotals(beats), []);
  assert.equal(dailyTotals(beats, 30 * MIN)[0].ms, 20 * MIN);
});

test("a lone heartbeat is no time at all", () => {
  assert.deepEqual(dailyTotals([beat(A, at(9))]), []);
  assert.deepEqual(dailyTotals([]), []);
});

test("two projects worked at once are each counted in full", () => {
  const totals = dailyTotals([
    beat(A, at(14, 0)), beat(B, at(14, 1)), beat(A, at(14, 10)), beat(B, at(14, 11)),
  ]);
  assert.deepEqual(totals, [
    { day: "2026-10-08", project: A, ms: 10 * MIN },
    { day: "2026-10-08", project: B, ms: 10 * MIN },
  ]);
});

test("two sessions in one project count once, and order of arrival doesn't matter", () => {
  // Session 1 beats at :00 :10, session 2 at :05 :12 — 12 minutes of work, not 17.
  const totals = dailyTotals([beat(A, at(9, 10)), beat(A, at(9, 5)), beat(A, at(9, 0)), beat(A, at(9, 12))]);
  assert.equal(totals[0].ms, 12 * MIN);
});

test("duplicate heartbeats add nothing", () => {
  assert.equal(dailyTotals([beat(A, at(9)), beat(A, at(9)), beat(A, at(9, 4))])[0].ms, 4 * MIN);
});

test("a stretch across midnight is split between the two days", () => {
  const totals = dailyTotals([beat(A, at(23, 50)), beat(A, at(0, 5, 9))]);
  assert.deepEqual(totals, [
    { day: "2026-10-08", project: A, ms: 10 * MIN },
    { day: "2026-10-09", project: A, ms: 5 * MIN },
  ]);
});

test("totals come sorted by day, then project", () => {
  const totals = dailyTotals([
    beat(B, at(9, 0, 9)), beat(B, at(9, 5, 9)),
    beat(B, at(9, 0)), beat(B, at(9, 5)),
    beat(A, at(9, 0)), beat(A, at(9, 5)),
  ]);
  assert.deepEqual(totals.map((t) => [t.day, t.project]), [
    ["2026-10-08", A], ["2026-10-08", B], ["2026-10-09", B],
  ]);
});

test("the log is read line by line, skipping what doesn't parse", () => {
  const jsonl = [
    JSON.stringify({ t: 1, project: A, agent: "claude" }),
    "",
    "not json",
    JSON.stringify({ t: "2", project: A }), // t must be a number
    JSON.stringify({ t: 3, project: "" }), // no project
    JSON.stringify({ t: 4, project: B }),
    '{"t": 5, "proj', // half written when the app was killed
  ].join("\n");
  assert.deepEqual(parseBeats(jsonl), [
    { t: 1, project: A, agent: "claude" },
    { t: 4, project: B, agent: undefined },
  ]);
});

test("the week grid covers the seven days ending today, busiest project first", () => {
  const totals = [
    { day: "2026-10-01", project: A, ms: 99 * MIN }, // eight days back: left out
    { day: "2026-10-02", project: A, ms: 10 * MIN },
    { day: "2026-10-08", project: A, ms: 20 * MIN },
    { day: "2026-10-08", project: B, ms: 60 * MIN },
  ];
  const { days, rows } = weekGrid(totals, new Date(2026, 9, 8, 15));
  assert.deepEqual(days, [
    "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08",
  ]);
  assert.deepEqual(rows.map((r) => [r.project, r.total]), [[B, 60 * MIN], [A, 30 * MIN]]);
  assert.deepEqual(rows[1].perDay, [10 * MIN, 0, 0, 0, 0, 0, 20 * MIN]);
});

test("the CSV bills hours at each project's rate, and leaves unbilled ones blank", () => {
  const csv = toCsv(
    [{ day: "2026-10-08", project: A, ms: 90 * MIN }, { day: "2026-10-08", project: B, ms: 30 * MIN }],
    { [A]: { client: "Acme, Inc.", rate: 80 } },
    "EUR",
  );
  assert.deepEqual(csv.split("\r\n"), [
    "date,project,folder,client,hours,rate,currency,amount",
    `2026-10-08,acme-site,${A},"Acme, Inc.",1.50,80.00,EUR,120.00`,
    `2026-10-08,trade-vault,${B},,0.50,,,`,
    "",
  ]);
});

test("a client name can't smuggle a formula into the spreadsheet", () => {
  const csv = toCsv([{ day: "2026-10-08", project: A, ms: 60 * MIN }], { [A]: { client: '=HYPERLINK("x")', rate: 0 } }, "USD");
  assert.match(csv, /,"'=HYPERLINK\(""x""\)",/);
});
