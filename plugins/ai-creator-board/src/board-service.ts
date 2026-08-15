import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { stat } from "node:fs/promises";
import type { AppConfig } from "./config.js";
import { classifyRevisionScope, findMissingArtifacts, isArchiveDue, transitionTask } from "./domain/state-machine.js";
import type {
  ArchiveQuery,
  ArtifactRecord,
  BatchRecord,
  BoardSnapshot,
  CreatorTask,
  DecisionKind,
  PendingDecision,
  Platform,
  SelectedViewpoint,
  ViewpointOption
} from "./domain/types.js";
import type { CreatorExecutor, StageResult } from "./executor/codex-executor.js";
import type { NotificationAdapter, NotificationKind } from "./notifications.js";
import type { SitePublisher } from "./publisher/site-publisher.js";
import { FileStore } from "./storage/file-store.js";
import { GitWorkspace } from "./sync/git-workspace.js";

export interface WorkerResult {
  action: "idle" | "processed" | "blocked" | "needs-decision" | "completed";
  task?: CreatorTask;
  message: string;
}

export class BoardService {
  constructor(
    readonly config: AppConfig,
    readonly store: FileStore,
    readonly workspace: GitWorkspace,
    private readonly executor: CreatorExecutor,
    private readonly notifier: NotificationAdapter,
    private readonly publisher?: SitePublisher
  ) {}

  async initialize(): Promise<void> {
    await this.store.ensureLayout();
  }

  async getSnapshot(): Promise<BoardSnapshot> {
    return this.store.boardSnapshot(this.workspace.getHealth(), await this.workspace.getLease());
  }

  async getTaskDetail(taskId: string) {
    return this.store.getTaskDetail(taskId);
  }

  async queryArchive(query: ArchiveQuery) {
    return this.store.queryArchive(query);
  }

  async activateDevice() {
    return this.workspace.activateDevice();
  }

  async syncWorkspace() {
    try {
      return await this.workspace.syncWorkspace({ allowDirty: false, allowInactive: true });
    } catch (error) {
      await this.safeNotify("sync-failed", "AI Creator Board 同步失败", (error as Error).message);
      throw error;
    }
  }

  async createDraft(input: {
    topic: string;
    sources?: Array<{ url: string; title?: string }>;
    personalJudgment?: string;
    concept?: string;
    tags?: string[];
    notes?: string;
  }): Promise<CreatorTask> {
    return this.workspace.withMutation(`draft: ${input.topic}`, () => this.store.createDraft(input));
  }

  async approveCandidate(input: {
    taskId: string;
    expectedVersion: number;
    viewpoint: "A" | "B" | "C" | "AUTO";
    personalJudgment?: string;
  }): Promise<CreatorTask> {
    return this.workspace.withMutation(`approve: ${input.taskId}`, async () => {
      return this.store.mutateTask(input.taskId, input.expectedVersion, (current) => {
        const selectedViewpoint = selectViewpoint(current.viewpointOptions ?? [], input.viewpoint);
        const approved = transitionTask({
          ...current,
          selectedViewpoint,
          ...(input.personalJudgment ? { personalJudgment: input.personalJudgment } : {})
        }, { type: "APPROVE" });
        return approved;
      });
    });
  }

  async submitDecision(input: {
    taskId: string;
    expectedVersion: number;
    decisionId: string;
    answer: string;
    optionId?: string;
  }): Promise<CreatorTask> {
    return this.workspace.withMutation(`decision: ${input.taskId}`, async () => {
      const current = await this.store.getTask(input.taskId);
      if (current.version !== input.expectedVersion) {
        return this.store.mutateTask(input.taskId, input.expectedVersion, (task) => task);
      }
      if (!current.pendingDecision || current.pendingDecision.id !== input.decisionId) throw new Error("Decision is stale or no longer pending");
      await this.store.appendDecision(input.taskId, {
        decisionId: input.decisionId,
        kind: current.pendingDecision.kind,
        answer: input.answer,
        ...(input.optionId ? { optionId: input.optionId } : {})
      });
      await this.store.appendConversation(input.taskId, { role: "user", content: input.answer });
      return this.store.mutateTask(input.taskId, input.expectedVersion, (task) => transitionTask(task, { type: "RESUME" }));
    });
  }

