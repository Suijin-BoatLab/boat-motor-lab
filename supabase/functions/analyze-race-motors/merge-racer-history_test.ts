import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mergeRacerStartHistory, type RacerStartHistoryRow } from "./merge-racer-history.ts";

const base = (overrides: Partial<RacerStartHistoryRow> = {}): RacerStartHistoryRow => ({
  user_id: "user-1",
  race_date: "2026-11-25",
  venue_code: 11,
  race_no: 1,
  lane: 2,
  racer_registration_no: "4700",
  actual_course: null,
  finish_rank: null,
  actual_st: null,
  actual_st_is_f: false,
  ...overrides,
});

Deno.test("fallback fills missing course, rank, and numeric ST", () => {
  const rows = mergeRacerStartHistory(
    [base()],
    [base({ actual_course: 2, finish_rank: 1, actual_st: 0.15 })],
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0].actual_course, 2);
  assertEquals(rows[0].finish_rank, 1);
  assertEquals(rows[0].actual_st, 0.15);
  assertEquals(rows[0].actual_st_is_f, false);
});

Deno.test("primary non-null fields win independently", () => {
  const rows = mergeRacerStartHistory(
    [base({ actual_course: 1, finish_rank: 3, actual_st: 0.12 })],
    [base({ actual_course: 2, finish_rank: 1, actual_st: 0.15 })],
  );
  assertEquals(rows[0].actual_course, 1);
  assertEquals(rows[0].finish_rank, 3);
  assertEquals(rows[0].actual_st, 0.12);
});

Deno.test("primary F marker blocks numeric fallback ST", () => {
  const rows = mergeRacerStartHistory(
    [base({ actual_st: null, actual_st_is_f: true })],
    [base({ actual_st: 0.15, actual_st_is_f: false })],
  );
  assertEquals(rows[0].actual_st, null);
  assertEquals(rows[0].actual_st_is_f, true);
});

Deno.test("fallback F ST is not used as a numeric value", () => {
  const rows = mergeRacerStartHistory(
    [base()],
    [base({ actual_st: null, actual_st_is_f: true })],
  );
  assertEquals(rows[0].actual_st, null);
  assertEquals(rows[0].actual_st_is_f, true);
});

Deno.test("F and invalid ST values are excluded while course and rank can still fill", () => {
  const rows = mergeRacerStartHistory(
    [base({ actual_st: -1, actual_st_is_f: false })],
    [base({ actual_course: 2, finish_rank: 1, actual_st: 1.02, actual_st_is_f: false })],
  );
  assertEquals(rows[0].actual_course, 2);
  assertEquals(rows[0].finish_rank, 1);
  assertEquals(rows[0].actual_st, null);
});

Deno.test("racer-only rows are retained and duplicate keys are merged once", () => {
  const rows = mergeRacerStartHistory(
    [base({ lane: 1, actual_course: 1, finish_rank: 2 })],
    [
      base({ lane: 1, actual_st: 0.11 }),
      base({ lane: 3, actual_course: 3, finish_rank: 1, actual_st: 0.14 }),
    ],
  );
  assertEquals(rows.length, 2);
  assertEquals(rows.find((row) => row.lane === 1)?.actual_st, 0.11);
  assertEquals(rows.find((row) => row.lane === 3)?.finish_rank, 1);
});

Deno.test("different lanes and racers are never collapsed into one start", () => {
  const rows = mergeRacerStartHistory(
    [base({ lane: 1 }), base({ lane: 2, racer_registration_no: "1234" })],
    [],
  );
  assertEquals(rows.length, 2);
});
