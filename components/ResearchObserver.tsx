"use client";

import {useEffect,useRef,useState} from "react";
import {useRouter} from "next/navigation";
import type {ResearchRecord} from "@/lib/research-observer";
import styles from "./ResearchObserver.module.css";

type Run={id:string;title:string;status:string;stage:string;round:number;model_calls:number;claude_cost_usd:number;model_activity?:Record<string,{last_progress_at:number}>;
  config:{executor:string;max_rounds:number;role_models?:Record<string,string>};
  human?:{kind?:string;reason?:string;requested_action?:string}|null;
  rounds?:{round:number;path?:string;scores?:number[];stop_reason?:string}[];final_artifact?:string};
type Snapshot={run:Run;events:{seq:number;at:number;kind:string;message:string}[];records:ResearchRecord[];
  artifacts:{path:string;size:number}[];unavailable:string[];truncated:boolean;read_only:true};
const names:Record<string,string>={reviewing:"独立 APR 审稿",running:"运行中",queued:"排队中",paused:"已暂停",waiting_human:"需要人工处理",failed:"运行失败",
  completed:"通过质量门槛",validation_completed:"闭环验证完成",benchmark_completed:"实验任务执行结束",budget_exhausted:"达到运行上限",cancelled:"已取消",
  planning:"设计实验",experiments:"执行实验",approval:"确认研究方向",confirming:"确认研究方向",drafting:"APD 写作",evaluating:"归档与反馈分流",verification:"核验论文",packaging:"交付归档",benchmark_packaging:"核验与打包"};
