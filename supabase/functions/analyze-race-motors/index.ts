import { createClient } from "npm:@supabase/supabase-js@2";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const names:Record<string,string>={"1":"桐生","2":"戸田","3":"江戸川","4":"平和島","5":"多摩川","6":"浜名湖","7":"蒲郡","8":"常滑","9":"津","10":"三国","11":"びわこ","12":"住之江","13":"尼崎","14":"鳴門","15":"丸亀","16":"児島","17":"宮島","18":"徳山","19":"下関","20":"若松","21":"芦屋","22":"福岡","23":"唐津","24":"大村"};
const num=(v:any)=>{if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null};
const st=(v:any)=>{const raw=v==null?"":String(v).trim();if(!raw)return {raw:null,value:null,isF:false};if(/^F/i.test(raw))return {raw,value:null,isF:true};const value=num(raw);if(value!==null&&value<0)return {raw,value:null,isF:true};return {raw,value,isF:false};};
const avg=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
const metrics=["exhibition_time","lap_time","straight_time","turn_time","exhibition_st"];
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
 try{
  if(req.method!=="POST")return json({error:"POST only"},405);
  const authHeader=req.headers.get("Authorization")??"",token=authHeader.replace(/^Bearer\s+/i,"");
  if(!token||token===authHeader)return json({error:"ログインが必要です"},401);
  const supabase=createClient(Deno.env.get("SUPABASE_URL")??"",Deno.env.get("SUPABASE_ANON_KEY")??Deno.env.get("SUPABASE_PUBLISHABLE_KEY")??"",{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}});
  const {data:auth,error:authError}=await supabase.auth.getUser(token);
  if(authError||!auth.user)return json({error:"認証を確認できません"},401);
  const body=await req.json(),date=String(body?.date??""),venueCode=Number(body?.venue_code),raceNo=Number(body?.race_no);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isInteger(venueCode)||venueCode<1||venueCode>24||!Number.isInteger(raceNo)||raceNo<1||raceNo>12)return json({error:"日付・競艇場・レース番号を確認してください"},400);
  const compact=date.replaceAll("-",""),url=`https://boatraceopenapi.github.io/api/v1/${date.slice(0,4)}/${compact}.json`;
  const upstream=await fetch(url,{headers:{Accept:"application/json"}});
  if(upstream.status===404)return json({error:"指定日の出走データはまだ公開されていないか、開催がありません"},404);
  if(!upstream.ok)return json({error:"出走データ取得失敗 HTTP "+upstream.status},502);
  const payload=await upstream.json(),stadium=payload?.programs?.stadiums?.[String(venueCode)],race=stadium?.races?.[String(raceNo)];
  if(!race)return json({error:"指定レースの出走データが見つかりません"},404);
  const racers=race.racers??{},preview=race.preview?.racers??{},results=race.result?.racers??{};
  const boats=[];
  for(let lane=1;lane<=6;lane++){
   const b=racers[String(lane)]??{},p=preview[String(lane)]??{},r=results[String(lane)]??{},motor=num(b.motor_number);
   if(!motor){boats.push({lane,available:false});continue;}
   const min180=new Date(Date.parse(date+"T00:00:00Z")-180*86400000).toISOString().slice(0,10);
   const {data:history,error}=await supabase.from("historical_motor_entries").select("race_date,exhibition_time,lap_time,straight_time,turn_time,exhibition_st,exhibition_st_is_f,finish_rank").eq("user_id",auth.user.id).eq("venue_code",venueCode).eq("motor_number",motor).lt("race_date",date).gte("race_date",min180).order("race_date",{ascending:false}).limit(500);
   if(error)return json({error:"モーター履歴取得失敗: "+error.message},500);
   const detailRows=history??[];
   const {data:daily,error:dailyError}=await supabase.from("historical_motor_daily").select("race_date,motor_data").eq("user_id",auth.user.id).lt("race_date",date).gte("race_date",min180).order("race_date",{ascending:false}).limit(185);
   if(dailyError)return json({error:"日別履歴取得失敗: "+dailyError.message},500);
   const detailDates=new Set(detailRows.map(x=>x.race_date));
   const legacyRows:any[]=[];
   for(const day of daily??[]){
    if(detailDates.has(day.race_date))continue;
    const data=day.motor_data??{};
    let found:any=null;
    const oldKey=Object.keys(data).find(k=>k===names[String(venueCode)]+"::"+motor);
    if(oldKey)found=data[oldKey];
    const venueList=data.venues?.[String(venueCode)];
    if(!found&&Array.isArray(venueList))found=venueList.find((m:any)=>Number(m.motor_number)===motor);
    if(!found)continue;
    const count=Math.max(1,Number(found.count??found.entries??1)||1);
    const fCount=Math.max(0,Number(found.fCount??found.exhibition_f_count??0)||0);
    legacyRows.push({race_date:day.race_date,exhibition_time:num(found.exAvg??found.avg_exhibition),exhibition_count:Number(found.exhibition_count??count),lap_time:num(found.avg_lap),straight_time:num(found.avg_straight),turn_time:num(found.avg_turn),exhibition_st:num(found.stAvg??found.avg_exhibition_st),exhibition_st_count:Number(found.exhibition_st_count??Math.max(0,count-fCount)),exhibition_st_is_f:false,_f_count:fCount,_first_places:Number(found.wins??found.first_places??0),_weight:count});
   }
   const rows=[...detailRows,...legacyRows].sort((a,b)=>b.race_date.localeCompare(a.race_date));
   const windows=[7,30,90,180].map(days=>{
    const minDate=new Date(Date.parse(date+"T00:00:00Z")-days*86400000).toISOString().slice(0,10);
    const sample=rows.filter(x=>x.race_date>=minDate);
    const out:any={days,count:sample.reduce((s,x)=>s+Number((x as any)._weight??1),0),days_with_data:sample.length,first_date:sample.length?sample[sample.length-1].race_date:null,last_date:sample.length?sample[0].race_date:null};
    for(const key of metrics){
     const valid=sample.filter(x=>key!=="exhibition_st"||(!x.exhibition_st_is_f&&(num(x.exhibition_st)??-1)>=0));
     const values=valid.map(x=>({v:num((x as any)[key]),w:Number((x as any)._weight??1)})).filter(x=>x.v!==null);
     const total=values.reduce((s,x)=>s+x.w,0);
     out[key]=total?values.reduce((s,x)=>s+(x.v as number)*x.w,0)/total:null;out[key+"_count"]=total;
    }
    out.exhibition_f_count=sample.reduce((s,x)=>s+Number((x as any)._f_count??(x.exhibition_st_is_f?1:0)),0);
    out.first_places=sample.reduce((s,x)=>s+Number((x as any)._first_places??(Number(x.finish_rank)===1?1:0)),0);
    return out;
   });
   const racer={name:b.racer_name??b.name??null,registration_no:b.registration_number??null,class:b.rank_number??null,branch:b.branch_number??null,national_win_rate:num(b.national_win_rate),national_place_rate:num(b.national_place_rate),local_win_rate:num(b.local_win_rate),local_place_rate:num(b.local_place_rate)};
   const current={exhibition_time:num(p.exhibition_time),lap_time:num(p.lap_time),straight_time:num(p.straight_time),turn_time:num(p.turn_time),exhibition_st:st(p.start_timing),actual_st:st(r.start_timing)};
   boats.push({lane,motor_number:motor,boat_number:num(b.boat_number),racer,motor_rates:{win:num(b.motor_win_rate),place:num(b.motor_place_rate)},current,history:windows,history_rows:rows.length,history_source:rows.length?"詳細履歴":"未蓄積"});
  }
  return json({date,venue_code:venueCode,venue_name:names[String(venueCode)],race_no:raceNo,boats,source:"boatraceopenapi-v1",generated_at:new Date().toISOString()});
 }catch(e){return json({error:e instanceof Error?e.message:"処理エラー"},500)}
});