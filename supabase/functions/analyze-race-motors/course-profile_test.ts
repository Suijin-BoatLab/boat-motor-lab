import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateWeightedProfileScore, summarizeStartTimes, validActualSt } from "./course-profile.ts";

Deno.test("F and invalid ST values are excluded", () => {
  assertEquals(validActualSt({ race_date: "2026-11-01", actual_st: "F.03" }), null);
  assertEquals(validActualSt({ race_date: "2026-11-01", actual_st: 0.12, actual_st_is_f: true }), null);
  assertEquals(validActualSt({ race_date: "2026-11-01", actual_st: 1.02 }), null);
  assertEquals(validActualSt({ race_date: "2026-11-01", actual_st: "0.14" }), 0.14);
});

Deno.test("last ten window keeps F starts in race count but excludes their ST", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    race_date: `2026-11-${String(25 - i).padStart(2, "0")}`,
    race_no: 1,
    venue_code: 9,
    actual_st: i === 0 ? null : 0.10 + i / 100,
    actual_st_is_f: i === 0,
  }));
  const stats = summarizeStartTimes(rows, "2026-11-26", 9);
  assertEquals(stats.last10.races, 10);
  assertEquals(stats.last10.count, 9);
  assertEquals(stats.last10.eligible, true);
});

Deno.test("minimum sample thresholds are exact at 5 and 10 valid ST observations", () => {
  const five = Array.from({ length: 5 }, (_, i) => ({ race_date: `2026-11-${25-i}`, venue_code: 9, actual_st: 0.1 }));
  const nine = Array.from({ length: 9 }, (_, i) => ({ race_date: `2026-11-${25-i}`, venue_code: 9, actual_st: 0.1 }));
  const ten = Array.from({ length: 10 }, (_, i) => ({ race_date: `2026-11-${25-i}`, venue_code: 9, actual_st: 0.1 }));
  assertEquals(summarizeStartTimes(five, "2026-11-26", 9).last10.eligible, true);
  assertEquals(summarizeStartTimes(nine, "2026-11-26", 9).last90d.eligible, false);
  assertEquals(summarizeStartTimes(ten, "2026-11-26", 9).last90d.eligible, true);
  assertEquals(summarizeStartTimes(five, "2026-11-26", 9).venue.eligible, true);
});

Deno.test("target date and same-day rows are excluded", () => {
  const rows = [
    { race_date: "2026-11-25", venue_code: 9, actual_st: 0.11 },
    { race_date: "2026-11-26", venue_code: 9, actual_st: 0.01 },
  ];
  const stats = summarizeStartTimes(rows, "2026-11-26", 9);
  assertEquals(stats.last10.races, 1);
  assertEquals(stats.last10.average, 0.11);
});

Deno.test("lane-specific weights and missing-feature renormalization", () => {
  const lane1 = calculateWeightedProfileScore(1, { courseRecord: 1, last10St: 0 });
  assertAlmostEquals(lane1.score!, (0.5 * 1) / 0.7);
  assertAlmostEquals(lane1.coverage, 0.7);
  const outer = calculateWeightedProfileScore(4, { courseRecord: 1, last10St: 0 });
  assertAlmostEquals(outer.score!, (0.35 * 1) / 0.6);
});

Deno.test("no available feature returns null rather than a fabricated score", () => {
  assertEquals(calculateWeightedProfileScore(2, {}).score, null);
});
