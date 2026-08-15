import { Codex, type ThreadEvent } from "@openai/codex-sdk";
import { relative } from "node:path";
import type { AppConfig } from "../config.js";
import { candidateBatchOutputSchema, stageOutputSchema } from "../domain/contracts.js";
import type {
  ArtifactRecord,
  CandidateInput,
  ConversationEntry,
  CreatorTask,
  PendingDecision,
  Platform,
  ProgressEvent,
  WorkflowStage
} from "../domain/types.js";

export interface CandidateScanResult {
  date: string;
  candidates: CandidateInput[];
  sourceErrors: string[];
  threadId: string;
  progress: ProgressEvent[];
}

export interface StageReview {
  platform: Platform;
  status: "PASS" | "FAIL";
  failures: string[];
  suggestions: string[];
}

export interface StageResult {
  summary: string;
  nextStage: Exclude<WorkflowStage, "candidate">;
  artifacts: Array<Omit<ArtifactRecord, "id" | "createdAt">>;
  reviews: StageReview[];
  needsDecision: Omit<PendingDecision, "id" | "createdAt"> | null;
  threadId: string;
  rebuiltFromThreadId?: string;
  progress: ProgressEvent[];
}

export interface CreatorExecutor {
  scanCandidates(date: string): Promise<CandidateScanResult>;
  runStage(task: CreatorTask, conversation: ConversationEntry[]): Promise<StageResult>;
}

export class CodexCreatorExecutor implements CreatorExecutor {
  private readonly codex: Codex;

  constructor(
    private readonly config: AppConfig,
    private readonly skillDirectory: string
  ) {
    this.codex = new Codex({ codexPathOverride: config.codexPath });
  }

  async scanCandidates(date: string): Promise<CandidateScanResult> {
    const thread = this.codex.startThread(this.threadOptions());
    const prompt = [
      `今天是 ${date}（Asia/Shanghai）。`,
      `请先完整读取并遵守 ${this.skillDirectory}/SKILL.md，然后只执行“每日候选扫描”阶段。`,
      "联网核查最近 7 天的一手信源，交付恰好 5 条互不重复、证据达标的 AI 资讯候选。",
      "只返回符合 outputSchema 的 JSON；若某类来源失败，写入 sourceErrors，不伪造数据。",
      "不要写稿、不要生成标题或封面、不要推进任何候选。"
    ].join("\n");
    const streamed = await thread.runStreamed(prompt, { outputSchema: candidateBatchOutputSchema });
    const collected = await collectStream(streamed.events, "candidate");
    const parsed = parseStructured<{ date: string; candidates: CandidateInput[]; sourceErrors: string[] }>(collected.finalResponse);
    return {
      ...parsed,
      threadId: collected.threadId ?? thread.id ?? "",
      progress: collected.progress
    };
  }

  async runStage(task: CreatorTask, conversation: ConversationEntry[]): Promise<StageResult> {
    const sameDevice = task.threadId && task.threadDeviceId === this.config.deviceId;
    const thread = sameDevice
      ? this.codex.resumeThread(task.threadId!, this.threadOptions())
      : this.codex.startThread(this.threadOptions());
    const rebuiltFromThreadId = task.threadId && !sameDevice ? task.threadId : undefined;
    const taskDirectory = `active/${task.id}`;
    const history = conversation.slice(-40).map((entry) => `${entry.role}: ${entry.content}`).join("\n");
    const prompt = [
      `请完整读取并遵守 ${this.skillDirectory}/SKILL.md。`,
      `当前数据仓库是 ${this.config.dataDir}，任务目录是 ${taskDirectory}，所有产物只能写入 ${taskDirectory}/artifacts/。`,
      rebuiltFromThreadId ? `这是跨设备重建线程。旧线程 ${rebuiltFromThreadId} 不可恢复；以下任务检查点与对话镜像是唯一依据。` : "继续本任务的独立 Codex 线程。",
      `当前阶段：${task.workflowStage}`,
      `任务检查点：${JSON.stringify(task)}`,
      history ? `最近对话镜像：\n${history}` : "暂无对话镜像。",
      stageInstruction(task),
      "每个返回的 artifact.path 必须是相对任务目录的路径（以 artifacts/ 开头），并且文件已实际写入。",
      "只返回符合 outputSchema 的 JSON。"
    ].join("\n\n");
    const streamed = await thread.runStreamed(prompt, { outputSchema: stageOutputSchema });
    const collected = await collectStream(streamed.events, task.workflowStage);
    const parsed = parseStructured<Omit<StageResult, "threadId" | "rebuiltFromThreadId" | "progress">>(collected.finalResponse);
    return {
      ...parsed,
      artifacts: parsed.artifacts.map((artifact) => ({
        ...artifact,
        path: normalizeArtifactPath(artifact.path, task.id)
      })),
      threadId: collected.threadId ?? thread.id ?? task.threadId ?? "",
      ...(rebuiltFromThreadId ? { rebuiltFromThreadId } : {}),
      progress: collected.progress
    };
  }

