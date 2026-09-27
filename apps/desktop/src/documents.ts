import { canonical, parseScene } from "@local-excalidraw/model";
import {
  errorMessage,
  hasCode,
  type DiskSnapshot,
  type DocumentFs,
} from "./filesystem";

/** An open tab keeps its editor buffer separate from its last acknowledged save. */
export interface OpenDocument {
  path: string;
  content: string;
  savedContent: string;
  savedHash: string;
  modifiedAt: number;
  dirty: boolean;
  saving: boolean;
  initialized: boolean;
  revision: number;
  external: boolean;
  error: string | null;
  conflict: { disk: DiskSnapshot | null; message: string } | null;
}

/** Owns autosave and disk reconciliation independently of React or the editor. */
export class Documents {
  private documents: OpenDocument[] = [];
  private listeners = new Set<() => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, Promise<void>>();
  private opening = new Map<string, Promise<void>>();
  private reads = new Map<string, number>();
  private disposed = false;

  constructor(
    readonly fs: DocumentFs,
    private onError: (message: string) => void,
    private delay = 750,
  ) {}

  /** Stable external-store snapshot for React. */
  getSnapshot = (): OpenDocument[] => this.documents;
  /** Subscribe to immutable state changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** Retrieve a current tab by workspace-relative path. */
  get(path: string): OpenDocument | undefined {
    return this.documents.find((doc) => doc.path === path);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
  private patch(path: string, changes: Partial<OpenDocument>): void {
    if (this.disposed) return;
    this.documents = this.documents.map((doc) =>
      doc.path === path ? { ...doc, ...changes } : doc,
    );
    this.emit();
  }
  private clearTimer(path: string): void {
    clearTimeout(this.timers.get(path));
    this.timers.delete(path);
  }
  private schedule(path: string): void {
    this.clearTimer(path);
    const doc = this.get(path);
    if (!doc?.dirty || doc.conflict || doc.error || this.disposed) return;
    this.timers.set(
      path,
      setTimeout(() => {
        void this.save(path).catch((error) =>
          this.onError(errorMessage(error)),
        );
      }, this.delay),
    );
  }
  private loaded(
    path: string,
    disk: DiskSnapshot,
    revision = 0,
    external = false,
  ): OpenDocument {
    parseScene(disk.content);
    return {
      path,
      content: disk.content,
      savedContent: disk.content,
      savedHash: disk.hash,
      modifiedAt: disk.modifiedAt,
      dirty: false,
      saving: false,
      initialized: false,
      revision,
      external,
      error: null,
      conflict: null,
    };
  }

  /** Read once even if a user opens the same file several times concurrently. */
  async open(path: string): Promise<void> {
    if (this.get(path)) return;
    const existing = this.opening.get(path);
    if (existing) return existing;
    const operation = (async () => {
      const disk = await this.fs.read(path);
      if (!this.disposed && !this.get(path)) {
        this.documents = [...this.documents, this.loaded(path, disk)];
        this.emit();
      }
    })();
    this.opening.set(path, operation);
    try {
      await operation;
    } finally {
      this.opening.delete(path);
    }
  }

  /** Normalize the editor's initial restoration without rewriting untouched files. */
  change(path: string, content: string, revision: number): void {
    const doc = this.get(path);
    if (!doc || doc.revision !== revision) return;
    if (!doc.initialized) {
      this.patch(path, { initialized: true, content, savedContent: content });
      return;
    }
    if (canonical(JSON.parse(doc.content)) === canonical(JSON.parse(content)))
      return;
    const dirty =
      canonical(JSON.parse(doc.savedContent)) !==
      canonical(JSON.parse(content));
    this.patch(path, { content, dirty, external: false, error: null });
    this.schedule(path);
  }

  /** Save an immutable snapshot; edits arriving during I/O remain dirty. */
  async save(path: string, expectedOverride?: string | null): Promise<void> {
    this.clearTimer(path);
    const running = this.pending.get(path);
    if (running) {
      await running;
      return this.save(path, expectedOverride);
    }
    const doc = this.get(path);
    if (!doc || (!doc.dirty && expectedOverride === undefined)) return;
    if (doc.conflict && expectedOverride === undefined)
      throw new Error(`Resolve the conflict in ${path} before saving.`);
    const content = doc.content;
    const expected =
      expectedOverride === undefined ? doc.savedHash : expectedOverride;
    this.patch(path, { saving: true, error: null });
    const operation = (async () => {
      try {
        const disk = await this.fs.save(path, content, expected);
        const current = this.get(path);
        if (current)
          this.patch(path, {
            savedHash: disk.hash,
            savedContent: content,
            modifiedAt: disk.modifiedAt,
            dirty: current.content !== content,
            conflict: null,
            external: false,
          });
      } catch (error) {
        if (hasCode(error, "conflict") || hasCode(error, "missing")) {
          await this.captureConflict(path);
        } else {
          this.patch(path, { error: errorMessage(error) });
        }
        throw error;
      } finally {
        this.patch(path, { saving: false });
      }
    })();
    this.pending.set(path, operation);
    try {
      await operation;
    } finally {
      this.pending.delete(path);
      this.schedule(path);
    }
  }

  private async captureConflict(path: string): Promise<void> {
    this.clearTimer(path);
    try {
      const disk = await this.fs.read(path);
      this.patch(path, {
        conflict: {
          disk,
          message:
            "This drawing changed outside the app. Your canvas has been preserved.",
        },
      });
    } catch (error) {
      this.patch(path, {
        conflict: {
          disk: null,
          message: `The disk version is unavailable: ${errorMessage(error)}`,
        },
      });
    }
  }

  /** Recheck current state after each await, so an external read cannot erase a new edit. */
  async reconcile(path: string): Promise<void> {
    const pending = this.pending.get(path);
    if (pending) {
      await pending.catch((error) => this.onError(errorMessage(error)));
    }
    const ticket = (this.reads.get(path) ?? 0) + 1;
    this.reads.set(path, ticket);
    const baseline = this.get(path)?.savedHash;
    if (!baseline) return;
    try {
      const disk = await this.fs.read(path);
      if (this.reads.get(path) !== ticket) return;
      const current = this.get(path);
      if (!current) return;
      if (this.pending.has(path) || current.savedHash !== baseline)
        return this.reconcile(path);
      if (disk.hash === current.savedHash) {
        if (current.conflict) this.patch(path, { conflict: null });
        this.schedule(path);
        return;
      }
      if (current.dirty || current.conflict) {
        this.clearTimer(path);
        this.patch(path, {
          conflict: {
            disk,
            message:
              "This drawing changed outside the app. Your canvas has been preserved.",
          },
        });
      } else {
        try {
          this.replace(path, disk, true);
        } catch (error) {
          this.patch(path, {
            conflict: {
              disk,
              message: `The external file is invalid: ${errorMessage(error)}`,
            },
          });
        }
      }
    } catch (error) {
      if (this.reads.get(path) !== ticket || !this.get(path)) return;
      this.clearTimer(path);
      this.patch(path, {
        conflict: {
          disk: null,
          message: `The disk version is unavailable: ${errorMessage(error)}`,
        },
      });
    }
  }

  private replace(path: string, disk: DiskSnapshot, external: boolean): void {
    const doc = this.get(path);
    if (!doc) return;
    const loaded = this.loaded(path, disk, doc.revision + 1, external);
    this.clearTimer(path);
    this.documents = this.documents.map((item) =>
      item.path === path ? loaded : item,
    );
    this.emit();
  }

  /** Explicitly discard the local buffer in favor of the latest valid disk version. */
  async reload(path: string): Promise<void> {
    const before = this.get(path);
    const disk = await this.fs.read(path);
    if (this.get(path)?.content !== before?.content)
      throw new Error(
        "The canvas changed while reloading. Review it before reloading again.",
      );
    this.replace(path, disk, true);
  }
  /** Overwrite only the external version displayed in the conflict prompt. */
  async keep(path: string): Promise<void> {
    const doc = this.get(path);
    if (!doc?.conflict) return;
    await this.save(path, doc.conflict.disk?.hash ?? null);
  }
  /** Save the local buffer to a new file; keep later edits in the original tab. */
  async saveCopy(path: string, destination: string): Promise<void> {
    const doc = this.get(path);
    if (!doc) return;
    await this.fs.save(destination, doc.content, null);
    await this.open(destination);
    if (this.get(path)?.content === doc.content) this.remove(path);
  }
  /** Save all tabs before a workspace switch or a normal application exit. */
  async flush(): Promise<void> {
    do {
      for (const doc of this.documents) await this.drain(doc.path);
    } while (this.documents.some((doc) => doc.dirty || doc.saving));
  }
  /** Close a tab only after its pending changes have been safely saved. */
  async close(path: string): Promise<void> {
    await this.drain(path);
    this.remove(path);
  }
  private async drain(path: string): Promise<void> {
    do {
      if (this.get(path)?.conflict)
        throw new Error(`Resolve the conflict in ${path} before continuing.`);
      await this.save(path);
    } while (this.get(path)?.dirty || this.get(path)?.saving);
  }
  private remove(path: string): void {
    this.clearTimer(path);
    this.documents = this.documents.filter((doc) => doc.path !== path);
    this.emit();
  }
  /** Update tabs after a successful filesystem move, including folder descendants. */
  moved(from: string, to: string): void {
    this.documents = this.documents.map((doc) =>
      doc.path === from || doc.path.startsWith(`${from}/`)
        ? { ...doc, path: to + doc.path.slice(from.length) }
        : doc,
    );
    this.emit();
  }
  /** Remove saved tabs after an explicitly confirmed move to Trash. */
  trashed(path: string): void {
    for (const doc of [...this.documents])
      if (doc.path === path || doc.path.startsWith(`${path}/`))
        this.remove(doc.path);
  }
  /** Release timers after the owning workspace has been flushed. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.listeners.clear();
  }
}
