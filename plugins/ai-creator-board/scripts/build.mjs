import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
await mkdir(dist, { recursive: true });

await Promise.all([
  build({
    entryPoints: [resolve(root, "src/server.ts")],
    outfile: resolve(dist, "server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: false,
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }
  }),
  build({
    entryPoints: [resolve(root, "src/ui/main.tsx")],
    outfile: resolve(dist, "board.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: ["chrome120", "safari17"],
    minify: true,
    sourcemap: false
  }),
  copyFile(resolve(root, "src/ui/board.css"), resolve(dist, "board.css"))
]);

for (const file of ["server.mjs", "board.js", "board.css"]) {
  const path = resolve(dist, file);
  const content = await readFile(path, "utf8");
  await writeFile(path, content.replace(/[ \t]+$/gm, ""), "utf8");
}
