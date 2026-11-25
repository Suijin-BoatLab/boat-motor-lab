export type DecisionParseResult = {
  method: string | null;
  registration: string | null;
  course: number | null;
  status: "parsed" | "method_only" | "unparsed";
};

type AnyObject = Record<string, unknown>;

function asObject(value: unknown): AnyObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as AnyObject
    : {};
}

function firstText(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(values: unknown[]): number | null {
  for (const value of values) {
    const number = Number(value);
    if (value !== null && value !== undefined && value !== "" && Number.isFinite(number)) return number;
  }
  return null;
}

function findWinner(source: unknown): AnyObject | null {
  const root = asObject(source);
  const entries = Array.isArray(root.entries) ? root.entries : [];
  const winner = entries.find((entry) => {
    const row = asObject(entry);
    return firstNumber([row.rank, row.finish_rank, row["着順"], row["着"]]) === 1;
  });
  if (winner) return asObject(winner);

  // Some source formats nest result rows. Search only for a row that explicitly
  // identifies first place; do not infer a winner from unrelated fields.
  const visit = (value: unknown): AnyObject | null => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item);
        if (found) return found;
      }
      return null;
    }
    if (value && typeof value === "object") {
      const object = value as AnyObject;
      if (firstNumber([object.rank, object.finish_rank, object["着順"], object["着"]]) === 1) return object;
      for (const child of Object.values(object)) {
        const found = visit(child);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(source);
}

export function parseDecision(source: unknown): DecisionParseResult {
  const root = asObject(source);
  const race = asObject(root.race);
  // Prefer race-level official field; only use root-level aliases as fallback.
  const method = firstText([
    race.kimarite, race.decision_method, race.kimari, race["決まり手"],
    root.decision_method, root.kimarite, root.kimari, root["決まり手"],
  ]);
  const winner = findWinner(source);

  const registration = winner
    ? winner.regno ?? winner.racer_registration_no ?? winner.registration_no ?? winner.touban ?? winner["登録番号"]
    : null;
  const registrationText = registration === null || registration === undefined || String(registration).trim() === ""
    ? null
    : String(registration).trim();

  const rawCourse = winner
    ? firstNumber([winner.course, winner.actual_course, winner.entry_course, winner["進入コース"], winner["コース"]])
    : null;
  const course = rawCourse !== null && Number.isInteger(rawCourse) && rawCourse >= 1 && rawCourse <= 6
    ? rawCourse
    : null;

  return {
    method,
    registration: registrationText,
    course,
    status: method && winner ? "parsed" : method ? "method_only" : "unparsed",
  };
}
