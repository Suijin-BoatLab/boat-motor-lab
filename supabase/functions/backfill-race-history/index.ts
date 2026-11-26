import postgres from "npm:postgres@3.4.5";
type O=Record<string,any>;
const V:Record<number,string>={1:"桐生",2:"戸田",3:"江戸川",4:"平和島",5:"多摩川",6:"浜名湖",7:"蒲郡",8:"常滑",9:"津",10:"三国",11:"びわこ",12:"住之江",13:"尼崎",14:"鳴門",15:"丸亀",16:"児島",17:"宮島",18:"徳山",19:"下関",20:"若松",21:"芦屋",22:"福岡",23:"唐津",24:"大村"};
const H={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"content-type,x-cron-token","Access-Control-Allow-Methods":"POST,OPTIONS"};
const reply=(x:unknown,s=200)=>new Response(JSON.stringify(x),{status:s,headers:H});
function st(e:O){const raw=e.start_timing_source;if(typeof raw==="string"&&raw.trim())return raw.trim();const n=Number(e.start_timing);return Number.isFinite(n)?(n<0?"F."+Math.round(Math.abs(n)*100).toString().padStart(2,"0"):n.toFixed(2)):"—";}
function parse(r:O,date:string,v:number,no:number){
 const z=r?.result;if(!z||typeof z!=="object")return null;const racers=z.racers&&typeof z.racers==="object"?z.racers as O:{};
 const entries=Object.entries(racers).map(([k,e]:[string,any])=>{const lane=Number(e.entry_number??k),p=Number(e.place_number),rank=Number.isInteger(p)&&p>=1&&p<=6?p:null;return{lane,rank,reg:e.number==null?null:String(e.number),name:e.name??null,course:Number(e.course_number),st:Number(e.start_timing),straw:st(e)};}).filter(e=>e.lane>=1&&e.lane<=6);
 if(!entries.some(e=>e.rank!==null))return null;
 const pays:O[]=[];for(const [type,arr] of Object.entries(z.payouts??{}))if(Array.isArray(arr))for(const p of arr as O[])pays.push({bet_type:type,combo:p.combination??null,amount:p.amount??null,popularity:p.popularity??null});
 const winner=entries.find(e=>e.rank===1),tri=pays.find(p=>p.bet_type==="trifecta");
 return{entries,pays,winner,tri,method:z.technique_number_source??(z.technique_number==null?null:String(z.technique_number)),raw:z};
}
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:H});if(req.method!=="POST")return reply({error:"POST only"},405);
 const sql=postgres(Deno.env.get("SUPABASE_DB_URL")??"",{max:1,connect_timeout:10});
 try{
  const token=req.headers.get("x-cron-token")??"",auth=await sql`select exists(select 1 from vault.decrypted_secrets where name='race_result_sync_cron_token' and decrypted_secret=${token}) ok`;
  if(!auth[0]?.ok)return reply({error:"認証失敗"},401);
  const body=await req.json(),from=String(body.date_from??""),to=String(body.date_to??"");
  if(!/^2026-\d\d-\d\d$/.test(from)||!/^2026-\d\d-\d\d$/.test(to)||from>"2026-11-26"||from>to)return reply({error:"日付指定が不正です"},400);
  const span=(Date.parse(to+"T00:00:00Z")-Date.parse(from+"T00:00:00Z"))/86400000+1;if(span>7)return reply({error:"一度に最大7日分です"},400);
  const owners=await sql`select user_id from public.historical_motor_entries group by user_id order by count(*) desc limit 1`;const owner=owners[0]?.user_id;if(!owner)return reply({error:"保存先ユーザーなし"},500);
  const totals={days:0,races:0,boats:0,skipped:0,missing_days:0};const detail:O[]=[];
  for(let i=0;i<span;i++){
   const d=new Date(Date.parse(from+"T00:00:00Z")+i*86400000).toISOString().slice(0,10),compact=d.replaceAll("-",""),url=`https://boatraceopenapi.github.io/api/v1/2026/${compact}.json`;
   const res=await fetch(url,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(20000)});
   if(res.status===404){totals.missing_days++;detail.push({date:d,status:"no_data"});continue;}if(!res.ok)throw new Error(d+" HTTP "+res.status);
   const data=await res.json(),stadiums=data?.programs?.stadiums??{};let dayR=0,dayB=0,skip=0;
   for(const [vk,s] of Object.entries(stadiums)){const venue=Number(vk);if(venue<1||venue>24)continue;
    for(const [rk,r] of Object.entries((s as O)?.races??{})){const no=Number(rk);if(no<1||no>12)continue;const x=parse(r as O,d,venue,no);if(!x){skip++;continue;}
     const now=new Date().toISOString(),win=x.winner,tri=x.tri,amount=Number(tri?.amount),pop=Number(tri?.popularity),course=Number(win?.course),method=x.method;
     const sourceData={source:"BOAT RACE Open API v1 backfill",race_date:d,venue_code:venue,race_no:no,raw_result:x.raw,entries:x.entries,payouts:x.pays};
     await sql`insert into public.race_payout_results(user_id,race_date,venue_code,race_no,source_name,source_data,result_status,result_combination,payout_yen,popularity,decision_method,winning_racer_registration_no,winning_course,decision_parse_status,decision_parsed_at,fetched_at,updated_at)
      values(${owner},${d},${venue},${no},'boatraceopenapi-v1-backfill',${sql.json(sourceData)},'fetched',${typeof tri?.combo==="string"?tri.combo:null},${Number.isFinite(amount)?Math.round(amount):null},${Number.isInteger(pop)&&pop>0?pop:null},${method},${win?.reg??null},${Number.isInteger(course)&&course>=1&&course<=6?course:null},${method?"parsed":"unparsed"},${now},${now},${now})
      on conflict(user_id,race_date,venue_code,race_no) do update set source_name=excluded.source_name,source_data=excluded.source_data,result_status=excluded.result_status,result_combination=excluded.result_combination,payout_yen=excluded.payout_yen,popularity=excluded.popularity,decision_method=excluded.decision_method,winning_racer_registration_no=excluded.winning_racer_registration_no,winning_course=excluded.winning_course,decision_parse_status=excluded.decision_parse_status,decision_parsed_at=excluded.decision_parsed_at,fetched_at=excluded.fetched_at,updated_at=excluded.updated_at`;
     for(const e of x.entries){const reg=String(e.reg??"");if(!/^\d{4}$/.test(reg))continue;const isF=/^F/i.test(e.straw),actualSt=!isF&&Number.isFinite(e.st)&&e.st>=0?e.st:null,actualCourse=Number.isInteger(e.course)&&e.course>=1&&e.course<=6?e.course:null;
      await sql`insert into public.historical_racer_entries(user_id,race_date,venue_code,venue_name,race_no,lane,racer_name,racer_registration_no,actual_course,finish_rank,actual_st,actual_st_raw,actual_st_is_f,decision_method,source_name,source_data,imported_at,updated_at)
       values(${owner},${d},${venue},${V[venue]},${no},${e.lane},${e.name},${reg},${actualCourse},${e.rank},${actualSt},${e.straw},${isF},${e.rank===1?method:null},'boatraceopenapi-v1-backfill',${sql.json({source:"BOAT RACE Open API v1 backfill",race_id:compact+String(venue).padStart(2,"0")+String(no).padStart(2,"0")})},now(),now())
       on conflict(user_id,race_date,venue_code,race_no,lane) do update set racer_name=excluded.racer_name,racer_registration_no=excluded.racer_registration_no,actual_course=excluded.actual_course,finish_rank=excluded.finish_rank,actual_st=excluded.actual_st,actual_st_raw=excluded.actual_st_raw,actual_st_is_f=excluded.actual_st_is_f,decision_method=excluded.decision_method,source_name=excluded.source_name,source_data=excluded.source_data,imported_at=now(),updated_at=now()`;
      await sql`update public.historical_motor_entries set finish_rank=${e.rank},actual_course=${actualCourse},actual_st=${actualSt},actual_st_raw=${e.straw},actual_st_is_f=${isF},source_data=coalesce(source_data,'{}'::jsonb)||${sql.json({result_backfill_source:"boatraceopenapi-v1",result_backfilled_at:now})} where user_id=${owner} and race_date=${d} and venue_code=${venue} and race_no=${no} and lane=${e.lane}`;
      dayB++;
     }
     dayR++;
    }
   }
   totals.days++;totals.races+=dayR;totals.boats+=dayB;totals.skipped+=skip;detail.push({date:d,status:"ok",races:dayR,boats:dayB,skipped:skip});
  }
  return reply({success:true,source:"boatraceopenapi-v1",range:{from,to},totals,detail});
 }catch(e){return reply({error:e instanceof Error?e.message:"backfill failed"},500);}finally{await sql.end({timeout:5});}
});