  async sendTaskMessage(input: {
    taskId: string;
    expectedVersion: number;
    message: string;
  }): Promise<CreatorTask> {
    return this.workspace.withMutation(`message: ${input.taskId}`, async () => {
      const current = await this.store.getTask(input.taskId);
      const scope = current.status === "COMPLETED" ? classifyRevisionScope(input.message) : "all";
      await this.store.appendConversation(input.taskId, { role: "user", content: input.message, scope });
      return this.store.mutateTask(input.taskId, input.expectedVersion, (task) => {
        if (task.status === "COMPLETED") return transitionTask(task, { type: "REVISE" });
        return { ...task, version: task.version + 1, updatedAt: new Date().toISOString() };
      });
    });
  }

  async dismissDraft(taskId: string, expectedVersion: number): Promise<CreatorTask> {
    return this.workspace.withMutation(`dismiss: ${taskId}`, () =>
      this.store.mutateTask(taskId, expectedVersion, (task) => transitionTask(task, { type: "DISMISS" }))
    );
  }

  async retryTask(taskId: string, expectedVersion: number): Promise<CreatorTask> {
    return this.workspace.withMutation(`retry: ${taskId}`, () =>
      this.store.mutateTask(taskId, expectedVersion, (task) => {
        if (task.status !== "RUNNING") throw new Error("Only a running blocked task can be retried");
        return { ...task, version: task.version + 1, blocked: undefined, technicalAttempts: 0, updatedAt: new Date().toISOString() };
      })
    );
  }

  async runDailyScan(date = shanghaiDate()): Promise<BatchRecord> {
    const snapshot = await this.getSnapshot();
    const existing = snapshot.batches.find((batch) => batch.date === date);
    if (existing) return existing;
    return this.workspace.withMutation(`scan: ${date}`, async () => {
      const scan = await this.executor.scanCandidates(date);
      return this.store.createBatch(scan.date, scan.candidates, scan.sourceErrors, scan.threadId);
    });
  }

