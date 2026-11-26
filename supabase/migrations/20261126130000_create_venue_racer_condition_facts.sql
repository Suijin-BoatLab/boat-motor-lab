create or replace view public.venue_racer_condition_facts
with (security_invoker = true)
as
select
  f.race_id,f.user_id,f.race_date,f.venue_code,f.venue_name,f.race_no,
  f.wind_direction,f.wind_speed,f.wave_height,f.water_temperature,f.tide_condition,
  f.course,f.finish_rank,f.is_winner,f.decision_method,
  e.lane,e.racer_name,e.racer_registration_no,e.racer_class,e.racer_win_rate,
  e.racer_place_rate,e.actual_st,e.actual_st_is_f,e.exhibition_st,e.exhibition_st_is_f,
  case when f.wind_speed is null then null when f.wind_speed < 2 then '0〜1m' when f.wind_speed < 4 then '2〜3m' else '4m以上' end as wind_speed_band,
  case when f.wave_height is null then null when f.wave_height <= 2 then '0〜2cm' when f.wave_height <= 5 then '3〜5cm' else '6cm以上' end as wave_height_band,
  case when f.water_temperature is null then null when f.water_temperature < 15 then '15℃未満' when f.water_temperature < 20 then '15〜19.9℃' when f.water_temperature < 25 then '20〜24.9℃' else '25℃以上' end as water_temperature_band
from public.venue_water_condition_facts f
join public.race_entries e
  on e.race_id=f.race_id and e.user_id=f.user_id and e.lane=f.lane
where nullif(regexp_replace(coalesce(e.racer_registration_no,''),'\\D','','g'),'') is not null;

grant select on public.venue_racer_condition_facts to authenticated;
