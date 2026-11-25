// Pure merge helper for validating racer-start facts from the two history sources.
// This is intentionally not wired into the live Edge Function yet.
export type RacerStartHistoryRow = {
  user_id?: string | null;
  race_date: string;
  venue_code: number | string;
  race_no: number | string;
  lane: number | string;
  racer_registration_no: string | number;
  actual_course?: number | string | null;
  finish_rank?: number | string | null;
  actual_st?: number | string | null;
  actual_st_is_f?: boolean | null;
};

function keyOf(row: RacerStartHistoryRow): string {
  return [
    row.user_id ?? "",
    row.race_date,
    row.venue_code,
    row.race_no,
    row.lane,
    String(row.racer_registration_no).trim(),
  ].join(":");
}

function validCourse(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null;
}

function validRank(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null;
}

function validSt(row: RacerStartHistoryRow): number | null {
  if (row.actual_st_is_f) return null;
  if (row.actual_st === null || row.actual_st === undefined || row.actual_st === "") return null;
  const n = Number(row.actual_st);
  return Number.isFinite(n) && n >= 0 && n <= 0.99 ? n : null;
}

/**
 * Keep all unique start facts. Primary motor-history values win field by field;
 * racer-history fills missing course/rank/ST. F-marked ST is never a numeric fallback.
 * A primary F marker is preserved and cannot be replaced by a fallback numeric ST.
 */
export function mergeRacerStartHistory(
  primaryRows: RacerStartHistoryRow[],
  fallbackRows: RacerStartHistoryRow[],
): RacerStartHistoryRow[] {
  const merged = new Map<string, RacerStartHistoryRow>();
  for (const row of primaryRows) merged.set(keyOf(row), { ...row });

  for (const fallback of fallbackRows) {
    const key = keyOf(fallback);
    const primary = merged.get(key);
    if (!primary) {
      merged.set(key, { ...fallback });
      continue;
    }

    const course = validCourse(primary.actual_course) ?? validCourse(fallback.actual_course);
    const rank = validRank(primary.finish_rank) ?? validRank(fallback.finish_rank);
    const primarySt = validSt(primary);
    const fallbackSt = validSt(fallback);
    const primaryF = primary.actual_st_is_f === true;
    const fallbackF = fallback.actual_st_is_f === true;

    merged.set(key, {
      ...primary,
      actual_course: course,
      finish_rank: rank,
      actual_st: primarySt ?? (primaryF || fallbackF ? null : fallbackSt),
      actual_st_is_f: primarySt !== null
        ? false
        : primaryF || fallbackF,
    });
  }

  return [...merged.values()].sort((a, b) =>
    b.race_date.localeCompare(a.race_date) ||
    Number(b.race_no) - Number(a.race_no) ||
    Number(a.lane) - Number(b.lane)
  );
}
