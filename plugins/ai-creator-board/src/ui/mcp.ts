import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";

type ToolResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
};

declare global {
  interface Window {
    __AI_CREATOR_BOARD_TEST_BRIDGE__?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    openai?: {
      callTool?: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
      setWidgetState?: (state: unknown) => void;
      widgetState?: unknown;
    };
  }
}

const app = new App({ name: "AI Creator Board", version: "0.1.0" }, {});
let connection: Promise<void> | undefined;

async function ensureConnected(): Promise<void> {
  if (window.__AI_CREATOR_BOARD_TEST_BRIDGE__ || window.openai?.callTool) return;
  connection ??= app.connect(new PostMessageTransport(window.parent, window.parent));
  await connection;
}

export async function callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (window.__AI_CREATOR_BOARD_TEST_BRIDGE__) return window.__AI_CREATOR_BOARD_TEST_BRIDGE__(name, args) as Promise<T>;
  await ensureConnected();
  const result = window.openai?.callTool
    ? await window.openai.callTool(name, args)
    : await app.callServerTool({ name, arguments: args });
  const textBlock = result.content?.find((item): item is { type: "text"; text: string } => item.type === "text");
  if (result.isError) throw new Error(textBlock?.text ?? `${name} failed`);
  if (result.structuredContent !== undefined) return result.structuredContent as T;
  const text = textBlock?.text;
  if (!text) throw new Error(`${name} returned no data`);
  return JSON.parse(text) as T;
}
