import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type NotificationKind = "decision" | "completed" | "blocked" | "sync-failed" | "publish-failed";

export interface NotificationMessage {
  kind: NotificationKind;
  title: string;
  body: string;
  threadId?: string;
}

export interface NotificationAdapter {
  notify(message: NotificationMessage): Promise<void>;
}

export class SystemNotifier implements NotificationAdapter {
  constructor(private readonly customCommand?: string) {}

  async notify(message: NotificationMessage): Promise<void> {
    const deepLink = message.threadId ? `codex://threads/${encodeURIComponent(message.threadId)}` : undefined;
    if (this.customCommand) {
      await execFileAsync(this.customCommand, [message.title, message.body, deepLink ?? ""]);
      return;
    }
    if (platform() === "darwin") {
      const args = ["-title", message.title, "-message", message.body, "-group", `ai-creator-board-${message.kind}`];
      if (deepLink) args.push("-open", deepLink);
      await execFileAsync("terminal-notifier", args);
      return;
    }
    if (platform() === "win32") {
      const safe = `${message.title}: ${message.body}`.replaceAll("'", "''");
      await execFileAsync("powershell", ["-NoProfile", "-Command", `[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; [System.Windows.Forms.MessageBox]::Show('${safe}') | Out-Null`]);
    }
  }
}

export class MemoryNotifier implements NotificationAdapter {
  readonly messages: NotificationMessage[] = [];
  async notify(message: NotificationMessage): Promise<void> {
    this.messages.push(message);
  }
}
