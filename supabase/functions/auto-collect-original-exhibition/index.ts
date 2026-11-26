import postgres from "npm:postgres@3.4.5";

type Row = string[];
const VENUES: Record<number,string> = {1:"桐生",2:"戸田",3:"江戸川",4:"平和島",5:"多摩川",6:"浜名湖",7:"蒲郡",8:"常滑",9:"津",10:"三国",11:"びわこ",12:"住之江",13:"尼崎",14:"鳴門",15:"丸亀",16:"児島",17:"宮島",18:"徳山",19:"下関",20:"若松",21:"芦屋",22:"福岡",23:"唐津",24:"大村"};
const headers = {"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"content-type,x-cron-token","Access-Control-Allow-Methods":"POST,OPTIONS"};
const reply=(x:unknown,s=200)=>new Response(JSON.stringify(x),{status:s,headers});
function jstParts(){const p=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date());const v=(t:string)=>p.find(x=>x.type===t)?.value??"";return {date:`${v("year")}-${v("month")}-${v("day")}`,hour:Number(v("hour")),minute:Number(v("minute"))};}
function parseCsv(text:string):Row[]{const out:Row[]=[];let row:Row=[],cell="",quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}else if(c==='"')quoted=true;else if(c===","){row.push(cell);cell="";}else if(c==="\n"){row.push(cell.replace(/\r$/,""));if(row.some(x=>x!==""))out.push(row);row=[];cell="";}else cell+=c;}if(cell!==""||row.length){row.push(cell.replace(/\r$/,""));if(row.some(x=>x!==""))out.push(row);}return out;}
function n(v:string|undefined):number|null{if(!v)return null;const x=Number(v.trim());return Number.isFinite(x)&&x>0?x:null;}
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers});
 if(req.method!=="POST")return reply({error:"POST only"},405);
 const db=Deno.env.get("SUPABASE_DB_URL")??"";if(!db)return reply({error:"DB接続設定なし"},500);
 const sql=postgres(db,{max:1,idle_timeout:20,connect_timeout:10});
 try{
  const token=req.headers.get("x-cron-token")??"";
  const auth=await sql`select exists(select 1 from vault.decrypted_secrets where name='race_result_sync_cron_token' and decrypted_secret=${token}) as ok`;
  if(!auth[0]?.ok)return reply({error:"自動収集の認証に失敗しました"},401);
  const now=jstParts();
  if(now.hour<8||now.hour>23||(now.hour===23&&now.minute!==0))return reply({success:true,skipped:true,reason:"収集時間外",jst_hour:now.hour,jst_minute:now.minute});
  const owners=await sql`select user_id from public.historical_motor_entries group by user_id order by count(*) desc limit 1`;
  const owner=owners[0]?.user_id;if(!owner)return reply({error:"保存先ユーザーがありません"},500);
  const [y,m,d]=now.date.split("-");
  const url=`https://boatracecsv.github.io/data/previews/original_exhibition/${y}/${m}/${d}.csv`;
  const response=await fetch(url,{headers:{Accept:"text/csv,text/plain,*/*"},signal:AbortSignal.timeout(15000)});
  if(response.status===404)return reply({success:true,date:now.date,status:"not_published",saved_races:0});
  if(!response.ok)throw new Error("BoatraceCSV HTTP "+response.status);
  const parsed=parseCsv((await response.text()).replace(/^\uFEFF/,""));
  if(parsed.length<2)return reply({success:true,date:now.date,status:"empty",saved_races:0});
  const savedRaces=new Set<string>(),summary:{race:string,updated:number,metrics:string[]}[]=[];
  const labels:Record<string,string>={"一周":"lap_time","半周ラップ":"half_lap_time","まわり足":"turn_time","回り足":"turn_time","直線":"straight_time"};
  for(const row of parsed.slice(1)){
   const date=row[1]??"",venue=Number(row[2]),raceNo=Number((row[3]??"").replace(/R/i,""));
   if(date!==now.date||!venue||!raceNo||venue===3)continue;
   const count=Number(row[6]??0),metricLabels=[row[7],row[8],row[9]].slice(0,count).map(x=>String(x??"").trim());
   const metricKeys=metricLabels.map(x=>labels[x]??null);
   if(!metricKeys.some(Boolean))continue;
   let updated=0;
   for(let lane=1;lane<=6;lane++){
    const base=10+(lane-1)*4;
    const vals:Record<string,number|null>={};
    for(let i=0;i<3;i++){const key=metricKeys[i];if(key)vals[key]=n(row[base+1+i]);}
    if(!Object.values(vals).some(x=>x!==null))continue;
    const result=await sql`update public.historical_motor_entries set
      lap_time=coalesce(${vals.lap_time??null},lap_time),
      half_lap_time=coalesce(${vals.half_lap_time??null},half_lap_time),
      turn_time=coalesce(${vals.turn_time??null},turn_time),
      straight_time=coalesce(${vals.straight_time??null},straight_time),
      source_name='boatraceopenapi-v1+boatracecsv-original-exhibition',
      source_data=coalesce(source_data,'{}'::jsonb)||${sql.json({original_exhibition_source:"BoatraceCSV",original_exhibition_collected_at:row[5]??null,original_exhibition_metrics:metricLabels})}
     where user_id=${owner} and race_date=${date} and venue_code=${venue} and race_no=${raceNo} and lane=${lane}
     returning id`;
    if(result.length)updated++;
   }
   const key=`${venue}-${raceNo}`;
   const metrics=metricKeys.filter(Boolean) as string[];
   const status=updated>0?"saved":"error";
   await sql`insert into public.original_exhibition_collection_checks(user_id,race_date,venue_code,race_no,status,lap_found,half_lap_found,turn_found,straight_found,saved_boats,detail,checked_at)
    values(${owner},${date},${venue},${raceNo},${status},${metrics.includes("lap_time")},${metrics.includes("half_lap_time")},${metrics.includes("turn_time")},${metrics.includes("straight_time")},${updated},${status==="error"?"出走表データに対応する艇データなし":null},now())
    on conflict(user_id,race_date,venue_code,race_no) do update set status=excluded.status,lap_found=original_exhibition_collection_checks.lap_found or excluded.lap_found,half_lap_found=original_exhibition_collection_checks.half_lap_found or excluded.half_lap_found,turn_found=original_exhibition_collection_checks.turn_found or excluded.turn_found,straight_found=original_exhibition_collection_checks.straight_found or excluded.straight_found,saved_boats=greatest(original_exhibition_collection_checks.saved_boats,excluded.saved_boats),detail=excluded.detail,checked_at=now()`;
   if(updated>0){savedRaces.add(key);summary.push({race:key,updated,metrics});}
  }
  return reply({success:true,date:now.date,source:"BoatraceCSV",csv_rows:parsed.length-1,saved_races:savedRaces.size,summary});
 }catch(e){return reply({error:e instanceof Error?e.message:"自動収集エラー"},500);}
 finally{await sql.end({timeout:5});}
});