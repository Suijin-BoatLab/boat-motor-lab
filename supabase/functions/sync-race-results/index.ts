import { createClient } from "npm:@supabase/supabase-js@2";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const venues:Record<number,string>={1:"01",2:"02",3:"03",4:"04",5:"05",6:"06",7:"07",8:"08",9:"09",10:"10",11:"11",12:"12",13:"13",14:"14",15:"15",16:"16",17:"17",18:"18",19:"19",20:"20",21:"21",22:"22",23:"23",24:"24"};
type AnyObj=Record<string,unknown>;
const norm=(v:string)=>v.toLowerCase().replace(/[\\s_\\-・]/g,"");
const keyMatch=(obj:AnyObj,aliases:string[])=>{
 const wanted=aliases.map(norm);
 for(const [k,v] of Object.entries(obj))if(wanted.includes(norm(k)))return v;
 return undefined;
};
const walk=(v:unknown,fn:(o:AnyObj)=>void)=>{
 if(Array.isArray(v)){for(const x of v)walk(x,fn);return;}
 if(v&&typeof v==="object"){const o=v as AnyObj;fn(o);for(const x of Object.values(o))walk(x,fn);}
};
const parseDecision=(source:unknown)=>{
 const root=(source&&typeof source==="object"?source:{}) as AnyObj;
 const race=(root.race&&typeof root.race==="object"?root.race:{}) as AnyObj;
 const entries=Array.isArray(root.entries)?root.entries as AnyObj[]:[];
 const directMethod=race.kimarite??race.decision_method??race.kimari??root.decision_method??root.kimarite;
 let method=typeof directMethod==="string"&&directMethod.trim()?directMethod.trim():null;
 let winner=entries.find((entry)=>Number(entry.rank??entry.finish_rank??entry着順)===1)??null;
 if(!winner){
  walk(source,o=>{
   if(!winner){
    const rank=Number(keyMatch(o,["finish_rank","rank","着順","着"]));
    if(rank===1)winner=o;
   }
   if(!method){
    const v=keyMatch(o,["decision_method","kimarite","kimari","決まり手"]);
    if(typeof v==="string"&&v.trim())method=v.trim();
   }
  });
 }
 const registration=winner?(winner.regno??winner.racer_registration_no??winner.registration_no??winner.touban??winner["登録番号"]):undefined;
 const course=winner?Number(winner.course??winner.actual_course??winner.entry_course??winner["進入コース"]??winner["コース"]):NaN;
 return {method,registration:registration===undefined||registration===null?null:String(registration),course:Number.isInteger(course)&&course>=1&&course<=6?course:null,status:method&&winner?"parsed":method?"method_only":"unparsed"};
};
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,"Content-Type":"application/json"}});
 try{
  if(req.method!=="POST")return json({error:"POST only"},405);
  const authHeader=req.headers.get("Authorization")??"",token=authHeader.replace(/^Bearer\s+/i,"");
  if(!token||token===authHeader)return json({error:"ログインが必要です"},401);
  const supabase=createClient(Deno.env.get("SUPABASE_URL")??"",Deno.env.get("SUPABASE_ANON_KEY")??Deno.env.get("SUPABASE_PUBLISHABLE_KEY")??"",{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}});
  const {data:auth,error:authError}=await supabase.auth.getUser(token);
  if(authError||!auth.user)return json({error:"認証を確認できません"},401);
  const body=await req.json(),date=String(body?.date??""),venue=Number(body?.venue_code),race=Number(body?.race_no);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isInteger(venue)||!venues[venue]||!Number.isInteger(race)||race<1||race>12)return json({error:"日付・競艇場・レース番号を確認してください"},400);
  const compact=date.replaceAll("-","");
  const url=`https://boatrace-db.jp/api/race/${compact}/${venues[venue]}/${race}/`;
  const response=await fetch(url,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(12000)});
  if(response.status===404)return json({error:"結果データがまだ公開されていません",source_url:url},404);
  if(!response.ok)return json({error:"結果データ取得失敗 HTTP "+response.status,source_url:url},502);
  const sourceData=await response.json();
  const decision=parseDecision(sourceData);
  const row={user_id:auth.user.id,race_date:date,venue_code:venue,race_no:race,source_name:"boatrace-db.jp",source_data:sourceData,result_status:"fetched",decision_method:decision.method,winning_racer_registration_no:decision.registration,winning_course:decision.course,decision_parse_status:decision.status,decision_parsed_at:new Date().toISOString(),fetched_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  const {data:saved,error:saveError}=await supabase.from("race_payout_results").upsert(row,{onConflict:"user_id,race_date,venue_code,race_no"}).select("id,race_date,venue_code,race_no,result_status,fetched_at").single();
  if(saveError)return json({error:"取得データの保存に失敗: "+saveError.message},500);
  return json({success:true,saved,decision_parse_status:decision.status,decision_method:decision.method,winning_racer_registration_no:decision.registration,winning_course:decision.course,source_url:url,source_data:sourceData,notice:"データ提供：艇愛ボートレースDB"});
 }catch(e){return json({error:e instanceof Error?e.message:"処理エラー"},500)}
});