export type DecisionHistoryRow = {
  race_date: string;
  venue_code: number | string;
  race_no: number | string;
  racer_registration_no?: string | number | null;
  winning_racer_registration_no?: string | number | null;
  decision_method?: string | null;
  actual_course?: number | string | null;
  winning_course?: number | string | null;
};

export function buildDecisionMethodStats(
  importedRows: DecisionHistoryRow[],
  payoutRows: DecisionHistoryRow[],
  registrationNos: string[],
) {
  const allowed = new Set(registrationNos.map((value) => String(value).trim()));
  const stats = new Map<string, any>();
  const seenRaces = new Set<string>();

  const add = (row: DecisionHistoryRow, imported: boolean) => {
    const reg = String(imported ? row.racer_registration_no ?? "" : row.winning_racer_registration_no ?? "").trim();
    const method = String(row.decision_method ?? "").trim();
    if (!reg || !allowed.has(reg) || !method) return;
    const raceKey = [row.race_date, row.venue_code, row.race_no].join(":");
    if (seenRaces.has(raceKey)) return;
    seenRaces.add(raceKey);

    const value = stats.get(reg) ?? { wins: 0, by_method: {}, by_course: {} };
    value.wins++;
    value.by_method[method] = (value.by_method[method] ?? 0) + 1;
    const course = Number(imported ? row.actual_course : row.winning_course);
    if (Number.isInteger(course) && course >= 1 && course <= 6) {
      const key = String(course);
      value.by_course[key] ??= { wins: 0, by_method: {} };
      value.by_course[key].wins++;
      value.by_course[key].by_method[method] = (value.by_course[key].by_method[method] ?? 0) + 1;
    }
    stats.set(reg, value);
  };

  // Imported racer history is preferred; payout history fills only races absent there.
  for (const row of importedRows) add(row, true);
  for (const row of payoutRows) add(row, false);

  for (const value of stats.values()) {
    value.method_rate = Object.fromEntries(
      Object.entries(value.by_method).map(([method, count]) => [method, value.wins ? Number(count) / value.wins : null]),
    );
    for (const course of Object.values(value.by_course) as any[]) {
      course.method_rate = Object.fromEntries(
        Object.entries(course.by_method).map(([method, count]) => [method, course.wins ? Number(count) / course.wins : null]),
      );
    }
  }
  return stats;
}
