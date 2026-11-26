import postgres from "npm:postgres@3.4.5";
type Obj = Record<string, any>;
const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const labels:Record<string,string>={win:"単勝",place:"複勝",exacta:"2連単",quinella:"2連複",quinella_place:"拡連複",trifecta:"3連単",trio:"3連複"};
function jst(){const p=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hourCycle:"h23"}).formatToParts(new Date());const g=(t:string)=>p.find(x=>x.type===t)?.value??"";return{date:g("year")+"-"+g("month")+"-"+g("day"),hour:Number(g("hour"))};}
function prev(d:string){const x=new Date(d+"T00:00:00Z");x.setUTCDate(x.getUTCDate()-1);return x.toISOString().slice(0,10);}
function start(e:Obj){const raw=e.start_timing_source;if(typeof raw==="string"&&raw.trim())return raw.trim();const n=Number(e.start_timing);return Number.isFinite(n)?(n<0?"F."+Math.round(Math.abs(n)*100).toString().padStart(2,"0"):n.toFixed(2)):"—";}
function normalize(r:Obj,date:string,v:number,n:number){
 const z=r?.result;if(!z||typeof z!=="object")return null;const rr=z.racers&&typeof z.racers==="object"?z.racers as Obj:{},pairs=Object.entries(rr);
 if(!pairs.some(([_,e])=>e&&e.place_number!==null&&e.place_number!==undefined&&String(e.place_number).trim()!==""))return null;
 const entries=pairs.map(([k,e])=>{const boat=Number(e.entry_number??k),p=Number(e.place_number),rank=Number.isInteger(p)&&p>=1&&p<=6?p:null,st=Number(e.start_timing);return{rank,result_code:rank===null?(e.place_number_source??(e.place_number==null?"—":String(e.place_number))):null,boat,name:e.name??"—",course:e.course_number??"—",st:Number.isFinite(st)?st:null,st_flag:start(e),regno:e.number==null?null:String(e.number),race_time:null};}).sort((a,b)=>a.boat-b.boat);
 const payouts:Obj[]=[];const rp=z.payouts&&typeof z.payouts==="object"?z.payouts as Obj:{};
 for(const [type,items] of Object.entries(rp))if(Array.isArray(items))for(const x of items as Obj[])payouts.push({bet_type:type,bet_label:labels[type]??type,combo:x.combination??"—",amount:x.amount??null,popularity:null,label:x.label??null});
 const win=entries.find(x=>x.rank===1),tri=payouts.find(x=>x.bet_type==="trifecta"),method=z.technique_number_source??(z.technique_number==null?null:String(z.technique_number));
 const source={source:"BOAT RACE Open API（自動定期取得）",race:{date,pid:v,rno:n,name:r.title??null,remarks:z.remarks??null,refunds:z.refunds??[]},entries,payouts,raw_result:z};
 return{user_id:"",race_date:date,venue_code:v,race_no:n,source_name:'boatraceopenapi-v1-auto',source_data:source,result_status:"fetched",result_combination:typeof tri?.combo==="string"?tri.combo:null,payout_yen:tri?.amount==null?null:Math.round(Number(tri.amount)),popularity:null,decision_method:method,winning_racer_registration_no:win?.regno??null,winning_course:Number.isInteger(Number(win?.course))?Number(win.course):null,decision_parse_status:method&&win?"parsed":method?"method_only":"unparsed",decision_parsed_at:new Date().toISOString(),fetched_at:new Date().toISOString(),updated_at:new Date().toISOString()};
}
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers});const reply=(x:unknown,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{...headers,"Content-Type":"application/json"}});
 if(req.method!=="POST")return reply({error:"POST only"},405);const token=req.headers.get("x-cron-token")??"",db=Deno.env.get("SUPABASE_DB_URL")??"";if(!db)return reply({error:"DB接続設定なし"},500);
 const sql=postgres(db,{max:1,idle_timeout:20,connect_timeout:10});
 try{
  const auth=await sql`select exists(select 1 from vault.decrypted_secrets where name='race_result_sync_cron_token' and decrypted_secret=${token}) as ok`;
  if(!auth[0]?.ok)return reply({error:"自動取得の認証に失敗しました"},401);
  let owners=await sql`select user_id from public.race_payout_results limit 1`;if(!owners.length)owners=await sql`select user_id from public.race_records limit 1`;
  const owner=owners[0]?.user_id;if(!owner)return reply({error:"保存先ユーザーを特定できません"},500);
  const t=jst(),dates=[t.date];if(t.hour===0)dates.push(prev(t.date));const summary:Obj[]=[];
  for(const date of dates){
   const compact=date.replaceAll("-",""),url="https://boatraceopenapi.github.io/api/v1/"+date.slice(0,4)+"/"+compact+".json",res=await fetch(url,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(25000)});
   if(res.status===404){summary.push({date,status:"not_published",saved:0});continue;}if(!res.ok)throw new Error("開催データ取得失敗 HTTP "+res.status);
   const data=await res.json(),stadiums=data?.programs?.stadiums??{},rows:Obj[]=[];let skipped=0;
   for(const [vk,stadium] of Object.entries(stadiums)){const venue=Number(vk);if(venue<1||venue>24)continue;for(const [rk,race] of Object.entries((stadium as Obj)?.races??{})){const no=Number(rk);if(no<1||no>12)continue;const row=normalize(race as Obj,date,venue,no);if(!row){skipped++;continue;}row.user_id=owner;rows.push(row);}}
   const venueNames:Record<number,string>={1:"桐生",2:"戸田",3:"江戸川",4:"平和島",5:"多摩川",6:"浜名湖",7:"蒲郡",8:"常滑",9:"津",10:"三国",11:"びわこ",12:"住之江",13:"尼崎",14:"鳴門",15:"丸亀",16:"児島",17:"宮島",18:"徳山",19:"下関",20:"若松",21:"芦屋",22:"福岡",23:"唐津",24:"大村"};
   let historySaved=0;
   for(const row of rows){
    await sql`
     insert into public.race_payout_results(user_id,race_date,venue_code,race_no,source_name,source_data,result_status,result_combination,payout_yen,popularity,decision_method,winning_racer_registration_no,winning_course,decision_parse_status,decision_parsed_at,fetched_at,updated_at)
     values(${row.user_id},${row.race_date},${row.venue_code},${row.race_no},${row.source_name},${sql.json(row.source_data)},${row.result_status},${row.result_combination},${row.payout_yen},${row.popularity},${row.decision_method},${row.winning_racer_registration_no},${row.winning_course},${row.decision_parse_status},${row.decision_parsed_at},${row.fetched_at},${row.updated_at})
     on conflict(user_id,race_date,venue_code,race_no) do update set source_name=excluded.source_name,source_data=excluded.source_data,result_status=excluded.result_status,result_combination=excluded.result_combination,payout_yen=excluded.payout_yen,popularity=excluded.popularity,decision_method=excluded.decision_method,winning_racer_registration_no=excluded.winning_racer_registration_no,winning_course=excluded.winning_course,decision_parse_status=excluded.decision_parse_status,decision_parsed_at=excluded.decision_parsed_at,fetched_at=excluded.fetched_at,updated_at=excluded.updated_at
    `;
    const resultEntries=Array.isArray(row.source_data?.entries)?row.source_data.entries:[];
    for(const e of resultEntries){
     const reg=String(e.regno??"").trim(),lane=Number(e.boat),rank=Number(e.rank),course=Number(e.course);
     if(!/^\d{4}$/.test(reg)||!Number.isInteger(lane)||lane<1||lane>6)continue;
     const raw=String(e.st_flag??"").trim(),isF=/^F/i.test(raw),st=Number(e.st);
     const actualSt=!isF&&Number.isFinite(st)&&st>=0?st:null;
     const actualCourse=Number.isInteger(course)&&course>=1&&course<=6?course:null;
     const finishRank=Number.isInteger(rank)&&rank>=1&&rank<=6?rank:null;
     await sql`
      insert into public.historical_racer_entries(user_id,race_date,venue_code,venue_name,race_no,lane,racer_name,racer_registration_no,actual_course,finish_rank,actual_st,actual_st_raw,actual_st_is_f,decision_method,source_name,source_data,imported_at,updated_at)
      values(${owner},${date},${row.venue_code},${venueNames[row.venue_code]??("場"+row.venue_code)},${row.race_no},${lane},${String(e.name??"")||null},${reg},${actualCourse},${finishRank},${actualSt},${raw||null},${isF},${finishRank===1?row.decision_method:null},${"boatraceopenapi-v1-auto"},${sql.json({source:"BOAT RACE Open API（自動定期取得）",race_id:date.replaceAll("-","")+String(row.venue_code).padStart(2,"0")+String(row.race_no).padStart(2,"0"),st_flag:raw,decision_method:row.decision_method})},now(),now())
      on conflict(user_id,race_date,venue_code,race_no,lane) do update set racer_name=excluded.racer_name,racer_registration_no=excluded.racer_registration_no,actual_course=excluded.actual_course,finish_rank=excluded.finish_rank,actual_st=excluded.actual_st,actual_st_raw=excluded.actual_st_raw,actual_st_is_f=excluded.actual_st_is_f,decision_method=excluded.decision_method,source_name=excluded.source_name,source_data=excluded.source_data,imported_at=now(),updated_at=now()
     `;
     historySaved++;
    }
   }
   summary.push({date,status:"ok",saved:rows.length,history_saved:historySaved,skipped});
  }
  // Backfill result data for races previously recorded by BOAT MOTOR LAB.
  // This closes the gap between saved water-condition records and result rows.
  const backfillStart=new Date(t.date+"T00:00:00Z");backfillStart.setUTCDate(backfillStart.getUTCDate()-14);
  const backfillFrom=backfillStart.toISOString().slice(0,10);
  const missing=await sql`
   select r.id,r.race_date::text as race_date,r.venue_code,r.race_no
   from public.race_records r
   left join public.race_payout_results p
    on p.user_id=r.user_id and p.race_date=r.race_date and p.venue_code=r.venue_code and p.race_no=r.race_no
   where r.user_id=${owner} and r.race_date>=${backfillFrom}::date and r.race_date<${t.date}::date
    and (p.id is null or p.result_status<>'fetched' or p.winning_course is null)
   order by r.race_date desc,r.venue_code,r.race_no
   limit 24
  `;
  const backfill:Obj[]=[];
  for(const target of missing){
   const date=String(target.race_date),venue=Number(target.venue_code),raceNo=Number(target.race_no);
   const url="https://boatrace-db.jp/api/race/"+date.replaceAll("-","")+"/"+String(venue).padStart(2,"0")+"/"+raceNo+"/";
   try{
    const res=await fetch(url,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(10000)});
    if(res.status===404){backfill.push({date,venue,race:raceNo,status:"not_published"});continue;}
    if(!res.ok){backfill.push({date,venue,race:raceNo,status:"source_error",http_status:res.status});continue;}
    const data=await res.json(),race=data?.race&&typeof data.race==="object"?data.race:{},entries=Array.isArray(data?.entries)?data.entries as Obj[]:[];
    const valid=entries.filter((e)=>{const lane=Number(e.boat),rank=Number(e.rank),course=Number(e.course);return Number.isInteger(lane)&&lane>=1&&lane<=6&&Number.isInteger(rank)&&rank>=1&&rank<=6&&Number.isInteger(course)&&course>=1&&course<=6;});
    const winner=valid.find((e)=>Number(e.rank)===1);
    const uniqueLanes=new Set(valid.map(e=>Number(e.boat))),uniqueRanks=new Set(valid.map(e=>Number(e.rank))),uniqueCourses=new Set(valid.map(e=>Number(e.course)));
    if(Number(race.has_result)!==1||valid.length!==6||uniqueLanes.size!==6||uniqueRanks.size!==6||uniqueCourses.size!==6||!winner){
     backfill.push({date,venue,race:raceNo,status:"result_not_ready_or_incomplete"});continue;
    }
    const payouts=Array.isArray(data?.payouts)?data.payouts as Obj[]:[];
    const trifecta=payouts.find(x=>String(x.bet_type??"").toLowerCase()==="trifecta");
    const triAmount=Number(trifecta?.amount),triPopularity=Number(trifecta?.popularity);
    const method=typeof race.kimarite==="string"&&race.kimarite.trim()?race.kimarite.trim():null;
    const course=Number(winner.course),registration=winner.regno==null?null:String(winner.regno);
    const now=new Date().toISOString();
    const sourceData={...data,source:"boatrace-db.jp（保存済みレース結果の自動補完）"};
    await sql`
     insert into public.race_payout_results(user_id,race_date,venue_code,race_no,source_name,source_data,result_status,result_combination,payout_yen,popularity,decision_method,winning_racer_registration_no,winning_course,decision_parse_status,decision_parsed_at,fetched_at,updated_at)
     values(${owner},${date}::date,${venue},${raceNo},'boatrace-db.jp-backfill',${sql.json(sourceData)},'fetched',${typeof trifecta?.combo==="string"?trifecta.combo:null},${Number.isFinite(triAmount)?Math.round(triAmount):null},${Number.isInteger(triPopularity)&&triPopularity>=1?triPopularity:null},${method},${registration},${course},${method?"parsed":"method_only"},${now},${now},${now})
     on conflict(user_id,race_date,venue_code,race_no) do update set source_name=excluded.source_name,source_data=excluded.source_data,result_status=excluded.result_status,result_combination=excluded.result_combination,payout_yen=excluded.payout_yen,popularity=excluded.popularity,decision_method=excluded.decision_method,winning_racer_registration_no=excluded.winning_racer_registration_no,winning_course=excluded.winning_course,decision_parse_status=excluded.decision_parse_status,decision_parsed_at=excluded.decision_parsed_at,fetched_at=excluded.fetched_at,updated_at=excluded.updated_at
    `;
    // Keep the saved race entries aligned with the verified official result.
    for(const e of valid){
     const lane=Number(e.boat),rank=Number(e.rank),actualCourse=Number(e.course),raw=String(e.st_flag??"").trim(),isF=/^F/i.test(raw),st=Number(e.st);
     const actualSt=!isF&&Number.isFinite(st)&&st>=0?st:null;
     await sql`
      update public.race_entries set finish_rank=${rank},actual_course=${actualCourse},actual_st=${actualSt},actual_st_raw=${raw||null},actual_st_is_f=${isF},updated_at=now()
      where race_id=${target.id}::uuid and user_id=${owner} and lane=${lane}
     `;
    }
    backfill.push({date,venue,race:raceNo,status:"saved",winning_course:course,decision_method:method});
   }catch(err){
    backfill.push({date,venue,race:raceNo,status:"fetch_or_save_error",message:err instanceof Error?err.message:"unknown"});
   }
  }
  const out={success:true,source:"boatraceopenapi-v1",checked_at_jst:new Date().toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"}),summary,backfill:{checked:missing.length,saved:backfill.filter(x=>x.status==="saved").length,items:backfill}};console.log("auto-sync-race-results",out);return reply(out);
 }catch(e){console.error("auto-sync-race-results failed",e);return reply({error:e instanceof Error?e.message:"自動取得処理に失敗しました"},500);}
 finally{await sql.end({timeout:5});}
});