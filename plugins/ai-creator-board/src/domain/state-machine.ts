import type { ArtifactRecord, CreatorTask, Platform, TaskStatus } from "./types.js";

export class InvalidTransitionError extends Error {}
export class IncompleteArtifactsError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Task cannot complete; missing: ${missing.join(", ")}`);
  }
}

const PLATFORM_LIST: Platform[] = ["bilibili", "douyin", "shipinhao", "xiaohongshu"];

export type TaskEvent =
  | { type: "APPROVE" }
  | { type: "START" }
  | { type: "REQUEST_DECISION" }
  | { type: "RESUME" }
  | { type: "COMPLETE"; now?: Date }
  | { type: "REVISE" }
  | { type: "ARCHIVE"; now?: Date }
  | { type: "DISMISS"; now?: Date };

const ALLOWED: Record<TaskEvent["type"], TaskStatus[]> = {
  APPROVE: ["DRAFT"],
  START: ["TODO"],
  REQUEST_DECISION: ["RUNNING"],
  RESUME: ["NEEDS_DECISION"],
  COMPLETE: ["RUNNING"],
  REVISE: ["COMPLETED"],
  ARCHIVE: ["COMPLETED"],
  DISMISS: ["DRAFT"]
};

export function transitionTask(task: CreatorTask, event: TaskEvent): CreatorTask {
  if (!ALLOWED[event.type].includes(task.status)) {
    throw new InvalidTransitionError(`${task.status} cannot handle ${event.type}`);
  }
  const now = "now" in event && event.now ? event.now : new Date();
  const iso = now.toISOString();
  const next: CreatorTask = { ...task, version: task.version + 1, updatedAt: iso };

  switch (event.type) {
    case "APPROVE":
      return { ...next, status: "TODO", workflowStage: "research", pendingDecision: undefined };
    case "START":
      return { ...next, status: "RUNNING", startedAt: task.startedAt ?? iso, blocked: undefined };
    case "REQUEST_DECISION":
      return { ...next, status: "NEEDS_DECISION" };
    case "RESUME":
      return { ...next, status: "RUNNING", pendingDecision: undefined, blocked: undefined };
    case "COMPLETE": {
      const missing = findMissingArtifacts(task.artifacts);
      if (missing.length > 0) throw new IncompleteArtifactsError(missing);
      const due = new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString();
      return {
        ...next,
        status: "COMPLETED",
        workflowStage: "finalize",
        completedAt: iso,
        archiveDueAt: due,
        blocked: undefined,
        technicalAttempts: 0
      };
    }
    case "REVISE":
      return {
        ...next,
        status: "RUNNING",
        workflowStage: "production",
        completedAt: undefined,
        archiveDueAt: undefined,
        publish: task.publish ? { status: "NOT_REQUESTED", updatedAt: iso } : undefined,
        blocked: undefined,
        technicalAttempts: 0
      };
    case "ARCHIVE":
      return { ...next, status: "ARCHIVED", archivedAt: iso, archiveDueAt: undefined };
    case "DISMISS":
      return { ...next, status: "DISMISSED", dismissedAt: iso };
  }
}

export function isArchiveDue(task: CreatorTask, now = new Date()): boolean {
  return task.status === "COMPLETED" && Boolean(task.archiveDueAt) && new Date(task.archiveDueAt!).getTime() <= now.getTime();
}

export function findMissingArtifacts(artifacts: ArtifactRecord[]): string[] {
  const missing: string[] = [];
  const has = (type: ArtifactRecord["type"], platform?: Platform, pass = false) =>
    artifacts.some((artifact) =>
      artifact.type === type &&
      (platform === undefined || artifact.platform === platform) &&
      (!pass || artifact.reviewStatus === "PASS")
    );

  for (const type of ["research-card", "fact-ledger", "cover-horizontal", "cover-vertical", "source-appendix", "manifest"] as const) {
    if (!has(type)) missing.push(type);
  }
  for (const platform of PLATFORM_LIST) {
    if (!has("script", platform)) missing.push(`${platform}:script`);
    if (!has("storyboard", platform)) missing.push(`${platform}:storyboard`);
    if (!has("publishing-metadata", platform)) missing.push(`${platform}:publishing-metadata`);
    if (!has("review-report", platform, true)) missing.push(`${platform}:review-PASS`);
  }
  return missing;
}

export function classifyRevisionScope(message: string): "all" | Platform {
  const normalized = message.toLowerCase();
  const matches: Array<[Platform, RegExp]> = [
    ["bilibili", /b站|bilibili/],
    ["douyin", /抖音|douyin/],
    ["shipinhao", /视频号|shipinhao|wechat video/],
    ["xiaohongshu", /小红书|xiaohongshu|rednote/]
  ];
  const platform = matches.find(([, pattern]) => pattern.test(normalized))?.[0];
  const sharedChange = /事实|观点|结论|信源|核心概念|全部|所有平台|封面/.test(normalized);
  return platform && !sharedChange ? platform : "all";
}
