import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseDecision } from "./decision-parser.ts";

Deno.test("parses the official BOAT RACE DB payload shape", () => {
  const result = parseDecision({
    race: { kimarite: "逃げ" },
    entries: [
      { rank: 1, regno: 4320, course: 1 },
      { rank: 2, regno: 3897, course: 4 },
    ],
  });
  assertEquals(result, {
    method: "逃げ",
    registration: "4320",
    course: 1,
    status: "parsed",
  });
});

Deno.test("finds the winner even when the method is only at race level", () => {
  const result = parseDecision({
    race: { decision_method: "差し" },
    entries: [{ finish_rank: 1, racer_registration_no: "4567", actual_course: 3 }],
  });
  assertEquals(result.method, "差し");
  assertEquals(result.registration, "4567");
  assertEquals(result.course, 3);
  assertEquals(result.status, "parsed");
});

Deno.test("returns method_only when winner information is absent", () => {
  assertEquals(parseDecision({ race: { kimarite: "まくり" }, entries: [] }), {
    method: "まくり",
    registration: null,
    course: null,
    status: "method_only",
  });
});

Deno.test("does not invent a method or winner", () => {
  assertEquals(parseDecision({ race: {}, entries: [{ rank: 2, regno: 1234, course: 2 }] }), {
    method: null,
    registration: null,
    course: null,
    status: "unparsed",
  });
});

Deno.test("rejects invalid course values but keeps the winner", () => {
  const result = parseDecision({
    race: { kimarite: "抜き" },
    entries: [{ rank: 1, regno: 9999, course: 8 }],
  });
  assertEquals(result.course, null);
  assertEquals(result.registration, "9999");
  assertEquals(result.status, "parsed");
});
