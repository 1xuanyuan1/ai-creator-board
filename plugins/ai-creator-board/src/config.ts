import { readFile } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface AppConfig {
  dataDir: string;
  deviceId: string;
  deviceName: string;
  siteRepository?: string;
  publisherCacheDir: string;
  coverBackend: "bitto" | "none";
  codexPath: string;
  notificationCommand?: string;
}

interface LocalConfigFile {
  dataDir?: string;
  deviceId?: string;
  deviceName?: string;
  siteRepository?: string;
  publisherCacheDir?: string;
  coverBackend?: "bitto" | "none";
  codexPath?: string;
  notificationCommand?: string;
}

export const LOCAL_CONFIG_PATH = join(homedir(), ".config", "ai-creator-board", "config.json");

async function loadLocalConfig(): Promise<LocalConfigFile> {
  try {
    return JSON.parse(await readFile(LOCAL_CONFIG_PATH, "utf8")) as LocalConfigFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function resolveConfig(env: NodeJS.ProcessEnv = process.env): Promise<AppConfig> {
  const local = await loadLocalConfig();
  const dataDir = resolve(env.AI_CREATOR_BOARD_DATA_DIR ?? local.dataDir ?? join(homedir(), "ai-creator-board-data"));
  const deviceId = env.AI_CREATOR_BOARD_DEVICE_ID ?? local.deviceId ?? `unconfigured-${randomUUID()}`;
  const deviceName = env.AI_CREATOR_BOARD_DEVICE_NAME ?? local.deviceName ?? `${hostname()} (${platform()})`;
  const siteRepository = env.AI_CREATOR_BOARD_SITE_REPOSITORY ?? local.siteRepository;
  const publisherCacheDir = resolve(env.AI_CREATOR_BOARD_PUBLISHER_CACHE ?? local.publisherCacheDir ?? join(homedir(), ".cache", "ai-creator-board", "publisher"));
  const coverBackend = (env.AI_CREATOR_BOARD_COVER_BACKEND ?? local.coverBackend ?? "none") as AppConfig["coverBackend"];
  const codexPath = env.AI_CREATOR_BOARD_CODEX_PATH ?? local.codexPath ?? "codex";
  const notificationCommand = env.AI_CREATOR_BOARD_NOTIFICATION_COMMAND ?? local.notificationCommand;
  return {
    dataDir,
    deviceId,
    deviceName,
    publisherCacheDir,
    coverBackend,
    codexPath,
    ...(siteRepository ? { siteRepository } : {}),
    ...(notificationCommand ? { notificationCommand } : {})
  };
}