  async runWorkerOnce(preferredTaskId?: string): Promise<WorkerResult> {
    await this.archiveDueTasks();
    let notification: { kind: NotificationKind; title: string; body: string; threadId?: string } | undefined;
    const result = await this.workspace.withMutation("worker: process one task", async () => {
      const tasks = await this.store.listTasks(["RUNNING", "TODO"]);
      const eligible = tasks
        .filter((item) => !item.blocked)
        .sort((a, b) => {
          const priority = (value: CreatorTask) => value.status === "RUNNING" ? 0 : 1;
          return priority(a) - priority(b) || a.updatedAt.localeCompare(b.updatedAt);
        });
      let task = (preferredTaskId ? eligible.find((item) => item.id === preferredTaskId) : undefined) ?? eligible[0];
      if (!task) return { action: "idle", message: "没有可领取的任务" } satisfies WorkerResult;
      if (task.status === "TODO") {
        task = await this.store.mutateTask(task.id, task.version, (current) => transitionTask(current, { type: "START" }));
      }

      if (task.workflowStage === "production" && this.config.coverBackend === "none" && !hasBothCovers(task.artifacts)) {
        task = await this.pauseForDecision(task, "CONFIGURATION", "封面后端尚未配置", "请在本机配置 Bitto，或手工放入横竖封面后再继续。", [
          { id: "configured", label: "已配置 Bitto", description: "继续生成横竖封面与四平台交付包" },
          { id: "manual", label: "我会手工提供", description: "将横竖封面放入 artifacts 后继续" }
        ]);
        notification = { kind: "decision", title: "AI Creator Board 等待配置", body: task.topic, ...(task.threadId ? { threadId: task.threadId } : {}) };
        return { action: "needs-decision", task, message: "缺少封面后端配置" } satisfies WorkerResult;
      }

      let stageResult: StageResult | undefined;
      let lastError: Error | undefined;
      const detail = await this.store.getTaskDetail(task.id);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          stageResult = await this.executor.runStage(task, detail.conversation);
          break;
        } catch (error) {
          lastError = error as Error;
          task = await this.store.mutateTask(task.id, task.version, (current) => ({
            ...current,
            version: current.version + 1,
            technicalAttempts: current.technicalAttempts + 1,
            progress: [...current.progress, {
              id: randomUUID(),
              at: new Date().toISOString(),
              stage: current.workflowStage,
              type: "error",
              message: `技术重试 ${attempt}/3：${lastError!.message}`
            }]
          }));
        }
      }
      if (!stageResult) {
        task = await this.store.mutateTask(task.id, task.version, (current) => ({
          ...current,
          version: current.version + 1,
          blocked: { reason: lastError?.message ?? "Unknown executor error", attempts: current.technicalAttempts, since: new Date().toISOString() }
        }));
        notification = { kind: "blocked", title: "AI Creator Board 任务阻塞", body: `${task.topic}：${lastError?.message ?? "未知错误"}`, ...(task.threadId ? { threadId: task.threadId } : {}) };
        return { action: "blocked", task, message: lastError?.message ?? "连续三次执行失败" } satisfies WorkerResult;
      }

      const verifiedArtifacts = await this.verifyArtifacts(task.id, stageResult.artifacts);
      const mergedArtifacts = mergeArtifacts(task.artifacts, verifiedArtifacts);
      task = await this.store.mutateTask(task.id, task.version, (current) => ({
        ...current,
        version: current.version + 1,
        threadId: stageResult!.threadId,
        threadDeviceId: this.config.deviceId,
        ...(stageResult!.rebuiltFromThreadId ? { rebuiltFromThreadId: stageResult!.rebuiltFromThreadId } : {}),
        progress: [...current.progress, ...stageResult!.progress, {
          id: randomUUID(), at: new Date().toISOString(), stage: current.workflowStage, type: "status", message: stageResult!.summary
        }],
        artifacts: mergedArtifacts,
        workflowStage: stageResult!.nextStage,
        technicalAttempts: 0,
        blocked: undefined
      }));
      await this.store.appendConversation(task.id, { role: "assistant", content: stageResult.summary, threadId: stageResult.threadId });

      if (stageResult.needsDecision || detail.task.workflowStage === "research" || detail.task.workflowStage === "title_cover") {
        const decision = stageResult.needsDecision ?? {
          kind: "TITLE_COVER" as const,
          question: "请选择标题与封面方向",
          context: stageResult.summary,
          options: []
        };
        task = await this.pauseForDecision(task, decision.kind, decision.question, decision.context, decision.options);
        notification = { kind: "decision", title: "AI Creator Board 等待决策", body: task.topic, threadId: stageResult.threadId };
        return { action: "needs-decision", task, message: decision.question } satisfies WorkerResult;
      }

      if (detail.task.workflowStage === "review") {
        const allReviewsPass = stageResult.reviews.length === 4 && stageResult.reviews.every((review) => review.status === "PASS");
        const missing = findMissingArtifacts(task.artifacts);
        if (!allReviewsPass || missing.length > 0) {
          const nextRound = task.reviewRounds + 1;
          task = await this.store.mutateTask(task.id, task.version, (current) => ({
            ...current,
            version: current.version + 1,
            reviewRounds: nextRound,
            workflowStage: "production"
          }));
          if (nextRound >= 2) {
            const failures = [
              ...stageResult.reviews.flatMap((review) => review.failures.map((line) => `${review.platform}: ${line}`)),
              ...missing.map((item) => `缺少产物：${item}`)
            ];
            task = await this.pauseForDecision(task, "REVIEW_FAILED", "两轮自动返工后仍未通过终审", failures.join("\n"), [
              { id: "continue", label: "按建议继续返工", description: stageResult.reviews.flatMap((review) => review.suggestions).join("；") },
              { id: "override", label: "补充人工要求", description: "写下新的修改边界后继续" }
            ]);
            notification = { kind: "decision", title: "AI Creator Board 终审待决策", body: task.topic, threadId: stageResult.threadId };
            return { action: "needs-decision", task, message: "两轮终审未通过" } satisfies WorkerResult;
          }
          return { action: "processed", task, message: "终审未通过，已安排自动返工" } satisfies WorkerResult;
        }
        task = await this.store.mutateTask(task.id, task.version, (current) => transitionTask({ ...current, reviewRounds: current.reviewRounds + 1 }, { type: "COMPLETE" }));
        notification = { kind: "completed", title: "AI Creator Board 已完成", body: task.topic, threadId: stageResult.threadId };
        return { action: "completed", task, message: "四平台交付包已通过终审" } satisfies WorkerResult;
      }

      return { action: "processed", task, message: stageResult.summary } satisfies WorkerResult;
    });
    if (notification) await this.safeNotify(notification.kind, notification.title, notification.body, notification.threadId);
    return result;
  }

  async archiveTask(taskId: string, expectedVersion: number): Promise<CreatorTask> {
    let archived = await this.workspace.withMutation(`archive: ${taskId}`, () =>
      this.store.mutateTask(taskId, expectedVersion, (task) => transitionTask({
        ...task,
        publish: this.publisher ? { status: "PENDING", updatedAt: new Date().toISOString() } : task.publish
      }, { type: "ARCHIVE" }))
    );
    if (!this.publisher) return archived;
    const detail = await this.store.getTaskDetail(taskId);
    try {
      const published = await this.publisher.publish(archived, dirname(detail.artifactRoot));
      archived = await this.workspace.withMutation(`publish: ${taskId}`, () =>
        this.store.mutateTask(taskId, archived.version, (task) => ({
          ...task,
          version: task.version + 1,
          publish: { status: "PUBLISHED", url: published.articlePath, updatedAt: new Date().toISOString() }
        }))
      );
    } catch (error) {
      archived = await this.workspace.withMutation(`publish failed: ${taskId}`, () =>
        this.store.mutateTask(taskId, archived.version, (task) => ({
          ...task,
          version: task.version + 1,
          publish: { status: "FAILED", error: (error as Error).message, updatedAt: new Date().toISOString() }
        }))
      );
      await this.safeNotify("publish-failed", "AI Creator Board 网站发布失败", `${archived.topic}：${(error as Error).message}`, archived.threadId);
    }
    return archived;
  }

  private async archiveDueTasks(): Promise<void> {
    const due = (await this.store.listTasks(["COMPLETED"])).filter((task) => isArchiveDue(task));
    for (const task of due) await this.archiveTask(task.id, task.version);
  }

  private async pauseForDecision(
    task: CreatorTask,
    kind: DecisionKind,
    question: string,
    context: string | undefined,
    options: Array<{ id: string; label: string; description?: string }> | undefined
  ): Promise<CreatorTask> {
    return this.store.mutateTask(task.id, task.version, (current) => transitionTask({
      ...current,
      pendingDecision: {
        id: randomUUID(),
        kind,
        question,
        createdAt: new Date().toISOString(),
        ...(context ? { context } : {}),
        ...(options ? { options } : {})
      }
    }, { type: "REQUEST_DECISION" }));
  }

  private async verifyArtifacts(taskId: string, artifacts: StageResult["artifacts"]): Promise<ArtifactRecord[]> {
    const taskRoot = join(this.config.dataDir, "active", taskId);
    const verified: ArtifactRecord[] = [];
    for (const artifact of artifacts) {
      const absolute = join(taskRoot, artifact.path);
      await stat(absolute);
      verified.push({ id: randomUUID(), createdAt: new Date().toISOString(), ...artifact });
    }
    return verified;
  }

  private async safeNotify(kind: NotificationKind, title: string, body: string, threadId?: string): Promise<void> {
    try {
      await this.notifier.notify({ kind, title, body, ...(threadId ? { threadId } : {}) });
    } catch {
      // Notifications are a secondary channel; task state remains authoritative.
    }
  }
}

function selectViewpoint(options: ViewpointOption[], selection: "A" | "B" | "C" | "AUTO"): SelectedViewpoint {
  if (selection === "AUTO") {
    return { mode: "AUTO", statement: "授权 Codex 选择证据最充分的观点", rationale: "执行阶段必须记录选择理由和反方证据" };
  }
  const option = options.find((item) => item.key === selection);
  if (!option) throw new Error(`Viewpoint ${selection} is unavailable`);
  return { mode: selection, statement: option.statement, rationale: option.rationale };
}

function mergeArtifacts(existing: ArtifactRecord[], incoming: ArtifactRecord[]): ArtifactRecord[] {
  const keys = new Set(incoming.map(artifactKey));
  return [...existing.filter((artifact) => !keys.has(artifactKey(artifact))), ...incoming];
}

function artifactKey(artifact: Pick<ArtifactRecord, "type" | "platform">): string {
  return `${artifact.type}:${artifact.platform ?? "shared"}`;
}

function hasBothCovers(artifacts: ArtifactRecord[]): boolean {
  return artifacts.some((item) => item.type === "cover-horizontal") && artifacts.some((item) => item.type === "cover-vertical");
}

function shanghaiDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
