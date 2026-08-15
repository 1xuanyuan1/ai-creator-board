import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CreatorTask } from "../domain/types.js";

const execFileAsync = promisify(execFile);

export interface PublishResult {
  commit: string;
  articlePath: string;
  coverPath?: string;
}

export class SitePublisher {
  constructor(
    private readonly remote: string,
    private readonly cloneDir: string,
    private readonly buildCommand: { command: string; args: string[] } = { command: "pnpm", args: ["run", "build"] }
  ) {}

  async publish(task: CreatorTask, taskDirectory: string): Promise<PublishResult> {
    await this.ensureCleanClone();
    await this.git(["fetch", "origin", "main"]);
    await this.git(["switch", "main"]);
    await this.git(["merge", "--ff-only", "origin/main"]);
    const dirty = (await this.git(["status", "--porcelain"])).trim();
    if (dirty) throw new Error("Publisher clone is not clean");

    const slug = `${(task.completedAt ?? task.updatedAt).slice(0, 10)}-${slugify(task.topic)}-${task.id.slice(0, 8)}`;
    const articleRelative = join("content", `${slug}.md`);
    const articlePath = join(this.cloneDir, articleRelative);
    const research = await this.readArtifactText(task, taskDirectory, "research-card");
    const longScript = await this.readArtifactText(task, taskDirectory, "script", "bilibili");
    const sources = await this.readArtifactText(task, taskDirectory, "source-appendix");
    const horizontal = task.artifacts.find((item) => item.type === "cover-horizontal");
    let coverRelative: string | undefined;
    if (horizontal) {
      coverRelative = join("source", "images", "ai-creator-board", `${slug}${extensionFor(horizontal.mimeType, horizontal.path)}`);
      await mkdir(dirname(join(this.cloneDir, coverRelative)), { recursive: true });
      await copyFile(join(taskDirectory, horizontal.path), join(this.cloneDir, coverRelative));
    }
    const coverPublic = coverRelative ? `/${coverRelative.replace(/^source\//, "").replaceAll("\\", "/")}` : undefined;
    const frontMatter = [
      "---",
      `title: ${JSON.stringify(task.topic)}`,
      `date: ${(task.completedAt ?? task.updatedAt).replace("T", " ").replace("Z", "")}`,
      `tags: [${task.tags.map((tag) => JSON.stringify(tag)).join(", ")}]`,
      ...(coverPublic ? [`cover: ${JSON.stringify(coverPublic)}`] : []),
      "---"
    ].join("\n");
    const article = `${frontMatter}\n\n${research}\n\n## 可阅读长稿\n\n${longScript}\n\n## 来源\n\n${sources}\n`;
    await mkdir(dirname(articlePath), { recursive: true });
    await writeFile(articlePath, article, "utf8");

    await execFileAsync(this.buildCommand.command, this.buildCommand.args, { cwd: this.cloneDir, maxBuffer: 20 * 1024 * 1024 });
    await this.git(["add", "--", articleRelative, ...(coverRelative ? [coverRelative] : [])]);
    await this.git(["commit", "-m", `content: publish ${task.topic}`]);
    const commit = (await this.git(["rev-parse", "HEAD"])).trim();
    await this.git(["push", "origin", "HEAD:main"]);
    return { commit, articlePath: articleRelative, ...(coverRelative ? { coverPath: coverRelative } : {}) };
  }

  private async ensureCleanClone(): Promise<void> {
    try {
      if ((await stat(join(this.cloneDir, ".git"))).isDirectory()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(this.cloneDir), { recursive: true });
    await execFileAsync("git", ["clone", "--branch", "main", this.remote, this.cloneDir], { maxBuffer: 10 * 1024 * 1024 });
  }

  private async readArtifactText(task: CreatorTask, taskDirectory: string, type: CreatorTask["artifacts"][number]["type"], platform?: string): Promise<string> {
    const artifact = task.artifacts.find((item) => item.type === type && (!platform || item.platform === platform));
    if (!artifact) throw new Error(`Missing public artifact: ${type}${platform ? `:${platform}` : ""}`);
    return readFile(join(taskDirectory, artifact.path), "utf8");
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", this.cloneDir, ...args], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  }
}

function slugify(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "ai-intel";
}

function extensionFor(mimeType: string, path: string): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/jpeg") return ".jpg";
  const extension = basename(path).match(/\.[a-z0-9]+$/i)?.[0];
  return extension ?? ".png";
}
