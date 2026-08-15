import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BoardService } from "../src/board-service.js";
import type { AppConfig } from "../src/config.js";
import { transitionTask } from "../src/domain/state-machine.js";
import type { CreatorTask } from "../src/domain/types.js";
import type { CandidateScanResult, CreatorExecutor, StageResult } from "../src/executor/codex-executor.js";
import { MemoryNotifier } from "../src/notifications.js";
import { FileStore } from "../src/storage/file-store.js";
import type { GitWorkspace } from "../src/sync/git-workspace.js";
import { completeArtifacts, readySync } from "./helpers.js";

class FakeWorkspace {
  getHealth() { return readySync; }
  async getLease() { return { schemaVersion: 1 as const, deviceId: "device-a", deviceName: "Test", activatedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }; }
  async withMutation<T>(_message: string, operation: () => Promise<T>) { return operation(); }
  async activateDevice() { return this.getLease(); }
  async syncWorkspace() { return readySync; }
}

class MockExecutor implements CreatorExecutor {
  calls = 0;
  constructor(private readonly run: (task: CreatorTask, call: number) => Promise<StageResult>) {}
  async scanCandidates(): Promise<CandidateScanResult> { throw new Error("not used"); }
  async runStage(task: CreatorTask): Promise<StageResult> { this.calls += 1; return this.run(task, this.calls); }
}

const baseResult = (task: CreatorTask, overrides: Partial<StageResult> = {}): StageResult => ({
  summary: "阶段完成",
  nextStage: "production",
  artifacts: [],
  reviews: [],
  needsDecision: null,
  threadId: task.threadId ?? "019-test-thread",
  progress: [],
  ...overrides
});

async function setup(executor: CreatorExecutor) {
  const root = await mkdtemp(join(tmpdir(), "creator-runner-"));
  const store = new FileStore(root);
  await store.ensureLayout();
  const config: AppConfig = { dataDir: root, deviceId: "device-a", deviceName: "Test", publisherCacheDir: join(root, "publisher"), coverBackend: "bitto", codexPath: "codex" };
  const notifier = new MemoryNotifier();
  const service = new BoardService(config, store, new FakeWorkspace() as unknown as GitWorkspace, executor, notifier);
  return { root, store, service, notifier };
}

async function createTodo(store: FileStore, topic: string) {
  const draft = await store.createDraft({ topic });
  return store.mutateTask(draft.id, draft.version, (task) => transitionTask(task, { type: "APPROVE" }));
}

describe("serial worker", () => {
  it("claims exactly one queued card and pauses at title/cover decision", async () => {
    const executor = new MockExecutor(async (task) => baseResult(task, {
      needsDecision: { kind: "TITLE_COVER", question: "选标题和封面", context: "三个方向", options: [] }
    }));
    const { store, service } = await setup(executor);
    const first = await createTodo(store, "第一张");
    const second = await createTodo(store, "第二张");
    const result = await service.runWorkerOnce();
    expect(result.action).toBe("needs-decision");
    expect((await store.getTask(first.id)).status).toBe("NEEDS_DECISION");
    expect((await store.getTask(second.id)).status).toBe("TODO");
    expect(executor.calls).toBe(1);
  });

  it("retries technical failures three times and leaves RUNNING as Blocked", async () => {
    const executor = new MockExecutor(async () => { throw new Error("SDK unavailable"); });
    const { store, service, notifier } = await setup(executor);
    const todo = await createTodo(store, "会失败的任务");
    const result = await service.runWorkerOnce(todo.id);
    const task = await store.getTask(todo.id);
    expect(result.action).toBe("blocked");
    expect(executor.calls).toBe(3);
    expect(task.status).toBe("RUNNING");
    expect(task.blocked?.attempts).toBe(3);
    expect(notifier.messages.at(-1)?.kind).toBe("blocked");
  });

  it("stops for a decision after two failed review rounds", async () => {
    const executor = new MockExecutor(async (task) => task.workflowStage === "production"
      ? baseResult(task, { nextStage: "review", summary: "已按建议返工" })
      : baseResult(task, {
          nextStage: "production",
          summary: "终审未通过",
          reviews: ["bilibili", "douyin", "shipinhao", "xiaohongshu"].map((platform) => ({ platform: platform as "bilibili", status: "FAIL", failures: ["失败原句"], suggestions: ["改得更准确"] }))
        }));
    const { store, service } = await setup(executor);
    const draft = await store.createDraft({ topic: "终审任务" });
    let task = await store.mutateTask(draft.id, draft.version, (current) => ({ ...current, version: current.version + 1, status: "RUNNING", workflowStage: "review", artifacts: completeArtifacts() }));
    expect((await service.runWorkerOnce(task.id)).message).toContain("自动返工");
    task = await store.getTask(task.id);
    expect(task.reviewRounds).toBe(1);
    await service.runWorkerOnce(task.id);
    const final = await service.runWorkerOnce(task.id);
    task = await store.getTask(task.id);
    expect(final.action).toBe("needs-decision");
    expect(task.reviewRounds).toBe(2);
    expect(task.pendingDecision?.kind).toBe("REVIEW_FAILED");
    expect(task.pendingDecision?.context).toContain("失败原句");
  });
});
