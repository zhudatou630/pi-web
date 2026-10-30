import { researchHome,researchService } from "@/lib/research-service";
import { researchRunPattern,parseResearchLog,sanitizeResearchValue } from "@/lib/research-observer";
import { readResearchLogTail } from "@/lib/research-observer-log";

export const runtime="nodejs";
export const dynamic="force-dynamic";

// GET only. This endpoint cannot start, resume, acknowledge or prompt a task.
export async function GET(_request: Request, context: {params:Promise<{runId:string}>}) {
  const {runId}=await context.params;
  if (!researchRunPattern.test(runId)) return Response.json({error:"Invalid research run"},{status:400});
  try {
    const service=await researchService();
    const response=await fetch(`${service.url}/v1/runs/${runId}`,{headers:{Authorization:`Bearer ${service.token}`},cache:"no-store",signal:AbortSignal.timeout(15_000)});
    if (!response.ok) return Response.json({error:response.status===404?"研究任务不存在":"读取研究任务失败"},{status:response.status});
    const run=await response.json();
    const artifacts=((run.artifacts || []) as {path:string;size:number}[]).filter(file=>
      typeof file.path==="string" && /^(rounds|logs|workspace\/paper\/build|workspace\/swebench)\//.test(file.path)
      && !file.path.split(/[\\/]/).some(part=>part===".." || part===".env" || part.startsWith(".env.")));
    const recent=artifacts.filter(p=>/^logs\/[A-Za-z0-9_.-]+\.(out|err)$/.test(p.path) && p.size>0).sort((a,b)=>b.path.localeCompare(a.path));
    const names=[...new Set([run.active_log,...recent.map(p=>p.path)].filter((name):name is string=>typeof name==="string" && /^logs\/[A-Za-z0-9_.-]+\.(out|err)$/.test(name)))].slice(0,6);
    const logs=await Promise.all(names.map(async name=>{
      try {const tail=await readResearchLogTail(researchHome(),runId,name);return {records:parseResearchLog(tail.text.replaceAll(service.token,"[REDACTED_SERVICE_TOKEN]"),name,tail.offset),truncated:tail.truncated};}
      catch {return {records:[],truncated:false,unavailable:name};}
    }));
    const {id,title,status,stage,round,model_calls,claude_cost_usd,heartbeat,human,rounds,final_artifact,benchmark}=run;
    const data=sanitizeResearchValue({run:{id,title,status,stage,round,model_calls,claude_cost_usd,heartbeat,human,rounds,final_artifact,benchmark,
      config:{executor:run.config?.executor,max_rounds:run.config?.max_rounds,role_models:run.config?.role_models}},
      events:(run.events || []).slice(-200),artifacts,
      records:logs.flatMap(log=>log.records).sort((a,b)=>a.at-b.at).slice(-160),
      truncated:logs.some(log=>log.truncated),unavailable:logs.flatMap(log=>log.unavailable?[log.unavailable]:[]),read_only:true},service.token);
    return Response.json(data,{headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  } catch {return Response.json({error:"观察数据暂时不可用，后台任务不受此窗口影响。"},{status:503});}
}
