import { createClient } from "npm:@supabase/supabase-js@2";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const venueNames:Record<string,number>={"桐生":1,"戸田":2,"江戸川":3,"平和島":4,"多摩川":5,"浜名湖":6,"蒲郡":7,"常滑":8,"津":9,"三国":10,"びわこ":11,"住之江":12,"尼崎":13,"鳴門":14,"丸亀":15,"児島":16,"宮島":17,"徳山":18,"下関":19,"若松":20,"芦屋":21,"福岡":22,"唐津":23,"大村":24};
const norm=(s:string)=>s.replace(/^\uFEFF/,"").trim().toLowerCase().replace(/[\s　_-]/g,"");
function parseCsv(input:string):string[][]{const out:string[][]=[];let row:string[]=[],cell="",quoted=false;for(let i=0;i<input.length;i++){const c=input[i];if(quoted){if(c==='"'&&input[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}else if(c==='"')quoted=true;else if(c===","){row.push(cell);cell="";}else if(c==="\n"){row.push(cell);out.push(row);row=[];cell="";}else if(c!=="\r")cell+=c;}row.push(cell);if(row.some(x=>x.trim()))out.push(row);return out;}
const aliases:Record<string,string[]>={date:["race_date","date","開催日","日付","レース日","年月日","開催年月日"],venue:["venue_code","venue","stadium","stadium_name","stadium_code","venue_name","競艇場","場","場名","場コード","競艇場コード","レース場コード","レース場"],race:["race_no","race_number","r","R","race","レース番号","レース回","レースR","レース"],lane:["lane","boat","boat_no","boat_number","艇番","艇","枠番","枠"],name:["racer_name","name","選手名"],course:["actual_course","course","進入","進入コース","コース"],rank:["finish_rank","rank","着順","着"],st:["actual_st","start_timing","st","本番ST","スタートタイミング"],method:["decision_method","kimarite","kimari","決まり手","決り手","決まり手名"]};
function pick(o:Record<string,string>,key:string){for(const a of aliases[key]||[]){const v=o[norm(a)];if(v!==undefined&&v.trim()!=="")return v.trim();}return "";}
function dateNorm(s:string){const v=s.trim().replace(/[/.]/g,"-");if(/^\d{8}$/.test(v))return v.slice(0,4)+"-"+v.slice(4,6)+"-"+v.slice(6,8);return v;}
function validDate(s:string){return /^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s+"T00:00:00Z"))&&new Date(s+"T00:00:00Z").toISOString().slice(0,10)===s;}
function int(s:string,min:number,max:number){const n=Number(String(s).replace(/R$/i,""));return Number.isInteger(n)&&n>=min&&n<=max?n:null;}
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{...cors,"Content-Type":"application/json"}});
 try{
  if(req.method!=="POST")return json({error:"POST only"},405);
  const ah=req.headers.get("Authorization")??"",token=ah.replace(/^Bearer\s+/i,"");
  if(!token||token===ah)return json({error:"ログインが必要です"},401);
  const supabase=createClient(Deno.env.get("SUPABASE_URL")??"",Deno.env.get("SUPABASE_ANON_KEY")??Deno.env.get("SUPABASE_PUBLISHABLE_KEY")??"",{global:{headers:{Authorization:ah}},auth:{persistSession:false}});
  const {data:auth,error:ae}=await supabase.auth.getUser(token);if(ae||!auth.user)return json({error:"認証を確認できません"},401);
  const body=await req.json(),regs=[...new Set((Array.isArray(body?.registration_numbers)?body.registration_numbers:[]).map((x:unknown)=>String(x).replace(/\D/g,"")).filter((x:string)=>/^\d{4}$/.test(x)))];
  const from=dateNorm(String(body?.from_date??"")),to=dateNorm(String(body?.to_date??""));
  if(!regs.length||regs.length>6)return json({error:"選択中レースの登録番号を1〜6名指定してください"},400);
  if(!validDate(from)||!validDate(to)||from>to)return json({error:"期間を正しく指定してください"},400);
  const span=Math.round((Date.parse(to+"T00:00:00Z")-Date.parse(from+"T00:00:00Z"))/86400000)+1;if(span>180)return json({error:"一度に取得できる期間は最大180日です"},400);
  const rows:any[]=[];const diagnostics:any[]=[];let totalSourceRows=0;
  for(const reg of regs){
   const response=await fetch("https://boatrace-db.jp/api/racer/"+reg+"/results/");
   if(!response.ok)return json({error:"選手履歴APIの取得に失敗しました",registration_no:reg,status:response.status},502);
   const raw=await response.text(),matrix=parseCsv(raw);
   if(matrix.length<2){diagnostics.push({registration_no:reg,source_rows:0,headers:matrix[0]??[]});continue;}
   const headers=matrix[0].map(norm),parsed=matrix.slice(1).filter(r=>r.some(v=>v.trim()));
   totalSourceRows+=parsed.length;
   const sample:Record<string,string>={};headers.forEach((h,i)=>sample[h]="");
   const has=(key:string)=>aliases[key].some(a=>headers.includes(norm(a)));
   if(!has("date")||!has("venue")||!has("race")||!has("lane"))return json({error:"選手履歴CSVの列名を確認する必要があります。まだ保存していません。",registration_no:reg,headers:matrix[0],required:{date:has("date"),venue:has("venue"),race:has("race"),lane:has("lane")}},422);
   let matched=0,invalidDate=0,outsideDate=0,invalidRaceKeys=0;
   const sampleRows=parsed.slice(0,2).map(r=>Object.fromEntries(headers.slice(0,12).map((h,i)=>[h,r[i]??""])));
   for(let idx=0;idx<parsed.length;idx++){
    const obj:Record<string,string>={};headers.forEach((h,i)=>obj[h]=parsed[idx][i]??"");
    const rawDate=pick(obj,"date"),date=dateNorm(rawDate);
    if(!validDate(date)){invalidDate++;continue;}
    if(date<from||date>to){outsideDate++;continue;}
    const venueRaw=pick(obj,"venue"),venueCode=int(venueRaw,1,24)??venueNames[venueRaw]??null;
    const race=int(pick(obj,"race"),1,12),lane=int(pick(obj,"lane"),1,6);
    if(!venueCode||!race||!lane){invalidRaceKeys++;continue;}
    const rankRaw=pick(obj,"rank"),rank=int(rankRaw,1,6),stRaw=pick(obj,"st"),isF=/^F/i.test(stRaw)||Number(stRaw)<0,st=stRaw&&!isF&&Number.isFinite(Number(stRaw))?Number(stRaw):null;
    const course=int(pick(obj,"course"),1,6),name=pick(obj,"name"),method=pick(obj,"method");
    rows.push({user_id:auth.user.id,race_date:date,venue_code:venueCode,venue_name:venueRaw&&!/^\d+$/.test(venueRaw)?venueRaw:Object.keys(venueNames).find(k=>venueNames[k]===venueCode)||String(venueCode),race_no:race,lane,racer_name:name||null,racer_registration_no:reg,actual_course:course,finish_rank:rank,actual_st:st,actual_st_raw:stRaw||null,actual_st_is_f:isF,decision_method:rank===1?(method||null):null,source_name:"boatrace-db.jp-api",source_data:{source:"艇愛ボートレースDB racer results API"},imported_at:new Date().toISOString(),updated_at:new Date().toISOString()});
    matched++;
   }
   diagnostics.push({registration_no:reg,source_rows:parsed.length,matched_rows:matched,invalid_date_rows:invalidDate,outside_date_rows:outsideDate,invalid_race_key_rows:invalidRaceKeys,headers:matrix[0],sample_rows:sampleRows});
  }
  if(!rows.length)return json({saved:0,source_rows:totalSourceRows,diagnostics,message:"指定期間内に取り込める履歴がありませんでした。"});
  let saved=0;
  for(let i=0;i<rows.length;i+=300){const {error}=await supabase.from("historical_racer_entries").upsert(rows.slice(i,i+300),{onConflict:"user_id,race_date,venue_code,race_no,lane"});if(error)return json({error:"保存に失敗しました："+error.message,saved_before_error:saved},500);saved+=Math.min(300,rows.length-i);}
  return json({saved,source_rows:totalSourceRows,diagnostics,source:"艇愛ボートレースDB",message:"選択した選手の履歴を保存しました。"});
 }catch(e){return json({error:e instanceof Error?e.message:"処理エラー"},500);}
});