alter table public.historical_motor_entries
  add column if not exists half_lap_time numeric;

update public.historical_motor_entries
set half_lap_time = nullif(source_data->>'half_lap_time', '')::numeric
where half_lap_time is null
  and source_data ? 'half_lap_time'
  and (source_data->>'half_lap_time') ~ '^[0-9]+(\\.[0-9]+)?$';
