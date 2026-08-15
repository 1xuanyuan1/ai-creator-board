import { describe, expect, it } from "vitest";
import { classifyRevisionScope, findMissingArtifacts, IncompleteArtifactsError, InvalidTransitionError, isArchiveDue, transitionTask } from "../src/domain/state-machine.js";
import { completeArtifacts, makeTask } from "./helpers.js";

describe("task state machine", () => {
  it("implements the approved transition graph", () => {
    let task = makeTask();
    task = transitionTask(task, { type: "APPROVE" });
    expect(task.status).toBe("TODO");
    task = transitionTask(task, { type: "START", });
    expect(task.status).toBe("RUNNING");
    task = transitionTask(task, { type: "REQUEST_DECISION" });
    expect(task.status).toBe("NEEDS_DECISION");
    task = transitionTask(task, { type: "RESUME" });
    expect(task.status).toBe("RUNNING");
    task = transitionTask({ ...task, artifacts: completeArtifacts() }, { type: "COMPLETE", now: new Date("2026-08-15T04:00:00Z") });
    expect(task.status).toBe("COMPLETED");
    expect(task.archiveDueAt).toBe("2026-08-18T04:00:00.000Z");
    task = transitionTask(task, { type: "REVISE" });
    expect(task.status).toBe("RUNNING");
    expect(task.archiveDueAt).toBeUndefined();
  });

  it("rejects invalid transitions and incomplete completion", () => {
    expect(() => transitionTask(makeTask(), { type: "START" })).toThrow(InvalidTransitionError);
    const running = makeTask({ status: "RUNNING", workflowStage: "review" });
    expect(() => transitionTask(running, { type: "COMPLETE" })).toThrow(IncompleteArtifactsError);
    expect(findMissingArtifacts([])).toContain("bilibili:review-PASS");
  });

  it("archives after 72 hours and resets timing after revision", () => {
    const completed = makeTask({ status: "COMPLETED", archiveDueAt: "2026-08-18T04:00:00.000Z", artifacts: completeArtifacts() });
    expect(isArchiveDue(completed, new Date("2026-08-18T03:59:59Z"))).toBe(false);
    expect(isArchiveDue(completed, new Date("2026-08-18T04:00:00Z"))).toBe(true);
    expect(transitionTask(completed, { type: "REVISE" }).archiveDueAt).toBeUndefined();
  });

  it("limits platform-local rewrites to explicit platform changes", () => {
    expect(classifyRevisionScope("只改一下 B站 的结尾口播")).toBe("bilibili");
    expect(classifyRevisionScope("抖音里的事实结论要换掉")).toBe("all");
    expect(classifyRevisionScope("封面和核心观点全部修改")).toBe("all");
  });
});
