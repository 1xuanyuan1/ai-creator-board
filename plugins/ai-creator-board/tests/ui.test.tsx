// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardSnapshot, CreatorTask } from "../src/domain/types.js";
import { BoardApp } from "../src/ui/main.js";
import { makeTask, readySync } from "./helpers.js";

afterEach(() => { cleanup(); delete window.__AI_CREATOR_BOARD_TEST_BRIDGE__; });

function snapshotWith(task: CreatorTask): BoardSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    sync: readySync,
    columns: {
      DRAFT: task.status === "DRAFT" ? [task] : [],
      TODO: task.status === "TODO" ? [task] : [],
      RUNNING: task.status === "RUNNING" ? [task] : [],
      NEEDS_DECISION: task.status === "NEEDS_DECISION" ? [task] : [],
      COMPLETED: task.status === "COMPLETED" ? [task] : []
    },
    batches: task.batchDate ? [{ schemaVersion: 1, date: task.batchDate, createdAt: new Date().toISOString(), taskIds: [task.id], sourceErrors: [] }] : [],
    archiveMonths: []
  };
}

describe("MCP App UI", () => {
  it("renders daily candidate batches, task detail, conversation and approval", async () => {
    const task = makeTask({
      topic: "Agent 新发布值得讲吗",
      batchDate: "2026-08-15",
      concept: "Agent",
      viewpointOptions: [
        { key: "A", statement: "架构变化", rationale: "一手文档充分" },
        { key: "B", statement: "开发者实验", rationale: "生态仍早期" },
        { key: "C", statement: "生态入口", rationale: "平台意图明显" }
      ]
    });
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const snapshot = snapshotWith(task);
    window.__AI_CREATOR_BOARD_TEST_BRIDGE__ = vi.fn(async (name, args) => {
      calls.push({ name, args });
      if (name === "get_board_snapshot") return snapshot;
      if (name === "get_task_detail") return { task, conversation: [{ id: "c1", at: task.createdAt, role: "user", content: "这是我的判断" }], decisions: [] };
      if (name === "approve_candidate") return { ...task, status: "TODO" };
      if (name === "query_archive") return [];
      return {};
    });
    render(<BoardApp />);
    expect(await screen.findByText("8月15日 · 每日候选")).toBeTruthy();
    fireEvent.click(screen.getByText("Agent 新发布值得讲吗"));
    expect(await screen.findByText("选择本期观点")).toBeTruthy();
    fireEvent.click(screen.getByText("对话", { selector: "button" }));
    expect(await screen.findByText("这是我的判断")).toBeTruthy();
    fireEvent.click(screen.getByText("概览", { selector: "button" }));
    fireEvent.click(await screen.findByText("放入待办"));
    await waitFor(() => expect(calls.some((call) => call.name === "approve_candidate" && call.args.viewpoint === "AUTO")).toBe(true));
  });

  it("returns a completed card to execution when a revision message is sent", async () => {
    const task = makeTask({ topic: "已完成内容", status: "COMPLETED", workflowStage: "finalize", completedAt: new Date().toISOString() });
    const snapshot = snapshotWith(task);
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    window.__AI_CREATOR_BOARD_TEST_BRIDGE__ = vi.fn(async (name, args) => {
      calls.push({ name, args });
      if (name === "get_board_snapshot") return snapshot;
      if (name === "get_task_detail") return { task, conversation: [], decisions: [] };
      if (name === "send_task_message") return { ...task, status: "RUNNING" };
      return [];
    });
    render(<BoardApp />);
    fireEvent.click(await screen.findByText("已完成内容"));
    const textarea = await screen.findByPlaceholderText("描述要修改的地方；发送后卡片会回到执行区…");
    fireEvent.change(textarea, { target: { value: "只修改 B站 结尾" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(calls.some((call) => call.name === "send_task_message" && call.args.message === "只修改 B站 结尾")).toBe(true));
  });

  it("queries monthly archives with platform and keyword filters", async () => {
    const task = makeTask({ status: "DRAFT" });
    const archived = makeTask({ topic: "归档文章", status: "ARCHIVED", archivedAt: "2026-08-15T04:00:00.000Z" });
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    window.__AI_CREATOR_BOARD_TEST_BRIDGE__ = vi.fn(async (name, args) => {
      calls.push({ name, args });
      if (name === "get_board_snapshot") return snapshotWith(task);
      if (name === "query_archive") return [archived];
      return {};
    });
    render(<BoardApp />);
    fireEvent.click(await screen.findByRole("button", { name: "月度归档" }));
    expect(await screen.findByText("归档文章")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("搜索主题、备注或关键词"), { target: { value: "Agent" } });
    await waitFor(() => expect(calls.some((call) => call.name === "query_archive" && call.args.keyword === "Agent")).toBe(true));
  });
});
