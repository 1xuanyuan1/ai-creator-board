import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type {
  ArchiveQuery,
  BatchRecord,
  BoardSnapshot,
  CandidateInput,
  ConversationEntry,
  CreatorTask,
  DecisionEntry,
  DeviceLease,
  SyncHealth
} from "../domain/types.js";

export class VersionConflictError extends Error {
  constructor(public readonly expected: number, public readonly actual: number) {
    super(`Task version conflict: expected ${expected}, current ${actual}`);
  }
}

export class TaskNotFoundError extends Error {}

interface LocatedTask {
  task: CreatorTask;
  dir: string;
}

export class FileStore {
  private lockTail: Promise<void> = Promise.resolve();

  constructor(readonly root: string) {}

  async ensureLayout(): Promise<void> {
    await Promise.all([
      mkdir(join(this.root, "batches"), { recursive: true }),
      mkdir(join(this.root, "active"), { recursive: true }),
      mkdir(join(this.root, "archive"), { recursive: true }),
      mkdir(join(this.root, "dismissed"), { recursive: true }),
      mkdir(join(this.root, "profiles"), { recursive: true }),
      mkdir(join(this.root, ".board"), { recursive: true })
    ]);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async writeJsonAtomic(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  }

  private async readJson<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(path, "utf8")) as T;
  }

  async createDraft(input: {
    topic: string;
    sources?: CreatorTask["sources"];
    personalJudgment?: string;
    concept?: string;
    tags?: string[];
    notes?: string;
    batchDate?: string;
  }): Promise<CreatorTask> {
    return this.withLock(async () => {
      const now = new Date().toISOString();
      const task: CreatorTask = {
        schemaVersion: 1,
        id: randomUUID(),
        version: 1,
        profile: "ai-intel",
        topic: input.topic.trim(),
        sources: input.sources ?? [],
        tags: input.tags ?? [],
        status: "DRAFT",
        workflowStage: "candidate",
        progress: [],
        artifacts: [],
        reviewRounds: 0,
        technicalAttempts: 0,
        createdAt: now,
        updatedAt: now,
        ...(input.personalJudgment ? { personalJudgment: input.personalJudgment } : {}),
        ...(input.concept ? { concept: input.concept } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.batchDate ? { batchDate: input.batchDate } : {})
      };
      const dir = join(this.root, "active", task.id);
      await mkdir(join(dir, "artifacts"), { recursive: true });
      await this.writeJsonAtomic(join(dir, "task.json"), task);
      await Promise.all([
        writeFile(join(dir, "conversation.jsonl"), "", { flag: "a" }),
        writeFile(join(dir, "decisions.jsonl"), "", { flag: "a" })
      ]);
      return task;
    });
  }

  async createBatch(date: string, candidates: CandidateInput[], sourceErrors: string[] = [], scanThreadId?: string): Promise<BatchRecord> {
    const taskIds: string[] = [];
    for (const [index, candidate] of candidates.entries()) {
      const task = await this.createDraft({
        topic: candidate.topic,
        sources: [...candidate.primarySources, ...candidate.crossSources],
        concept: candidate.concept,
        tags: candidate.tags,
        batchDate: date,
        notes: [candidate.factStatus, candidate.whyNow, candidate.tension, candidate.audience].join("\n")
      });
      await this.mutateTask(task.id, task.version, (current) => ({
        ...current,
        candidateRank: index + 1,
        viewpointOptions: candidate.viewpoints
      }));
      taskIds.push(task.id);
    }
    const batch: BatchRecord = {
      schemaVersion: 1,
      date,
      createdAt: new Date().toISOString(),
      taskIds,
      sourceErrors,
      ...(scanThreadId ? { scanThreadId } : {})
    };
    const [year, month, day] = date.split("-");
    if (!year || !month || !day) throw new Error(`Invalid batch date: ${date}`);
    await this.writeJsonAtomic(join(this.root, "batches", year, month, day, "batch.json"), batch);
    return batch;
  }

  async getTask(id: string): Promise<CreatorTask> {
    return (await this.locateTask(id)).task;
  }

  async getTaskDetail(id: string): Promise<{ task: CreatorTask; conversation: ConversationEntry[]; decisions: DecisionEntry[]; artifactRoot: string }> {
    const located = await this.locateTask(id);
    return {
      task: located.task,
      conversation: await this.readJsonLines<ConversationEntry>(join(located.dir, "conversation.jsonl")),
      decisions: await this.readJsonLines<DecisionEntry>(join(located.dir, "decisions.jsonl")),
      artifactRoot: join(located.dir, "artifacts")
    };
  }

  async mutateTask(id: string, expectedVersion: number, mutate: (task: CreatorTask) => CreatorTask | Promise<CreatorTask>): Promise<CreatorTask> {
    return this.withLock(async () => {
      const located = await this.locateTask(id);
      if (located.task.version !== expectedVersion) throw new VersionConflictError(expectedVersion, located.task.version);
      const next = await mutate(structuredClone(located.task));
      if (next.id !== id) throw new Error("Task id cannot change");
      if (next.version <= located.task.version) next.version = located.task.version + 1;
      next.updatedAt = next.updatedAt || new Date().toISOString();
      await this.writeJsonAtomic(join(located.dir, "task.json"), next);
      const target = this.targetDir(next);
      if (target !== located.dir) {
        await mkdir(dirname(target), { recursive: true });
        await rename(located.dir, target);
      }
      return next;
    });
  }

  async appendConversation(id: string, entry: Omit<ConversationEntry, "id" | "at"> & Partial<Pick<ConversationEntry, "id" | "at">>): Promise<ConversationEntry> {
    return this.withLock(async () => {
      const located = await this.locateTask(id);
      const value: ConversationEntry = {
        id: entry.id ?? randomUUID(),
        at: entry.at ?? new Date().toISOString(),
        role: entry.role,
        content: entry.content,
        ...(entry.scope ? { scope: entry.scope } : {}),
        ...(entry.threadId ? { threadId: entry.threadId } : {})
      };
      await appendFile(join(located.dir, "conversation.jsonl"), `${JSON.stringify(value)}\n`, "utf8");
      return value;
    });
  }

  async appendDecision(id: string, entry: Omit<DecisionEntry, "id" | "at">): Promise<DecisionEntry> {
    return this.withLock(async () => {
      const located = await this.locateTask(id);
      const value: DecisionEntry = { id: randomUUID(), at: new Date().toISOString(), ...entry };
      await appendFile(join(located.dir, "decisions.jsonl"), `${JSON.stringify(value)}\n`, "utf8");
      return value;
    });
  }

  async readArtifact(taskId: string, artifactPath: string): Promise<{ data: Buffer; mimeType: string; name: string }> {
    const located = await this.locateTask(taskId);
    const artifact = located.task.artifacts.find((item) => item.path === artifactPath || item.id === artifactPath);
    if (!artifact) throw new Error("Artifact is not registered on this task");
    const absolute = join(located.dir, artifact.path);
    const rel = relative(located.dir, absolute);
    if (rel.startsWith("..")) throw new Error("Artifact path escapes task directory");
    return { data: await readFile(absolute), mimeType: artifact.mimeType, name: basename(absolute) };
  }

  async boardSnapshot(sync: SyncHealth, lease?: DeviceLease): Promise<BoardSnapshot> {
    const tasks = await this.listActiveTasks();
    const batches = await this.listBatches();
    const archiveMonths = await this.listArchiveMonths();
    const by = (status: CreatorTask["status"]) => tasks.filter((task) => task.status === status).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      generatedAt: new Date().toISOString(),
      sync,
      ...(lease ? { lease } : {}),
      columns: {
        DRAFT: by("DRAFT"),
        TODO: by("TODO"),
        RUNNING: by("RUNNING"),
        NEEDS_DECISION: by("NEEDS_DECISION"),
        COMPLETED: by("COMPLETED")
      },
      batches,
      archiveMonths
    };
  }

  async listTasks(statuses?: CreatorTask["status"][]): Promise<CreatorTask[]> {
    const tasks = await this.listActiveTasks();
    return statuses ? tasks.filter((task) => statuses.includes(task.status)) : tasks;
  }

  async queryArchive(query: ArchiveQuery = {}): Promise<CreatorTask[]> {
    const months = await this.safeReadDir(join(this.root, "archive"));
    const results: CreatorTask[] = [];
    for (const month of months.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse()) {
      for (const taskDir of await this.safeReadDir(join(this.root, "archive", month))) {
        if (!taskDir.isDirectory()) continue;
        const task = await this.readJson<CreatorTask>(join(this.root, "archive", month, taskDir.name, "task.json"));
        if (query.keyword && !`${task.topic} ${task.notes ?? ""} ${task.tags.join(" ")}`.toLowerCase().includes(query.keyword.toLowerCase())) continue;
        if (query.tags?.length && !query.tags.every((tag) => task.tags.includes(tag))) continue;
        if (query.platform && !task.artifacts.some((artifact) => artifact.platform === query.platform)) continue;
        if (query.from && (task.archivedAt ?? "") < query.from) continue;
        if (query.to && (task.archivedAt ?? "") > `${query.to}T23:59:59.999Z`) continue;
        results.push(task);
      }
    }
    return results;
  }

  async readLease(): Promise<DeviceLease | undefined> {
    try {
      return await this.readJson<DeviceLease>(join(this.root, ".board", "device-lease.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async writeLease(lease: DeviceLease): Promise<void> {
    await this.writeJsonAtomic(join(this.root, ".board", "device-lease.json"), lease);
  }

  private async listActiveTasks(): Promise<CreatorTask[]> {
    const entries = await this.safeReadDir(join(this.root, "active"));
    const tasks: CreatorTask[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) tasks.push(await this.readJson<CreatorTask>(join(this.root, "active", entry.name, "task.json")));
    }
    return tasks;
  }

  private async listBatches(): Promise<BatchRecord[]> {
    const records: BatchRecord[] = [];
    for (const year of await this.safeReadDir(join(this.root, "batches"))) {
      if (!year.isDirectory()) continue;
      for (const month of await this.safeReadDir(join(this.root, "batches", year.name))) {
        if (!month.isDirectory()) continue;
        for (const day of await this.safeReadDir(join(this.root, "batches", year.name, month.name))) {
          if (!day.isDirectory()) continue;
          records.push(await this.readJson<BatchRecord>(join(this.root, "batches", year.name, month.name, day.name, "batch.json")));
        }
      }
    }
    return records.sort((a, b) => b.date.localeCompare(a.date));
  }

  private async listArchiveMonths(): Promise<Array<{ month: string; count: number }>> {
    const months: Array<{ month: string; count: number }> = [];
    for (const entry of await this.safeReadDir(join(this.root, "archive"))) {
      if (!entry.isDirectory()) continue;
      const count = (await this.safeReadDir(join(this.root, "archive", entry.name))).filter((item) => item.isDirectory()).length;
      months.push({ month: entry.name, count });
    }
    return months.sort((a, b) => b.month.localeCompare(a.month));
  }

  private targetDir(task: CreatorTask): string {
    if (task.status === "ARCHIVED") return join(this.root, "archive", (task.archivedAt ?? task.updatedAt).slice(0, 7), task.id);
    if (task.status === "DISMISSED") return join(this.root, "dismissed", task.id);
    return join(this.root, "active", task.id);
  }

  private async locateTask(id: string): Promise<LocatedTask> {
    const active = join(this.root, "active", id);
    if (await this.isDirectory(active)) return { dir: active, task: await this.readJson<CreatorTask>(join(active, "task.json")) };
    const dismissed = join(this.root, "dismissed", id);
    if (await this.isDirectory(dismissed)) return { dir: dismissed, task: await this.readJson<CreatorTask>(join(dismissed, "task.json")) };
    for (const month of await this.safeReadDir(join(this.root, "archive"))) {
      const archived = join(this.root, "archive", month.name, id);
      if (month.isDirectory() && await this.isDirectory(archived)) return { dir: archived, task: await this.readJson<CreatorTask>(join(archived, "task.json")) };
    }
    throw new TaskNotFoundError(`Task not found: ${id}`);
  }

  private async readJsonLines<T>(path: string): Promise<T[]> {
    try {
      const content = await readFile(path, "utf8");
      return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async safeReadDir(path: string) {
    try {
      return await readdir(path, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
