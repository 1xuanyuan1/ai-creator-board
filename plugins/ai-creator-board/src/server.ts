import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { BoardService } from "./board-service.js";
import { resolveConfig } from "./config.js";
import { CodexCreatorExecutor } from "./executor/codex-executor.js";
import { SystemNotifier } from "./notifications.js";
import { SitePublisher } from "./publisher/site-publisher.js";
import { FileStore } from "./storage/file-store.js";
import { GitWorkspace } from "./sync/git-workspace.js";

const distDirectory = dirname(fileURLToPath(import.meta.url));
const pluginDirectory = dirname(distDirectory);
const skillDirectory = join(pluginDirectory, "skills", "ai-intel-video-production");
const BOARD_URI = "ui://ai-creator-board/board-v1.html";

const config = await resolveConfig();
const store = new FileStore(config.dataDir);
const workspace = new GitWorkspace(config.dataDir, store, config.deviceId, config.deviceName);
const executor = new CodexCreatorExecutor(config, skillDirectory);
const notifier = new SystemNotifier(config.notificationCommand);
const publisher = config.siteRepository ? new SitePublisher(config.siteRepository, config.publisherCacheDir) : undefined;
const service = new BoardService(config, store, workspace, executor, notifier, publisher);
await service.initialize();

const server = new McpServer({ name: "ai-creator-board", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });

registerAppResource(server, "AI Creator Board", BOARD_URI, {
  description: "Interactive AI video production Kanban board",
  _meta: { ui: { prefersBorder: false } }
}, async () => {
  const [script, styles] = await Promise.all([
    readFile(join(distDirectory, "board.js"), "utf8"),
    readFile(join(distDirectory, "board.css"), "utf8")
  ]);
  return {
    contents: [{
      uri: BOARD_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style></head><body><div id="root"></div><script type="module">${script}</script></body></html>`,
      _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } }
    }]
  };
});

registerAppTool(server, "open_board", {
  title: "打开 AI Creator Board",
  description: "打开创作看板并返回当前快照。",
  inputSchema: {},
  _meta: {
    ui: { resourceUri: BOARD_URI },
    "openai/outputTemplate": BOARD_URI,
    "openai/toolInvocation/invoking": "正在打开创作看板…",
    "openai/toolInvocation/invoked": "创作看板已打开"
  }
}, tool(async () => service.getSnapshot()));

server.registerTool("get_board_snapshot", {
  title: "获取看板快照",
  description: "读取五列任务、每日批次、同步状态和归档月份。",
  inputSchema: {}
}, tool(async () => service.getSnapshot()));

server.registerTool("get_task_detail", {
  title: "获取任务详情",
  description: "读取任务、对话镜像、决策与产物清单。",
  inputSchema: { taskId: z.string().uuid() }
}, tool(async ({ taskId }) => {
  const { artifactRoot: _artifactRoot, ...detail } = await service.getTaskDetail(taskId);
  return detail;
}));

server.registerTool("create_draft", {
  title: "创建初稿",
  description: "在初稿区手工创建一张选题卡。",
  inputSchema: {
    topic: z.string().min(1),
    sources: z.array(z.object({ url: z.string().url(), title: z.string().optional() })).optional(),
    personalJudgment: z.string().optional(),
    concept: z.string().optional(),
    tags: z.array(z.string()).optional(),
    notes: z.string().optional()
  }
}, tool(async (input) => service.createDraft(input)));

server.registerTool("approve_candidate", {
  title: "批准候选",
  description: "选择 A/B/C 观点或授权 Codex 自动选择后，把初稿推进到待办。",
  inputSchema: {
    taskId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    viewpoint: z.enum(["A", "B", "C", "AUTO"]),
    personalJudgment: z.string().optional()
  }
}, tool(async (input) => service.approveCandidate(input)));

server.registerTool("submit_decision", {
  title: "提交任务决策",
  description: "回答待决策表单并让任务回到执行区。",
  inputSchema: {
    taskId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    decisionId: z.string().uuid(),
    answer: z.string().min(1),
    optionId: z.string().optional()
  }
}, tool(async (input) => service.submitDecision(input)));

server.registerTool("send_task_message", {
  title: "发送任务消息",
  description: "向任务线程发送修改或补充要求；完成任务会自动返回执行区。",
  inputSchema: {
    taskId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    message: z.string().min(1)
  }
}, tool(async (input) => service.sendTaskMessage(input)));

server.registerTool("run_daily_scan", {
  title: "运行每日候选扫描",
  description: "按 AI 情报主编 Skill 生成当天恰好五张候选卡。",
  inputSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }
}, tool(async ({ date }) => service.runDailyScan(date)));

server.registerTool("run_worker_once", {
  title: "运行一次串行 Worker",
  description: "检查到期归档，然后领取或继续一张任务。",
  inputSchema: { taskId: z.string().uuid().optional() }
}, tool(async ({ taskId }) => service.runWorkerOnce(taskId)));

server.registerTool("archive_task", {
  title: "主动归档任务",
  description: "归档完成卡，并在已配置时发布公开研究长文。",
  inputSchema: { taskId: z.string().uuid(), expectedVersion: z.number().int().positive() }
}, tool(async ({ taskId, expectedVersion }) => service.archiveTask(taskId, expectedVersion)));

server.registerTool("dismiss_draft", {
  title: "放弃初稿",
  description: "把初稿软删除到 dismissed，不发布网站。",
  inputSchema: { taskId: z.string().uuid(), expectedVersion: z.number().int().positive() }
}, tool(async ({ taskId, expectedVersion }) => service.dismissDraft(taskId, expectedVersion)));

server.registerTool("retry_task", {
  title: "重试阻塞任务",
  description: "清除 Running 卡片的 Blocked 标记并重置技术重试计数。",
  inputSchema: { taskId: z.string().uuid(), expectedVersion: z.number().int().positive() }
}, tool(async ({ taskId, expectedVersion }) => service.retryTask(taskId, expectedVersion)));

server.registerTool("activate_device", {
  title: "激活当前设备",
  description: "把当前电脑设为唯一执行定时任务的设备。",
  inputSchema: {}
}, tool(async () => service.activateDevice()));

server.registerTool("sync_workspace", {
  title: "同步数据仓库",
  description: "快进同步私有数据仓库；冲突时进入只读状态。",
  inputSchema: {}
}, tool(async () => service.syncWorkspace()));

server.registerTool("query_archive", {
  title: "查询月度归档",
  description: "按关键词、标签、平台和日期查询归档任务。",
  inputSchema: {
    keyword: z.string().optional(),
    tags: z.array(z.string()).optional(),
    platform: z.enum(["bilibili", "douyin", "shipinhao", "xiaohongshu"]).optional(),
    from: z.string().optional(),
    to: z.string().optional()
  }
}, tool(async (input) => service.queryArchive(input)));

server.registerTool("read_artifact", {
  title: "读取任务产物",
  description: "读取已登记产物，供面板预览和下载。",
  inputSchema: { taskId: z.string().uuid(), artifactPath: z.string().min(1) }
}, tool(async ({ taskId, artifactPath }) => {
  const artifact = await store.readArtifact(taskId, artifactPath);
  return { name: artifact.name, mimeType: artifact.mimeType, base64: artifact.data.toString("base64") };
}));

await server.connect(new StdioServerTransport());

function tool<TArgs extends Record<string, unknown>, TResult>(handler: (args: TArgs) => Promise<TResult>) {
  return async (args: TArgs) => {
    try {
      const data = await handler(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: data as Record<string, unknown>
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: (error as Error).message }]
      };
    }
  };
}
