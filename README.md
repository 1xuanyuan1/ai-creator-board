# AI Creator Board

一个嵌入 Codex 的可视化视频创作看板。v0.1 内置“AI 情报主编”Profile，把每日候选、人工选题、Codex 执行、关键决策、四平台交付包与月度归档串成一条可追踪工作流。

```text
初稿 → 待办 → 执行 → 待决策 → 执行 → 完成 → 按月归档
```

![MIT](https://img.shields.io/badge/license-MIT-1c6b4b) ![Node](https://img.shields.io/badge/node-%3E%3D20-1c6b4b) ![Codex](https://img.shields.io/badge/Codex-plugin-1c6b4b)

## v0.1 能做什么

- 五列 React MCP App 看板，初稿候选按日期显示为批次子卡。
- 每张卡独立 Codex SDK 线程，通过 `runStreamed()` 镜像进度，通过 JSON Schema 约束阶段结果。
- 观点 A/B/C 或自动授权；标题与封面必停决策；敏感题材、证据冲突与终审失败额外暂停。
- B站、抖音、视频号、小红书各自的口播、分镜、标题、描述、关键词和发布备注。
- 共享横版/竖版封面、研究卡、事实台账、四份终审、来源附录与产物清单。
- 完成卡发送修改后自动返工；平台局部修改只影响该平台，共享事实或观点变化重查全部平台。
- 任务、对话、决策和产物以 JSON/JSONL/Markdown/媒体文件保存到独立私有 Git 仓库。
- 单激活设备租约、非快进拒绝、同步失败只读降级、系统通知与 72 小时自动归档。
- 归档后可从独立干净克隆向 Hexo 内容站发布“研究长文版”，不公开对话、决策、提示词和终审过程。

暂不制作视频成片，也不向 B站、抖音、小红书或视频号自动发布。

## 安装

前置条件：macOS、Codex/ChatGPT 桌面端、Node.js 20+、Git、Git LFS。封面默认支持可选的 Bitto；没有配置时任务会进入待决策，不会伪装完成。

1. 克隆你的私有数据仓库：

   ```bash
   git clone https://github.com/YOUR_NAME/ai-creator-board-data.git ~/ai-creator-board-data
   git -C ~/ai-creator-board-data lfs install --local
   ```

2. 启用 Codex 的本地 MCP App 渲染能力，然后完整退出并重新打开 Codex：

   ```bash
   codex features enable enable_mcp_apps
   ```

   `enable_mcp_apps` 在当前 Codex 版本中仍标记为 under development。未启用时，插件工具仍能运行，但 `open_board` 只会返回 JSON，不会渲染 React 面板。

3. 添加 marketplace 并安装插件：

   ```bash
   codex plugin marketplace add 1xuanyuan1/ai-creator-board --ref main
   codex plugin add ai-creator-board@ai-creator-board
   ```

   插件提交了已打包的 `dist/server.mjs`、`dist/board.js` 和 `dist/board.css`；安装阶段不运行 npm lifecycle 脚本。

4. 创建仅保存在本机的 `~/.config/ai-creator-board/config.json`：

   ```json
   {
     "dataDir": "/absolute/path/to/ai-creator-board-data",
     "deviceId": "a-stable-uuid-for-this-computer",
     "deviceName": "My Mac",
     "siteRepository": "https://github.com/YOUR_NAME/YOUR_HEXO_SITE.git",
     "publisherCacheDir": "/absolute/path/to/a-clean-publisher-cache",
     "coverBackend": "bitto",
     "codexPath": "codex"
   }
   ```

   每台电脑使用不同、稳定的 `deviceId`。配置文件、Git 凭证、Bitto 登录态与环境变量不进入任何仓库。

5. 新建一个 Codex 任务并说“打开 AI Creator Board”。首次使用点击“激活这台电脑”；激活新设备会让旧设备的定时 Worker 自动退出。

如果工具调用成功但页面只显示 JSON，先运行 `codex features list`，确认 `enable_mcp_apps` 为 `true`，再用 `Command-Q` 完整退出 Codex 后重新打开。已有任务不会热加载 MCP App 渲染器。

## 定时任务

建议在 Codex Scheduled Tasks 中创建：

- 每天 10:00（`Asia/Shanghai`）：调用 `run_daily_scan`，生成当天五张候选卡。
- 每 10 分钟：调用 `run_worker_once`；它先处理到期归档，再串行领取或继续一张卡。

电脑需要开机，Codex/ChatGPT 桌面端需要保持运行。宠物只自然反映 Codex 的 Running、Needs input、Ready、Blocked 状态；可靠提醒由 macOS 系统通知承担。

## 数据结构

```text
batches/YYYY/MM/DD/batch.json
active/<task-id>/
  task.json
  conversation.jsonl
  decisions.jsonl
  artifacts/
archive/YYYY-MM/<task-id>/
dismissed/<task-id>/
profiles/
.board/device-lease.json
```

写操作先抓取远端、检查设备租约和任务版本，再原子写入、提交、推送。远端分叉、网络失败或未提交文件会让面板进入只读/待同步状态，并停止自动领取任务。

## MCP 工具

稳定工具：`open_board`、`get_board_snapshot`、`create_draft`、`approve_candidate`、`submit_decision`、`send_task_message`、`run_daily_scan`、`run_worker_once`、`archive_task`、`activate_device`、`sync_workspace`。

辅助工具：`get_task_detail`、`query_archive`、`read_artifact`、`dismiss_draft`、`retry_task`。

除新建初稿外，所有任务写操作都使用 `expectedVersion` 做乐观并发控制。

## 开发与验证

```bash
cd plugins/ai-creator-board
npm ci
npm run check
```

`check` 包含 TypeScript、状态机/存储/Worker/Git/LFS/发布器测试、React UI 测试、前后端构建和包完整性校验。官方验证器另外检查插件 manifest 与内置 Skill。

## 安全与隐私

- 公开代码仓库不包含 `.env`、绝对开发机路径、Token、Cookie 或登录态。
- 私有数据仓库不保存 `~/.codex/sessions`；换设备时从任务检查点与对话镜像创建新线程。
- 网站发布仅提取研究卡、可阅读长稿、来源与横版封面。
- 同步只允许快进，不自动合并冲突，不强推。

## License

[MIT](LICENSE)
