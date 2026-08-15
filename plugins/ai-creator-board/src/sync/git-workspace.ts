import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeviceLease, SyncHealth } from "../domain/types.js";
import type { FileStore } from "../storage/file-store.js";

const execFileAsync = promisify(execFile);

export class InactiveDeviceError extends Error {}
export class WorkspaceReadOnlyError extends Error {}

export class GitWorkspace {
  private health: SyncHealth = { mode: "READY" };
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    readonly repository: string,
    private readonly store: FileStore,
    readonly deviceId: string,
    readonly deviceName: string
  ) {}

  getHealth(): SyncHealth {
    return { ...this.health };
  }

  async getLease(): Promise<DeviceLease | undefined> {
    return this.store.readLease();
  }

  async activateDevice(): Promise<DeviceLease> {
    return this.serialize(async () => {
      await this.syncWorkspace({ allowDirty: false, allowInactive: true });
      const now = new Date().toISOString();
      const lease: DeviceLease = {
        schemaVersion: 1,
        deviceId: this.deviceId,
        deviceName: this.deviceName,
        activatedAt: now,
        heartbeatAt: now
      };
      await this.store.writeLease(lease);
      await this.commitAndPush(`chore(data): activate ${this.deviceName}`);
      this.health = { mode: "READY", lastSyncedAt: new Date().toISOString() };
      return lease;
    });
  }

  async assertActiveDevice(): Promise<DeviceLease> {
    const lease = await this.store.readLease();
    if (!lease || lease.deviceId !== this.deviceId) {
      this.health = {
        mode: "INACTIVE_DEVICE",
        message: lease ? `Active device is ${lease.deviceName}` : "No active device; activate this device first"
      };
      throw new InactiveDeviceError(this.health.message);
    }
    return lease;
  }

  async withMutation<T>(message: string, operation: () => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      if (this.health.mode === "READ_ONLY" || this.health.mode === "PENDING_SYNC") {
        throw new WorkspaceReadOnlyError(this.health.message ?? "Workspace is read-only until sync succeeds");
      }
      await this.syncWorkspace({ allowDirty: false, allowInactive: false });
      const lease = await this.assertActiveDevice();
      const result = await operation();
      await this.store.writeLease({ ...lease, heartbeatAt: new Date().toISOString() });
      await this.commitAndPush(message);
      this.health = { mode: "READY", lastSyncedAt: new Date().toISOString(), ahead: 0, behind: 0 };
      return result;
    });
  }

  async syncWorkspace(options: { allowDirty?: boolean; allowInactive?: boolean } = {}): Promise<SyncHealth> {
    try {
      const dirty = (await this.git(["status", "--porcelain"])).trim();
      if (dirty && !options.allowDirty) {
        this.health = { mode: "PENDING_SYNC", message: "Data repository has uncommitted changes" };
        throw new WorkspaceReadOnlyError(this.health.message);
      }
      await this.git(["fetch", "origin", "main"]);
      const counts = (await this.git(["rev-list", "--left-right", "--count", "HEAD...origin/main"])).trim().split(/\s+/).map(Number);
      const ahead = counts[0] ?? 0;
      const behind = counts[1] ?? 0;
      if (ahead > 0 && behind > 0) {
        this.health = { mode: "READ_ONLY", message: "Local and remote data histories diverged", ahead, behind };
        return this.health;
      }
      if (behind > 0) await this.git(["merge", "--ff-only", "origin/main"]);
      if (ahead > 0) await this.git(["push", "origin", "HEAD:main"]);
      if (!options.allowInactive) await this.assertActiveDevice();
      this.health = { mode: "READY", lastSyncedAt: new Date().toISOString(), ahead: 0, behind: 0 };
      return this.health;
    } catch (error) {
      if (error instanceof InactiveDeviceError || error instanceof WorkspaceReadOnlyError) throw error;
      this.health = { mode: "READ_ONLY", message: `Sync failed: ${(error as Error).message}` };
      throw new WorkspaceReadOnlyError(this.health.message);
    }
  }

  private async commitAndPush(message: string): Promise<void> {
    await this.git(["add", "--all"]);
    const staged = (await this.git(["diff", "--cached", "--name-only"])).trim();
    if (!staged) return;
    await this.git(["commit", "-m", message]);
    try {
      await this.git(["push", "origin", "HEAD:main"]);
    } catch (error) {
      this.health = { mode: "PENDING_SYNC", message: `Local commit is waiting to sync: ${(error as Error).message}` };
      throw new WorkspaceReadOnlyError(this.health.message);
    }
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", this.repository, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    });
    return stdout;
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