const time=(at:number)=>at?new Date(at*1000).toLocaleTimeString():"";
export function ResearchObserver({selection}:{selection:string}) {
  const router=useRouter();const [runId,setRunId]=useState(selection==="latest"?null:selection);
  const [runs,setRuns]=useState<{id:string;title:string;status:string}[]>([]);
  const [data,setData]=useState<Snapshot|null>(null);const [error,setError]=useState("");
  const [view,setView]=useState<"execution"|"workflow"|"artifacts">("execution");const [follow,setFollow]=useState(true);
  const [updated,setUpdated]=useState("");const end=useRef<HTMLDivElement>(null);const selectionRef=useRef(selection);selectionRef.current=selection;
  useEffect(()=>{setData(null);setError("");setRunId(selection==="latest"?null:selection);},[selection]);
  useEffect(()=>{
    const abort=new AbortController();let busy=false;
    async function list(){if(busy)return;busy=true;try{
      const response=await fetch("/api/research/runs",{cache:"no-store",signal:abort.signal});if(!response.ok)throw new Error("无法读取研究任务列表");
      const body=await response.json();const items=body.runs || [];setRuns(items.map((run:Run)=>({id:run.id,title:run.title,status:run.status})));
      if(selectionRef.current==="latest")setRunId(current=>current || (items.find((run:Run)=>["running","queued"].includes(run.status)) || items[0])?.id || null);
    }catch(error){if(!abort.signal.aborted)setError(error instanceof Error?error.message:"读取任务失败");}finally{busy=false;}}
    void list();const timer=window.setInterval(()=>void list(),15_000);return()=>{abort.abort();window.clearInterval(timer);};
  },[]);
  useEffect(()=>{
    if(!runId)return;const abort=new AbortController();let busy=false;
    async function poll(){if(busy)return;busy=true;try{
      const response=await fetch(`/api/research/observer/${runId}`,{cache:"no-store",signal:abort.signal});const body=await response.json();
      if(!response.ok)throw new Error(body.error || "读取观察数据失败");if(abort.signal.aborted)return;
      setData(body);setError("");setUpdated(new Date().toLocaleTimeString());
    }catch(error){if(!abort.signal.aborted)setError(error instanceof Error?error.message:"连接暂时中断");}finally{busy=false;}}
    void poll();const timer=window.setInterval(()=>void poll(),3000);const visible=()=>{if(!document.hidden)void poll();};document.addEventListener("visibilitychange",visible);
    return()=>{abort.abort();window.clearInterval(timer);document.removeEventListener("visibilitychange",visible);};
  },[runId]);
  const fingerprint=data?.records.map(record=>record.id).join("|");
  useEffect(()=>{if(follow&&view==="execution")end.current?.scrollIntoView({block:"end"});},[fingerprint,follow,view]);
  const run=data?.run;const detail=runId?`/research?run=${encodeURIComponent(runId)}`:"/research";
  const artifact=(path:string)=>`/api/research/runs/${runId}/artifact?path=${encodeURIComponent(path)}`;
  const papers=(data?.artifacts || []).filter(file=>/\.(pdf|tex|csv|zip)$/i.test(file.path));
  return <section className={styles.root} aria-label="Research Loop 只读观察">
    <header className={styles.header}>
      <div><h2>{run?.title || "Research Loop 研究观察"}</h2><p>只读同步 · 同一后台任务 · {updated?`同步于 ${updated}`:"正在连接"}</p></div>
      <nav><a href={detail} target="_blank" rel="noreferrer">研究详情与人工处理 ↗</a><button type="button" onClick={()=>router.replace("/",{scroll:false})}>返回聊天</button></nav>
    </header>
    <div className={styles.controls}>
      <label>研究任务<select aria-label="观察的研究任务" value={runId || ""} onChange={event=>router.replace(`/?research=${encodeURIComponent(event.target.value)}`,{scroll:false})}>
        {!runs.length && <option value={runId || ""}>{run?.title || "暂无研究任务"}</option>}
        {runs.map(item=><option key={item.id} value={item.id}>{item.title} · {names[item.status] || item.status}</option>)}
      </select></label>
      {run&&<p><span>{names[run.status] || run.status}</span> · 第 {run.round}/{run.config.max_rounds} 轮 · {names[run.stage] || run.stage}</p>}
      {run?.status === "running" && Object.keys(run.model_activity || {}).length > 0 && <p role="status">模型请求进行中 · 最近活动 {new Date(Math.max(...Object.values(run.model_activity || {}).map(item => item.last_progress_at)) * 1000).toLocaleTimeString()} · 持续输出时继续等待</p>}
      <div role="tablist" aria-label="研究记录类型">{([["execution","执行过程"],["workflow","流程记录"],["artifacts","论文与产物"]] as const).map(([key,title])=><button type="button" role="tab" aria-selected={view===key} key={key} onClick={()=>setView(key)}>{title}{key==="artifacts"?` (${papers.length})`:""}</button>)}</div>
      {view==="execution"&&<label className={styles.follow}><input type="checkbox" checked={follow} onChange={event=>setFollow(event.target.checked)}/>自动滚动</label>}
    </div>
    {error&&<p className={styles.error} role="alert">{error} 已显示的记录保留，窗口会自动重连。</p>}
    {run?.human&&<aside className={styles.human}><h3>需要人工处理</h3><p>{run.human.reason || "请查看研究详情中的请求。"}</p>{run.human.requested_action&&<p>{run.human.requested_action}</p>}<a href={detail} target="_blank" rel="noreferrer">打开请求并处理 ↗</a></aside>}
    <div className={styles.scroll} aria-live="off">
      {!run&&<p className={styles.empty}>{error?"暂未取得任务快照。":"正在读取后台任务；此窗口不会启动模型或执行实验。"}</p>}
      {view==="execution"&&<>
        <p className={styles.note}>近期实际执行记录自动更新。完整历史保存在研究详情的文件与日志中。</p>
        {run&&<p className={styles.note}>执行器 {run.config.executor} · 实验 {run.config.role_models?.experiment} · 写作 {run.config.role_models?.writer} · 审稿 {run.config.role_models?.reviewer} · 救火 {run.config.role_models?.rescue}</p>}
        {data&&!data.records.length&&<p className={styles.empty}>暂未产生可显示的代理回复或工具返回。可切换“流程记录”查看当前阶段。</p>}
        {data?.records.map(record=><article className={styles.message} data-record-kind={record.kind} key={record.id}><header><h3>{record.title}</h3><span>{record.recorded_at?time(record.recorded_at):`日志开始 ${time(record.at)}`} · {record.source}</span></header><div className={record.kind==="tool"||record.kind==="output"||record.kind==="error"?styles.verbatim:styles.body}>{record.text}</div></article>)}
        {!!data?.unavailable.length&&<p className={styles.note}>部分日志正被写入，本窗口稍后重试。</p>}
        <div ref={end}/>
      </>}
      {view==="workflow"&&<>{run&&<p className={styles.note}>写作／审稿网关调用 {run.model_calls} 次；该计数不包含 Claude CLI 代理内部的全部工具轮次。</p>}{data?.events.map(event=><article className={styles.message} key={event.seq}><header><h3>{event.kind}</h3><span>{time(event.at)}</span></header><div className={styles.body}>{event.message}</div></article>)}</>}
      {view==="artifacts"&&<>
        <h3>论文与实验产物</h3>{run?.final_artifact&&<p><a href={artifact(run.final_artifact)} target="_blank" rel="noreferrer">打开当前交付文件 ↗</a></p>}
        {!papers.length&&<p className={styles.empty}>尚未生成 PDF、TeX、CSV 或交付压缩包。</p>}
        <ul className={styles.files}>{papers.map(file=><li key={file.path}><a href={artifact(file.path)} target="_blank" rel="noreferrer">{file.path}</a><span>{(file.size/1024).toFixed(1)} KB</span></li>)}</ul>
        {!!run?.rounds?.length&&<><h3>已归档轮次</h3>{run.rounds.map(round=><p key={round.round}>第 {round.round} 轮 · {round.stop_reason || "已归档"} · 评分轨迹 {round.scores?.join(" → ") || "见审稿记录"}</p>)}</>}
        <p><a href={detail} target="_blank" rel="noreferrer">查看全部文件与原始日志 ↗</a></p>
      </>}
    </div>
    <footer className={styles.footer}>观察窗口不接收实验指令。关闭窗口后，后台 loop 继续运行。</footer>
  </section>;
}
