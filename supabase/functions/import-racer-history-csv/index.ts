import { createClient } from "npm:@supabase/supabase-js@2";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const venueNames: Record<string,number> = {
 "桐生":1,"戸田":2,"江戸川":3,"平和島":4,"多摩川":5,"浜名湖":6,"蒲郡":7,"常滑":8,"津":9,"三国":10,"びわこ":11,"住之江":12,
 "尼崎":13,"鳴門":14,"丸亀":15,"児島":16,"宮島":17,"徳山":18,"下関":19,"若松":20,"芦屋":21,"福岡":22,"唐津":23,"大村":24
};
const aliases: Record<string,string[]> = {
 date:["race_date","date","開催日","日付"],
 venue:["venue_code","venue","stadium","競艇場","場"],
 venue_name:["venue_name","競艇場名","場名"],
 race:["race_no","race_number","race","レース","レース番号"],
 lane:["lane","艇番","枠番","枠"],
 name:["racer_name","name","選手名"],
 reg:["racer_registration_no","registration_no","regno","touban","登録番号","選手登録番号"],
 course:["actual_course","course","進入","進入コース"],
 rank:["finish_rank","rank","place_number","着順","着"],
 st:["actual_st","start_timing","st","本番ST","スタートタイミング"],
 method:["decision_method","kimarite","kimari","決まり手","決り手"]
};
const norm=(s:string)=>s.replace(/^\uFEFF/,"").trim().toLowerCase().replace(/[\s　_-]/g,"");
function parseCsv(input:string):string[][] {
 const out:string[][]=[]; let row:string[]=[], cell="", quoted=false;
 for(let i=0;i<input.length;i++){
  const c=input[i];
  if(quoted){if(c==='"'&&input[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}
  else if(c==='"')quoted=true;
  else if(c===","){row.push(cell);cell="";}
  else if(c==="\n"){row.push(cell);out.push(row);row=[];cell="";}
  else if(c!=="\r")cell+=c;
 }
 row.push(cell); if(row.some(x=>x.trim()))out.push(row); return out;
}
function get(row:Record<string,string>,key:string){for(const a of aliases[key]||[]){const v=row[norm(a)];if(v!==undefined&&v.trim()!=="")return v.trim();}return "";}
function dateOk(s:string){return /^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s+"T00:00:00Z"))&&new Date(s+"T00:00:00Z").toISOString().slice(0,10)===s;}
function int(v:string,min:number,max:number){const n=Number(v);return Number.isInteger(n)&&n>=min&&n<=max?n:null;}
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
 try{
  if(req.method!=="POST")return json({error:"POST only"},405);
  const authHeader=req.headers.get("Authorization")??"";
  const token=authHeader.replace(/^Bearer\s+/i,"");
  if(!token||token===authHeader)return json({error:"ログインが必要です"},401);
  const supabase=createClient(Deno.env.get("SUPABASE_URL")??"",Deno.env.get("SUPABASE_ANON_KEY")??Deno.env.get("SUPABASE_PUBLISHABLE_KEY")??"",{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}});
  const {data:auth,error:authError}=await supabase.auth.getUser(token);
  if(authError||!auth.user)return json({error:"認証を確認できません"},401);
  const body=await req.json(); const csv=String(body?.csv??"");
  if(!csv.trim())return json({error:"CSVデータが空です"},400);
  if(csv.length>12_000_000)return json({error:"CSVが大きすぎます。12MB以下にしてください"},413);
  const matrix=parseCsv(csv); if(matrix.length<2)return json({error:"見出し行とデータ行が必要です"},400);
  const headers=matrix[0].map(norm);
  const rows:any[]=[]; const errors:string[]=[];
  for(let i=1;i<matrix.length;i++){
   const vals=matrix[i]; if(!vals.some(v=>v.trim()))continue;
   const obj:Record<string,string>={}; headers.forEach((h,j)=>obj[h]=vals[j]??"");
   const date=get(obj,"date"),venueRaw=get(obj,"venue"),venueName=get(obj,"venue_name"),venueCode=int(venueRaw,1,24)??venueNames[venueRaw]??venueNames[venueName]??null;
   const raceRaw=get(obj,"race").replace(/R$/i,""),race=int(raceRaw,1,12),lane=int(get(obj,"lane"),1,6);
   const reg=get(obj,"reg"),rank=int(get(obj,"rank"),1,6),course=int(get(obj,"course"),1,6);
   const stRaw=get(obj,"st"),isF=/^F/i.test(stRaw),st=stRaw&&!isF&&Number.isFinite(Number(stRaw))?Number(stRaw):null;
   if(!dateOk(date)||!venueCode||!race||!lane||!reg){errors.push((i+1)+"行目：日付・競艇場・レース・艇番・登録番号を確認してください");continue;}
   if(stRaw&&!isF&&st===null){errors.push((i+1)+"行目：STの形式を確認してください");continue;}
   rows.push({
    user_id:auth.user.id,race_date:date,venue_code:venueCode,venue_name:venueName||Object.keys(venueNames).find(k=>venueNames[k]===venueCode)||String(venueCode),
    race_no:race,lane,racer_name:get(obj,"name")||null,racer_registration_no:reg,
    actual_course:course,finish_rank:rank,actual_st:st,actual_st_raw:stRaw||null,actual_st_is_f:isF,
    decision_method:rank===1?(get(obj,"method")||null):null,source_name:"csv-import",
    source_data:{csv_row:i+1,original:obj},imported_at:new Date().toISOString(),updated_at:new Date().toISOString()
   });
  }
  if(errors.length)return json({error:"CSVに不備があります。修正して再取込してください。",invalid_rows:errors.slice(0,30),valid_rows:rows.length},400);
  if(!rows.length)return json({error:"取り込めるデータ行がありません"},400);
  let saved=0;
  for(let offset=0;offset<rows.length;offset+=300){
   const batch=rows.slice(offset,offset+300);
   const {error}=await supabase.from("historical_racer_entries").upsert(batch,{onConflict:"user_id,race_date,venue_code,race_no,lane"});
   if(error)return json({error:"保存に失敗しました："+error.message,saved_before_error:saved},500);
   saved+=batch.length;
  }
  return json({saved,skipped:0,source:"csv-import",message:"選手別履歴をクラウドに保存しました"});
 }catch(e){return json({error:e instanceof Error?e.message:"処理エラー"},500);}
});