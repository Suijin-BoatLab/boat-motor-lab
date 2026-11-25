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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

async function readAll<T>(
  queryFactory: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await queryFactory(offset, offset + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const authorization = req.headers.get("Authorization") ?? "";
    const token = authorization.replace(/^Bearer\s+/i, "");
    if (!token || token === authorization) return json({ error: "ログインが必要です" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "",
      { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } },
    );
    const { data: auth, error: authError } = await supabase.auth.getUser(token);
    if (authError || !auth.user) return json({ error: "認証を確認できません" }, 401);

    const body = await req.json();
    const date = String(body?.date ?? "");
    const venueCode = Number(body?.venue_code);
    const raceNo = Number(body?.race_no);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isInteger(venueCode) || venueCode < 1 || venueCode > 24 ||
      !Number.isInteger(raceNo) || raceNo < 1 || raceNo > 12) {
      return json({ error: "日付・競艇場・レース番号を確認してください" }, 400);
    }

    const compact = date.replaceAll("-", "");
    const upstreamUrl = `https://boatraceopenapi.github.io/api/v1/${date.slice(0, 4)}/${compact}.json`;
    const upstream = await fetch(upstreamUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (upstream.status === 404) return json({ error: "指定日の出走データはまだ公開されていないか、開催がありません" }, 404);
    if (!upstream.ok) return json({ error: `出走データ取得失敗 HTTP ${upstream.status}` }, 502);

    const payload = await upstream.json();
    const race = payload?.programs?.stadiums?.[String(venueCode)]?.races?.[String(raceNo)];
    if (!race) return json({ error: "指定レースの出走データが見つかりません" }, 404);

    const racers = race.racers ?? {};
    // Aggregate only results explicitly belonging to the selected event day.
    const eventDay = Number(race.day_number);
    const eventStart = Number.isInteger(eventDay) && eventDay >= 1 && eventDay <= 7
      ? new Date(Date.parse(date + "T00:00:00Z") - (eventDay - 1) * 86400000).toISOString().slice(0, 10)
      : null;
    const seriesByRegistration = new Map<string, { starts: number; wins: number; top2: number; top3: number; stTotal: number; stCount: number }>();
    if (eventStart) {
      for (let cursor = Date.parse(eventStart + "T00:00:00Z"); cursor <= Date.parse(date + "T00:00:00Z"); cursor += 86400000) {
        const eventDate = new Date(cursor).toISOString().slice(0, 10);
        let eventPayload: any = eventDate === date ? payload : null;
        if (eventDate !== date) {
          const eventUrl = `https://boatraceopenapi.github.io/api/v1/${eventDate.slice(0, 4)}/${eventDate.replaceAll("-", "")}.json`;
          const eventResponse = await fetch(eventUrl, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
          if (eventResponse.ok) eventPayload = await eventResponse.json();
        }
        const eventRaces = eventPayload?.programs?.stadiums?.[String(venueCode)]?.races ?? {};
        for (const eventRace of Object.values(eventRaces) as any[]) {
          if (Number(eventRace?.day_number) !== eventDay || !eventRace?.result?.racers) continue;
          for (const resultEntry of Object.values(eventRace.result.racers) as any[]) {
            const registration = String(resultEntry?.number ?? "").trim();
            const place = Number(resultEntry?.place_number);
            if (!registration || !Number.isInteger(place) || place < 1 || place > 6) continue;
            const stat = seriesByRegistration.get(registration) ?? { starts: 0, wins: 0, top2: 0, top3: 0, stTotal: 0, stCount: 0 };
            stat.starts++; if (place === 1) stat.wins++; if (place <= 2) stat.top2++; if (place <= 3) stat.top3++;
            const actualSt = Number(resultEntry?.start_timing); if (Number.isFinite(actualSt) && actualSt >= 0 && actualSt <= 0.99) { stat.stTotal += actualSt; stat.stCount++; }
            seriesByRegistration.set(registration, stat);
          }
        }
      }
    }
    const motorNumbers = [...new Set(Array.from({ length: 6 }, (_, i) => {
      const n = Number(racers[String(i + 1)]?.motor_number);
      return Number.isInteger(n) && n > 0 ? n : null;
    }).filter((n): n is number => n !== null))];
    const registrationNumbers = [...new Set(Array.from({ length: 6 }, (_, i) => {
      const raw = racers[String(i + 1)]?.number ?? racers[String(i + 1)]?.registration_number;
      const n = String(raw ?? "").trim();
      return n || null;
    }).filter((n): n is string => n !== null))];
    const fromDate = new Date(Date.parse(date + "T00:00:00Z") - 180 * 86400000).toISOString().slice(0, 10);

    const [motorHistory, racerHistory] = await Promise.all([
      motorNumbers.length ? readAll((from, to) =>
        supabase.from("historical_motor_entries")
          .select("race_date,venue_code,venue_name,race_no,lane,racer_name,racer_registration_no,motor_number,exhibition_time,lap_time,straight_time,turn_time,exhibition_st,exhibition_st_is_f,actual_st,actual_st_is_f,finish_rank,actual_course")
          .eq("user_id", auth.user.id).eq("venue_code", venueCode)
          .in("motor_number", motorNumbers).lt("race_date", date).gte("race_date", fromDate)
          .order("race_date", { ascending: false }).order("race_no", { ascending: false }).range(from, to)
      ) : Promise.resolve([]),
      registrationNumbers.length ? readAll((from, to) =>
        supabase.from("historical_racer_entries")
          .select("race_date,venue_code,venue_name,race_no,lane,racer_name,racer_registration_no,actual_course,finish_rank,actual_st,actual_st_is_f,decision_method")
          .eq("user_id", auth.user.id).in("racer_registration_no", registrationNumbers)
          .lt("race_date", date).gte("race_date", fromDate)
          .order("race_date", { ascending: false }).order("race_no", { ascending: false }).range(from, to)
      ) : Promise.resolve([]),
    ]);

    const boats = Array.from({ length: 6 }, (_, i) => {
      const lane = i + 1;
      return {
        lane,
        entry: racers[String(lane)] ?? null,
        preview: race.preview?.racers?.[String(lane)] ?? null,
        result: race.result?.racers?.[String(lane)] ?? null,
        series: (() => { const stat = seriesByRegistration.get(String(racers[String(lane)]?.number ?? "")); return stat ? { ...stat, average_st: stat.stCount ? stat.stTotal / stat.stCount : null } : null; })(),
        motor_history: motorHistory.filter((row: any) => Number(row.motor_number) === Number(racers[String(lane)]?.motor_number)),
        racer_history: racerHistory.filter((row: any) =>
          String(row.racer_registration_no) === String(racers[String(lane)]?.number ?? racers[String(lane)]?.registration_number ?? "")),
      };
    });

    return json({
      date, venue_code: venueCode, venue_name: venueNames[String(venueCode)],
      race_no: raceNo, race_status: race.result ? "result_available" : "program_available",
      event_day_number: race.day_number ?? null, event_start_date: eventStart,
      boats, sources: ["boatraceopenapi-v1", "historical_motor_entries", "historical_racer_entries"],
      history_window: { from: fromDate, to: date, days: 180 },
      read_only: true, generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "処理エラー" }, 500);
  }
});
