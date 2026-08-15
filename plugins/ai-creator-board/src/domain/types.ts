export const TASK_STATUSES = [
  "DRAFT",
  "TODO",
  "RUNNING",
  "NEEDS_DECISION",
  "COMPLETED",
  "ARCHIVED",
  "DISMISSED"
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type Platform = "bilibili" | "douyin" | "shipinhao" | "xiaohongshu";
export type WorkflowStage = "candidate" | "research" | "title_cover" | "production" | "review" | "finalize";
export type DecisionKind = "VIEWPOINT" | "TITLE_COVER" | "SENSITIVE_TOPIC" | "EVIDENCE_CONFLICT" | "REVIEW_FAILED" | "CONFIGURATION";

export interface SourceLink {
  title?: string;
  url: string;
  tier?: "T1-primary" | "T2-secondary" | "T3-community";
}

export interface ViewpointOption {
  key: "A" | "B" | "C";
  statement: string;
  rationale: string;
}

export interface SelectedViewpoint {
  mode: "A" | "B" | "C" | "AUTO";
  statement: string;
  rationale?: string;
}

export interface PendingDecision {
  id: string;
  kind: DecisionKind;
  question: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  context?: string;
  createdAt: string;
}

export interface ProgressEvent {
  id: string;
  at: string;
  stage: WorkflowStage;
  type: "status" | "reasoning" | "tool" | "file" | "error";
  message: string;
}

export interface ArtifactRecord {
  id: string;
  type:
    | "research-card"
    | "fact-ledger"
    | "script"
    | "storyboard"
    | "publishing-metadata"
    | "cover-horizontal"
    | "cover-vertical"
    | "review-report"
    | "source-appendix"
    | "manifest";
  name: string;
  path: string;
  mimeType: string;
  platform?: Platform;
  reviewStatus?: "PASS" | "FAIL";
  createdAt: string;
}

export interface BlockedState {
  reason: string;
  attempts: number;
  since: string;
}

export interface PublishState {
  status: "NOT_REQUESTED" | "PENDING" | "PUBLISHED" | "FAILED";
  url?: string;
  error?: string;
  updatedAt: string;
}

export interface CreatorTask {
  schemaVersion: 1;
  id: string;
  version: number;
  profile: string;
  batchDate?: string;
  topic: string;
  sources: SourceLink[];
  personalJudgment?: string;
  concept?: string;
  tags: string[];
  notes?: string;
  candidateRank?: number;
  viewpointOptions?: ViewpointOption[];
  selectedViewpoint?: SelectedViewpoint;
  status: TaskStatus;
  workflowStage: WorkflowStage;
  threadId?: string;
  threadDeviceId?: string;
  rebuiltFromThreadId?: string;
  pendingDecision?: PendingDecision;
  progress: ProgressEvent[];
  artifacts: ArtifactRecord[];
  reviewRounds: number;
  technicalAttempts: number;
  blocked?: BlockedState;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  archiveDueAt?: string;
  archivedAt?: string;
  dismissedAt?: string;
  publish?: PublishState;
}

export interface ConversationEntry {
  id: string;
  at: string;
  role: "user" | "assistant" | "system";
  content: string;
  scope?: "all" | Platform;
  threadId?: string;
}

export interface DecisionEntry {
  id: string;
  at: string;
  decisionId: string;
  kind: DecisionKind;
  answer: string;
  optionId?: string;
}

export interface CandidateInput {
  topic: string;
  occurredAt: string;
  freshness: string;
  factStatus: string;
  whyNow: string;
  tension: string;
  concept: string;
  viewpoints: ViewpointOption[];
  audience: string;
  primarySources: SourceLink[];
  crossSources: SourceLink[];
  score: {
    importance: number;
    evidence: number;
    concept: number;
    audience: number;
    visuals: number;
  };
  tags: string[];
}

export interface BatchRecord {
  schemaVersion: 1;
  date: string;
  createdAt: string;
  taskIds: string[];
  scanThreadId?: string;
  sourceErrors: string[];
}

export interface DeviceLease {
  schemaVersion: 1;
  deviceId: string;
  deviceName: string;
  activatedAt: string;
  heartbeatAt: string;
}

export interface SyncHealth {
  mode: "READY" | "READ_ONLY" | "PENDING_SYNC" | "INACTIVE_DEVICE";
  message?: string;
  lastSyncedAt?: string;
  ahead?: number;
  behind?: number;
}

export interface BoardSnapshot {
  generatedAt: string;
  sync: SyncHealth;
  lease?: DeviceLease;
  columns: Record<"DRAFT" | "TODO" | "RUNNING" | "NEEDS_DECISION" | "COMPLETED", CreatorTask[]>;
  batches: BatchRecord[];
  archiveMonths: Array<{ month: string; count: number }>;
}

export interface ArchiveQuery {
  keyword?: string;
  tags?: string[];
  platform?: Platform;
  from?: string;
  to?: string;
}
