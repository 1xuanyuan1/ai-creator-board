# 产物合同

所有路径相对任务目录，以 `artifacts/` 开头。推荐固定文件名：

```text
artifacts/
  research-card.md
  fact-ledger.md
  bilibili/script.md
  bilibili/storyboard.md
  bilibili/publishing-metadata.md
  bilibili/review.md
  douyin/script.md
  douyin/storyboard.md
  douyin/publishing-metadata.md
  douyin/review.md
  shipinhao/script.md
  shipinhao/storyboard.md
  shipinhao/publishing-metadata.md
  shipinhao/review.md
  xiaohongshu/script.md
  xiaohongshu/storyboard.md
  xiaohongshu/publishing-metadata.md
  xiaohongshu/review.md
  covers/horizontal.png
  covers/vertical.png
  sources.md
  manifest.json
```

最终结构化响应为每个文件登记 `type`、`name`、`path`、`mimeType`，平台文件还要登记 `platform`，审查报告登记 `reviewStatus`。

`manifest.json` 至少包含任务 ID、Profile、完成时间、确认观点、核心概念、产物数组、文件用途、平台、画幅和审查状态。对话、决策、提示词、失败返工过程不得复制进公开产物。
