create or replace view public.venue_water_condition_facts
with (security_invoker = true)
as
with valid_races as (
  select
    r.id as race_id,
    r.user_id,
    r.race_date,
    r.venue_code,
    r.venue_name,
    r.race_no,
    r.wind_direction,
    r.wind_speed,
    r.wave_height,
    r.weather,
    r.air_temperature,
    r.water_temperature,
    r.water_condition,
    r.tide_condition,
    p.winning_course,
    p.decision_method,
    p.result_combination,
    p.payout_yen,
    count(e.id) as entry_count,
    count(distinct e.actual_course) as distinct_courses,
    count(distinct e.finish_rank) as distinct_ranks,
    count(*) filter (where e.finish_rank = 1) as winner_count,
    max(e.actual_course) filter (where e.finish_rank = 1) as actual_winning_course
  from public.race_records r
  join public.race_entries e
    on e.race_id = r.id and e.user_id = r.user_id
  join public.race_payout_results p
    on p.user_id = r.user_id
   and p.race_date = r.race_date
   and p.venue_code = r.venue_code
   and p.race_no = r.race_no
   and p.result_status = 'fetched'
   and p.winning_course is not null
  group by
    r.id,r.user_id,r.race_date,r.venue_code,r.venue_name,r.race_no,
    r.wind_direction,r.wind_speed,r.wave_height,r.weather,
    r.air_temperature,r.water_temperature,r.water_condition,r.tide_condition,
    p.winning_course,p.decision_method,p.result_combination,p.payout_yen
  having count(e.id) = 6
     and count(distinct e.actual_course) = 6
     and count(distinct e.finish_rank) = 6
     and count(*) filter (where e.finish_rank = 1) = 1
     and max(e.actual_course) filter (where e.finish_rank = 1) = p.winning_course
)
select
  v.race_id,v.user_id,v.race_date,v.venue_code,v.venue_name,v.race_no,
  v.wind_direction,v.wind_speed,v.wave_height,v.weather,
  v.air_temperature,v.water_temperature,v.water_condition,v.tide_condition,
  v.winning_course,v.decision_method,v.result_combination,v.payout_yen,
  e.lane,e.actual_course as course,e.finish_rank,
  (e.finish_rank = 1) as is_winner
from valid_races v
join public.race_entries e
  on e.race_id = v.race_id and e.user_id = v.user_id;

grant select on public.venue_water_condition_facts to authenticated;
