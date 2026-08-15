import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { SitePublisher } from "../src/publisher/site-publisher.js";
import { completeArtifacts, makeTask } from "./helpers.js";

const run = promisify(execFile);
async function git(cwd: string, ...args: string[]) { return (await run("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout; }

describe("site publisher", () => {
  it("publishes only public research artifacts from a clean clone", async () => {
    const root = await mkdtemp(join(tmpdir(), "creator-publisher-"));
    const remote = join(root, "site.git"); const seed = join(root, "seed"); const cache = join(root, "cache"); const taskDir = join(root, "task");
    await run("git", ["init", "--bare", "--initial-branch=main", remote]);
    await run("git", ["clone", remote, seed]);
    await git(seed, "config", "user.name", "Test"); await git(seed, "config", "user.email", "test@example.com");
    await mkdir(join(seed, "content"), { recursive: true }); await mkdir(join(seed, "source"), { recursive: true });
    await writeFile(join(seed, "README.md"), "fake site\n"); await git(seed, "add", "README.md"); await git(seed, "commit", "-m", "seed"); await git(seed, "push", "origin", "main");

    const artifacts = completeArtifacts();
    for (const artifact of artifacts) {
      const path = join(taskDir, artifact.path); await mkdir(dirname(path), { recursive: true });
      await writeFile(path, artifact.mimeType.startsWith("image/") ? Buffer.from([1,2,3]) : `${artifact.type} public body\n`);
    }
    await writeFile(join(taskDir, "conversation.jsonl"), "SECRET CONVERSATION\n");
    const task = makeTask({ status: "ARCHIVED", archivedAt: "2026-08-15T04:00:00.000Z", completedAt: "2026-08-15T03:00:00.000Z", artifacts, topic: "公开研究文章" });
    const oldName = process.env.GIT_AUTHOR_NAME; const oldEmail = process.env.GIT_AUTHOR_EMAIL;
    process.env.GIT_AUTHOR_NAME = "Test"; process.env.GIT_AUTHOR_EMAIL = "test@example.com"; process.env.GIT_COMMITTER_NAME = "Test"; process.env.GIT_COMMITTER_EMAIL = "test@example.com";
    try {
      const publisher = new SitePublisher(remote, cache, { command: process.execPath, args: ["-e", "process.exit(0)"] });
      const result = await publisher.publish(task, taskDir);
      const article = await readFile(join(cache, result.articlePath), "utf8");
      expect(article).toContain("research-card public body");
      expect(article).toContain("script public body");
      expect(article).toContain("source-appendix public body");
      expect(article).not.toContain("SECRET CONVERSATION");
      expect((await git(cache, "status", "--porcelain")).trim()).toBe("");
    } finally {
      if (oldName === undefined) delete process.env.GIT_AUTHOR_NAME; else process.env.GIT_AUTHOR_NAME = oldName;
      if (oldEmail === undefined) delete process.env.GIT_AUTHOR_EMAIL; else process.env.GIT_AUTHOR_EMAIL = oldEmail;
    }
  });
});
