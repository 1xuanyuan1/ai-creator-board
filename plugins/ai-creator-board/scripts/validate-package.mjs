import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "dist/server.mjs",
  "dist/board.js",
  "dist/board.css",
  "skills/ai-intel-video-production/SKILL.md"
];

await Promise.all(required.map((file) => access(resolve(root, file))));
const manifest = JSON.parse(await readFile(resolve(root, ".codex-plugin/plugin.json"), "utf8"));
if (manifest.name !== "ai-creator-board" || !manifest.version.startsWith("0.1.0")) {
  throw new Error("Unexpected plugin identity");
}
const mcp = JSON.parse(await readFile(resolve(root, ".mcp.json"), "utf8"));
const boardServer = mcp.mcpServers?.["ai-creator-board"];
if (!boardServer) {
  throw new Error("MCP server entry is missing");
}
if (boardServer.cwd !== ".") {
  throw new Error("MCP server must start from the plugin root");
}
console.log("AI Creator Board package is complete.");
