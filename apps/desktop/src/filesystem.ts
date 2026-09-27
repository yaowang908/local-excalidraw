import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isRecord } from "@local-excalidraw/model";

/** One consistent disk read; hashes use SHA-256 over the exact UTF-8 bytes. */
export interface DiskSnapshot {
  content: string;
  hash: string;
  modifiedAt: number;
}
/** Visible workspace entry. */
export interface FileEntry {
  name: string;
  path: string;
  kind: "folder" | "drawing" | "library";
  children: FileEntry[];
}
/** Lightweight session metadata; never contains drawing contents. */
export interface Preferences {
  workspacePath: string | null;
  openTabs: string[];
  activeTab: string | null;
}
/** Filesystem boundary shared by document state and the native adapter. */
export interface DocumentFs {
  read(path: string): Promise<DiskSnapshot>;
  save(
    path: string,
    content: string,
    expectedHash: string | null,
  ): Promise<DiskSnapshot>;
}

/** Convert native structured errors into readable messages. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string")
    return error.message;
  return String(error);
}

/** Check native error codes without relying on translated message text. */
export function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

/** Native operations are bound to a specific workspace, including pending requests. */
export class NativeFs implements DocumentFs {
  constructor(readonly root: string) {}
  read(path: string): Promise<DiskSnapshot> {
    return invoke("read_document", { root: this.root, path });
  }
  save(
    path: string,
    content: string,
    expectedHash: string | null,
  ): Promise<DiskSnapshot> {
    return invoke("save_document", {
      root: this.root,
      path,
      content,
      expectedHash,
    });
  }
  tree(): Promise<FileEntry[]> {
    return invoke("list_entries", { root: this.root });
  }
  createFolder(path: string): Promise<void> {
    return invoke("create_folder", { root: this.root, path });
  }
  move(from: string, to: string): Promise<void> {
    return invoke("move_entry", { root: this.root, from, to });
  }
  trash(path: string): Promise<void> {
    return invoke("trash_entry", { root: this.root, path });
  }
  reveal(path: string | null): Promise<void> {
    return invoke("reveal_entry", { root: this.root, path });
  }
  watch(callback: (error: string | null) => void): Promise<() => void> {
    return listen<{ root: string; error: string | null }>(
      "workspace-changed",
      (event) => {
        if (event.payload.root === this.root) callback(event.payload.error);
      },
    );
  }
}
