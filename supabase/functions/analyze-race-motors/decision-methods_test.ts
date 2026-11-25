import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildDecisionMethodStats } from "./decision-methods.ts";

Deno.test("prefers imported race record and ignores payout duplicate", () => {
  const stats = buildDecisionMethodStats(
    [{ race_date: "2026-11-20", venue_code: 11, race_no: 1, racer_registration_no: "1234", decision_method: "逃げ", actual_course: 1 }],
    [{ race_date: "2026-11-20", venue_code: 11, race_no: 1, winning_racer_registration_no: "1234", decision_method: "差し", winning_course: 2 }],
    ["1234"],
  );
  assertEquals(stats.get("1234")?.wins, 1);
  assertEquals(stats.get("1234")?.by_method, { "逃げ": 1 });
  assertEquals(stats.get("1234")?.by_course["1"]?.wins, 1);
  assertEquals(stats.get("1234")?.by_course["2"], undefined);
});

Deno.test("counts different races for the same racer and keeps course breakdown", () => {
  const stats = buildDecisionMethodStats(
    [
      { race_date: "2026-11-20", venue_code: 11, race_no: 1, racer_registration_no: "1234", decision_method: "逃げ", actual_course: 1 },
    ],
    [
      { race_date: "2026-11-21", venue_code: 11, race_no: 2, winning_racer_registration_no: "1234", decision_method: "まくり", winning_course: 3 },
    ],
    ["1234"],
  );
  const value = stats.get("1234");
  assertEquals(value?.wins, 2);
  assertEquals(value?.by_method, { "逃げ": 1, "まくり": 1 });
  assertEquals(value?.method_rate, { "逃げ": 0.5, "まくり": 0.5 });
  assertEquals(value?.by_course["3"]?.method_rate, { "まくり": 1 });
});

Deno.test("ignores unrequested racers, missing methods, and invalid registration numbers", () => {
  const stats = buildDecisionMethodStats(
    [
      { race_date: "2026-11-20", venue_code: 11, race_no: 1, racer_registration_no: "9999", decision_method: "逃げ", actual_course: 1 },
      { race_date: "2026-11-20", venue_code: 11, race_no: 2, racer_registration_no: "1234", decision_method: null, actual_course: 1 },
      { race_date: "2026-11-20", venue_code: 11, race_no: 3, racer_registration_no: "", decision_method: "差し", actual_course: 2 },
    ],
    [],
    ["1234"],
  );
  assertEquals(stats.size, 0);
});

Deno.test("blank imported method does not block valid payout fallback", () => {
  const stats = buildDecisionMethodStats(
    [
      { race_date: "2026-11-20", venue_code: 11, race_no: 1, racer_registration_no: "1234", decision_method: "   ", actual_course: 1 },
    { race_date: "2026-11-20", venue_code: 11, race_no: 2, racer_registration_no: "1234", decision_method: null, actual_course: 1 },
  ],
    [
      { race_date: "2026-11-20", venue_code: 11, race_no: 1, winning_racer_registration_no: "1234", decision_method: "差し", winning_course: 2 },
      { race_date: "2026-11-20", venue_code: 11, race_no: 2, winning_racer_registration_no: "1234", decision_method: "まくり", winning_course: 3 },
    ],
    ["1234"],
  );
  const value = stats.get("1234");
  assertEquals(value?.wins, 2);
  assertEquals(value?.by_method, { "差し": 1, "まくり": 1 });
  assertEquals(value?.by_course["2"]?.wins, 1);
  assertEquals(value?.by_course["3"]?.wins, 1);
});
