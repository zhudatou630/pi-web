"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import styles from "./research.module.css";

type Candidate = { id: string; contribution: string; novelty?: string };
type Run = {
  id: string; title: string; status: string; stage: string; round: number; attempt: number;
  created_at: number; updated_at: number; heartbeat: number; model_calls: number;
  claude_cost_usd: number; last_error?: string; active_log?: string; final_artifact?: string;
  pi_session_id?: string; requested?: string;
  model_activity?: Record<string, { last_progress_at: number }>;
  sealed?: boolean; recovery_count?: number; operator_interventions?: number;
  config: { executor: string; max_rounds: number; compile_pdf?: boolean; role_models?: Record<string,string>; experiment_profile?: string };
  benchmark_progress?: {phase?:string;instance_id?:string;step?:number};
  benchmark?: {id:string;status:string;rescue_calls:number;tasks:{task_id:string;state:string;attempts:number;passed?:boolean|null;unscored_reason?:string}[];incidents:{id:string;task_id:string;kind:string;state:string;error:string}[]};
  human?: { kind: string; reason: string; requested_action?: string; sha256?: string; session_id?: string; incident_id?:string;
    document?: { motivation?: { statement?: string; intended_contribution?: string; standpoint?: string }; candidates?: Candidate[] } };
  rounds: { round: number; scores: number[]; stop_reason: string; ready_for_venue: boolean; path?: string; acceptance_blockers?: string[] }[];
  events?: { seq: number; at: number; kind: string; message: string }[];
  artifacts?: { path: string; size: number }[];
};
type Health = { ok: boolean; worker_alive: boolean; claude_available: boolean; journal_loop_version?: number; modules: Record<string, string> };
type Model = { id: string; provider: string; name: string };
type Notice = { id: string; run_id: string; kind: string; body: {title: string; message: string}; ack_at?: number; delivery_state: string };
const names: Record<string, string> = {
  queued: "排队中", running: "运行中", paused: "已暂停", waiting_human: "需要你处理",
  completed: "已通过质量门槛", validation_completed: "闭环验证完成（论文候选稿）", budget_exhausted: "已达到运行上限", cancelled: "已取消", failed: "运行失败",
  planning: "设计实验", experiments: "执行与改进实验", approval: "检查研究确认", confirming: "确认研究方向",
  drafting: "APD 写作", reviewing: "独立 APR 审稿", evaluating: "归档与反馈分流", verification: "复查论文验收证据",
  packaging: "自动核验与交付", initializing: "准备封存运行环境",
  benchmark_completed: "真实 benchmark 验收完成", benchmark_packaging: "核验任务结果与交付",
  generate_candidate: "生成并冻结模型补丁", eval_started: "官方测试执行中", candidates_frozen: "候选补丁已冻结",
  pending: "待执行", succeeded: "任务通过", failed_task: "任务未通过", evaluation_error: "评测超时，未评分", failed_infra: "基础设施故障", repairing: "独立救火中", fork_required: "实验条件变化，需新版本",
};
const stopped = new Set(["completed", "validation_completed", "benchmark_completed", "budget_exhausted", "cancelled", "failed"]);
const roleModelOptions = ["claude-sonnet-5-5", "claude-opus-5-5"];

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/research/${path}`, {
    cache: "no-store", ...(body !== undefined ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

function encodeFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("无法读取 proposal 文件"));
    reader.readAsDataURL(file);
  });
}

export default function ResearchPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [executor, setExecutor] = useState("claude");
  const [model, setModel] = useState("");
  const [experimentModel, setExperimentModel] = useState("claude-sonnet-5-5");
  const [writerModel, setWriterModel] = useState("claude-sonnet-5-5");
  const [reviewerModel, setReviewerModel] = useState("claude-opus-5-5");
  const [rescueModel, setRescueModel] = useState("claude-opus-5-5");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [paperWorkflow, setPaperWorkflow] = useState("journal");
  const [rounds, setRounds] = useState(3);
  const [retries, setRetries] = useState(2);
  const [timeout, setTimeoutSeconds] = useState(1800);
  const [maxSeconds, setMaxSeconds] = useState(14400);
  const [maxCalls, setMaxCalls] = useState(120);
  const [person, setPerson] = useState("");
  const [candidate, setCandidate] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notify, setNotify] = useState(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [unattended, setUnattended] = useState(false);
  const [experimentProfile, setExperimentProfile] = useState("journal_validation");
  const effectiveWorkflow = unattended ? experimentProfile === "journal_validation" ? "journal" : "legacy" : paperWorkflow;
  const [permissionProbe, setPermissionProbe] = useState(false);
  const statuses = useRef(new Map<string, string>());

  const refresh = useCallback(async () => {
    const [nextHealth, listing] = await Promise.all([api<Health>("health"), api<{ runs: Run[] }>("runs")]);
    setHealth(nextHealth);
    setConnectionError("");
    setRuns(listing.runs);
    const inbox = await api<{notifications: Notice[]}>("notifications");
    setNotices(inbox.notifications.filter(n => !n.ack_at));
    for (const item of listing.runs) {
      const old = statuses.current.get(item.id);
      if (notify && old && old !== item.status && ["waiting_human", "completed", "validation_completed", "benchmark_completed", "failed", "budget_exhausted"].includes(item.status)) {
        new Notification(item.title, { body: names[item.status], tag: item.id });
      }
      statuses.current.set(item.id, item.status);
    }
    if (selected) setRun(await api<Run>(`runs/${selected}`));
  }, [selected, notify]);

  useEffect(() => {
    let cancelled = false;
    let loading = false;
    const poll = async () => {
      if (loading || cancelled) return;
      loading = true;
      try { await refresh(); } catch (err) { if (!cancelled) { setConnectionError(String(err instanceof Error ? err.message : err)); setHealth(null); } }
      finally { loading = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    const requestedRun = new URLSearchParams(window.location.search).get("run");
    if (requestedRun && /^[a-f0-9-]{36}$/.test(requestedRun)) setSelected(requestedRun);
    void api<{ modelList: Model[] }>("models").then(data => setModels(data.modelList || [])).catch(() => {});
  }, []);

  useEffect(() => { setCandidate(""); setNote(""); setRun(null); }, [selected]);

  async function create() {
    if (!file) return;
    setError(""); setBusy(true);
    try {
      if (file.size > 10_000_000) throw new Error("Proposal 文件不能超过 10 MB");
      if (effectiveWorkflow === "journal" && !health?.journal_loop_version) throw new Error("服务器尚未加载 Journal／独立 APR 后台，请先完成配套版本部署。");
      const chosen = models.find(m => `${m.provider}:${m.id}` === model);
      if (writerModel === reviewerModel) throw new Error("论文写作与审稿必须使用不同型号");
      const baseModel = executor === "pi" && chosen ? chosen.id : experimentModel;
      const created = await api<Run>("runs", { title, filename: file.name, content_base64: await encodeFile(file),
        ...(unattended ? {delegated_authorization: true} : {}),
        config: { executor:unattended ? "claude" : executor, max_rounds:unattended ? experimentProfile === "swebench_lite" ? 1 : 2 : rounds, max_retries: retries, stage_timeout_seconds: timeout,
          max_run_seconds: maxSeconds, max_model_calls: maxCalls, paper_workflow: effectiveWorkflow,
          role_models: {planning: baseModel, experiment: baseModel, benchmark_solver: baseModel,
            writer: writerModel, reviewer: reviewerModel, rescue: rescueModel, auxiliary: writerModel},
          ...(unattended ? experimentProfile === "swebench_lite" ? {unattended:true,experiment_profile:"swebench_lite",run_goal:"benchmark_validation",min_rounds:1,
            compile_pdf:false,fault_probe:!permissionProbe,benchmark_permission_probe:permissionProbe,
            benchmark_instance_ids:["sympy__sympy-11400","sympy__sympy-11870","sympy__sympy-11897"]} :
            experimentProfile === "journal_validation" ? {unattended:true,experiment_profile:"journal_validation",run_goal:"journal_validation",paper_workflow:"journal",min_rounds:2,defer_publication_deposit:true} :
            {unattended: true, experiment_profile: "cpu_summation", run_goal: "closed_loop_validation", min_rounds: 2} : {}),
          ...(chosen ? { provider: chosen.provider, model_id: chosen.id } : {}) } });
      setSelected(created.id);
      setFile(null);
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function act(action: string) {
    if (!run) return;
    setError(""); setBusy(true);
    try {
      await api(`runs/${run.id}/action`, { action, by: person, candidate_id: candidate,
        sha256: run.human?.sha256, note });
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  const artifactUrl = (path: string) => `/api/research/runs/${run?.id}/artifact?path=${encodeURIComponent(path.replace(/\\/g, "/"))}`;
  const motivation = run?.human?.document?.motivation;
  const candidates = run?.human?.document?.candidates || [];

  return <main className={styles.page}>
    <header className={styles.header}>
      <div><Link href="/" className={styles.back}>← Pi Web 工作区</Link><h1>Research Loop</h1><p>Proposal → 实验 → 论文 → 审稿 → 下一轮实验</p></div>
      <div className={styles.health}><span className={health?.worker_alive ? styles.online : styles.offline} />
        {health?.worker_alive ? "调度器运行中" : "调度器未连接"}
        <button type="button" onClick={async () => {
          if (!("Notification" in window)) { setError("此浏览器不支持桌面通知"); return; }
          try { setNotify(await Notification.requestPermission() === "granted"); }
          catch { setError("无法启用桌面通知"); }
        }}>{notify ? "已启用状态通知" : "启用状态通知"}</button>
      </div>
    </header>
    {(error || connectionError) && <div className={styles.error} role="alert">{error || connectionError}<button type="button" aria-label="关闭提示" onClick={() => { setError(""); setConnectionError(""); }}>×</button></div>}
    {notices.length > 0 && <section className={styles.card} aria-label="需要关注的通知">
      <h2>需要关注 · {notices.length}</h2>
      <p>后台会独立发送 Windows 通知。系统接收通知不等于你已看到；这里保留到你确认。</p>
      {notices.map(n => <div key={n.id}><button type="button" onClick={() => setSelected(n.run_id)}>{n.body.title}</button><p>{n.body.message}</p>
        <p>{n.delivery_state === "queued_to_os" ? "已交给 Windows 通知中心" : "桌面通知待发送或重试；待办已保存"}</p>
        <button type="button" onClick={async () => { try { await api(`notifications/${n.id}/ack`, {}); await refresh(); } catch (err) { setError(String(err)); } }}>我已看到</button></div>)}
    </section>}
    <div className={styles.grid}>
      <aside className={styles.sidebar}>
        <section className={styles.card}>
          <h2>启动新的研究</h2>
          <label>项目名称<input value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：检索策略对照实验" /></label>
          <label>Research proposal<input type="file" accept=".pdf,.docx,.md,.txt" aria-label="Research proposal" onChange={e => setFile(e.target.files?.[0] || null)} /></label>
          <p className={styles.muted}>PDF、DOCX、Markdown 或 TXT，最大 10 MB。扫描 PDF 需要先做 OCR。</p>
          <label>论文工作流<select value={effectiveWorkflow} disabled={unattended} onChange={e => setPaperWorkflow(e.target.value)}><option value="journal">TPAMI 期刊写作 → 独立 APR（默认）</option><option value="legacy">旧版兼容流程</option></select></label>
          {effectiveWorkflow === "journal" && health && !health.journal_loop_version && <p role="status">当前后台尚未加载 Journal／独立 APR 接口；完成配套部署后才能启动该流程。</p>}
          <label>模型执行方式<select value={executor} onChange={e => setExecutor(e.target.value)}>
            <option value="claude">Claude Code · 本机登录</option><option value="pi">Pi Web · 已配置模型</option>
          </select></label>
          {executor === "pi" && <label>Pi 模型<select value={model} onChange={e => setModel(e.target.value)}>
            <option value="">选择模型</option>{models.filter(m => roleModelOptions.includes(m.id)).map(m => <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>{m.name} · {m.provider}</option>)}
          </select></label>}
          {executor === "claude" && <label>实验与被测系统模型<select value={experimentModel} onChange={e => setExperimentModel(e.target.value)}>{roleModelOptions.map(id => <option key={id} value={id}>{id}</option>)}</select></label>}
          <label>论文写作模型<select value={writerModel} onChange={e => setWriterModel(e.target.value)}>{roleModelOptions.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
          <label>审稿与证据审核模型<select value={reviewerModel} onChange={e => setReviewerModel(e.target.value)}>{roleModelOptions.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
          <label>救火模型<select value={rescueModel} onChange={e => setRescueModel(e.target.value)}>{roleModelOptions.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
          <p className={styles.muted}>最低 Sonnet 5.5；写作与审稿须不同型号。不可用或实际返回型号不符时停止，不自动降级。Pi 提供商须同时支持所选型号。</p>
          {executor === "pi" && models.length === 0 && <p className={styles.muted}>请先在 Pi Web 设置中添加模型，再刷新此页面。</p>}
          <label><input type="checkbox" checked={unattended} onChange={e => { setUnattended(e.target.checked); if (e.target.checked) { setExecutor("claude"); setRounds(experimentProfile === "swebench_lite" ? 1 : 2); } }} /> 授权限定范围的无人值守验收</label>
          {unattended && <label>验收档案<select value={experimentProfile} onChange={e => {setExperimentProfile(e.target.value);setRounds(e.target.value === "swebench_lite" ? 1 : 2);}}><option value="journal_validation">Journal → 独立 APR · 两轮真实闭环</option><option value="cpu_summation">CPU 求和 · 实验与论文两轮</option><option value="swebench_lite">SWE-bench Lite · 三项真实仓库任务</option></select></label>}
          {unattended && experimentProfile === "journal_validation" && <p className={styles.muted}>按上传 Proposal 授权两轮有预算的真实实验、期刊写作和独立 APR。仅本地归档；公开发布／DOI 要求保留为未解决问题并延后。外部权限、伦理与范围变化仍转人工；闭环完成不代表论文达到投稿质量。</p>}
          {unattended && experimentProfile === "cpu_summation" && <p className={styles.muted}>仅适用于约定的本机求和研究。允许范围内的代码、测量和恢复自动进行；外部授权与科研范围变化仍会停下通知你。论文质量门槛保留。</p>}
          {unattended && experimentProfile === "swebench_lite" && <><p className={styles.muted}>固定 SymPy Lite 11400、11870、11897。先冻结模型补丁，再由官方容器评测。默认在第二项中终止所属测试进程，验证独立救火与续跑；不生成论文。</p><label><input type="checkbox" checked={permissionProbe} onChange={e => setPermissionProbe(e.target.checked)} /> 单独验证权限不足通知（会停止等待人工，不产生任务成绩）</label></>}
          <details><summary>运行上限与故障修复</summary><div className={styles.options}>
            <label>最多实验轮数<input type="number" min={1} max={30} value={rounds} onChange={e => setRounds(Number(e.target.value))} /></label>
            <label>每阶段最多自动修复次数<input type="number" min={0} max={5} value={retries} onChange={e => setRetries(Number(e.target.value))} /></label>
            <label>代理无进展超时／计算任务限时（秒）<input type="number" min={30} max={86400} value={timeout} onChange={e => setTimeoutSeconds(Number(e.target.value))} /></label>
            <label>累计运行预算（秒，当前模型完成后检查）<input type="number" min={60} max={604800} value={maxSeconds} onChange={e => setMaxSeconds(Number(e.target.value))} /></label>
            <label>写作与审稿模型调用上限<input type="number" min={1} max={1000} value={maxCalls} onChange={e => setMaxCalls(Number(e.target.value))} /></label>
          </div></details>
          <button className={styles.primary} type="button" disabled={busy || !file || !health?.worker_alive || (executor === "pi" && !model)} onClick={() => void create()}>{busy ? "正在提交…" : "上传并开始研究"}</button>
          <p className={styles.muted}>实验 agent 会在项目目录编写并执行代码。涉及外部授权或科研判断时会停下来请求处理。</p>
        </section>
        <section className={styles.card}><h2>研究项目 <span className={styles.muted}>{runs.length}</span></h2>
          {runs.length === 0 && <p className={styles.muted}>上传 proposal 后，任务和每轮版本会保存在这里。</p>}
          <div className={styles.runList}>{runs.map(item => <button type="button" key={item.id} className={item.id === selected ? styles.selected : ""} onClick={() => setSelected(item.id)}>
            <span>{item.title}</span><span className={styles.muted}>{names[item.status] || item.status} · 第 {item.round} 轮</span>
          </button>)}</div>
        </section>
        {health && <p className={styles.moduleInfo}>APD {health.modules.autopaperdraft} · APR {health.modules.autopaperreview}<br />{health.claude_available ? "已检测到 Claude Code" : "未检测到 Claude Code"}</p>}
      </aside>
      <article className={styles.content}>
        {!run && <section className={`${styles.card} ${styles.empty}`}><h2>{selected ? "正在加载研究任务…" : "从一份研究 proposal 开始"}</h2><p>这里会展示实验进度、人工请求、审稿意见和逐轮论文。</p><div className={styles.flow}>{["设计实验", "执行实验", "APD 写作", "APR 审稿", "反馈改进"].map(x => <span key={x}>{x}</span>)}</div><p className={styles.muted}>研究动机与核心贡献由你确认；实验故障由调度器检查并尝试修复。</p></section>}
        {run && <>
          <section className={styles.card}>
            <div className={styles.row}><div><h2>{run.title}</h2><p className={styles.status} data-status={run.status}>{names[run.status] || run.status}</p></div>
              <div className={styles.actions}>
                {!stopped.has(run.status) && run.status !== "paused" && <button type="button" disabled={busy} onClick={() => void act("pause")}>暂停</button>}
                {["paused", "failed"].includes(run.status) && <button type="button" disabled={busy} onClick={() => void act("resume")}>继续</button>}
                {!stopped.has(run.status) && <button type="button" disabled={busy} onClick={() => void act("cancel")}>停止研究</button>}
              </div>
            </div>
            <dl className={styles.stats}>
              <div><dt>当前阶段</dt><dd>{names[run.stage] || run.stage}</dd></div>
              <div><dt>实验轮次</dt><dd>{run.round} / {run.config.max_rounds}</dd></div>
              <div><dt>本阶段修复次数</dt><dd>{run.attempt}</dd></div>
              <div><dt>模型调用</dt><dd>{run.model_calls}</dd></div>
            </dl>
            {run.config.role_models && <p className={styles.muted}>实验 {run.config.role_models.experiment} · 写作 {run.config.role_models.writer}<br />审稿 {run.config.role_models.reviewer} · 救火 {run.config.role_models.rescue}</p>}
            {run.requested && <p role="status">正在处理{run.requested === "pause" ? "暂停" : "停止"}请求…</p>}
            {run.status === "running" && Object.keys(run.model_activity || {}).length > 0 && <p role="status">模型请求进行中 · 最近活动 {new Date(Math.max(...Object.values(run.model_activity || {}).map(item => item.last_progress_at)) * 1000).toLocaleTimeString()} · 持续输出时继续等待</p>}
            {run.claude_cost_usd > 0 && <p className={styles.muted}>Claude CLI 报告的费用估算：US${run.claude_cost_usd.toFixed(4)}</p>}
            <a href={`/?research=${encodeURIComponent(run.id)}`} target="_blank" rel="noreferrer">在主界面只读观察 ↗</a>
            {(run.pi_session_id || run.human?.session_id) && <a href={`/?session=${encodeURIComponent(run.pi_session_id || run.human?.session_id || "")}`} target="_blank" rel="noreferrer">打开实验 agent 对话</a>}
            {run.active_log && <a href={artifactUrl(run.active_log)} target="_blank" rel="noreferrer">查看最近执行日志</a>}
            {run.final_artifact && <a className={styles.download} href={artifactUrl(run.final_artifact)} target="_blank" rel="noreferrer">{run.config.experiment_profile === "swebench_lite" ? "打开实验验收报告" : run.status === "validation_completed" ? "打开闭环验证论文" : "打开最终论文"} ↗</a>}
            {run.benchmark_progress && <p>任务进度：{run.benchmark_progress.instance_id || "准备中"} · {run.benchmark?.status === "repairing" ? "救火诊断与验证中" : run.benchmark?.status === "waiting_human" ? "等待人工处理" : run.benchmark_progress.phase === "completed" ? "全部任务执行结束" : names[run.benchmark_progress.phase || ""] || run.benchmark_progress.phase}{run.benchmark_progress.step ? ` · 模型步骤 ${run.benchmark_progress.step}` : ""}</p>}
            {run.status === "budget_exhausted" && <p className={styles.muted}>已保存最新候选稿。运行上限已达到，论文尚未满足全部质量条件。</p>}
          </section>
          {run.status === "waiting_human" && run.human && <section className={`${styles.card} ${styles.attention}`}>
            <h2>需要你处理</h2><p>{run.human.reason}</p>
            {run.human.requested_action && <p>{run.human.requested_action}</p>}
            {run.human.kind === "contribution" ? <>
              {motivation && <dl className={styles.motivation}><dt>研究动机</dt><dd>{motivation.statement}</dd><dt>预期贡献</dt><dd>{motivation.intended_contribution}</dd><dt>研究立场</dt><dd>{motivation.standpoint}</dd></dl>}
              <label>选择核心贡献<select value={candidate} onChange={e => setCandidate(e.target.value)}><option value="">请在阅读后选择</option>{candidates.map(c => <option key={c.id} value={c.id}>{c.id} · {c.contribution}</option>)}</select></label>
              {candidates.filter(c => c.id === candidate).map(c => <p key={c.id}>{c.novelty}</p>)}
              <label>确认人姓名<input value={person} onChange={e => setPerson(e.target.value)} placeholder="输入你的姓名" /></label>
              <details><summary>查看完整贡献与证据计划</summary><pre>{JSON.stringify(run.human.document, null, 2)}</pre></details>
              <button type="button" className={styles.primary} disabled={busy || !person.trim() || !candidate} onClick={() => void act("confirm")}>确认以上研究方向并继续</button>
            </> : <>
              <details><summary>查看请求详情</summary><pre>{JSON.stringify(run.human, null, 2)}</pre></details>
              <label>处理结果或补充说明<textarea value={note} onChange={e => setNote(e.target.value)} placeholder="例如：已登录服务，数据路径为…" /></label>
              <button type="button" className={styles.primary} disabled={busy || (Boolean(run.human.incident_id) && !note.trim())} onClick={() => void act("resume")}>已处理，继续运行</button>
            </>}
          </section>}
          {run.sealed && <p>封存运行 · 系统阶段自愈 {run.recovery_count || 0} 次 · 运行中人工控制 {run.operator_interventions || 0} 次</p>}
          {run.benchmark && <section className={styles.card}><h2>实验内部任务循环</h2><p>状态：{run.benchmark.status === "completed" ? "全部任务执行结束" : names[run.benchmark.status] || run.benchmark.status} · 独立救火调用 {run.benchmark.rescue_calls} 次</p><div className={styles.tableWrap}><table><thead><tr><th>Task</th><th>状态</th><th>执行次数</th></tr></thead><tbody>{run.benchmark.tasks.map(task => <tr key={task.task_id}><td>{task.task_id}</td><td>{names[task.state] || task.state}</td><td>{task.attempts}</td></tr>)}</tbody></table></div>{run.benchmark.incidents.map(incident => <details key={incident.id}><summary>{incident.task_id} · {incident.kind} · {incident.state}</summary><pre>{incident.error}</pre></details>)}</section>}
          {run.config.experiment_profile !== "swebench_lite" && <section className={styles.card}>
            <h2>论文版本与评审轨迹</h2>
            {run.rounds.length === 0 ? <p className={styles.muted}>第一轮论文和审稿完成后，每轮版本会显示在这里。</p> :
              <div className={styles.tableWrap}><table>
                <thead><tr><th>轮次</th><th>内部写作评分轨迹</th><th>验收状态</th><th>产物</th></tr></thead>
                <tbody>{run.rounds.map(item => <tr key={item.round}>
                  <td>{item.round}</td><td>{item.scores.join(" → ") || "—"}</td>
                  <td>{item.ready_for_venue ? "通过" : item.acceptance_blockers?.length ? item.acceptance_blockers.join("、") : item.stop_reason}</td>
                  <td><a href={artifactUrl(`${item.path || `rounds/${String(item.round).padStart(3, "0")}`}/paper/build/paper.${run.config.compile_pdf === false ? "tex" : "pdf"}`)} target="_blank" rel="noreferrer">{item.ready_for_venue ? "论文" : "候选稿"} {run.config.compile_pdf === false ? "TeX" : "PDF"}</a>{" · "}<a href={artifactUrl(`${item.path || `rounds/${String(item.round).padStart(3, "0")}`}/feedback.json`)} target="_blank" rel="noreferrer">审稿反馈</a></td>
                </tr>)}</tbody>
              </table></div>}
          </section>}
          <section className={styles.card}><h2>运行记录</h2><div className={styles.events}>{[...(run.events || [])].reverse().map(event => <details key={event.seq}><summary><time>{new Date(event.at * 1000).toLocaleTimeString()}</time><span className={styles.eventKind}>{event.kind}</span><span>{event.message.split("\n")[0].slice(0, 180)}</span></summary><pre>{event.message}</pre></details>)}</div></section>
          <section className={styles.card}><h2>文件与日志</h2><div className={styles.artifacts}>{(run.artifacts || []).map(a => <a href={artifactUrl(a.path)} key={a.path} target="_blank" rel="noreferrer"><span>{a.path}</span><span className={styles.muted}>{(a.size / 1024).toFixed(1)} KB</span></a>)}</div></section>
        </>}
      </article>
    </div>
  </main>;
}
