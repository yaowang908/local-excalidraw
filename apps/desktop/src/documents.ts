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
  waiting: boolean;
  initialized: boolean;
  revision: number;
  external: boolean;
  error: string | null;
  conflict: { disk: DiskSnapshot | null; message: string; copyPath?: string } | null;
}

/** Owns autosave and disk reconciliation independently of React or the editor. */
export class Documents {
  private documents: OpenDocument[] = [];
  private listeners = new Set<() => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, Promise<void>>();
  private opening = new Map<string, Promise<void>>();
  private reads = new Map<string, number>();
  private reconciling = new Map<string, Promise<void>>();
  private checkpoints = new Map<string, Promise<string>>();
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
      waiting: false,
      initialized: false,
      revision,
      external,
      error: null,
      conflict: null,
    };
  }

  private checkpoint(path: string, content: string, baseHash: string): Promise<string> {
    const previous = this.checkpoints.get(path);
    const next = (previous ?? Promise.resolve(""))
      .catch((error) => {
        this.onError(`Previous local recovery failed: ${errorMessage(error)}`);
      })
      .then(() => this.fs.checkpoint(path, content, baseHash));
    this.checkpoints.set(path, next);
    const cleanup = () => {
      if (this.checkpoints.get(path) === next) this.checkpoints.delete(path);
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  private versionPath(path: string, kind: "local" | "incoming", hash: string): string {
    const slash = path.lastIndexOf("/");
    const directory = slash < 0 ? "" : path.slice(0, slash + 1);
    const stem = Array.from(path.slice(slash + 1).replace(/\.excalidraw$/, ""));
    const suffix = `-${kind}-${hash.slice(0, 16)}.excalidraw`;
    const encoder = new TextEncoder();
    while (stem.length && encoder.encode(`${stem.join("")}${suffix}`).length > 255)
      stem.pop();
    return `${directory}${stem.join("") || "version"}${suffix}`;
  }

  private async createVersion(path: string, kind: "local" | "incoming", content: string, hash: string): Promise<string> {
    const destination = this.versionPath(path, kind, hash);
    try {
      await this.fs.save(destination, content, null);
    } catch (error) {
      if (!hasCode(error, "conflict")) throw error;
      const existing = await this.fs.read(destination);
      if (existing.content !== content) throw error;
    }
    return destination;
  }

  /** Read once even if a user opens the same file several times concurrently. */
  async open(path: string): Promise<void> {
    if (this.get(path)) return;
    const existing = this.opening.get(path);
    if (existing) return existing;
    const operation = (async () => {
      const recovery = await this.fs.recovery(path);
      let disk: DiskSnapshot | null = null;
      let readError: unknown;
      try {
        disk = await this.fs.read(path);
      } catch (error) {
        readError = error;
      }
      if (!disk && !recovery.pending && !recovery.written) throw readError;
      if (!this.disposed && !this.get(path)) {
        let doc: OpenDocument;
        if (recovery.pending) {
          const pending = recovery.pending;
          const fallback: DiskSnapshot = disk ?? {
            content: pending.content,
            hash: pending.baseHash ?? pending.hash,
            modifiedAt: 0,
          };
          doc = this.loaded(path, fallback);
          if (!disk || disk.hash !== pending.hash) {
            doc = {
              ...doc,
              content: pending.content,
              dirty: true,
              conflict: {
                disk,
                message: disk
                  ? "Recovered local changes differ from the workspace file. Choose a version."
                  : `Recovered local changes. The workspace file is unavailable: ${errorMessage(readError)}`,
              },
            };
          }
        } else if (recovery.written && (!disk || recovery.written.hash !== disk.hash)) {
          doc = this.loaded(path, {
            content: recovery.written.content,
            hash: recovery.written.hash,
            modifiedAt: disk?.modifiedAt ?? 0,
          });
          doc.conflict = {
            disk,
            message: disk
              ? "The workspace file differs from the last version saved here. Choose a version."
              : `The last locally saved version is available. The workspace file is unavailable: ${errorMessage(readError)}`,
          };
        } else if (disk) {
          doc = this.loaded(path, disk);
        } else {
          throw readError;
        }
        this.documents = [...this.documents, doc];
        this.emit();
        if (doc.dirty && disk && disk.hash !== recovery.pending?.baseHash) {
          await this.captureConflict(path);
        }
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
    if (doc.conflict) {
      void this.checkpoint(path, content, doc.savedHash).catch((error) =>
        this.patch(path, { error: `Local recovery failed: ${errorMessage(error)}` }),
      );
    }
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
    this.patch(path, { saving: true, waiting: false, error: null });
    const waitingTimer = setTimeout(() => {
      if (this.get(path)?.saving) this.patch(path, { waiting: true });
    }, 2000);
    const operation = (async () => {
      try {
        const checkpoint = this.checkpoints.get(path);
        if (checkpoint) await checkpoint;
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
        clearTimeout(waitingTimer);
        this.patch(path, { saving: false, waiting: false });
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

  private async captureConflict(path: string, knownDisk?: DiskSnapshot): Promise<void> {
    this.clearTimer(path);
    const current = this.get(path);
    if (!current) return;
    this.patch(path, {
      conflict: {
        disk: knownDisk ?? current.conflict?.disk ?? null,
        copyPath: current.conflict?.copyPath,
        message: "Checking the workspace version. Your canvas is preserved.",
      },
    });
    let checkpointHash: string | null = null;
    try {
      checkpointHash = await this.checkpoint(path, current.content, current.savedHash);
    } catch (error) {
      this.patch(path, { error: `Local recovery failed: ${errorMessage(error)}` });
    }
    try {
      const disk = knownDisk ?? await this.fs.read(path);
      let copyPath = current.conflict?.copyPath;
      if (current.dirty && disk.hash !== current.savedHash && checkpointHash && !copyPath) {
        try {
          copyPath = await this.createVersion(path, "local", current.content, checkpointHash);
        } catch (error) {
          this.patch(path, { error: `Could not create local version: ${errorMessage(error)}` });
        }
      }
      this.patch(path, {
        conflict: {
          disk,
          copyPath,
          message: "The workspace file changed. Your canvas and local recovery are preserved.",
        },
      });
    } catch (error) {
      this.patch(path, {
        conflict: {
          disk: null,
          message: `The workspace file is unavailable. Retry when it finishes downloading: ${errorMessage(error)}`,
        },
      });
    }
  }

  /** Recheck current state after each await, so an external read cannot erase a new edit. */
  reconcile(path: string): Promise<void> {
    const existing = this.reconciling.get(path);
    if (existing) return existing;
    const operation = this.reconcileOnce(path);
    this.reconciling.set(path, operation);
    const clear = () => {
      if (this.reconciling.get(path) === operation) this.reconciling.delete(path);
    };
    void operation.then(clear, clear);
    return operation;
  }

  private async reconcileOnce(path: string): Promise<void> {
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
      if (this.pending.has(path) || current.savedHash !== baseline) return;
      if (current.dirty && disk.content === current.content) {
        this.patch(path, {
          savedHash: disk.hash,
          savedContent: disk.content,
          modifiedAt: disk.modifiedAt,
          dirty: false,
          conflict: null,
          error: null,
        });
        return;
      }
      if (disk.hash === current.savedHash) {
        if (current.conflict && !current.dirty) this.patch(path, { conflict: null });
        this.schedule(path);
        return;
      }
      if (current.dirty || current.conflict) {
        await this.captureConflict(path, disk);
      } else {
        try {
          const recovery = await this.fs.recovery(path);
          const latest = this.get(path);
          if (this.reads.get(path) !== ticket || !latest) return;
          if (latest.savedHash !== baseline) return;
          if (latest.content !== current.content)
            return this.captureConflict(path, disk);
          if (latest.dirty) return this.captureConflict(path, disk);
          if (recovery.written?.hash === current.savedHash || recovery.pending?.hash === current.savedHash) {
            this.patch(path, {
              conflict: {
                disk,
                message: "The workspace file differs from the last version saved here. Choose a version.",
              },
            });
          } else {
            this.replace(path, disk, true);
          }
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
      const current = this.get(path);
      if (current?.dirty) {
        try {
          await this.checkpoint(path, current.content, current.savedHash);
        } catch (checkpointError) {
          this.patch(path, { error: `Local recovery failed: ${errorMessage(checkpointError)}` });
        }
      }
      this.patch(path, {
        conflict: {
          disk: null,
          message: `The workspace file is unavailable. Retry when it finishes downloading: ${errorMessage(error)}`,
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
    parseScene(disk.content);
    if (this.get(path)?.content !== before?.content)
      throw new Error(
        "The canvas changed while reloading. Review it before reloading again.",
      );
    if (before?.conflict?.disk && before.conflict.disk.hash !== disk.hash)
      throw new Error("The workspace file changed again. Review the new version first.");
    if (before?.conflict) {
      const localHash = await this.checkpoint(path, before.content, before.savedHash);
      await this.createVersion(path, "local", before.content, localHash);
    }
    if (this.get(path)?.content !== before?.content)
      throw new Error("The canvas changed while preserving its version. Review it before reloading again.");
    await this.fs.acceptExternal(path);
    if (this.get(path)?.content !== before?.content) {
      const current = this.get(path);
      if (current) await this.checkpoint(path, current.content, current.savedHash);
      throw new Error("The canvas changed while accepting the external version. Your edit is preserved.");
    }
    this.replace(path, disk, true);
  }
  /** Make the local canvas primary after preserving the incoming version. */
  async keep(path: string): Promise<void> {
    const doc = this.get(path);
    if (!doc?.conflict) return;
    if (!doc.conflict.disk) throw new Error("Wait for the workspace file before replacing it.");
    await this.createVersion(path, "incoming", doc.conflict.disk.content, doc.conflict.disk.hash);
    await this.save(path, doc.conflict.disk?.hash ?? null);
  }
  /** Open a create-only sibling of the incoming version without changing the canvas. */
  async openIncoming(path: string): Promise<string> {
    const disk = this.get(path)?.conflict?.disk;
    if (!disk) throw new Error("The incoming version is unavailable.");
    const destination = await this.createVersion(path, "incoming", disk.content, disk.hash);
    await this.open(destination);
    return destination;
  }
  /** Keep the local scene as a sibling and explicitly accept the incoming primary. */
  async keepBoth(path: string): Promise<string> {
    const doc = this.get(path);
    if (!doc?.conflict?.disk) throw new Error("The incoming version is unavailable.");
    const checkpointHash = await this.checkpoint(path, doc.content, doc.savedHash);
    const destination = await this.createVersion(path, "local", doc.content, checkpointHash);
    await this.reload(path);
    await this.open(destination);
    return destination;
  }
  /** Save the local buffer to a new file; keep later edits in the original tab. */
  async saveCopy(path: string, destination: string): Promise<void> {
    const doc = this.get(path);
    if (!doc) return;
    await this.fs.save(destination, doc.content, null);
    await this.open(destination);
    if (this.get(path)?.content === doc.content) {
      await this.fs.acceptExternal(path);
      this.remove(path);
    }
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
