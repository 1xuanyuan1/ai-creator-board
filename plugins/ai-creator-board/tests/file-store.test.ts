import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { transitionTask } from "../src/domain/state-machine.js";
import { FileStore, VersionConflictError } from "../src/storage/file-store.js";

describe("file store", () => {
  it("writes mergeable task/jsonl files and enforces optimistic versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "creator-store-"));
    const store = new FileStore(root);
    await store.ensureLayout();
    const draft = await store.createDraft({ topic: "手工选题", tags: ["Agent"] });
    const approved = await store.mutateTask(draft.id, draft.version, (task) => transitionTask(task, { type: "APPROVE" }));
    await store.appendConversation(draft.id, { role: "user", content: "我选观点 A" });
    expect((await store.getTaskDetail(draft.id)).conversation).toHaveLength(1);
    await expect(store.mutateTask(draft.id, draft.version, (task) => task)).rejects.toBeInstanceOf(VersionConflictError);
    expect(approved.version).toBeGreaterThan(draft.version);
  });

  it("moves dismissed drafts out of the active board", async () => {
    const root = await mkdtemp(join(tmpdir(), "creator-dismiss-"));
    const store = new FileStore(root);
    await store.ensureLayout();
    const draft = await store.createDraft({ topic: "不做了" });
    await store.mutateTask(draft.id, draft.version, (task) => transitionTask(task, { type: "DISMISS" }));
    expect(await store.listTasks()).toHaveLength(0);
    expect((await store.getTask(draft.id)).status).toBe("DISMISSED");
  });
});