  private threadOptions() {
    return {
      workingDirectory: this.config.dataDir,
      additionalDirectories: [this.skillDirectory],
      skipGitRepoCheck: false,
      sandboxMode: "workspace-write" as const,
      approvalPolicy: "never" as const,
      networkAccessEnabled: true,
      webSearchMode: "live" as const,
      modelReasoningEffort: "high" as const
    };
  }
}

function stageInstruction(task: CreatorTask): string {
  switch (task.workflowStage) {
    case "research":
      return [
        "完成深挖、事实台账、概念解释、5 个母标题与 2—3 个封面方向。",
        "写出 artifacts/research-card.md 与 artifacts/fact-ledger.md。",
        "标题与封面是必停决策点：needsDecision.kind 必须为 TITLE_COVER，options 给出可选组合，nextStage 返回 production。",
        "如题材敏感或信源冲突，改用对应 needsDecision.kind 并附原始证据。"
      ].join("\n");
    case "title_cover":
      return "整理标题与封面方向并返回 TITLE_COVER 决策表单，不进入写稿。";
    case "production":
      return [
        "依据已确认观点、标题和封面方向制作四平台完整交付包。",
        "必须分别生成四平台口播稿、含镜号/时长/画面/口播/屏幕文字/素材来源/画幅的分镜表，以及标题/描述/关键词/发布备注。",
        "生成一张横版和一张竖版共享封面；四平台短稿不能由长稿平均压缩。",
        "完成来源附录与 manifest，nextStage 返回 review。"
      ].join("\n");
    case "review":
      return [
        `执行四平台硬终审。这是第 ${task.reviewRounds + 1} 轮，逐平台输出 PASS 或 FAIL。`,
        "FAIL 必须逐字列出失败原句与修改建议；允许直接修复后重新检查。",
        "每个平台写 review-report artifact；全部 PASS 时 nextStage 返回 finalize。"
      ].join("\n");
    case "finalize":
      return "核对产物清单、四平台 PASS 和文件存在性；不再改写内容，nextStage 返回 finalize。";
    case "candidate":
      return "该候选尚未获批，不应执行后续生产。";
  }
}

async function collectStream(events: AsyncGenerator<ThreadEvent>, stage: WorkflowStage) {
  const progress: ProgressEvent[] = [];
  let finalResponse = "";
  let threadId: string | undefined;
  for await (const event of events) {
    const at = new Date().toISOString();
    if (event.type === "thread.started") threadId = event.thread_id;
    if (event.type !== "item.completed") continue;
    const item = event.item;
    if (item.type === "agent_message") {
      finalResponse = item.text;
      continue;
    }
    if (item.type === "reasoning") progress.push(progressEvent(stage, "reasoning", item.text, at));
    if (item.type === "web_search") progress.push(progressEvent(stage, "tool", `搜索：${item.query}`, at));
    if (item.type === "mcp_tool_call") progress.push(progressEvent(stage, "tool", `${item.server}/${item.tool}: ${item.status}`, at));
    if (item.type === "file_change") progress.push(progressEvent(stage, "file", item.changes.map((change) => `${change.kind} ${change.path}`).join("；"), at));
    if (item.type === "command_execution") progress.push(progressEvent(stage, item.status === "failed" ? "error" : "tool", `${item.command}: ${item.status}`, at));
    if (item.type === "error") progress.push(progressEvent(stage, "error", item.message, at));
  }
  if (!finalResponse) throw new Error("Codex completed without a structured response");
  return { finalResponse, threadId, progress };
}

function progressEvent(stage: WorkflowStage, type: ProgressEvent["type"], message: string, at: string): ProgressEvent {
  return { id: crypto.randomUUID(), at, stage, type, message: message.slice(0, 1200) };
}

function parseStructured<T>(text: string): T {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed) as T;
}

function normalizeArtifactPath(path: string, taskId: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const taskPrefix = `active/${taskId}/`;
  const relativePath = normalized.startsWith(taskPrefix) ? normalized.slice(taskPrefix.length) : normalized;
  if (!relativePath.startsWith("artifacts/") || relativePath.includes("../")) {
    throw new Error(`Unsafe artifact path: ${path}`);
  }
  return relativePath;
}
