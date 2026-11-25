# BOAT MOTOR LAB — Prospective racer/course profile validation

Status: frozen candidate specification; not production scoring.

## Purpose
Validate whether the lane-specific course-focused profile generalizes to races dated 2026-11-26 onward. This document does not authorize merging, deployment, production writes, or changing live recommendations.

## Frozen candidate weights

| Start lane | Actual-course record | Last 10 actual ST | Last 90-day actual ST | Same-venue actual ST | 90-day racer form |
|---|---:|---:|---:|---:|---:|
| 1 | 50% | 20% | 10% | 10% | 10% |
| 2–6 | 35% | 25% | 15% | 10% | 15% |

The profile is fixed for the prospective window. No venue-, class-, or outcome-specific tuning is permitted during evaluation.

## Feature definitions and minimum samples

- Actual-course record: same racer, same actual course; at least 5 completed starts. Evaluate win rate, top-two rate, and average finish using the previously documented 40% / 30% / 30% blend.
- Last-10 actual ST: most recent 10 starts before the target race; at least 5 valid non-F actual-ST observations. F starts remain in the 10-start window but their ST is excluded from the average.
- Last-90-day actual ST: valid non-F actual-ST observations in the 90 days before the target race; at least 10 observations.
- Same-venue actual ST: valid non-F actual-ST observations at the target venue in the 180 days before the target race; at least 5 observations.
- 90-day racer form: completed starts in the 90 days before the target race; at least 10 starts. Blend win rate / top-two rate / average finish at 40% / 30% / 30%.

For ST features, lower average ST is better. For finish features, higher win/top-two rates and lower average finish are better. Missing or below-threshold features are unavailable, not zero.

## No-lookahead rules

- Every feature row must have a race date strictly earlier than the target race date.
- Same-day earlier races are excluded until event ordering can be proven reliable; this conservative rule prevents leakage.
- Only completed historical results are used. Never use target-race results, post-race corrections, or later imports to calculate a prediction.
- F-marked ST values are excluded from ST averages.
- Keep motor-condition indicators separate from racer/course indicators.

## Ranking and coverage

Within each target race, rank each available feature among boats that meet that feature's minimum sample threshold. Use the exact same rank direction and tie-handling rule throughout the entire prospective window. Do not silently substitute missing features with a zero or a best/worst rank. Record per-boat feature availability and the number of usable features.

If the implementation cannot reproduce the historical backtest's feature ranking, sample thresholds, and missing-data behavior exactly, mark the race as not comparable and do not include it in the primary validation.

## Outcomes and reporting

Primary outcomes:
1. Single top-ranked boat's win rate.
2. Single top-ranked boat's top-two finish rate.
3. Two-pick shortlist hit rate, reported separately only when the app's two picks are explicitly defined and recorded before the race.

Report numerator, denominator, Wilson 95% confidence interval, and coverage. Secondary breakdowns: venue, selected boat's class, actual course, and feature-coverage band.

- Fewer than 30 selections: suppress interpretation.
- 30–99: exploratory only.
- 100 or more: more stable, but still report uncertainty.
- First formal review: at least 200 eligible races overall.
- Do not change weights or deploy based on an early small sample.

## Data availability at lock time

Checked 2026-11-26: `historical_motor_entries` had 172,824 rows through 2026-11-25; `historical_racer_entries` had 698 rows through 2026-11-25. No 2026-11-26 rows were present at that check, so prospective results were not yet available.

## Implementation gate

Before production use, add deterministic tests for:
- F exclusion from ST means while preserving race order in the last-10 window;
- exact 5 / 10 sample minimum boundaries;
- same-day exclusion and strict prior-date filtering;
- lane-1 versus lane-2–6 weight selection;
- feature-level missingness and coverage accounting;
- tie handling and ranking direction;
- no motor metrics entering the racer/course score.

This specification is a validation contract, not evidence that a production scoring implementation exists.
