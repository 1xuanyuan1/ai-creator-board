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
if (manifest.name !== "ai-creator-board" || manifest.version !== "0.1.0") {
  throw new Error("Unexpected plugin identity");
}
const mcp = JSON.parse(await readFile(resolve(root, ".mcp.json"), "utf8"));
if (!mcp.mcpServers?.["ai-creator-board"]) {
  throw new Error("MCP server entry is missing");
}
console.log("AI Creator Board package is complete.");
