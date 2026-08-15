import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FileStore } from "../src/storage/file-store.js";
import { GitWorkspace, InactiveDeviceError } from "../src/sync/git-workspace.js";

const run = promisify(execFile);
async function git(cwd: string, ...args: string[]) { return (await run("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout; }
async function identity(cwd: string) { await git(cwd, "config", "user.name", "Test"); await git(cwd, "config", "user.email", "test@example.com"); }

async function createRemote() {
  const root = await mkdtemp(join(tmpdir(), "creator-git-"));
  const remote = join(root, "remote.git");
  await run("git", ["init", "--bare", "--initial-branch=main", remote]);
  const seed = join(root, "seed");
  await run("git", ["clone", remote, seed]);
  await identity(seed);
  await writeFile(join(seed, "README.md"), "seed\n");
  await git(seed, "add", "README.md"); await git(seed, "commit", "-m", "seed"); await git(seed, "push", "origin", "main");
  return { root, remote };
}

describe("Git workspace sync", () => {
  it("fast-forwards a second device and rejects divergent histories", async () => {
    const { root, remote } = await createRemote();
    const a = join(root, "a"); const b = join(root, "b");
    await run("git", ["clone", remote, a]); await run("git", ["clone", remote, b]); await identity(a); await identity(b);
    await writeFile(join(a, "a.json"), "{}\n"); await git(a, "add", "a.json"); await git(a, "commit", "-m", "a"); await git(a, "push", "origin", "main");
    const storeB = new FileStore(b);
    const workspaceB = new GitWorkspace(b, storeB, "b", "Device B");
    expect((await workspaceB.syncWorkspace({ allowInactive: true })).mode).toBe("READY");
    expect(await readFile(join(b, "a.json"), "utf8")).toBe("{}\n");
    await writeFile(join(b, "b.json"), "{}\n"); await git(b, "add", "b.json"); await git(b, "commit", "-m", "b");
    await writeFile(join(a, "a2.json"), "{}\n"); await git(a, "add", "a2.json"); await git(a, "commit", "-m", "a2"); await git(a, "push", "origin", "main");
    expect((await workspaceB.syncWorkspace({ allowInactive: true })).mode).toBe("READ_ONLY");
  });

  it("enforces the active-device lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "creator-lease-"));
    const store = new FileStore(root); await store.ensureLayout();
    await store.writeLease({ schemaVersion: 1, deviceId: "a", deviceName: "Device A", activatedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() });
    const workspace = new GitWorkspace(root, store, "b", "Device B");
    await expect(workspace.assertActiveDevice()).rejects.toBeInstanceOf(InactiveDeviceError);
    expect(workspace.getHealth().mode).toBe("INACTIVE_DEVICE");
  });

  it.runIf(spawnSync("git", ["lfs", "version"]).status === 0)("round-trips media through Git LFS", async () => {
    const { root, remote } = await createRemote();
    const source = join(root, "lfs-source"); const target = join(root, "lfs-target");
    await run("git", ["clone", remote, source]); await identity(source); await git(source, "lfs", "install", "--local");
    await writeFile(join(source, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");
    const binary = Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]); await writeFile(join(source, "cover.png"), binary);
    await git(source, "add", ".gitattributes", "cover.png"); await git(source, "commit", "-m", "lfs"); await git(source, "push", "origin", "main");
    await run("git", ["clone", remote, target]);
    expect(await readFile(join(target, "cover.png"))).toEqual(binary);
  });
});
