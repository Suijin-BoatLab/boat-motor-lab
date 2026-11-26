create or replace function public.sync_racer_master_from_source()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_row jsonb := to_jsonb(new);
  v_user uuid;
  v_reg text;
  v_name text;
  v_class text;
  v_branch text;
  v_date date;
  v_race_id uuid;
begin
  v_user := nullif(v_row->>'user_id','')::uuid;
  v_reg := regexp_replace(coalesce(v_row->>'racer_registration_no',''), '\\D', '', 'g');
  v_name := nullif(btrim(coalesce(v_row->>'racer_name','')), '');
  v_class := nullif(btrim(coalesce(v_row->>'racer_class','')), '');
  v_branch := nullif(btrim(coalesce(v_row->>'racer_branch','')), '');
  if tg_table_name = 'race_entries' then
    v_race_id := nullif(v_row->>'race_id','')::uuid;
    select rr.race_date into v_date from public.race_records rr where rr.id = v_race_id;
  else
    v_date := nullif(v_row->>'race_date','')::date;
  end if;
  if v_user is null or v_reg !~ '^[0-9]{4}$' then return new; end if;
  insert into public.racer_master(user_id,racer_registration_no,racer_name,racer_class,branch,first_seen_date,last_seen_date,source_count,updated_at)
  values(v_user,v_reg,v_name,v_class,v_branch,v_date,v_date,1,now())
  on conflict(user_id,racer_registration_no) do update set
    racer_name=coalesce(excluded.racer_name,public.racer_master.racer_name),
    racer_class=coalesce(excluded.racer_class,public.racer_master.racer_class),
    branch=coalesce(excluded.branch,public.racer_master.branch),
    first_seen_date=case when excluded.first_seen_date is null then public.racer_master.first_seen_date when public.racer_master.first_seen_date is null then excluded.first_seen_date else least(public.racer_master.first_seen_date,excluded.first_seen_date) end,
    last_seen_date=case when excluded.last_seen_date is null then public.racer_master.last_seen_date when public.racer_master.last_seen_date is null then excluded.last_seen_date else greatest(public.racer_master.last_seen_date,excluded.last_seen_date) end,
    source_count=public.racer_master.source_count+1,
    updated_at=now();
  return new;
end;
$function$;
