import { createClient } from "npm:@supabase/supabase-js@2";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const names:Record<string,string>={"1":"桐生","2":"戸田","3":"江戸川","4":"平和島","5":"多摩川","6":"浜名湖","7":"蒲郡","8":"常滑","9":"津","10":"三国","11":"びわこ","12":"住之江","13":"尼崎","14":"鳴門","15":"丸亀","16":"児島","17":"宮島","18":"徳山","19":"下関","20":"若松","21":"芦屋","22":"福岡","23":"唐津","24":"大村"};
const num=(v:any)=>{if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null};
const st=(v:any)=>{const raw=v==null?"":String(v).trim();if(!raw)return {raw:null,value:null,isF:false};if(/^F/i.test(raw))return {raw,value:null,isF:true};const value=num(raw);if(value!==null&&value<0)return {raw,value:null,isF:true};return {raw,value,isF:false};};
const avg=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
const metrics=["exhibition_time","lap_time","straight_time","turn_time","exhibition_st"];
Deno.serve(async(req:Request)=>{
 const startedAt=Date.now();
 const timings:Record<string,number>={};
 let stageAt=startedAt;
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
 try{
  if(req.method!=="POST")return json({error:"POST only"},405);
  const authHeader=req.headers.get("Authorization")??"",token=authHeader.replace(/^Bearer\s+/i,"");
  if(!token||token===authHeader)return json({error:"ログインが必要です"},401);
  const supabase=createClient(Deno.env.get("SUPABASE_URL")??"",Deno.env.get("SUPABASE_ANON_KEY")??Deno.env.get("SUPABASE_PUBLISHABLE_KEY")??"",{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}});
  const {data:auth,error:authError}=await supabase.auth.getUser(token);
  if(authError||!auth.user)return json({error:"認証を確認できません"},401);
  const body=await req.json(),date=String(body?.date??""),venueCode=Number(body?.venue_code),raceNo=Number(body?.race_no);const environmentContext={wind_direction:body?.wind_direction?String(body.wind_direction):null,wind_speed:body?.wind_speed==null||body.wind_speed===""?null:Number(body.wind_speed),wave_height:body?.wave_height==null||body.wave_height===""?null:Number(body.wave_height),entry_prediction:body?.entry_prediction?String(body.entry_prediction).slice(0,80):null};
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isInteger(venueCode)||venueCode<1||venueCode>24||!Number.isInteger(raceNo)||raceNo<1||raceNo>12)return json({error:"日付・競艇場・レース番号を確認してください"},400);
  const compact=date.replaceAll("-",""),url=`https://boatraceopenapi.github.io/api/v1/${date.slice(0,4)}/${compact}.json`;
  const upstream=await fetch(url,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(15000)});
  timings.open_api_fetch_ms=Date.now()-stageAt;stageAt=Date.now();
  if(upstream.status===404)return json({error:"指定日の出走データはまだ公開されていないか、開催がありません"},404);
  if(!upstream.ok)return json({error:"出走データ取得失敗 HTTP "+upstream.status},502);
  const payload=await upstream.json(),stadium=payload?.programs?.stadiums?.[String(venueCode)],race=stadium?.races?.[String(raceNo)];
  if(!race)return json({error:"指定レースの出走データが見つかりません"},404);
  const racers=race.racers??{},preview=race.preview?.racers??{},results=race.result?.racers??{};
  // BOATCAST original exhibition times. Missing upstream data never blocks analysis.
  const originalByLane:Record<number,any>={};
  let originalSource="未取得";
  try{
   const compact=date.replaceAll("-","");
   const venue=String(venueCode).padStart(2,"0");
   const raceNoText=String(raceNo).padStart(2,"0");
   const originalUrl=`https://race.boatcast.jp/txt/${venue}/bc_oriten_${compact}_${venue}_${raceNoText}.txt`;
   const originalResponse=await fetch(originalUrl,{headers:{Accept:"text/plain"},signal:AbortSignal.timeout(7000)});
   if(originalResponse.ok){
    const raw=(await originalResponse.text()).replace(/^\uFEFF/,"");
    const rows=raw.split(/\r?\n/).map(line=>line.split("\t"));
    if(rows[0]?.[0]?.trim()==="data="&&rows[1]?.[0]?.trim()==="1"){
     const count=Number(rows[1]?.[1])||0,labels=rows[2]??[],keys:Record<number,string>={};
     const labelMap:Record<string,string>={"一周":"lap_time","半周ラップ":"half_lap_time","まわり足":"turn_time","直線":"straight_time"};
     for(let i=0;i<Math.min(count,labels.length);i++){
      const label=String(labels[i]??"").replace(/\s/g,"");
      if(labelMap[label])keys[i+2]=labelMap[label];
     }
     for(let lane=1;lane<=6;lane++){
      const row=rows[lane+2]??[],values:any={};
      for(const [idx,key] of Object.entries(keys)){
       const v=String(row[Number(idx)]??"").trim(),n=v===""?null:Number(v);
       values[key]=n!==null&&Number.isFinite(n)?n:null;
      }
      originalByLane[lane]=values;
     }
     if(Object.keys(keys).length>0)originalSource="BOATCAST";
    }
   }
  }catch(_){ /* Keep standard official preview values on upstream failure. */ }
  timings.boatcast_fetch_parse_ms=Date.now()-stageAt;stageAt=Date.now();
  const min180=new Date(Date.parse(date+"T00:00:00Z")-180*86400000).toISOString().slice(0,10);
  // Detailed historical_motor_entries are the primary six-month source; avoid the legacy JSON aggregate query that is timing out.
  const dailyRows:any[]=[];
  const motorNumbers=[...new Set(Array.from({length:6},(_,i)=>num(racers[String(i+1)]?.motor_number)).filter((x):x is number=>x!==null))];
  const allHistory:any[]=[];
  if(motorNumbers.length){
   let historyOffset=0;
   while(true){
    const {data:historyPage,error:historyError}=await supabase.from("historical_motor_entries").select("race_date,motor_number,exhibition_time,lap_time,straight_time,turn_time,exhibition_st,exhibition_st_is_f,finish_rank").eq("user_id",auth.user.id).eq("venue_code",venueCode).in("motor_number",motorNumbers).lt("race_date",date).gte("race_date",min180).order("race_date",{ascending:false}).range(historyOffset,historyOffset+999);
    if(historyError)return json({error:"モーター履歴取得失敗: "+historyError.message},500);
    allHistory.push(...(historyPage??[]));
    if(!historyPage||historyPage.length<1000)break;
    historyOffset+=historyPage.length;
   }
  }
  const racerStatsByNo=new Map<string,any>();
  const racerHistorySeen=new Set<string>();
  const registrationNos=[...new Set(Array.from({length:6},(_,i)=>String(racers[String(i+1)]?.number??racers[String(i+1)]?.registration_number??"").trim()).filter(x=>/^\d+$/.test(x)))];
  const racerProfileByNo=new Map<string,any>();
  if(registrationNos.length){
   const {data:profileRows,error:profileError}=await supabase.from("racer_master")
    .select("racer_registration_no,racer_class,branch,registration_term,hometown,birth_date,gender,height_cm,weight_kg,blood_type,profile_data")
    .eq("user_id",auth.user.id).in("racer_registration_no",registrationNos);
   if(profileError)return json({error:"選手プロフィール取得失敗: "+profileError.message},500);
   for(const row of profileRows??[])racerProfileByNo.set(String(row.racer_registration_no),row);
  }
  const racerMinDate=new Date(Date.parse(date+"T00:00:00Z")-180*86400000).toISOString().slice(0,10);
  const racer90MinDate=new Date(Date.parse(date+"T00:00:00Z")-90*86400000).toISOString().slice(0,10);
  const raceMonth=Number(date.slice(5,7));
  const racerPeriodStartDate=raceMonth>=5&&raceMonth<=10?date.slice(0,4)+"-05-01":raceMonth>=11?date.slice(0,4)+"-11-01":String(Number(date.slice(0,4))-1)+"-11-01";

  if(registrationNos.length){
   let racerOffset=0;
   while(true){
    const {data:racerPage,error:racerError}=await supabase.from("historical_motor_entries").select("id,race_date,venue_code,venue_name,race_no,lane,actual_course,racer_registration_no,finish_rank,actual_st,actual_st_is_f").eq("user_id",auth.user.id).in("racer_registration_no",registrationNos).lt("race_date",date).gte("race_date",racerMinDate).order("race_date",{ascending:false}).order("race_no",{ascending:false}).order("id",{ascending:false}).range(racerOffset,racerOffset+999);
    if(racerError)return json({error:"選手履歴取得失敗: "+racerError.message},500);
    for(const row of racerPage??[]){
     const reg=String(row.racer_registration_no);racerHistorySeen.add([reg,row.race_date,row.venue_code,row.race_no].join(':'));
     const s=racerStatsByNo.get(reg)??{starts:0,wins:0,top2:0,top3:0,finishSum:0,starts90:0,wins90:0,top2_90:0,top3_90:0,finishSum90:0,stRows:[],venueStRows:[],courseStRows:[],courseResults:{},recentRaces:[]};
     const rank=Number(row.finish_rank),course=Number(row.actual_course);
     if(Number.isInteger(rank)&&rank>=1&&rank<=6){s.starts++;if(rank===1)s.wins++;if(rank<=2)s.top2++;if(rank<=3)s.top3++;s.finishSum+=rank;if(row.race_date>=racer90MinDate){s.starts90++;if(rank===1)s.wins90++;if(rank<=2)s.top2_90++;if(rank<=3)s.top3_90++;s.finishSum90+=rank;}if(course>=1&&course<=6){const key=String(course);s.courseResults??={};s.courseResults[key]??={starts:0,wins:0,top2:0,top3:0,finish_sum:0};const cr=s.courseResults[key];cr.starts++;if(rank===1)cr.wins++;if(rank<=2)cr.top2++;if(rank<=3)cr.top3++;cr.finish_sum+=rank;}}
     const actualSt=num(row.actual_st);
     s.recentRaces.push({date:row.race_date,race_no:Number(row.race_no)||0,venue_code:Number(row.venue_code)||0,venue_name:row.venue_name??names[String(row.venue_code)]??"場不明",st:!row.actual_st_is_f&&actualSt!==null&&actualSt>=0&&actualSt<=0.99?actualSt:null,is_f:!!row.actual_st_is_f});
     if(!row.actual_st_is_f&&actualSt!==null&&actualSt>=0&&actualSt<=0.99){
      const stRow={date:row.race_date,race_no:Number(row.race_no)||0,venue_code:Number(row.venue_code)||0,venue_name:row.venue_name??names[String(row.venue_code)]??"場不明",st:actualSt};
      s.stRows.push(stRow);
      if(Number(row.venue_code)===venueCode)s.venueStRows.push(stRow);
      const actualCourse=Number(row.actual_course);if(actualCourse>=1&&actualCourse<=6){s.courseStRows??=[];s.courseStRows.push({...stRow,course:actualCourse});}
     }
     racerStatsByNo.set(reg,s);
    }
    if(!racerPage||racerPage.length<1000)break;
    racerOffset+=racerPage.length;
   }
   let importedOffset=0;
   while(true){
    const {data:importedPage,error:importedError}=await supabase.from("historical_racer_entries").select("id,race_date,venue_code,venue_name,race_no,lane,actual_course,racer_registration_no,finish_rank,actual_st,actual_st_is_f").eq("user_id",auth.user.id).in("racer_registration_no",registrationNos).lt("race_date",date).gte("race_date",racerMinDate).order("race_date",{ascending:false}).order("race_no",{ascending:false}).range(importedOffset,importedOffset+999);
    if(importedError)return json({error:"CSV選手履歴取得失敗: "+importedError.message},500);
    for(const row of importedPage??[]){
     const reg=String(row.racer_registration_no),key=[reg,row.race_date,row.venue_code,row.race_no].join(':');
     if(racerHistorySeen.has(key))continue;
     racerHistorySeen.add(key);
     const s=racerStatsByNo.get(reg)??{starts:0,wins:0,top2:0,top3:0,finishSum:0,starts90:0,wins90:0,top2_90:0,top3_90:0,finishSum90:0,stRows:[],venueStRows:[],courseStRows:[],courseResults:{},recentRaces:[]};
     const rank=Number(row.finish_rank),course=Number(row.actual_course);
     if(Number.isInteger(rank)&&rank>=1&&rank<=6){s.starts++;if(rank===1)s.wins++;if(rank<=2)s.top2++;if(rank<=3)s.top3++;s.finishSum+=rank;if(row.race_date>=racer90MinDate){s.starts90++;if(rank===1)s.wins90++;if(rank<=2)s.top2_90++;if(rank<=3)s.top3_90++;s.finishSum90+=rank;}if(course>=1&&course<=6){const key=String(course);s.courseResults??={};s.courseResults[key]??={starts:0,wins:0,top2:0,top3:0,finish_sum:0};const cr=s.courseResults[key];cr.starts++;if(rank===1)cr.wins++;if(rank<=2)cr.top2++;if(rank<=3)cr.top3++;cr.finish_sum+=rank;}}
     const actualSt=num(row.actual_st);
     s.recentRaces.push({date:row.race_date,race_no:Number(row.race_no)||0,venue_code:Number(row.venue_code)||0,venue_name:row.venue_name??names[String(row.venue_code)]??"場不明",st:!row.actual_st_is_f&&actualSt!==null&&actualSt>=0&&actualSt<=0.99?actualSt:null,is_f:!!row.actual_st_is_f});
     if(!row.actual_st_is_f&&actualSt!==null&&actualSt>=0&&actualSt<=0.99){
      const stRow={date:row.race_date,race_no:Number(row.race_no)||0,venue_code:Number(row.venue_code)||0,venue_name:row.venue_name??names[String(row.venue_code)]??"場不明",st:actualSt};
      s.stRows.push(stRow);if(Number(row.venue_code)===venueCode)s.venueStRows.push(stRow);const actualCourse=Number(row.actual_course);if(actualCourse>=1&&actualCourse<=6){s.courseStRows??=[];s.courseStRows.push({...stRow,course:actualCourse});}
     }
     racerStatsByNo.set(reg,s);
    }
    if(!importedPage||importedPage.length<1000)break;
    importedOffset+=importedPage.length;
   }
  }
  for(const s of racerStatsByNo.values()){
   s.average_finish=s.starts?s.finishSum/s.starts:null;
   s.stRows.sort((a:any,b:any)=>b.date.localeCompare(a.date)||b.race_no-a.race_no);
   s.venueStRows.sort((a:any,b:any)=>b.date.localeCompare(a.date)||b.race_no-a.race_no);
   s.recentRaces.sort((a:any,b:any)=>b.date.localeCompare(a.date)||b.race_no-a.race_no);
   const last10Races=s.recentRaces.slice(0,10);
   const last10=last10Races.filter((x:any)=>x.st!==null);
   const last90=s.stRows.filter((x:any)=>x.date>=racer90MinDate);
   const avgSt=(rows:any[])=>rows.length?rows.reduce((sum:number,x:any)=>sum+x.st,0)/rows.length:null;
   const byCourse=Object.fromEntries(Array.from({length:6},(_,i)=>{const course=i+1,all=(s.courseStRows??[]).filter((x:any)=>x.course===course),recent=all.filter((x:any)=>x.date>=racer90MinDate);return [String(course),{average:avgSt(all),count:all.length,average_90d:avgSt(recent),count_90d:recent.length,status:all.length>=5?"参考可能":all.length>=3?"参考値":"データ不足"}];}));const coursePerformance=Object.fromEntries(Array.from({length:6},(_,i)=>{const key=String(i+1),x=s.courseResults?.[key]??{starts:0,wins:0,top2:0,top3:0,finish_sum:0};return [key,{starts:x.starts,wins:x.wins,win_rate:x.starts?Number((x.wins/x.starts*100).toFixed(1)):null,top2_rate:x.starts?Number((x.top2/x.starts*100).toFixed(1)):null,top3_rate:x.starts?Number((x.top3/x.starts*100).toFixed(1)):null,average_finish:x.starts?Number((x.finish_sum/x.starts).toFixed(2)):null}];}));s.course_performance=coursePerformance;s.start_time={last10:{average:avgSt(last10),count:last10.length,races:last10Races.length},last90d:{average:avgSt(last90),count:last90.length},venue:{average:avgSt(s.venueStRows),count:s.venueStRows.length,venue_code:venueCode,venue_name:names[String(venueCode)]},by_course:byCourse,last10_rows:last10,last10_races:last10Races};
  }
  const fStatsByNo=new Map<string,any>();
  if(registrationNos.length){
   const {data:fRows,error:fError}=await supabase.from("racer_f_incidents")
    .select("racer_registration_no,incident_date,f_type,suspension_start_date,suspension_end_date,suspension_days,venue_name,race_no,lane")
    .eq("user_id",auth.user.id).in("racer_registration_no",registrationNos)
    .lte("incident_date",date).order("incident_date",{ascending:false});
   if(fError)return json({error:"選手F履歴取得失敗: "+fError.message},500);
   for(const row of fRows??[]){
    const reg=String(row.racer_registration_no);
    const s=fStatsByNo.get(reg)??{total_f_count:0,f_count_last_6_months:0,f_count_current_period:0,latest_f_date:null,incidents:[]};
    s.total_f_count++;
    if(row.incident_date>=racerMinDate)s.f_count_last_6_months++;
    if(row.incident_date>=racerPeriodStartDate)s.f_count_current_period++;
    if(!s.latest_f_date||row.incident_date>s.latest_f_date)s.latest_f_date=row.incident_date;
    s.incidents.push(row);
    fStatsByNo.set(reg,s);
   }
   for(const s of fStatsByNo.values()){
    const active=s.incidents.find((x:any)=>x.suspension_start_date&&x.suspension_end_date&&x.suspension_start_date<=date&&x.suspension_end_date>=date);
    const upcoming=s.incidents.filter((x:any)=>x.suspension_start_date&&x.suspension_start_date>date).sort((a:any,b:any)=>a.suspension_start_date.localeCompare(b.suspension_start_date))[0];
    const completed=s.incidents.filter((x:any)=>x.suspension_end_date&&x.suspension_end_date<date).sort((a:any,b:any)=>b.suspension_end_date.localeCompare(a.suspension_end_date))[0];
    const selected=active??upcoming??completed??null;
    s.suspension_status=active?"F休み中":upcoming?"休み開始前":completed?"F休み消化済み":"休み日程未登録";
    s.suspension_start_date=selected?.suspension_start_date??null;
    s.suspension_end_date=selected?.suspension_end_date??null;
    s.suspension_days=selected?.suspension_days??null;
    s.days_since_suspension_end=completed&&!active&&!upcoming?Math.max(0,Math.floor((Date.parse(date+"T00:00:00Z")-Date.parse(completed.suspension_end_date+"T00:00:00Z"))/86400000)):null;
    s.is_suspended_on_race_date=!!active;
    s.incidents=s.incidents.slice(0,10).map((x:any)=>({date:x.incident_date,type:x.f_type,venue:x.venue_name,race_no:x.race_no,lane:x.lane}));
   }
  }
  const fReturnByNo=new Map<string,any>();
  if(registrationNos.length){
   const {data:returnRows,error:returnError}=await supabase.from("racer_f_return_performance_detail")
    .select("*").eq("user_id",auth.user.id).in("racer_registration_no",registrationNos)
    .lte("incident_date",date).order("incident_date",{ascending:false});
   if(returnError)return json({error:"F休み明け成績取得失敗: "+returnError.message},500);
   for(const row of returnRows??[]){
    const reg=String(row.racer_registration_no);
    if(!fReturnByNo.has(reg))fReturnByNo.set(reg,row);
   }
  }
  const decisionByNo=new Map<string,any>(),decisionRaceKeys=new Set<string>();
  const addDecision=(regValue:any,method:string,courseValue:any)=>{
   const reg=String(regValue??"").trim();if(!reg||!method)return;
   const v=decisionByNo.get(reg)??{wins:0,by_method:{},by_course:{}};
   v.wins++;v.by_method[method]=(v.by_method[method]??0)+1;
   const course=Number(courseValue);if(course>=1&&course<=6){const key=String(course);v.by_course[key]??={wins:0,by_method:{}};v.by_course[key].wins++;v.by_course[key].by_method[method]=(v.by_course[key].by_method[method]??0)+1;}
   decisionByNo.set(reg,v);
  };
  if(registrationNos.length){
   let importedDecisionOffset=0;
   while(true){
    const {data:importedDecisionPage,error:importedDecisionError}=await supabase.from("historical_racer_entries").select("race_date,venue_code,race_no,racer_registration_no,finish_rank,decision_method,actual_course").eq("user_id",auth.user.id).in("racer_registration_no",registrationNos).lt("race_date",date).gte("race_date",racer90MinDate).eq("finish_rank",1).not("decision_method","is",null).order("race_date",{ascending:false}).range(importedDecisionOffset,importedDecisionOffset+999);
    if(importedDecisionError)return json({error:"CSV決まり手履歴取得失敗: "+importedDecisionError.message},500);
    for(const row of importedDecisionPage??[]){
     decisionRaceKeys.add([row.race_date,row.venue_code,row.race_no].join(':'));
     addDecision(row.racer_registration_no,String(row.decision_method),row.actual_course);
    }
    if(!importedDecisionPage||importedDecisionPage.length<1000)break;
    importedDecisionOffset+=importedDecisionPage.length;
   }
   let decisionOffset=0;
   while(true){
    const {data:decisionPage,error:decisionError}=await supabase.from("race_payout_results").select("race_date,venue_code,race_no,winning_racer_registration_no,decision_method,winning_course").eq("user_id",auth.user.id).in("winning_racer_registration_no",registrationNos).lt("race_date",date).gte("race_date",racer90MinDate).not("decision_method","is",null).order("race_date",{ascending:false}).range(decisionOffset,decisionOffset+999);
    if(decisionError)return json({error:"決まり手履歴取得失敗: "+decisionError.message},500);
    for(const row of decisionPage??[]){
     const raceKey=[row.race_date,row.venue_code,row.race_no].join(':');
     if(decisionRaceKeys.has(raceKey))continue;
     addDecision(row.winning_racer_registration_no,String(row.decision_method),row.winning_course);
    }
    if(!decisionPage||decisionPage.length<1000)break;
    decisionOffset+=decisionPage.length;
   }
  }
  for(const v of decisionByNo.values()){
   v.method_rate=Object.fromEntries(Object.entries(v.by_method).map(([k,n])=>[k,v.wins?Number(n)/v.wins:null]));
   for(const c of Object.values(v.by_course) as any[])c.method_rate=Object.fromEntries(Object.entries(c.by_method).map(([k,n])=>[k,c.wins?Number(n)/c.wins:null]));
  }
  timings.racer_history_fetch_ms=Date.now()-stageAt;stageAt=Date.now();
  const historyByMotor=new Map<number,any[]>();
  for(const row of allHistory){const list=historyByMotor.get(Number(row.motor_number))??[];list.push(row);historyByMotor.set(Number(row.motor_number),list);}
  const boats=[];
  for(let lane=1;lane<=6;lane++){
   const b=racers[String(lane)]??{},p=preview[String(lane)]??{},r=results[String(lane)]??{},motor=num(b.motor_number);
   if(!motor){boats.push({lane,available:false});continue;}
   const detailRows=historyByMotor.get(motor)??[];
   const detailDates=new Set(detailRows.map(x=>x.race_date));
   const legacyRows:any[]=[];
   for(const day of dailyRows??[]){
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
    legacyRows.push({race_date:day.race_date,exhibition_time:num(found.exAvg??found.avg_exhibition),exhibition_count:Number(found.exhibition_count??count),lap_time:num(found.avg_lap),lap_count:Number(found.lap_count??0),straight_time:num(found.avg_straight),straight_count:Number(found.straight_count??0),turn_time:num(found.avg_turn),turn_count:Number(found.turn_count??0),exhibition_st:num(found.stAvg??found.avg_exhibition_st),exhibition_st_count:Number(found.exhibition_st_count??Math.max(0,count-fCount)),exhibition_st_is_f:false,_f_count:fCount,_first_places:Number(found.wins??found.first_places??0),_weight:count});
   }
   const rows=[...detailRows,...legacyRows].sort((a,b)=>b.race_date.localeCompare(a.race_date));
   const windows=[7,30,90,180].map(days=>{
    const minDate=new Date(Date.parse(date+"T00:00:00Z")-days*86400000).toISOString().slice(0,10);
    const sample=rows.filter(x=>x.race_date>=minDate);
    const sampleDates=[...new Set(sample.map(x=>x.race_date))].sort();
    const out:any={days,count:sample.reduce((s,x)=>s+Number((x as any)._weight??1),0),days_with_data:sampleDates.length,first_date:sampleDates[0]??null,last_date:sampleDates[sampleDates.length-1]??null};
    for(const key of metrics){
     const valid=sample.filter(x=>key!=="exhibition_st"||(!x.exhibition_st_is_f&&(num(x.exhibition_st)??-1)>=0));
     const countKey=key+"_count";const values=valid.map(x=>({v:num((x as any)[key]),w:Number((x as any)[countKey]??(x as any)._weight??1)})).filter(x=>x.v!==null&&x.w>0);
     const total=values.reduce((s,x)=>s+x.w,0);
     out[key]=total?values.reduce((s,x)=>s+(x.v as number)*x.w,0)/total:null;out[key+"_count"]=total;
    }
    out.exhibition_f_count=sample.reduce((s,x)=>s+Number((x as any)._f_count??(x.exhibition_st_is_f?1:0)),0);
    out.first_places=sample.reduce((s,x)=>s+Number((x as any)._first_places??(Number(x.finish_rank)===1?1:0)),0);
    const finished=sample.filter(x=>Number.isInteger(Number(x.finish_rank))&&Number(x.finish_rank)>=1&&Number(x.finish_rank)<=6);
    out.finish_count=finished.length;
    out.first_places=finished.filter(x=>Number(x.finish_rank)===1).length;
    out.top2_places=finished.filter(x=>Number(x.finish_rank)<=2).length;
    out.top3_places=finished.filter(x=>Number(x.finish_rank)<=3).length;
    out.average_finish=finished.length?finished.reduce((sum,x)=>sum+Number(x.finish_rank),0)/finished.length:null;
    return out;
   });
   const registrationNo=String(b.number??b.registration_number??"").trim()||null;const fReturn=registrationNo?fReturnByNo.get(registrationNo)??null:null;const fReturnSignal=(()=>{if(!fReturn||fReturn.return_analysis_status!=="比較可能")return {level:"判定保留",reason:fReturn?.return_analysis_status??"比較データなし",st_change:null};const before=Number(fReturn.pre_average_st),early=Number(fReturn.first3_average_st);if(!Number.isFinite(before)||!Number.isFinite(early)||Number(fReturn.pre_st_count)<5||Number(fReturn.first3_st_count)<3)return {level:"判定保留",reason:"STサンプル不足",st_change:null};const change=Number((early-before).toFixed(3));return {level:change>=0.03?"復帰直後は慎重傾向":change<=-0.03?"復帰直後は速化傾向":"大きな変化なし",prediction_note:change>=0.03?"スタート評価は慎重寄りに確認":change<=-0.03?"速化傾向。ただし過信せず当日展示STを優先":"F休み明けによる明確なST変化なし",score_adjustment:0,reason:"復帰直後3走とF前10走の平均ST比較（有効ST各3件以上）",st_change:change,pre_average_st:before,first3_average_st:early,pre_st_count:Number(fReturn.pre_st_count),first3_st_count:Number(fReturn.first3_st_count)};})();const racerHistory=registrationNo?racerStatsByNo.get(registrationNo)??{starts:0,wins:0,top2:0,top3:0,average_finish:null,starts90:0,wins90:0,top2_90:0,top3_90:0,finishSum90:0,start_time:null}:null;const masterProfile=registrationNo?racerProfileByNo.get(registrationNo)??null:null,profileJson=masterProfile?.profile_data??{},careerTotal=profileJson?.stats?.total??{},racer:any={name:b.racer_name??b.name??null,registration_no:registrationNo,class:masterProfile?.racer_class??b.rank_number??null,branch:masterProfile?.branch??b.branch_number??null,profile:{registration_term:masterProfile?.registration_term??null,hometown:masterProfile?.hometown??null,birth_date:masterProfile?.birth_date??null,gender:masterProfile?.gender??null,height_cm:masterProfile?.height_cm??null,weight_kg:masterProfile?.weight_kg??null,blood_type:masterProfile?.blood_type??null},career:{starts:num(careerTotal.starts),wins:num(careerTotal.wins),seconds:num(careerTotal.seconds),thirds:num(careerTotal.thirds),st_avg:num(careerTotal.st_avg),st_count:num(careerTotal.st_n),f_count:num(careerTotal.f),first:profileJson?.stats?.first??null,last:profileJson?.stats?.last??null},career_by_course:profileJson?.stats?.byCourse??[],career_by_venue:profileJson?.stats?.byVenue??[],career_by_year:profileJson?.stats?.byYear??[],national_win_rate:num(b.national_win_rate),national_place_rate:num(b.national_place_rate),local_win_rate:num(b.local_win_rate),local_place_rate:num(b.local_place_rate),decision_methods:registrationNo?decisionByNo.get(registrationNo)??{wins:0,by_method:{},method_rate:{},by_course:{}}:null,f_history:registrationNo?(fStatsByNo.get(registrationNo)??{total_f_count:0,f_count_last_6_months:0,f_count_current_period:0,latest_f_date:null,suspension_status:"F記録なし",suspension_start_date:null,suspension_end_date:null,suspension_days:null,days_since_suspension_end:null,is_suspended_on_race_date:false,incidents:[]}):null,f_return_performance:fReturn,f_return_signal:fReturnSignal,course_performance:racerHistory?.course_performance??{},start_time:racerHistory?.start_time??null,history_90d:racerHistory?{starts:racerHistory.starts90,wins:racerHistory.wins90,win_rate:racerHistory.starts90?racerHistory.wins90/racerHistory.starts90:null,top2:racerHistory.top2_90,top2_rate:racerHistory.starts90?racerHistory.top2_90/racerHistory.starts90:null,top3:racerHistory.top3_90,top3_rate:racerHistory.starts90?racerHistory.top3_90/racerHistory.starts90:null,average_finish:racerHistory.starts90?racerHistory.finishSum90/racerHistory.starts90:null}:null};
   const startPrediction=(()=>{const st=racerHistory?.start_time??{};const parts=[{key:"last10",weight:0.4,min:5},{key:"last90d",weight:0.3,min:5},{key:"venue",weight:0.3,min:3}].map(x=>({key:x.key,weight:x.weight,min:x.min,value:num(st[x.key]?.average),count:Number(st[x.key]?.count??0)})).filter(x=>x.value!==null&&x.count>=x.min);if(!parts.length)return {average:null,count:0,coverage:0,components:[],status:"データ不足"};const weight=parts.reduce((s,x)=>s+x.weight,0);const average=parts.reduce((s,x)=>s+(x.value as number)*x.weight,0)/weight;return {average:Number(average.toFixed(3)),count:Math.max(...parts.map(x=>x.count)),combined_sample_count:parts.reduce((s,x)=>s+x.count,0),coverage:parts.length,components:parts.map(x=>({period:x.key,average:x.value,count:x.count,minimum:x.min,eligible:true})),status:parts.length>=2?"複数期間で算出":"参考値（1期間のみ）"};})();const exhibitionSt=st(p.start_timing);const startComparison=(()=>{const baseline=startPrediction.average,shown=exhibitionSt.value;if(baseline===null||shown===null)return {status:"比較不可",exhibition_st:shown,delta:null,note:exhibitionSt.isF?"展示STがF": "展示STまたは本番ST目安が不足"};const delta=Number((shown-baseline).toFixed(3));return {status:delta>=0.03?"展示STは基準より遅め":delta<=-0.03?"展示STは基準より速め":"基準に近い",exhibition_st:shown,baseline_st:baseline,delta,note:"展示STと過去本番ST目安の参考比較。展示STは本番STを保証しない"};})();racer.start_prediction=startPrediction;racer.start_comparison=startComparison;const plannedCourse=Number(lane),courseData=racer.course_performance?.[String(plannedCourse)]??{},courseStData=racer.start_time?.by_course?.[String(plannedCourse)]??{},courseDecision=racer.decision_methods?.by_course?.[String(plannedCourse)]??{};const overallTop2=racerHistory?.starts?Number(racerHistory.top2||0)/Number(racerHistory.starts):null;const courseTop2=courseData.top2_rate==null?null:Number(courseData.top2_rate)/100;const courseFit=(()=>{if(!Number.isInteger(plannedCourse)||plannedCourse<1||plannedCourse>6||Number(courseData.starts||0)<5||overallTop2===null||courseTop2===null)return {status:"データ不足",course:plannedCourse,starts:Number(courseData.starts||0),top2_rate:courseTop2,overall_top2_rate:overallTop2,delta:null};const delta=Number((courseTop2-overallTop2).toFixed(3));return {status:delta>=0.08?"コース相性は高め":delta<=-0.08?"コース相性は低め":"全体成績と同程度",course:plannedCourse,starts:Number(courseData.starts||0),top2_rate:courseTop2,overall_top2_rate:overallTop2,delta,average_st:courseStData.average??null,st_count:Number(courseStData.count||0),decision_wins:Number(courseDecision.wins||0),decision_methods:courseDecision.by_method||{}};})();racer.course_fit=courseFit;const attackProfile=(()=>{const methods=Object.entries(racer.decision_methods?.by_method??{}).map(([name,count])=>({name,count:Number(count)||0})).sort((a,b)=>b.count-a.count);const total=methods.reduce((s,x)=>s+x.count,0),top=methods[0]??null,courseMethods=Object.entries(courseDecision.by_method??{}).map(([name,count])=>({name,count:Number(count)||0})).sort((a,b)=>b.count-a.count),courseTotal=courseMethods.reduce((s,x)=>s+x.count,0),courseTop=courseMethods[0]??null;return {total_wins:total,dominant_method:top?.name??null,dominant_count:top?.count??0,dominant_rate:total&&top?Number((top.count/total).toFixed(3)):null,confidence:total>=10?"参考傾向（10勝以上）":total>=3?"参考傾向（サンプル少）":"判定保留",course:{course:plannedCourse,total_wins:courseTotal,dominant_method:courseTop?.name??null,dominant_count:courseTop?.count??0,dominant_rate:courseTotal&&courseTop?Number((courseTop.count/courseTotal).toFixed(3)):null,confidence:courseTotal>=5?"参考傾向": "判定保留"}};})();racer.attack_profile=attackProfile;const original=originalByLane[lane]??{};
   const current={exhibition_time:num(p.exhibition_time),lap_time:num(original.lap_time??p.lap_time),half_lap_time:num(original.half_lap_time),straight_time:num(original.straight_time??p.straight_time),turn_time:num(original.turn_time??p.turn_time),original_exhibition_source:originalSource,exhibition_st:st(p.start_timing),actual_st:st(r.start_timing)};
   boats.push({lane,motor_number:motor,boat_number:num(b.boat_number),racer,motor_rates:{win:num(b.motor_win_rate),place:num(b.motor_place_rate)},current,history:windows,history_rows:rows.length,history_days:new Set(rows.map(x=>x.race_date)).size,history_source:detailRows.length&&legacyRows.length?"詳細履歴＋日別集計":detailRows.length?"詳細履歴":legacyRows.length?"日別集計":"未蓄積"});
  }
  let originalCapture:any={saved:0,status:"not_available",message:originalSource==="BOATCAST"?"BOATCASTデータに有効な数値がありません":"BOATCAST取得元から当日展示データを取得できません"};
  const hasOriginal=originalSource==="BOATCAST"&&Object.values(originalByLane).some((v:any)=>[v?.lap_time,v?.half_lap_time,v?.straight_time,v?.turn_time].some((n:any)=>n!==null&&n!==undefined));
  if(hasOriginal){
   const captureRows=boats.map((boat:any)=>({
    user_id:auth.user.id,race_date:date,venue_code:venueCode,venue_name:names[String(venueCode)],race_no:raceNo,lane:boat.lane,
    racer_name:boat.racer?.name??null,racer_registration_no:boat.racer?.registration_no==null?null:String(boat.racer.registration_no),
    racer_class:boat.racer?.class==null?null:String(boat.racer.class),motor_number:boat.motor_number,boat_number:boat.boat_number??null,
    exhibition_time:boat.current?.exhibition_time??null,lap_time:boat.current?.lap_time??null,straight_time:boat.current?.straight_time??null,turn_time:boat.current?.turn_time??null,
    exhibition_st_raw:boat.current?.exhibition_st?.raw??null,exhibition_st:boat.current?.exhibition_st?.value??null,exhibition_st_is_f:!!boat.current?.exhibition_st?.isF,
    source_name:"boatraceopenapi-v1+boatcast-original-exhibition",
    source_data:{original_exhibition_source:"BOATCAST",half_lap_time:boat.current?.half_lap_time??null}
   }));
   // Preserve any previously imported official/history fields on the same race row.
   // BOATCAST may not publish every metric, so nulls from this source must never erase existing values.
   const {data:existingRows,error:existingError}=await supabase.from("historical_motor_entries")
    .select("*").eq("user_id",auth.user.id).eq("race_date",date).eq("venue_code",venueCode).eq("race_no",raceNo);
   if(existingError){
    originalCapture={saved:0,status:"save_failed",message:"既存記録の保護確認に失敗: "+existingError.message};
   }else{
    const existingByLane=new Map((existingRows??[]).map((row:any)=>[Number(row.lane),row]));
    const safeRows=captureRows.map((fresh:any)=>{
     const old:any=existingByLane.get(Number(fresh.lane));
     if(!old)return fresh;
     const merged:any={...old,...fresh};
     for(const key of Object.keys(fresh)){
      if(fresh[key]===null||fresh[key]===undefined)merged[key]=old[key]??fresh[key];
     }
     merged.exhibition_st_is_f=fresh.exhibition_st_raw?fresh.exhibition_st_is_f:old.exhibition_st_is_f;
     merged.source_data={...(old.source_data??{}),...(fresh.source_data??{})};
     return merged;
    });
    const {error:captureError}=await supabase.from("historical_motor_entries").upsert(safeRows,{onConflict:"user_id,race_date,venue_code,race_no,lane"});
    if(captureError)originalCapture={saved:0,status:"save_failed",message:captureError.message};
    else originalCapture={saved:captureRows.length,status:"saved",preserved_existing_rows:existingRows?.length??0};
   }
  }
  let environmentSave:any={status:"入力なし"};if(environmentContext.wind_direction||environmentContext.wind_speed!=null||environmentContext.wave_height!=null){const validWind=environmentContext.wind_speed==null||Number.isFinite(environmentContext.wind_speed)&&environmentContext.wind_speed>=0;const validWave=environmentContext.wave_height==null||Number.isFinite(environmentContext.wave_height)&&environmentContext.wave_height>=0;if(!validWind||!validWave)environmentSave={status:"入力値エラー"};else{const {error:envSaveError}=await supabase.from("race_records").upsert({user_id:auth.user.id,race_date:date,venue_code:venueCode,venue_name:names[String(venueCode)]??null,race_no:raceNo,wind_direction:environmentContext.wind_direction,wind_speed:environmentContext.wind_speed,wave_height:environmentContext.wave_height,source_name:"BOAT MOTOR LAB analysis input",source_fetched_at:new Date().toISOString(),source_data:{entry_prediction:environmentContext.entry_prediction,source:"race analysis screen"}},{onConflict:"user_id,venue_code,race_date,race_no"});environmentSave=envSaveError?{status:"保存失敗",message:envSaveError.message}:{status:"保存済み"};}}
  const environmentTrend=await (async()=>{const {data:records,error:recordError}=await supabase.from("race_records").select("id,race_date,venue_code,race_no,wind_direction,wind_speed,wave_height").eq("user_id",auth.user.id).eq("venue_code",venueCode).order("race_date",{ascending:false}).limit(500);if(recordError)return {status:"取得失敗",message:recordError.message,sample_count:0,groups:[]};const dated=(records??[]).filter((x:any)=>x.wind_direction||x.wind_speed!=null||x.wave_height!=null);if(!dated.length)return {status:"環境記録なし",sample_count:0,record_count:0,groups:[]};const dates=Array.from(new Set(dated.map((x:any)=>x.race_date).filter(Boolean))).sort();const {data:outcomes,error:outcomeError}=await supabase.from("race_payout_results").select("race_date,venue_code,race_no,result_status,decision_method,winning_course").eq("user_id",auth.user.id).eq("venue_code",venueCode).eq("result_status","fetched").in("race_date",dates.slice(-60));if(outcomeError)return {status:"結果照合失敗",message:outcomeError.message,sample_count:0,record_count:dated.length,groups:[]};const resultByRace=new Map((outcomes??[]).filter((x:any)=>x.winning_course!=null).map((x:any)=>[x.race_date+"|"+x.venue_code+"|"+x.race_no,x]));const raceIds=dated.map((x:any)=>x.id);const {data:entries,error:entryError}=await supabase.from("race_entries").select("race_id,lane,actual_course,finish_rank").eq("user_id",auth.user.id).in("race_id",raceIds);if(entryError)return {status:"出走結果取得失敗",message:entryError.message,sample_count:0,record_count:dated.length,groups:[]};const entriesByRace=new Map<string,any[]>();for(const e of entries??[]){const rows=entriesByRace.get(e.race_id)||[];rows.push(e);entriesByRace.set(e.race_id,rows);}const groups=new Map<string,any>();let matched=0;for(const x of dated){const key=x.race_date+"|"+x.venue_code+"|"+x.race_no;const result=resultByRace.get(key);if(!result)continue;const raceEntries=entriesByRace.get(x.id)||[];const valid=raceEntries.filter((e:any)=>Number.isInteger(Number(e.actual_course))&&Number(e.actual_course)>=1&&Number(e.actual_course)<=6&&Number.isInteger(Number(e.finish_rank))&&Number(e.finish_rank)>=1&&Number(e.finish_rank)<=6);if(valid.length!==6||new Set(valid.map((e:any)=>Number(e.actual_course))).size!==6)continue;const winners=valid.filter((e:any)=>Number(e.finish_rank)===1);if(winners.length!==1||Number(winners[0].actual_course)!==Number(result.winning_course))continue;matched++;const add=(label:string)=>{const g=groups.get(label)||{condition:label,races:0,methods:{},winning_courses:{},course_stats:Object.fromEntries([1,2,3,4,5,6].map((c:number)=>[String(c),{starts:0,wins:0}]))};g.races++;if(result.decision_method)g.methods[result.decision_method]=(g.methods[result.decision_method]||0)+1;const winningCourse=String(result.winning_course);g.winning_courses[winningCourse]=(g.winning_courses[winningCourse]||0)+1;for(const e of valid){const c=String(e.actual_course);g.course_stats[c].starts++;if(Number(e.finish_rank)===1)g.course_stats[c].wins++;}groups.set(label,g);};if(x.wind_direction)add("風向："+x.wind_direction);if(x.wind_speed!=null)add("風速："+(Number(x.wind_speed)<2?"0〜1m":Number(x.wind_speed)<4?"2〜3m":"4m以上"));if(x.wave_height!=null)add("波高："+(Number(x.wave_height)<=2?"0〜2cm":Number(x.wave_height)<=5?"3〜5cm":"6cm以上"));}const rows=Array.from(groups.values()).map((g:any)=>{const methods=Object.entries(g.methods).sort((a:any,b:any)=>b[1]-a[1]);const courses=Object.entries(g.winning_courses).sort((a:any,b:any)=>b[1]-a[1]);const courseRates=Object.entries(g.course_stats).map(([course,v]:any)=>({course:Number(course),starts:Number(v.starts),wins:Number(v.wins),win_rate:Number(v.starts?(v.wins/v.starts*100).toFixed(1):0)}));return {...g,top_method:methods[0]?.[0]??null,top_method_count:methods[0]?.[1]??0,top_course:courses[0]?.[0]??null,top_course_count:courses[0]?.[1]??0,course_win_rates:courseRates,confidence:g.races>=30?"参考傾向（30レース以上）":"サンプル不足"};}).sort((a:any,b:any)=>b.races-a.races);return {status:matched>=30?"集計可能":"データ蓄積中",sample_count:matched,record_count:dated.length,groups:rows,minimum_sample:30,note:"結果取得済みで、1着艇の実際の進入コースと払戻データの勝ちコースが一致したレースだけを集計。コース別1着率は各コースの出走数を分母に算出。30レース未満は参考傾向として扱い、予想評価には反映しません。"};})();
  const attackScenarios=(()=>{const byLane=new Map(boats.map((b:any)=>[Number(b.lane),b]));const inside=byLane.get(1),insideFit=inside?.racer?.course_fit??{},insideAttack=inside?.racer?.attack_profile??{};const outside=boats.filter((b:any)=>Number(b.lane)>=2&&b.racer?.attack_profile?.course?.dominant_method&&Number(b.racer.attack_profile.course.dominant_count)>=3).map((b:any)=>({lane:Number(b.lane),method:b.racer.attack_profile.course.dominant_method,wins:Number(b.racer.attack_profile.course.dominant_count),rate:b.racer.attack_profile.course.dominant_rate,course_fit:b.racer.course_fit?.status??"データ不足",start_average:b.racer.start_prediction?.average??null,start_count:b.racer.start_prediction?.count??0})).sort((a:any,b:any)=>b.wins-a.wins);const scenarios:any[]=[];if(inside){const fit=insideFit.status??"データ不足",st=inside.racer?.start_prediction??{};scenarios.push({id:"inside_escape",title:"1号艇の逃げ",kind:"逃げ",candidate_lanes:[1],support:fit==="コース相性は高め"?"1コースの選手成績が全体成績を上回る":fit==="全体成績と同程度"?"1コース成績は全体成績と同程度":"1コース成績の裏付け不足",course_fit:fit,start_average:st.average??null,start_sample_count:st.count??0,confidence:fit==="データ不足"?"低": "参考",caveat:"スタート・モーター気配・進入が揃わない限り逃げを断定しない"});}for(const x of outside.slice(0,3)){scenarios.push({id:"outside_attack_"+x.lane,title:x.lane+"号艇の"+x.method,kind:x.method,candidate_lanes:[x.lane],support:x.wins+"勝のコース別決まり手データ",course_fit:x.course_fit,start_average:x.start_average,start_sample_count:x.start_count,confidence:x.wins>=5&&x.course_fit!=="データ不足"?"参考":"低",caveat:"攻めが成立するかは内艇のST・進入・モーター気配に左右される"});}return {scenarios,summary:scenarios.length?"選手のコース別成績から作成した展開候補。確定予想ではありません。":"展開候補を作るためのコース別決まり手データが不足しています。"};})();
  timings.calculate_and_save_ms=Date.now()-stageAt;
  timings.total_ms=Date.now()-startedAt;
  return json({timings,date,venue_code:venueCode,venue_name:names[String(venueCode)],race_no:raceNo,boats,attack_scenarios:attackScenarios,environment_context:environmentContext,environment_save:environmentSave,environment_trends:environmentTrend,original_capture:originalCapture,source:"boatraceopenapi-v1",generated_at:new Date().toISOString()});
 }catch(e){return json({error:e instanceof Error?e.message:"処理エラー"},500)}
});