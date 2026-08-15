import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ArchiveQuery, ArtifactRecord, BoardSnapshot, ConversationEntry, CreatorTask, DecisionEntry, Platform, TaskStatus } from "../domain/types.js";
import { callTool } from "./mcp.js";

const COLUMN_META: Array<{ status: keyof BoardSnapshot["columns"]; label: string; hint: string }> = [
  { status: "DRAFT", label: "初稿", hint: "候选与灵感" },
  { status: "TODO", label: "待办", hint: "已确认观点" },
  { status: "RUNNING", label: "执行", hint: "Codex 串行生产" },
  { status: "NEEDS_DECISION", label: "待决策", hint: "需要你的判断" },
  { status: "COMPLETED", label: "完成", hint: "可修改或归档" }
];

type TaskDetail = { task: CreatorTask; conversation: ConversationEntry[]; decisions: DecisionEntry[] };

export function BoardApp() {
  const [snapshot, setSnapshot] = useState<BoardSnapshot>();
  const [view, setView] = useState<"board" | "archive">("board");
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<TaskDetail>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [showDraft, setShowDraft] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(undefined);
      const data = await callTool<BoardSnapshot>("get_board_snapshot");
      setSnapshot(data);
      if (selectedId) setDetail(await callTool<TaskDetail>("get_task_detail", { taskId: selectedId }));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const selectTask = async (taskId: string) => {
    setSelectedId(taskId);
    setBusy("detail");
    try {
      setDetail(await callTool<TaskDetail>("get_task_detail", { taskId }));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const mutate = async (label: string, operation: () => Promise<unknown>) => {
    setBusy(label);
    setError(undefined);
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const handleDrop = (taskId: string, source: TaskStatus, target: TaskStatus) => {
    if (source === "DRAFT" && target === "TODO") void selectTask(taskId);
    if (source === "TODO" && target === "RUNNING") void mutate("worker", () => callTool("run_worker_once", { taskId }));
    if (source === "NEEDS_DECISION" && target === "RUNNING") void selectTask(taskId);
    if (source === "COMPLETED" && target === "RUNNING") void selectTask(taskId);
  };

  if (loading && !snapshot) return <div className="loading-screen"><div className="pulse" />正在打开创作台…</div>;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">AC</div>
          <div><h1>AI Creator Board</h1><p>AI 情报主编 · 从选题到四平台交付包</p></div>
        </div>
        <nav className="view-tabs" aria-label="视图">
          <button className={view === "board" ? "active" : ""} onClick={() => setView("board")}>创作看板</button>
          <button className={view === "archive" ? "active" : ""} onClick={() => setView("archive")}>月度归档</button>
        </nav>
        <div className="top-actions">
          <SyncPill snapshot={snapshot} />
          <button className="icon-button" title="同步" onClick={() => void mutate("sync", () => callTool("sync_workspace"))}>↻</button>
          <button className="secondary" onClick={() => void mutate("scan", () => callTool("run_daily_scan"))}>今日扫描</button>
          <button className="primary" onClick={() => setShowDraft(true)}>＋ 新建初稿</button>
        </div>
      </header>

      {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError(undefined)}>×</button></div>}
      {snapshot?.sync.mode === "INACTIVE_DEVICE" && (
        <div className="lease-banner">当前电脑不是激活设备，定时任务只读运行。<button onClick={() => void mutate("activate", () => callTool("activate_device"))}>激活这台电脑</button></div>
      )}

      <main>
        {view === "board" && snapshot && (
          <BoardColumns snapshot={snapshot} onSelect={selectTask} onDropTask={handleDrop} />
        )}
        {view === "archive" && <ArchiveView onSelect={selectTask} />}
      </main>

      {showDraft && <NewDraftModal onClose={() => setShowDraft(false)} onCreate={(input) => mutate("draft", () => callTool("create_draft", input)).then(() => setShowDraft(false))} />}
      {selectedId && (
        <TaskDrawer
          detail={detail}
          loading={busy === "detail"}
          busy={Boolean(busy)}
          onClose={() => { setSelectedId(undefined); setDetail(undefined); }}
          onMutate={mutate}
        />
      )}
    </div>
  );
}

function SyncPill({ snapshot }: { snapshot?: BoardSnapshot }) {
  const mode = snapshot?.sync.mode ?? "READY";
  const labels = { READY: "已同步", READ_ONLY: "只读", PENDING_SYNC: "待同步", INACTIVE_DEVICE: "非激活设备" };
  return <span className={`sync-pill ${mode.toLowerCase()}`}><i />{labels[mode]}</span>;
}

function BoardColumns({ snapshot, onSelect, onDropTask }: {
  snapshot: BoardSnapshot;
  onSelect: (id: string) => void;
  onDropTask: (id: string, source: TaskStatus, target: TaskStatus) => void;
}) {
  const batchesByTask = useMemo(() => new Map(snapshot.batches.flatMap((batch) => batch.taskIds.map((id) => [id, batch.date]))), [snapshot.batches]);
  return (
    <section className="board-grid">
      {COLUMN_META.map((column) => {
        const tasks = snapshot.columns[column.status];
        const draftGroups = column.status === "DRAFT" ? groupDrafts(tasks, batchesByTask) : undefined;
        return (
          <div
            className={`board-column status-${column.status.toLowerCase()}`}
            key={column.status}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              const payload = JSON.parse(event.dataTransfer.getData("application/json") || "{}") as { id?: string; status?: TaskStatus };
              if (payload.id && payload.status) onDropTask(payload.id, payload.status, column.status);
            }}
          >
            <div className="column-head"><div><h2>{column.label}</h2><p>{column.hint}</p></div><span>{tasks.length}</span></div>
            <div className="column-body">
              {draftGroups ? draftGroups.map(([label, group]) => (
                <div className="batch-group" key={label}>
                  <div className="batch-label"><span>{label === "manual" ? "手工初稿" : `${formatDate(label)} · 每日候选`}</span><small>{group.length} 张</small></div>
                  {group.map((task) => <TaskCard key={task.id} task={task} onSelect={onSelect} />)}
                </div>
              )) : tasks.map((task) => <TaskCard key={task.id} task={task} onSelect={onSelect} />)}
              {tasks.length === 0 && <div className="empty-column"><span>◇</span>暂无任务</div>}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function TaskCard({ task, onSelect }: { task: CreatorTask; onSelect: (id: string) => void }) {
  const last = task.progress.at(-1);
  return (
    <article
      className={`task-card ${task.blocked ? "blocked" : ""}`}
      draggable
      onDragStart={(event) => event.dataTransfer.setData("application/json", JSON.stringify({ id: task.id, status: task.status }))}
      onClick={() => onSelect(task.id)}
    >
      <div className="card-topline">
        <span className="profile-chip">{task.profile === "ai-intel" ? "AI 情报" : task.profile}</span>
        {task.blocked && <span className="blocked-chip">Blocked</span>}
        {task.pendingDecision && <span className="decision-dot">需要决策</span>}
      </div>
      <h3>{task.topic}</h3>
      {task.concept && <p className="concept">顺手讲懂 · {task.concept}</p>}
      <div className="tag-row">{task.tags.slice(0, 3).map((tag) => <span key={tag}>#{tag}</span>)}</div>
      {last && <p className="last-progress">{last.message}</p>}
      <footer><span>{stageLabel(task.workflowStage)}</span><time>{relativeTime(task.updatedAt)}</time></footer>
    </article>
  );
}

function TaskDrawer({ detail, loading, busy, onClose, onMutate }: {
  detail?: TaskDetail;
  loading: boolean;
  busy: boolean;
  onClose: () => void;
  onMutate: (label: string, operation: () => Promise<unknown>) => Promise<void>;
}) {
  const [tab, setTab] = useState<"overview" | "conversation" | "artifacts">("overview");
  const [message, setMessage] = useState("");
  const [decisionAnswer, setDecisionAnswer] = useState("");
  const [decisionOption, setDecisionOption] = useState<string>();
  const [approval, setApproval] = useState<"A" | "B" | "C" | "AUTO">("AUTO");
  const [preview, setPreview] = useState<{ name: string; url: string; mimeType: string }>();
  const task = detail?.task;

  const sendMessage = () => task && message.trim() && onMutate("message", () => callTool("send_task_message", { taskId: task.id, expectedVersion: task.version, message: message.trim() })).then(() => setMessage(""));
  return (
    <div className="drawer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <aside className="task-drawer">
        <div className="drawer-header">
          <div>{task && <span className={`status-label ${task.status.toLowerCase()}`}>{statusLabel(task.status)}</span>}<h2>{task?.topic ?? "任务详情"}</h2></div>
          <button className="close-button" onClick={onClose}>×</button>
        </div>
        {loading || !detail ? <div className="drawer-loading">正在读取任务镜像…</div> : <>
          <div className="drawer-tabs">
            <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>概览</button>
            <button className={tab === "conversation" ? "active" : ""} onClick={() => setTab("conversation")}>对话 <span>{detail.conversation.length}</span></button>
            <button className={tab === "artifacts" ? "active" : ""} onClick={() => setTab("artifacts")}>产物 <span>{task!.artifacts.length}</span></button>
          </div>
          <div className="drawer-content">
            {tab === "overview" && <>
              <section className="info-grid">
                <Info label="阶段" value={stageLabel(task!.workflowStage)} />
                <Info label="任务版本" value={`v${task!.version}`} />
                <Info label="Codex 线程" value={task!.threadId ? task!.threadId.slice(0, 12) : "尚未创建"} />
                <Info label="预计归档" value={task!.archiveDueAt ? new Date(task!.archiveDueAt).toLocaleString("zh-CN") : "—"} />
              </section>
              {task!.sources.length > 0 && <section className="drawer-section"><h3>信源</h3><div className="source-list">{task!.sources.map((source, index) => <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer">{source.title ?? source.url}</a>)}</div></section>}
              {task!.status === "DRAFT" && <section className="decision-panel"><div className="panel-kicker">推进前必选</div><h3>选择本期观点</h3><p>选 A/B/C，或明确授权 Codex 选择证据最充分的观点。</p><div className="option-stack">
                {task!.viewpointOptions?.map((option) => <label className={approval === option.key ? "selected" : ""} key={option.key}><input type="radio" checked={approval === option.key} onChange={() => setApproval(option.key)} /> <b>{option.key}</b><span>{option.statement}<small>{option.rationale}</small></span></label>)}
                <label className={approval === "AUTO" ? "selected" : ""}><input type="radio" checked={approval === "AUTO"} onChange={() => setApproval("AUTO")} /><b>AI</b><span>授权 Codex 自动选择<small>选择证据最充分的观点并记录理由</small></span></label>
              </div><button className="primary full" disabled={busy} onClick={() => void onMutate("approve", () => callTool("approve_candidate", { taskId: task!.id, expectedVersion: task!.version, viewpoint: approval }))}>放入待办</button></section>}
              {task!.pendingDecision && <section className="decision-panel urgent"><div className="panel-kicker">等待你的决策</div><h3>{task!.pendingDecision.question}</h3>{task!.pendingDecision.context && <pre>{task!.pendingDecision.context}</pre>}<div className="option-stack">
                {task!.pendingDecision.options?.map((option) => <label className={decisionOption === option.id ? "selected" : ""} key={option.id}><input type="radio" checked={decisionOption === option.id} onChange={() => { setDecisionOption(option.id); setDecisionAnswer(option.label); }} /><span>{option.label}<small>{option.description}</small></span></label>)}
              </div><textarea placeholder="补充你的判断、限制或修改要求…" value={decisionAnswer} onChange={(event) => setDecisionAnswer(event.target.value)} /><button className="primary full" disabled={busy || !decisionAnswer.trim()} onClick={() => void onMutate("decision", () => callTool("submit_decision", { taskId: task!.id, expectedVersion: task!.version, decisionId: task!.pendingDecision!.id, answer: decisionAnswer.trim(), ...(decisionOption ? { optionId: decisionOption } : {}) }))}>提交并继续执行</button></section>}
              <section className="drawer-section"><h3>进度时间线</h3><div className="timeline">{task!.progress.slice().reverse().map((event) => <div className={`timeline-item ${event.type}`} key={event.id}><i /><div><time>{new Date(event.at).toLocaleString("zh-CN")}</time><p>{event.message}</p></div></div>)}{task!.progress.length === 0 && <p className="muted">任务尚未开始执行。</p>}</div></section>
            </>}
            {tab === "conversation" && <section className="conversation-list">{detail.conversation.map((entry) => <div className={`message ${entry.role}`} key={entry.id}><header><span>{entry.role === "user" ? "你" : entry.role === "assistant" ? "Codex" : "系统"}</span><time>{new Date(entry.at).toLocaleString("zh-CN")}</time></header><p>{entry.content}</p>{entry.scope && entry.scope !== "all" && <small>只影响 {platformLabel(entry.scope)}</small>}</div>)}{detail.conversation.length === 0 && <p className="muted">暂无对话。</p>}</section>}
            {tab === "artifacts" && <ArtifactGallery task={task!} onPreview={setPreview} />}
          </div>
          <div className="drawer-footer">
            <textarea placeholder={task!.status === "COMPLETED" ? "描述要修改的地方；发送后卡片会回到执行区…" : "给这个任务补充要求…"} value={message} onChange={(event) => setMessage(event.target.value)} />
            <div className="footer-actions">
              {task!.blocked && <button className="danger" disabled={busy} onClick={() => void onMutate("retry", () => callTool("retry_task", { taskId: task!.id, expectedVersion: task!.version }))}>重试</button>}
              {task!.status === "DRAFT" && <button className="ghost danger-text" disabled={busy} onClick={() => void onMutate("dismiss", () => callTool("dismiss_draft", { taskId: task!.id, expectedVersion: task!.version }))}>放弃</button>}
              {(task!.status === "TODO" || task!.status === "RUNNING") && <button className="secondary" disabled={busy} onClick={() => void onMutate("worker", () => callTool("run_worker_once", { taskId: task!.id }))}>立即执行</button>}
              {task!.status === "COMPLETED" && <button className="secondary" disabled={busy} onClick={() => void onMutate("archive", () => callTool("archive_task", { taskId: task!.id, expectedVersion: task!.version }))}>主动归档</button>}
              <button className="primary" disabled={busy || !message.trim()} onClick={sendMessage}>发送</button>
            </div>
          </div>
        </>}
      </aside>
      {preview && <div className="preview-modal" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(undefined); }}><div onClick={(event) => event.stopPropagation()}><button onClick={() => { URL.revokeObjectURL(preview.url); setPreview(undefined); }}>×</button>{preview.mimeType.startsWith("image/") ? <img src={preview.url} alt={preview.name} /> : <iframe src={preview.url} title={preview.name} />}<p>{preview.name}</p></div></div>}
    </div>
  );
}

function ArtifactGallery({ task, onPreview }: { task: CreatorTask; onPreview: (value: { name: string; url: string; mimeType: string }) => void }) {
  const [busy, setBusy] = useState<string>();
  const open = async (artifact: ArtifactRecord, download = false) => {
    setBusy(artifact.id);
    try {
      const data = await callTool<{ name: string; mimeType: string; base64: string }>("read_artifact", { taskId: task.id, artifactPath: artifact.path });
      const bytes = Uint8Array.from(atob(data.base64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: data.mimeType }));
      if (download) {
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = data.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else onPreview({ name: data.name, mimeType: data.mimeType, url });
    } finally { setBusy(undefined); }
  };
  const grouped = groupBy(task.artifacts, (artifact) => artifact.platform ? platformLabel(artifact.platform) : "共享产物");
  return <div className="artifact-groups">{Object.entries(grouped).map(([group, artifacts]) => <section key={group}><h3>{group}</h3><div className="artifact-grid">{artifacts?.map((artifact) => <article key={artifact.id}><div className={`artifact-icon ${artifact.mimeType.startsWith("image/") ? "image" : "document"}`}>{artifact.mimeType.startsWith("image/") ? "▧" : "≡"}</div><div><b>{artifact.name}</b><small>{artifact.type}{artifact.reviewStatus ? ` · ${artifact.reviewStatus}` : ""}</small></div><button disabled={busy === artifact.id} onClick={() => void open(artifact)}>预览</button><button disabled={busy === artifact.id} onClick={() => void open(artifact, true)}>下载</button></article>)}</div></section>)}</div>;
}

function ArchiveView({ onSelect }: { onSelect: (id: string) => void }) {
  const [query, setQuery] = useState<ArchiveQuery>({});
  const [tasks, setTasks] = useState<CreatorTask[]>([]);
  const [loading, setLoading] = useState(true);
  const search = useCallback(async () => { setLoading(true); try { setTasks(await callTool("query_archive", query as Record<string, unknown>)); } finally { setLoading(false); } }, [query]);
  useEffect(() => { void search(); }, [search]);
  const grouped = groupBy(tasks, (task) => (task.archivedAt ?? task.updatedAt).slice(0, 7));
  return <section className="archive-page"><div className="archive-hero"><div><span>CONTENT LIBRARY</span><h2>月度归档</h2><p>只在公开站发布研究长文；任务对话与内部终审始终保留在私有数据仓库。</p></div><div className="archive-count"><b>{tasks.length}</b><span>篇已归档</span></div></div><div className="archive-filters"><input placeholder="搜索主题、备注或关键词" value={query.keyword ?? ""} onChange={(event) => setQuery({ ...query, keyword: event.target.value || undefined })} /><select value={query.platform ?? ""} onChange={(event) => setQuery({ ...query, platform: (event.target.value || undefined) as Platform | undefined })}><option value="">全部平台</option><option value="bilibili">B站</option><option value="douyin">抖音</option><option value="shipinhao">视频号</option><option value="xiaohongshu">小红书</option></select><input type="date" value={query.from ?? ""} onChange={(event) => setQuery({ ...query, from: event.target.value || undefined })} /><input type="date" value={query.to ?? ""} onChange={(event) => setQuery({ ...query, to: event.target.value || undefined })} /></div>{loading ? <div className="archive-loading">查询归档中…</div> : Object.entries(grouped).map(([month, monthTasks]) => <div className="archive-month" key={month}><div className="month-heading"><h3>{formatMonth(month)}</h3><span>{monthTasks?.length} 个任务</span></div><div className="archive-cards">{monthTasks?.map((task) => <button key={task.id} onClick={() => onSelect(task.id)}><span className="archive-cover">{task.artifacts.some((item) => item.type === "cover-horizontal") ? "封面" : "AI"}</span><span><small>{task.concept ?? "AI 情报"}</small><b>{task.topic}</b><em>{task.tags.map((tag) => `#${tag}`).join(" ")}</em><i className={`publish-${task.publish?.status.toLowerCase() ?? "none"}`}>{task.publish?.status === "PUBLISHED" ? "网站已发布" : task.publish?.status === "FAILED" ? "待重试发布" : "私有归档"}</i></span></button>)}</div></div>)}</section>;
}

function NewDraftModal({ onClose, onCreate }: { onClose: () => void; onCreate: (input: Record<string, unknown>) => Promise<void> }) {
  const [topic, setTopic] = useState(""); const [sources, setSources] = useState(""); const [judgment, setJudgment] = useState(""); const [concept, setConcept] = useState(""); const [tags, setTags] = useState(""); const [notes, setNotes] = useState("");
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><form className="draft-modal" onSubmit={(event) => { event.preventDefault(); void onCreate({ topic, sources: sources.split("\n").map((url) => url.trim()).filter(Boolean).map((url) => ({ url })), personalJudgment: judgment || undefined, concept: concept || undefined, tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean), notes: notes || undefined }); }}><header><div><span>MANUAL DRAFT</span><h2>新建选题初稿</h2></div><button type="button" onClick={onClose}>×</button></header><label>主题 *<input autoFocus required value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="例如：某个新模型真正改变了什么" /></label><div className="form-row"><label>顺手讲懂的概念<input value={concept} onChange={(event) => setConcept(event.target.value)} placeholder="Agent / Skill / MCP…" /></label><label>标签<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="AI资讯, Agent" /></label></div><label>来源链接（每行一个）<textarea value={sources} onChange={(event) => setSources(event.target.value)} placeholder="https://…" /></label><label>我的判断<textarea value={judgment} onChange={(event) => setJudgment(event.target.value)} placeholder="先记录你直觉上赞成、怀疑或想验证的地方" /></label><label>备注<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label><footer><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" type="submit">创建初稿</button></footer></form></div>;
}

function Info({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><b>{value}</b></div>; }
function groupDrafts(tasks: CreatorTask[], batches: Map<string, string>) { const groups = new Map<string, CreatorTask[]>(); for (const task of tasks) { const key = batches.get(task.id) ?? "manual"; groups.set(key, [...(groups.get(key) ?? []), task]); } return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a)); }
function statusLabel(status: TaskStatus) { return ({ DRAFT: "初稿", TODO: "待办", RUNNING: "执行中", NEEDS_DECISION: "待决策", COMPLETED: "已完成", ARCHIVED: "已归档", DISMISSED: "已放弃" } as const)[status]; }
function stageLabel(stage: CreatorTask["workflowStage"]) { return ({ candidate: "候选", research: "信源与研究", title_cover: "标题与封面", production: "四平台制作", review: "终审", finalize: "交付完成" } as const)[stage]; }
function platformLabel(platform: Platform) { return ({ bilibili: "B站", douyin: "抖音", shipinhao: "视频号", xiaohongshu: "小红书" } as const)[platform]; }
function formatDate(date: string) { return new Date(`${date}T00:00:00`).toLocaleDateString("zh-CN", { month: "long", day: "numeric" }); }
function formatMonth(month: string) { const [year, value] = month.split("-"); return `${year} 年 ${Number(value)} 月`; }
function relativeTime(value: string) { const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60000); if (minutes < 1) return "刚刚"; if (minutes < 60) return `${minutes} 分钟前`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours} 小时前`; return `${Math.floor(hours / 24)} 天前`; }
function groupBy<T>(values: T[], keyFor: (value: T) => string): Record<string, T[]> { return values.reduce<Record<string, T[]>>((groups, value) => { const key = keyFor(value); (groups[key] ??= []).push(value); return groups; }, {}); }

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><BoardApp /></StrictMode>);
