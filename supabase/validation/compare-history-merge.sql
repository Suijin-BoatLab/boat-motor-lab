-- Read-only diagnostic: field-level projection of racer facts onto motor rows.
-- SELECT only. This file intentionally contains no DDL or data mutation.
-- Join identity: user_id + race_date + venue_code + race_no + lane.
-- Primary motor-row values win. A primary F-marked ST is preserved and never
-- overwritten by an imported numeric ST. Imported F-marked ST is never used.

with joined as (
  select
    m.user_id, m.race_date, m.venue_code, m.race_no, m.lane,
    m.racer_registration_no as motor_reg,
    r.racer_registration_no as racer_reg,
    m.actual_course as motor_course, r.actual_course as racer_course,
    m.finish_rank as motor_rank, r.finish_rank as racer_rank,
    m.actual_st as motor_st, m.actual_st_is_f as motor_st_is_f,
    r.actual_st as racer_st, r.actual_st_is_f as racer_st_is_f,
    m.source_name as motor_source, r.source_name as racer_source,
    m.imported_at as motor_imported_at, r.imported_at as racer_imported_at,
    m.exhibition_time, m.lap_time, m.straight_time, m.turn_time,
    m.exhibition_st, m.exhibition_st_is_f
  from public.historical_motor_entries m
  left join public.historical_racer_entries r
    on r.user_id = m.user_id
   and r.race_date = m.race_date
   and r.venue_code = m.venue_code
   and r.race_no = m.race_no
   and r.lane = m.lane
),
summary as (
  select
    count(*) as motor_rows,
    count(*) filter (where racer_reg is not null) as matched_racer_rows,
    count(*) filter (where racer_reg is null) as unmatched_motor_rows,
    count(*) filter (where motor_course is not null) as course_before,
    count(*) filter (where motor_course is null and racer_course is not null) as course_fill_candidates,
    count(*) filter (where coalesce(motor_course, racer_course) is not null) as course_after,
    count(*) filter (where motor_rank is not null) as rank_before,
    count(*) filter (where motor_rank is null and racer_rank is not null) as rank_fill_candidates,
    count(*) filter (where coalesce(motor_rank, racer_rank) is not null) as rank_after,
    count(*) filter (where motor_st is not null) as st_numeric_before,
    count(*) filter (where motor_st is null and not coalesce(racer_st_is_f, true) and racer_st between 0 and 0.99) as st_fill_candidates,
    count(*) filter (where motor_st_is_f) as primary_f_rows_preserved,
    count(*) filter (where motor_st is null and racer_st is not null and coalesce(racer_st_is_f, false)) as imported_f_values_rejected,
    count(*) filter (where motor_course is not null and racer_course is not null and motor_course <> racer_course) as course_conflicts,
    count(*) filter (where motor_rank is not null and racer_rank is not null and motor_rank <> racer_rank) as rank_conflicts,
    count(*) filter (where motor_st is not null and racer_st is not null and motor_st <> racer_st) as st_value_conflicts,
    count(*) filter (where motor_source is null or motor_imported_at is null) as motor_missing_provenance,
    count(*) filter (where racer_reg is not null and (racer_source is null or racer_imported_at is null)) as racer_missing_provenance,
    count(*) filter (where exhibition_time is not null) as exhibition_time_rows,
    count(*) filter (where lap_time is not null) as lap_time_rows,
    count(*) filter (where straight_time is not null) as straight_time_rows,
    count(*) filter (where turn_time is not null) as turn_time_rows,
    count(*) filter (where exhibition_st is not null) as exhibition_st_rows
  from joined
),
racer_orphans as (
  select count(*) as racer_rows_without_motor_match
  from public.historical_racer_entries r
  where not exists (
    select 1 from public.historical_motor_entries m
    where m.user_id = r.user_id
      and m.race_date = r.race_date
      and m.venue_code = r.venue_code
      and m.race_no = r.race_no
      and m.lane = r.lane
  )
)
select summary.*, racer_orphans.racer_rows_without_motor_match
from summary cross join racer_orphans;
