import { createClient } from "npm:@supabase/supabase-js@2";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const venueNames: Record<string,string> = {
  "1":"桐生","2":"戸田","3":"江戸川","4":"平和島","5":"多摩川","6":"浜名湖",
  "7":"蒲郡","8":"常滑","9":"津","10":"三国","11":"びわこ","12":"住之江",
  "13":"尼崎","14":"鳴門","15":"丸亀","16":"児島","17":"宮島","18":"徳山",
  "19":"下関","20":"若松","21":"芦屋","22":"福岡","23":"唐津","24":"大村"
};
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  try {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token || token === authHeader) return json({ error: "ログインが必要です" }, 401);
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "", { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
    const { data: auth, error: authError } = await supabase.auth.getUser(token);
    if (authError || !auth.user) return json({ error: "認証を確認できません" }, 401);
    const body = await req.json();
    const dates = body?.dates;
    if (!Array.isArray(dates) || dates.length < 1 || dates.length > 7 || dates.some((d: unknown) => typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
      return json({ error: "日付は正しい形式で1〜7日分指定してください" }, 400);
    }
    const uniqueDates = [...new Set(dates)] as string[];
    const saved: any[] = [], skipped: any[] = [], errors: any[] = [];
    for (const date of uniqueDates) {
      try {
        const year = date.slice(0, 4), compact = date.replaceAll("-", "");
        const upstream = await fetch(`https://boatraceopenapi.github.io/api/v1/${year}/${compact}.json`, { headers: { "Accept": "application/json" } });
        if (upstream.status === 404) { skipped.push({ date, reason: "データ未公開または開催なし" }); continue; }
        if (!upstream.ok) { errors.push({ date, error: `公開データ HTTP ${upstream.status}` }); continue; }
        const payload = await upstream.json();
        const stadiums = payload?.programs?.stadiums;
        if (!stadiums || typeof stadiums !== "object") { errors.push({ date, error: "公開データの形式を確認できません" }); continue; }
        const venues: Record<string, any> = {};
        const detailRows: any[] = [];
        let racesSeen = 0, entriesSeen = 0;
        for (const [venueCode, stadium] of Object.entries(stadiums)) {
          const venueOut: Record<string, any> = {};
          for (const [raceKey, race] of Object.entries((stadium as any)?.races ?? {}) as [string, any][]) {
            racesSeen++;
            const raceNo = Number(race?.race_number ?? raceKey);
            if (!Number.isInteger(raceNo) || raceNo < 1 || raceNo > 12) continue;
            const racers = race?.racers ?? {}, previewRacers = race?.preview?.racers ?? {}, resultRacers = race?.result?.racers ?? {};
            for (let lane = 1; lane <= 6; lane++) {
              const b = racers[String(lane)] ?? {}, p = previewRacers[String(lane)] ?? {}, r = resultRacers[String(lane)] ?? {};
              const motor = Number(b.motor_number);
              if (!Number.isInteger(motor) || motor <= 0) continue;
              const key = String(motor);
              const m = venueOut[key] ??= { motor_number: motor, entries: 0, first_places: 0, exhibition_sum: 0, exhibition_count: 0, lap_sum: 0, lap_count: 0, straight_sum: 0, straight_count: 0, turn_sum: 0, turn_count: 0, exhibition_st_sum: 0, exhibition_st_count: 0, exhibition_f_count: 0 };
              m.entries++; entriesSeen++;
              const parseST = (value: unknown) => {
                const raw = value == null ? "" : String(value).trim();
                if (!raw) return { raw: null, value: null, isF: false };
                if (/^F/i.test(raw)) return { raw, value: null, isF: true };
                const n = Number(raw);
                return { raw, value: Number.isFinite(n) ? n : null, isF: false };
              };
              const exST = parseST(p.start_timing);
              const actualST = parseST(r.start_timing);
              detailRows.push({
                user_id: auth.user.id, race_date: date, venue_code: Number(venueCode),
                venue_name: venueNames[String(venueCode)] ?? String(venueCode),
                race_no: raceNo, lane, racer_name: b.racer_name ?? b.name ?? null,
                racer_registration_no: b.registration_number == null ? null : String(b.registration_number),
                racer_class: b.rank_number == null ? null : String(b.rank_number),
                motor_number: motor, boat_number: Number(b.boat_number)||null,
                exhibition_time: p.exhibition_time ?? null, lap_time: p.lap_time ?? null,
                straight_time: p.straight_time ?? null, turn_time: p.turn_time ?? null,
                exhibition_st_raw: exST.raw, exhibition_st: exST.value, exhibition_st_is_f: exST.isF,
                actual_st_raw: actualST.raw, actual_st: actualST.value, actual_st_is_f: actualST.isF,
                finish_rank: Number(r.place_number)||null, actual_course: Number(r.course_number)||null,
                source_data: { racer: b, preview: p, result: r }
              });
              if (Number(r.place_number) === 1) m.first_places++;
              const add = (value: unknown, sumKey: string, countKey: string) => {
                const n = Number(value);
                if (value !== null && value !== undefined && value !== "" && Number.isFinite(n) && n > 0) { m[sumKey] += n; m[countKey]++; }
              };
              add(p.exhibition_time, "exhibition_sum", "exhibition_count");
              add(p.lap_time, "lap_sum", "lap_count");
              add(p.straight_time, "straight_sum", "straight_count");
              add(p.turn_time, "turn_sum", "turn_count");
              if (exST.isF || (exST.value !== null && exST.value < 0)) {
                m.exhibition_f_count++;
              } else if (exST.value !== null) {
                m.exhibition_st_sum += exST.value;
                m.exhibition_st_count++;
              }
            }
          }
          venues[String(venueCode)] = Object.values(venueOut).map((m: any) => ({
            ...m,
            avg_exhibition: m.exhibition_count ? m.exhibition_sum / m.exhibition_count : null,
            avg_lap: m.lap_count ? m.lap_sum / m.lap_count : null,
            avg_straight: m.straight_count ? m.straight_sum / m.straight_count : null,
            avg_turn: m.turn_count ? m.turn_sum / m.turn_count : null,
            avg_exhibition_st: m.exhibition_st_count ? m.exhibition_st_sum / m.exhibition_st_count : null,
          }));
        }
        if (detailRows.length) {
          const { error: detailError } = await supabase.from("historical_motor_entries").upsert(detailRows, { onConflict: "user_id,race_date,venue_code,race_no,lane" });
          if (detailError) { errors.push({ date, error: "詳細履歴保存失敗: " + detailError.message }); continue; }
        }
        const { error: saveError } = await supabase.from("historical_motor_daily").upsert({ user_id: auth.user.id, race_date: date, source: "boatraceopenapi-v1", motor_data: { venues, races_seen: racesSeen, entries_seen: entriesSeen }, imported_at: new Date().toISOString() }, { onConflict: "user_id,race_date" });
        if (saveError) errors.push({ date, error: "日別集計保存失敗: " + saveError.message });
        else saved.push({ date, venues: Object.keys(venues).length, races_seen: racesSeen, entries_seen: entriesSeen, detailed_entries: detailRows.length });
      } catch (e) { errors.push({ date, error: e instanceof Error ? e.message : "取得処理エラー" }); }
    }
    return json({ saved, skipped, errors, processed: uniqueDates.length });
  } catch (error) { return json({ error: error instanceof Error ? error.message : "処理エラー" }, 500); }
});