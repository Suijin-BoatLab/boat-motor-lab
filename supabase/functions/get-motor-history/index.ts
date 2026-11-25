import { createClient } from "npm:@supabase/supabase-js@2";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const venueNames: Record<string,string> = {
  "1":"桐生","2":"戸田","3":"江戸川","4":"平和島","5":"多摩川","6":"浜名湖","7":"蒲郡","8":"常滑","9":"津","10":"三国","11":"びわこ","12":"住之江","13":"尼崎","14":"鳴門","15":"丸亀","16":"児島","17":"宮島","18":"徳山","19":"下関","20":"若松","21":"芦屋","22":"福岡","23":"唐津","24":"大村"
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
    const from = String(body?.from ?? ""), to = String(body?.to ?? ""), venue = String(body?.venue ?? ""), motorFilter = String(body?.motor ?? "").trim();
    const validDate = (d:string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d+"T00:00:00Z")) && new Date(d+"T00:00:00Z").toISOString().slice(0,10) === d;
    if (!validDate(from) || !validDate(to) || from > to) return json({ error: "期間の指定が正しくありません" }, 400);
    const days = Math.floor((Date.parse(to+"T00:00:00Z")-Date.parse(from+"T00:00:00Z"))/86400000)+1;
    if (days > 185) return json({ error: "一度に検索できる期間は185日までです" }, 400);
    if (!venue && days > 31) return json({ error: "全競艇場を選択した場合は31日以内にしてください。6か月を表示する場合は競艇場を選択してください。" }, 400);
    const { data: rows, error } = await supabase.from("historical_motor_daily").select("race_date,motor_data").eq("user_id",auth.user.id).gte("race_date",from).lte("race_date",to).order("race_date",{ascending:true});
    if (error) return json({ error: "履歴の読み込みに失敗しました: "+error.message }, 500);
    const out:any[] = [];
    for (const row of rows ?? []) {
      const data = row.motor_data ?? {};
      if (data.venues && typeof data.venues === "object") {
        for (const [code, motors] of Object.entries(data.venues) as [string,any[]][]) {
          const name = venueNames[code] ?? ("場コード"+code);
          if (venue && name !== venue) continue;
          for (const m of motors ?? []) {
            const motor = String(m.motor_number ?? "");
            if (!motor || (motorFilter && motor !== motorFilter)) continue;
            out.push({ date: row.race_date, venue: name, motor, count: Number(m.entries)||0, ex: m.avg_exhibition ?? null, lap: m.avg_lap ?? null, straight: m.avg_straight ?? null, turn: m.avg_turn ?? null, st: m.avg_exhibition_st ?? null, f: Number(m.exhibition_f_count)||0, wins: Number(m.first_places)||0, source:"日別公開データ" });
          }
        }
      } else {
        for (const [key,m] of Object.entries(data) as [string,any][]) {
          const sep = key.lastIndexOf("::");
          if (sep < 1) continue;
          const name = String(m.venue ?? key.slice(0,sep));
          if (venue && name !== venue) continue;
          const motor = String(m.motor ?? key.slice(sep+2));
          if (motorFilter && motor !== motorFilter) continue;
          out.push({ date: row.race_date, venue: name, motor, count: Number(m.count)||0, ex: m.exAvg ?? null, lap:null, straight:null, turn:null, st:m.stAvg ?? null, f:Number(m.fCount)||0, wins:Number(m.wins)||0, source:"保存済み日別集計" });
        }
      }
    }
    out.sort((a,b)=>a.date.localeCompare(b.date)||a.venue.localeCompare(b.venue,"ja")||a.motor.localeCompare(b.motor,"ja",{numeric:true}));
    return json({ rows: out, count: out.length, from, to, venue: venue || "全24場" });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "処理エラー" }, 500);
  }
});