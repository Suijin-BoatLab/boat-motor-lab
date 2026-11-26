import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const venueNames: Record<string, string> = {
  "1":"桐生","2":"戸田","3":"江戸川","4":"平和島","5":"多摩川","6":"浜名湖",
  "7":"蒲郡","8":"常滑","9":"津","10":"三国","11":"びわこ","12":"住之江",
  "13":"尼崎","14":"鳴門","15":"丸亀","16":"児島","17":"宮島","18":"徳山",
  "19":"下関","20":"若松","21":"芦屋","22":"福岡","23":"唐津","24":"大村",
};
const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const valueNumber = Number(value);
  return Number.isFinite(valueNumber) && valueNumber > 0 ? valueNumber : null;
};
type Target = { venue_code: number; race_no: number };

async function fetchOriginal(date: string, target: Target) {
  const venue = String(target.venue_code).padStart(2, "0");
  const raceNo = String(target.race_no).padStart(2, "0");
  const compact = date.replaceAll("-", "");
  const url = `https://race.boatcast.jp/txt/${venue}/bc_oriten_${compact}_${venue}_${raceNo}.txt`;
  const response = await fetch(url, {
    headers: { Accept: "text/plain" },
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 404) return { status: "not_published" as const, boats: {} };
  if (!response.ok) throw new Error(`BOATCAST HTTP ${response.status}`);
  const raw = (await response.text()).replace(/^\uFEFF/, "");
  const rows = raw.split(/\r?\n/).map((line) => line.split("\t"));
  if (rows[0]?.[0]?.trim() !== "data=" || rows[1]?.[0]?.trim() !== "1") {
    return { status: "no_data" as const, boats: {} };
  }
  const count = Number(rows[1]?.[1]) || 0;
  const labels = rows[2] ?? [];
  const labelMap: Record<string, string> = {
    "一周": "lap_time",
    "半周ラップ": "half_lap_time",
    "まわり足": "turn_time",
    "直線": "straight_time",
  };
  const keys: Record<number, string> = {};
  for (let index = 0; index < Math.min(count, labels.length); index++) {
    const label = String(labels[index] ?? "").replace(/\s/g, "");
    if (labelMap[label]) keys[index + 2] = labelMap[label];
  }
  if (!Object.keys(keys).length) return { status: "unsupported_metrics" as const, boats: {} };
  const boats: Record<number, Record<string, number | null>> = {};
  for (let lane = 1; lane <= 6; lane++) {
    const row = rows[lane + 2] ?? [];
    const values: Record<string, number | null> = {};
    for (const [index, key] of Object.entries(keys)) {
      values[key] = numberOrNull(row[Number(index)]);
    }
    boats[lane] = values;
  }
  return { status: "ok" as const, boats };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  try {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token || token === authHeader) return json({ error: "ログインが必要です" }, 401);
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
    );
    const { data: auth, error: authError } = await supabase.auth.getUser(token);
    if (authError || !auth.user) return json({ error: "認証を確認できません" }, 401);

    const body = await req.json();
    const date = String(body?.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date) {
      return json({ error: "日付はYYYY-MM-DDで指定してください" }, 400);
    }
    const targetsInput = body?.targets;
    if (!Array.isArray(targetsInput) || targetsInput.length < 1 || targetsInput.length > 288) {
      return json({ error: "targetsは1〜288レースで指定してください" }, 400);
    }
    const targets: Target[] = [];
    for (const item of targetsInput) {
      const venue_code = Number(item?.venue_code);
      const race_no = Number(item?.race_no);
      if (!Number.isInteger(venue_code) || venue_code < 1 || venue_code > 24 ||
        !Number.isInteger(race_no) || race_no < 1 || race_no > 12) {
        return json({ error: "競艇場コードまたはレース番号が不正です" }, 400);
      }
      targets.push({ venue_code, race_no });
    }
    const uniqueTargets = [...new Map(targets.map((x) => [`${x.venue_code}:${x.race_no}`, x])).values()];
    const compact = date.replaceAll("-", "");
    const apiUrl = `https://boatraceopenapi.github.io/api/v1/${date.slice(0, 4)}/${compact}.json`;
    const apiResponse = await fetch(apiUrl, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (apiResponse.status === 404) return json({ error: "指定日の公式出走データが未公開、または開催がありません" }, 404);
    if (!apiResponse.ok) return json({ error: `公式出走データ HTTP ${apiResponse.status}` }, 502);
    const apiData = await apiResponse.json();
    const summary: Record<string, unknown>[] = [];
    let savedEntries = 0;

    let targetIndex = 0;
    const workers = Array.from({ length: Math.min(6, uniqueTargets.length) }, async () => {
      while (targetIndex < uniqueTargets.length) {
        const target = uniqueTargets[targetIndex++];
      try {
        const race = apiData?.programs?.stadiums?.[String(target.venue_code)]?.races?.[String(target.race_no)];
        if (!race) {
          summary.push({ ...target, status: "race_not_found", saved: 0 });
          continue;
        }
        // Edogawa does not publish BOATCAST original exhibition measurements.
        // Record it as venue-level unsupported and avoid repeated HTTP 403 requests.
        if (target.venue_code === 3) {
          summary.push({ ...target, status: "unsupported_metrics", saved: 0, message: "江戸川はオリジナル展示タイム非公表のため取得対象外" });
          continue;
        }
        const result = await fetchOriginal(date, target);
        if (result.status !== "ok") {
          summary.push({ ...target, status: result.status, saved: 0 });
          continue;
        }
        const racers = race.racers ?? {};
        const preview = race.preview?.racers ?? {};
        const rows = [];
        for (let lane = 1; lane <= 6; lane++) {
          const racer = racers[String(lane)] ?? {};
          const previewRacer = preview[String(lane)] ?? {};
          const original = result.boats[lane] ?? {};
          rows.push({
            user_id: auth.user.id,
            race_date: date,
            venue_code: target.venue_code,
            venue_name: venueNames[String(target.venue_code)] ?? null,
            race_no: target.race_no,
            lane,
            racer_name: racer.racer_name ?? racer.name ?? null,
            racer_registration_no: racer.number == null ? null : String(racer.number),
            racer_class: racer.rank_number == null ? null : String(racer.rank_number),
            motor_number: Number(racer.motor_number) || null,
            boat_number: Number(racer.boat_number) || null,
            exhibition_time: numberOrNull(previewRacer.exhibition_time),
            lap_time: original.lap_time ?? null,
            half_lap_time: original.half_lap_time ?? null,
            straight_time: original.straight_time ?? null,
            turn_time: original.turn_time ?? null,
            exhibition_st_raw: previewRacer.start_timing == null ? null : String(previewRacer.start_timing),
            exhibition_st: numberOrNull(previewRacer.start_timing),
            exhibition_st_is_f: String(previewRacer.start_timing ?? "").trim().toUpperCase().startsWith("F"),
            source_name: "boatraceopenapi-v1+boatcast-original-exhibition",
            source_data: { original_exhibition_source: "BOATCAST", half_lap_time: original.half_lap_time ?? null },
          });
        }
        const { data: existing, error: existingError } = await supabase.from("historical_motor_entries")
          .select("*").eq("user_id", auth.user.id).eq("race_date", date)
          .eq("venue_code", target.venue_code).eq("race_no", target.race_no);
        if (existingError) throw new Error("既存データ確認失敗: " + existingError.message);
        const byLane = new Map((existing ?? []).map((row: any) => [Number(row.lane), row]));
        const safeRows = rows.map((fresh: any) => {
          const old: any = byLane.get(Number(fresh.lane));
          if (!old) return fresh;
          const merged: any = { ...old, ...fresh };
          for (const key of Object.keys(fresh)) {
            if (fresh[key] === null || fresh[key] === undefined) merged[key] = old[key] ?? fresh[key];
          }
          merged.source_data = { ...(old.source_data ?? {}), ...(fresh.source_data ?? {}) };
          return merged;
        });
        const { error: saveError } = await supabase.from("historical_motor_entries")
          .upsert(safeRows, { onConflict: "user_id,race_date,venue_code,race_no,lane" });
        if (saveError) throw new Error("保存失敗: " + saveError.message);
        savedEntries += safeRows.length;
        summary.push({
          ...target, status: "saved", saved: safeRows.length,
          metrics: {
            lap: rows.filter((x: any) => x.lap_time != null).length,
            half_lap: rows.filter((x: any) => x.half_lap_time != null).length,
            turn: rows.filter((x: any) => x.turn_time != null).length,
            straight: rows.filter((x: any) => x.straight_time != null).length,
          },
        });
      } catch (error) {
        summary.push({ ...target, status: "error", saved: 0, message: error instanceof Error ? error.message : "取得エラー" });
      }
      }
    });
    await Promise.all(workers);
    const checkRows = summary.map((item: any) => ({
      user_id: auth.user.id,
      race_date: date,
      venue_code: item.venue_code,
      race_no: item.race_no,
      status: item.status,
      lap_found: Number(item.metrics?.lap ?? 0) > 0,
      half_lap_found: Number(item.metrics?.half_lap ?? 0) > 0,
      turn_found: Number(item.metrics?.turn ?? 0) > 0,
      straight_found: Number(item.metrics?.straight ?? 0) > 0,
      saved_boats: Number(item.saved ?? 0),
      detail: item.message ?? null,
      checked_at: new Date().toISOString(),
    }));
    const { error: checkLogError } = await supabase
      .from("original_exhibition_collection_checks")
      .upsert(checkRows, { onConflict: "user_id,race_date,venue_code,race_no" });

    return json({
      success: true, date, checked_races: uniqueTargets.length, saved_entries: savedEntries,
      summary, check_log_saved: !checkLogError,
      check_log_error: checkLogError?.message ?? null,
      source: "BOATCAST original exhibition",
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "処理エラー" }, 500);
  }
});
