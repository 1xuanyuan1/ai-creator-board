import { randomUUID } from "node:crypto";
import type { ArtifactRecord, CreatorTask, Platform } from "../src/domain/types.js";

export function makeTask(overrides: Partial<CreatorTask> = {}): CreatorTask {
  const now = "2026-08-15T02:00:00.000Z";
  return {
    schemaVersion: 1,
    id: randomUUID(),
    version: 1,
    profile: "ai-intel",
    topic: "测试 AI 选题",
    sources: [],
    tags: ["AI资讯"],
    status: "DRAFT",
    workflowStage: "candidate",
    progress: [],
    artifacts: [],
    reviewRounds: 0,
    technicalAttempts: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

export function completeArtifacts(): ArtifactRecord[] {
  const now = "2026-08-15T03:00:00.000Z";
  const platforms: Platform[] = ["bilibili", "douyin", "shipinhao", "xiaohongshu"];
  const sharedSpecs: Array<[ArtifactRecord["type"], string, string]> = [
    ["research-card", "research-card.md", "text/markdown"],
    ["fact-ledger", "fact-ledger.md", "text/markdown"],
    ["cover-horizontal", "covers/horizontal.png", "image/png"],
    ["cover-vertical", "covers/vertical.png", "image/png"],
    ["source-appendix", "sources.md", "text/markdown"],
    ["manifest", "manifest.json", "application/json"]
  ];
  const shared: ArtifactRecord[] = sharedSpecs.map(([type, path, mimeType]) => ({ id: randomUUID(), type, name: path, path: `artifacts/${path}`, mimeType, createdAt: now }));
  return [
    ...shared,
    ...platforms.flatMap((platform) => [
      { id: randomUUID(), type: "script" as const, name: "script.md", path: `artifacts/${platform}/script.md`, mimeType: "text/markdown", platform, createdAt: now },
      { id: randomUUID(), type: "storyboard" as const, name: "storyboard.md", path: `artifacts/${platform}/storyboard.md`, mimeType: "text/markdown", platform, createdAt: now },
      { id: randomUUID(), type: "publishing-metadata" as const, name: "publishing-metadata.md", path: `artifacts/${platform}/publishing-metadata.md`, mimeType: "text/markdown", platform, createdAt: now },
      { id: randomUUID(), type: "review-report" as const, name: "review.md", path: `artifacts/${platform}/review.md`, mimeType: "text/markdown", platform, reviewStatus: "PASS" as const, createdAt: now }
    ])
  ];
}

export const readySync = { mode: "READY" as const, lastSyncedAt: "2026-08-15T02:00:00.000Z" };
