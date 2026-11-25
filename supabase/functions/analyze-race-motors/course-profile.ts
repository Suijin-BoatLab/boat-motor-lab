// Pure, deterministic helpers for the frozen racer/course candidate.
// Kept separate from the live Edge Function until parity with the research backtest is proven.
export const COURSE_PROFILE_VERSION = "course-focused-v1";

export const COURSE_PROFILE_WEIGHTS = {
  1: { courseRecord: 0.50, last10St: 0.20, last90dSt: 0.10, venueSt: 0.10, racerForm90d: 0.10 },
  2: { courseRecord: 0.35, last10St: 0.25, last90dSt: 0.15, venueSt: 0.10, racerForm90d: 0.15 },
} as const;

export type ProfileFeature = "courseRecord" | "last10St" | "last90dSt" | "venueSt" | "racerForm90d";

export type HistoricalStart = {
  race_date: string;
  race_no?: number | null;
  venue_code?: number | null;
  actual_st?: number | string | null;
  actual_st_is_f?: boolean | null;
};

export function validActualSt(row: HistoricalStart): number | null {
  if (row.actual_st_is_f) return null;
  if (row.actual_st === null || row.actual_st === undefined || row.actual_st === "") return null;
  const value = Number(row.actual_st);
  return Number.isFinite(value) && value >= 0 && value <= 0.99 ? value : null;
}

function beforeTarget(row: HistoricalStart, targetDate: string): boolean {
  return /^\\d{4}-\\d{2}-\\d{2}$/.test(row.race_date) && row.race_date < targetDate;
}

function newestFirst(a: HistoricalStart, b: HistoricalStart): number {
  return b.race_date.localeCompare(a.race_date) ||
    Number(b.race_no ?? 0) - Number(a.race_no ?? 0);
}

export function summarizeStartTimes(
  rows: HistoricalStart[],
  targetDate: string,
  targetVenueCode: number,
) {
  const prior = rows.filter((row) => beforeTarget(row, targetDate)).sort(newestFirst);
  const last10Races = prior.slice(0, 10);
  const mean = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const last10Values = last10Races.map(validActualSt).filter((v): v is number => v !== null);
  const last90Values = prior
    .filter((row) => row.race_date >= shiftDate(targetDate, -90))
    .map(validActualSt).filter((v): v is number => v !== null);
  const venueValues = prior
    .filter((row) => row.venue_code === targetVenueCode && row.race_date >= shiftDate(targetDate, -180))
    .map(validActualSt).filter((v): v is number => v !== null);

  return {
    last10: { average: mean(last10Values), count: last10Values.length, races: last10Races.length, eligible: last10Values.length >= 5 },
    last90d: { average: mean(last90Values), count: last90Values.length, eligible: last90Values.length >= 10 },
    venue: { average: mean(venueValues), count: venueValues.length, venue_code: targetVenueCode, eligible: venueValues.length >= 5 },
  };
}

function shiftDate(date: string, days: number): string {
  const d = new Date(date + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Inputs are already ranked feature values: lower rank is better.
// Missing features are omitted and remaining weights are renormalized.
export function calculateWeightedProfileScore(
  lane: number,
  featureRanks: Partial<Record<ProfileFeature, number>>,
) {
  const weights = lane === 1 ? COURSE_PROFILE_WEIGHTS[1] : COURSE_PROFILE_WEIGHTS[2];
  let weighted = 0;
  let availableWeight = 0;
  let featuresUsed = 0;
  for (const [key, weight] of Object.entries(weights) as [ProfileFeature, number][]) {
    const rank = featureRanks[key];
    if (typeof rank !== "number" || !Number.isFinite(rank)) continue;
    weighted += rank * weight;
    availableWeight += weight;
    featuresUsed++;
  }
  return availableWeight > 0
    ? { score: weighted / availableWeight, coverage: availableWeight, features_used: featuresUsed }
    : { score: null, coverage: 0, features_used: 0 };
}
