import { createClient } from "npm:@supabase/supabase-js@2";
import { buildDecisionMethodStats } from "./decision-methods.ts";
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
  const body=await req.json(),date=String(body?.date??""),venueCode=Number(body?.venue_code),raceNo=Number(body?.race_no);
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
  const courseStatsByNo=new Map<string,Map<number,any>>();
  const racerStatsByNo=new Map<string,any>();
  const racerHistorySeen=new Set<string>();
  const racerRankSeen=new Set<string>();
  const racerStSeen=new Set<string>();
  const courseHistorySeen=new Set<string>();
  const courseStSeen=new Set<string>();
  const registrationNos=[...new Set(Array.from({length:6},(_,i)=>String(racers[String(i+1)]?.number??racers[String(i+1)]?.registration_number??"").trim()).filter(x=>/^\d+$/.test(x)))];
  const racerMinDate=new Date(Date.parse(date+"T00:00:00Z")-180*86400000).toISOString().slice(0,10);
  const racer90MinDate=new Date(Date.parse(date+"T00:00:00Z")-90*86400000).toISOString().slice(0,10);
  if(registrationNos.length){
   let racerOffset=0;
   while(true){
    const {data:racerPage,error:racerError}=await supabase.from("historical_motor_entries").select("id,race_date,venue_code,venue_name,race_no,racer_registration_no,finish_rank,actual_course,actual_st,actual_st_is_f").eq("user_id",auth.user.id).in("racer_registration_no",registrationNos).lt("race_date",date).order("race_date",{ascending:false}).order("race_no",{ascending:false}).order("id",{ascending:false}).range(racerOffset,racerOffset+999);
    if(racerError)return json({error:"選手履歴取得失敗: "+racerError.message},500);
    for(const row of racerPage??[]){
     const reg=String(row.racer_registration_no),key=[reg,row.race_date,row.venue_code,row.race_no].join(':');racerHistorySeen.add(key);
     const actualCourse=Number(row.actual_course),courseRank=Number(row.finish_rank);
     if(Number.isInteger(actualCourse)&&actualCourse>=1&&actualCourse<=6){
      const byCourse=courseStatsByNo.get(reg)??new Map<number,any>();
      const cs=byCourse.get(actualCourse)??{starts:0,wins:0,top2:0,top3:0,finishSum:0,stSum:0,stCount:0};
      if(!courseHistorySeen.has(key)&&Number.isInteger(courseRank)&&courseRank>=1&&courseRank<=6){
       courseHistorySeen.add(key);
       cs.starts++;if(courseRank===1)cs.wins++;if(courseRank<=2)cs.top2++;if(courseRank<=3)cs.top3++;cs.finishSum+=courseRank;
      }
      const courseSt=num(row.actual_st);
      if(!courseStSeen.has(key)&&!row.actual_st_is_f&&courseSt!==null&&courseSt>=0&&courseSt<=0.99){
       courseStSeen.add(key);cs.stSum+=courseSt;cs.stCount++;
      }
      byCourse.set(actualCourse,cs);courseStatsByNo.set(reg,byCourse);
     }
     const s=racerStatsByNo.get(reg)??{starts:0,wins:0,top2:0,top3:0,finishSum:0,starts90:0,wins90:0,top2_90:0,top3_90:0,finishSum90:0,stRows:[],venueStRows:[],recentRaces:[]};
     const rank=Number(row.finish_rank);
     if(Number.isInteger(rank)&&rank>=1&&rank<=6){racerRankSeen.add(key);s.starts++;if(rank===1)s.wins++;if(rank<=2)s.top2++;if(rank<=3)s.top3++;s.finishSum+=rank;if(row.race_date>=racer90MinDate){s.starts90++;if(rank===1)s.wins90++;if(rank<=2)s.top2_90++;if(rank<=3)s.top3_90++;s.finishSum90+=rank;}}
     const actualSt=num(row.actual_st);
     s.recentRaces.push({date:row.race_date,race_no:Number(row.race_no)||0,venue_code:Number(row.venue_code)||0,venue_name:row.venue_name??names[String(row.venue_code)]??"場不明",st:!row.actual_st_is_f&&actualSt!==null&&actualSt>=0&&actualSt<=0.99?actualSt:null,is_f:!!row.actual_st_is_f});
     if(!row.actual_st_is_f&&actualSt!==null&&actualSt>=0&&actualSt<=0.99){
      racerStSeen.add(key);
      const stRow={date:row.race_date,race_no:Number(row.race_no)||0,venue_code:Number(row.venue_code)||0,venue_name:row.venue_name??names[String(row.venue_code)]??"場不明",st:actualSt};
      s.stRows.push(stRow);
      if(Number(row.venue_code)===venueCode&&row.race_date>=racerMinDate)s.venueStRows.push(stRow);
     }
     racerStatsByNo.set(reg,s);
    }
    if(!racerPage||racerPage.length<1000)break;
    racerOffset+=racerPage.length;
   }
   let importedOffset=0;
   while(true){
    const {data:importedPage,error:importedError}=await supabase.from("historical_racer_entries").select("id,race_date,venue_code,venue_name,race_no,lane,racer_registration_no,actual_course,finish_rank,actual_st,actual_st_is_f").eq("user_id",auth.user.id).in("racer_registration_no",registrationNos).lt("race_date",date).order("race_date",{ascending:false}).order("race_no",{ascending:false}).order("id",{ascending:false}).range(importedOffset,importedOffset+999);
    if(importedError)return json({error:"CSV選手履歴取得失敗: "+importedError.message},500);
    for(const row of importedPage??[]){
     const reg=String(row.racer_registration_no),key=[reg,row.race_date,row.venue_code,row.race_no].join(':');
     const actualCourse=Number(row.actual_course),rankForCourse=Number(row.finish_rank);
     if(Number.isInteger(actualCourse)&&actualCourse>=1&&actualCourse<=6){
      const byCourse=courseStatsByNo.get(reg)??new Map<number,any>();
      const cs=byCourse.get(actualCourse)??{starts:0,wins:0,top2:0,top3:0,finishSum:0,stSum:0,stCount:0};
      if(!courseHistorySeen.has(key)&&Number.isInteger(rankForCourse)&&rankForCourse>=1&&rankForCourse<=6){
       courseHistorySeen.add(key);
       cs.starts++;if(rankForCourse===1)cs.wins++;if(rankForCourse<=2)cs.top2++;if(rankForCourse<=3)cs.top3++;cs.finishSum+=rankForCourse;
      }
      const courseSt=num(row.actual_st);
      if(!courseStSeen.has(key)&&!row.actual_st_is_f&&courseSt!==null&&courseSt>=0&&courseSt<=0.99){
       courseStSeen.add(key);cs.stSum+=courseSt;cs.stCount++;
      }
      byCourse.set(actualCourse,cs);courseStatsByNo.set(reg,byCourse);
     }
     const alreadySeen=racerHistorySeen.has(key);
     if(alreadySeen&&racerRankSeen.has(key)&&racerStSeen.has(key))continue;
     racerHistorySeen.add(key);
     const s=racerStatsByNo.get(reg)??{starts:0,wins:0,top2:0,top3:0,finishSum:0,starts90:0,wins90:0,top2_90:0,top3_90:0,finishSum90:0,stRows:[],venueStRows:[],recentRaces:[]};
     const rank=Number(row.finish_rank);
     if(!racerRankSeen.has(key)&&Number.isInteger(rank)&&rank>=1&&rank<=6){racerRankSeen.add(key);s.starts++;if(rank===1)s.wins++;if(rank<=2)s.top2++;if(rank<=3)s.top3++;s.finishSum+=rank;if(row.race_date>=racer90MinDate){s.starts90++;if(rank===1)s.wins90++;if(rank<=2)s.top2_90++;if(rank<=3)s.top3_90++;s.finishSum90+=rank;}}
     const actualSt=num(row.actual_st);
     const validSt=!row.actual_st_is_f&&actualSt!==null&&actualSt>=0&&actualSt<=0.99;
     let recent=s.recentRaces.find((x:any)=>x.date===row.race_date&&x.race_no===(Number(row.race_no)||0)&&x.venue_code===(Number(row.venue_code)||0));
     if(!recent){recent={date:row.race_date,race_no:Number(row.race_no)||0,venue_code:Number(row.venue_code)||0,venue_name:row.venue_name??names[String(row.venue_code)]??"場不明",st:null,is_f:!!row.actual_st_is_f};s.recentRaces.push(recent);}
     if(!racerStSeen.has(key)&&validSt){
      racerStSeen.add(key);recent.st=actualSt;recent.is_f=false;
      const stRow={date:row.race_date,race_no:Number(row.race_no)||0,venue_code:Number(row.venue_code)||0,venue_name:row.venue_name??names[String(row.venue_code)]??"場不明",st:actualSt};
      s.stRows.push(stRow);if(Number(row.venue_code)===venueCode&&row.race_date>=racerMinDate)s.venueStRows.push(stRow);
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
   s.start_time={last10:{average:avgSt(last10),count:last10.length,races:last10Races.length},last90d:{average:avgSt(last90),count:last90.length},venue:{average:avgSt(s.venueStRows),count:s.venueStRows.length,venue_code:venueCode,venue_name:names[String(venueCode)]},last10_rows:last10,last10_races:last10Races};
  }
  const importedDecisionRows:any[]=[],payoutDecisionRows:any[]=[];
  if(registrationNos.length){
   let importedDecisionOffset=0;
   while(true){
    const {data:importedDecisionPage,error:importedDecisionError}=await supabase.from("historical_racer_entries").select("race_date,venue_code,race_no,racer_registration_no,finish_rank,decision_method,actual_course").eq("user_id",auth.user.id).in("racer_registration_no",registrationNos).lt("race_date",date).gte("race_date",racer90MinDate).eq("finish_rank",1).not("decision_method","is",null).order("race_date",{ascending:false}).range(importedDecisionOffset,importedDecisionOffset+999);
    if(importedDecisionError)return json({error:"CSV決まり手履歴取得失敗: "+importedDecisionError.message},500);
    importedDecisionRows.push(...(importedDecisionPage??[]));
    if(!importedDecisionPage||importedDecisionPage.length<1000)break;
    importedDecisionOffset+=importedDecisionPage.length;
   }
   let decisionOffset=0;
   while(true){
    const {data:decisionPage,error:decisionError}=await supabase.from("race_payout_results").select("race_date,venue_code,race_no,winning_racer_registration_no,decision_method,winning_course").eq("user_id",auth.user.id).in("winning_racer_registration_no",registrationNos).lt("race_date",date).gte("race_date",racer90MinDate).not("decision_method","is",null).order("race_date",{ascending:false}).range(decisionOffset,decisionOffset+999);
    if(decisionError)return json({error:"決まり手履歴取得失敗: "+decisionError.message},500);
    payoutDecisionRows.push(...(decisionPage??[]));
    if(!decisionPage||decisionPage.length<1000)break;
    decisionOffset+=decisionPage.length;
   }
  }
  const decisionByNo=buildDecisionMethodStats(importedDecisionRows,payoutDecisionRows,registrationNos);
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
   const registrationNo=String(b.number??b.registration_number??"").trim()||null;const racerHistory=registrationNo?racerStatsByNo.get(registrationNo)??{starts:0,wins:0,top2:0,top3:0,average_finish:null,starts90:0,wins90:0,top2_90:0,top3_90:0,finishSum90:0,start_time:null}:null;const racer={name:b.racer_name??b.name??null,registration_no:registrationNo,class:b.rank_number??null,branch:b.branch_number??null,national_win_rate:num(b.national_win_rate),national_place_rate:num(b.national_place_rate),local_win_rate:num(b.local_win_rate),local_place_rate:num(b.local_place_rate),decision_methods:registrationNo?decisionByNo.get(registrationNo)??{wins:0,by_method:{},method_rate:{},by_course:{}}:null,course_stats:registrationNo?Object.fromEntries([...(courseStatsByNo.get(registrationNo)??new Map()).entries()].map(([course,cs]:any)=>[String(course),{starts:cs.starts,wins:cs.wins,win_rate:cs.starts?cs.wins/cs.starts:null,top2:cs.top2,top2_rate:cs.starts?cs.top2/cs.starts:null,top3:cs.top3,top3_rate:cs.starts?cs.top3/cs.starts:null,average_finish:cs.starts?cs.finishSum/cs.starts:null,average_st:cs.stCount?cs.stSum/cs.stCount:null,st_count:cs.stCount}])):{},start_time:racerHistory?.start_time??null,history_90d:racerHistory?{starts:racerHistory.starts90,wins:racerHistory.wins90,win_rate:racerHistory.starts90?racerHistory.wins90/racerHistory.starts90:null,top2:racerHistory.top2_90,top2_rate:racerHistory.starts90?racerHistory.top2_90/racerHistory.starts90:null,top3:racerHistory.top3_90,top3_rate:racerHistory.starts90?racerHistory.top3_90/racerHistory.starts90:null,average_finish:racerHistory.starts90?racerHistory.finishSum90/racerHistory.starts90:null}:null};
   const original=originalByLane[lane]??{};
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
  timings.calculate_and_save_ms=Date.now()-stageAt;
  timings.total_ms=Date.now()-startedAt;
  return json({timings,date,venue_code:venueCode,venue_name:names[String(venueCode)],race_no:raceNo,boats,original_capture:originalCapture,source:"boatraceopenapi-v1",generated_at:new Date().toISOString()});
 }catch(e){return json({error:e instanceof Error?e.message:"処理エラー"},500)}
});