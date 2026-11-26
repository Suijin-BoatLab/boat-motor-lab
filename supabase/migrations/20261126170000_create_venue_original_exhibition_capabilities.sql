create table if not exists public.venue_original_exhibition_capabilities (
  venue_code smallint primary key check (venue_code between 1 and 24),
  venue_name text not null unique,
  lap_status text not null default 'not_checked' check (lap_status in ('not_checked','observed','confirmed_unavailable','unsupported')),
  half_lap_status text not null default 'not_checked' check (half_lap_status in ('not_checked','observed','confirmed_unavailable','unsupported')),
  turn_status text not null default 'not_checked' check (turn_status in ('not_checked','observed','confirmed_unavailable','unsupported')),
  straight_status text not null default 'not_checked' check (straight_status in ('not_checked','observed','confirmed_unavailable','unsupported')),
  historical_status text not null default 'not_checked' check (historical_status in ('not_checked','available','limited','unavailable')),
  observed_races integer not null default 0 check (observed_races >= 0),
  last_success_date date,
  checked_at timestamptz,
  notes text,
  updated_at timestamptz not null default now()
);

insert into public.venue_original_exhibition_capabilities (venue_code, venue_name) values
(1,'桐生'),(2,'戸田'),(3,'江戸川'),(4,'平和島'),(5,'多摩川'),(6,'浜名湖'),
(7,'蒲郡'),(8,'常滑'),(9,'津'),(10,'三国'),(11,'びわこ'),(12,'住之江'),
(13,'尼崎'),(14,'鳴門'),(15,'丸亀'),(16,'児島'),(17,'宮島'),(18,'徳山'),
(19,'下関'),(20,'若松'),(21,'芦屋'),(22,'福岡'),(23,'唐津'),(24,'大村')
on conflict (venue_code) do update set venue_name=excluded.venue_name;

with observed as (
 select venue_code,
  count(distinct (race_date,race_no))::int as races,
  count(lap_time) as lap_rows,
  count(half_lap_time) as half_rows,
  count(turn_time) as turn_rows,
  count(straight_time) as straight_rows,
  max(race_date) as last_date
 from public.historical_motor_entries
 where source_name ilike '%boatcast%'
 group by venue_code
)
update public.venue_original_exhibition_capabilities c
set observed_races=o.races,
    lap_status=case when o.lap_rows>0 then 'observed' else c.lap_status end,
    half_lap_status=case when o.half_rows>0 then 'observed' else c.half_lap_status end,
    turn_status=case when o.turn_rows>0 then 'observed' else c.turn_status end,
    straight_status=case when o.straight_rows>0 then 'observed' else c.straight_status end,
    last_success_date=o.last_date,
    checked_at=now()
from observed o where c.venue_code=o.venue_code;

alter table public.venue_original_exhibition_capabilities enable row level security;
grant select on public.venue_original_exhibition_capabilities to authenticated;
create policy "Authenticated users can read venue original exhibition capabilities"
on public.venue_original_exhibition_capabilities for select to authenticated using (true);
