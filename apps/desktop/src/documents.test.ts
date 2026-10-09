import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyScene } from "@local-excalidraw/model";
import { Documents } from "./documents";
import type { DiskSnapshot, DocumentFs, RecoveryRecord } from "./filesystem";

const content = (label: string) => JSON.stringify({ ...emptyScene(), label });
const disk = (label: string): DiskSnapshot => ({
  content: content(label),
  hash: `hash-${label}`,
  modifiedAt: 1,
});
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class MemoryFs implements DocumentFs {
  files = new Map<string, DiskSnapshot>([["a.excalidraw", disk("initial")]]);
  records = new Map<string, RecoveryRecord>();
  writes: string[] = [];
  async recovery(path: string): Promise<RecoveryRecord> {
    return this.records.get(path) ?? { root: "test", path, written: null, pending: null };
  }
  async checkpoint(path: string, text: string, baseHash: string | null): Promise<string> {
    const hash = Array.from(text).reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0).toString(16);
    this.records.set(path, {
      ...await this.recovery(path),
      pending: { content: text, hash, baseHash },
    });
    return hash;
  }
  async acceptExternal(path: string): Promise<void> {
    this.records.set(path, { ...await this.recovery(path), written: null, pending: null });
  }
  async read(path: string): Promise<DiskSnapshot> {
    const found = this.files.get(path);
    if (!found) throw { code: "missing", message: "File removed" };
    return found;
  }
  async save(
    path: string,
    text: string,
    expected: string | null,
  ): Promise<DiskSnapshot> {
    await this.checkpoint(path, text, expected);
    if ((this.files.get(path)?.hash ?? null) !== expected)
      throw { code: "conflict", message: "Disk changed" };
    const saved = { content: text, hash: `hash-${text}`, modifiedAt: 2 };
    this.files.set(path, saved);
    this.records.set(path, {
      ...await this.recovery(path),
      written: { content: text, hash: saved.hash, baseHash: null },
      pending: null,
    });
    this.writes.push(text);
    return saved;
  }
}

const stores: Documents[] = [];
async function setup() {
  const fs = new MemoryFs();
  const errors: string[] = [];
  const store = new Documents(fs, (message) => errors.push(message));
  stores.push(store);
  await store.open("a.excalidraw");
  store.change("a.excalidraw", content("initial"), 0);
  return { fs, store, errors };
}
afterEach(() => {
  stores.splice(0).forEach((store) => store.dispose());
  vi.useRealTimers();
});

describe("document lifecycle", () => {
  it("applies an agent save to a clean canvas without creating a conflict", async () => {
    const { fs, store } = await setup();
    const updated = await store.applyAgentEdit("a.excalidraw", "hash-initial", content("agent"),
      () => fs.save("a.excalidraw", content("agent"), "hash-initial"));
    expect(store.get("a.excalidraw")).toMatchObject({ content: content("agent"), savedHash: updated.hash,
      revision: 1, dirty: false, conflict: null });
    await store.reconcile("a.excalidraw");
    expect(store.get("a.excalidraw")?.conflict).toBeNull();
  });
  it("rejects an agent edit when the canvas changed since its read", async () => {
    const { fs, store } = await setup();
    store.change("a.excalidraw", content("local"), 0);
    await expect(store.applyAgentEdit("a.excalidraw", "hash-initial", content("agent"),
      () => fs.save("a.excalidraw", content("agent"), "hash-initial"))).rejects.toThrow("canvas changed");
    expect(fs.writes).toEqual([]);
    expect(store.get("a.excalidraw")?.content).toBe(content("local"));
  });
  it("preserves the live canvas if an edit arrives during the agent's atomic save", async () => {
    const { fs, store } = await setup();
    const gate = deferred<DiskSnapshot>();
    const saving = store.applyAgentEdit("a.excalidraw", "hash-initial", content("agent"), async () => {
      await gate.promise;
      return fs.save("a.excalidraw", content("agent"), "hash-initial");
    });
    store.change("a.excalidraw", content("local"), 0);
    gate.resolve(disk("agent"));
    await saving;
    expect(store.get("a.excalidraw")).toMatchObject({ content: content("local"), dirty: true,
      conflict: { disk: { content: content("agent") } } });
    expect(fs.files.get("a.excalidraw")?.content).toBe(content("agent"));
    expect([...fs.files.values()].some((file) => file.content === content("local"))).toBe(true);
  });
  it("holds concurrent autosave until an agent write completes", async () => {
    const { fs, store } = await setup();
    const gate = deferred<DiskSnapshot>();
    const agent = store.applyAgentEdit("a.excalidraw", "hash-initial", content("agent"), async () => {
      await gate.promise;
      return fs.save("a.excalidraw", content("agent"), "hash-initial");
    });
    const autosave = store.save("a.excalidraw");
    gate.resolve(disk("agent"));
    await Promise.all([agent, autosave]);
    expect(fs.writes).toEqual([content("agent")]);
  });
  it("flushes the chosen drawing before an agent read", async () => {
    const { fs, store } = await setup();
    store.change("a.excalidraw", content("local"), 0);
    await store.prepareAgentRead("a.excalidraw");
    expect(fs.files.get("a.excalidraw")?.content).toBe(content("local"));
  });
  it("preserves an agent save failure and rejects work on a disposed workspace", async () => {
    const { store } = await setup();
    await expect(store.applyAgentEdit("a.excalidraw", "hash-initial", content("agent"), async () => {
      throw { code: "uncertain", message: "Save timed out; reread" };
    })).rejects.toMatchObject({ code: "uncertain" });
    expect(store.get("a.excalidraw")).toMatchObject({ content: content("initial"), error: "Save timed out; reread", saving: false });
    store.dispose();
    await expect(store.prepareAgentRead("a.excalidraw")).rejects.toThrow("closed");
  });
  it("does not rewrite a restored or untouched scene", async () => {
    const { fs, store } = await setup();
    await store.open("a.excalidraw");
    await store.save("a.excalidraw");
    expect(store.getSnapshot()).toHaveLength(1);
    expect(fs.writes).toHaveLength(0);
  });
  it("deduplicates simultaneous opens", async () => {
    const { fs, store } = await setup();
    fs.files.set("b.excalidraw", disk("b"));
    await Promise.all([store.open("b.excalidraw"), store.open("b.excalidraw")]);
    expect(store.getSnapshot()).toHaveLength(2);
  });
  it("debounces editing and avoids view-only rewrites", async () => {
    vi.useFakeTimers();
    const { fs, store } = await setup();
    store.change("a.excalidraw", content("one"), 0);
    await vi.advanceTimersByTimeAsync(500);
    store.change("a.excalidraw", content("two"), 0);
    await vi.advanceTimersByTimeAsync(749);
    expect(fs.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fs.writes).toEqual([content("two")]);
    expect(store.get("a.excalidraw")?.dirty).toBe(false);
  });
  it("undo back to saved content clears dirty state", async () => {
    const { store } = await setup();
    store.change("a.excalidraw", content("edit"), 0);
    store.change("a.excalidraw", content("initial"), 0);
    expect(store.get("a.excalidraw")?.dirty).toBe(false);
  });
  it("preserves newer edits when an older save completes", async () => {
    const { fs, store } = await setup();
    const pending = deferred<DiskSnapshot>();
    fs.save = () => pending.promise;
    store.change("a.excalidraw", content("first"), 0);
    const saving = store.save("a.excalidraw");
    store.change("a.excalidraw", content("second"), 0);
    pending.resolve(disk("first"));
    await saving;
    expect(store.get("a.excalidraw")).toMatchObject({
      content: content("second"),
      savedHash: "hash-first",
      dirty: true,
      saving: false,
    });
  });
  it("close drains edits received while the last save is pending", async () => {
    const { fs, store } = await setup();
    const first = deferred<DiskSnapshot>();
    const actualSave = fs.save.bind(fs);
    let calls = 0;
    fs.save = async (path, text, expected) => {
      if (++calls === 1) {
        await first.promise;
      }
      return actualSave(path, text, expected);
    };
    store.change("a.excalidraw", content("first"), 0);
    const closing = store.close("a.excalidraw");
    store.change("a.excalidraw", content("newest"), 0);
    first.resolve(disk("first"));
    await closing;
    expect(fs.files.get("a.excalidraw")?.content).toBe(content("newest"));
    expect(store.getSnapshot()).toHaveLength(0);
  });
  it("reload cannot discard edits made while its disk read was pending", async () => {
    const { fs, store } = await setup();
    const read = deferred<DiskSnapshot>();
    fs.read = () => read.promise;
    const reload = store.reload("a.excalidraw");
    store.change("a.excalidraw", content("newest"), 0);
    read.resolve(disk("external"));
    await expect(reload).rejects.toThrow("changed while");
    expect(store.get("a.excalidraw")?.content).toBe(content("newest"));
  });
  it("reloads clean external changes and ignores own-write events", async () => {
    const { fs, store } = await setup();
    await store.reconcile("a.excalidraw");
    expect(store.get("a.excalidraw")?.revision).toBe(0);
    fs.files.set("a.excalidraw", disk("external"));
    await store.reconcile("a.excalidraw");
    expect(store.get("a.excalidraw")).toMatchObject({
      content: content("external"),
      external: true,
      revision: 1,
      dirty: false,
    });
  });
  it("preserves a dirty canvas when external edits appear", async () => {
    const { fs, store } = await setup();
    store.change("a.excalidraw", content("local"), 0);
    fs.files.set("a.excalidraw", disk("external"));
    await store.reconcile("a.excalidraw");
    expect(store.get("a.excalidraw")).toMatchObject({
      content: content("local"),
      conflict: { disk: disk("external") },
    });
    await expect(store.save("a.excalidraw")).rejects.toThrow("Resolve");
    expect(fs.files.get("a.excalidraw")).toEqual(disk("external"));
  });
  it("catches a conflict even before the watcher fires", async () => {
    const { fs, store } = await setup();
    store.change("a.excalidraw", content("local"), 0);
    fs.files.set("a.excalidraw", disk("external"));
    await expect(store.save("a.excalidraw")).rejects.toMatchObject({
      code: "conflict",
    });
    expect(store.get("a.excalidraw")?.conflict?.disk).toEqual(disk("external"));
  });
  it("preserves both versions when an external write lands during save", async () => {
    const { fs, store } = await setup();
    const gate = deferred<void>();
    const actualSave = fs.save.bind(fs);
    fs.save = async (path, text, expected) => {
      await gate.promise;
      return actualSave(path, text, expected);
    };
    store.change("a.excalidraw", content("local"), 0);
    const saving = store.save("a.excalidraw");
    fs.files.set("a.excalidraw", disk("incoming"));
    gate.resolve();
    await expect(saving).rejects.toMatchObject({ code: "conflict" });
    expect(fs.files.get("a.excalidraw")).toEqual(disk("incoming"));
    const copy = store.get("a.excalidraw")?.conflict?.copyPath;
    expect(fs.files.get(copy ?? "")?.content).toBe(content("local"));
  });
  it("rechecks dirty state after an asynchronous disk read", async () => {
    const { fs, store } = await setup();
    const read = deferred<DiskSnapshot>();
    fs.read = () => read.promise;
    const reconciling = store.reconcile("a.excalidraw");
    store.change("a.excalidraw", content("typed-during-read"), 0);
    read.resolve(disk("external"));
    await reconciling;
    expect(store.get("a.excalidraw")).toMatchObject({
      content: content("typed-during-read"),
      conflict: { disk: disk("external") },
    });
  });
  it("coalesces repeated watcher reads while a cloud read is pending", async () => {
    const { fs, store } = await setup();
    const first = deferred<DiskSnapshot>();
    const second = deferred<DiskSnapshot>();
    let calls = 0;
    fs.read = () => (++calls === 1 ? first.promise : second.promise);
    const oldRead = store.reconcile("a.excalidraw");
    const repeated = store.reconcile("a.excalidraw");
    expect(calls).toBe(1);
    first.resolve(disk("old"));
    await Promise.all([oldRead, repeated]);
    const newRead = store.reconcile("a.excalidraw");
    second.resolve(disk("latest"));
    await newRead;
    expect(store.get("a.excalidraw")?.content).toBe(content("latest"));
  });
  it("keep-my-version still rejects a second external write", async () => {
    const { fs, store } = await setup();
    store.change("a.excalidraw", content("local"), 0);
    fs.files.set("a.excalidraw", disk("external"));
    await store.reconcile("a.excalidraw");
    fs.files.set("a.excalidraw", disk("newer-external"));
    await expect(store.keep("a.excalidraw")).rejects.toMatchObject({
      code: "conflict",
    });
    expect(store.get("a.excalidraw")?.conflict?.disk).toEqual(
      disk("newer-external"),
    );
    await store.keep("a.excalidraw");
    expect(fs.files.get("a.excalidraw")?.content).toBe(content("local"));
  });
  it("reload explicitly accepts the latest external version", async () => {
    const { fs, store } = await setup();
    store.change("a.excalidraw", content("local"), 0);
    fs.files.set("a.excalidraw", disk("external"));
    await store.reconcile("a.excalidraw");
    await store.reload("a.excalidraw");
    expect(store.get("a.excalidraw")).toMatchObject({
      conflict: null,
      dirty: false,
      content: content("external"),
    });
  });
  it("save-as leaves the external file intact and refuses collisions", async () => {
    const { fs, store } = await setup();
    store.change("a.excalidraw", content("local"), 0);
    fs.files.set("a.excalidraw", disk("external"));
    await store.reconcile("a.excalidraw");
    await expect(
      store.saveCopy("a.excalidraw", "a.excalidraw"),
    ).rejects.toMatchObject({ code: "conflict" });
    await store.saveCopy("a.excalidraw", "copy.excalidraw");
    expect(fs.files.get("a.excalidraw")).toEqual(disk("external"));
    expect(fs.files.get("copy.excalidraw")?.content).toBe(content("local"));
    expect(store.get("a.excalidraw")).toBeUndefined();
  });
  it("preserves buffers on external deletion and corrupt JSON", async () => {
    const { fs, store } = await setup();
    fs.files.delete("a.excalidraw");
    await store.reconcile("a.excalidraw");
    expect(store.get("a.excalidraw")).toMatchObject({
      content: content("initial"),
      conflict: { disk: null },
    });
    fs.files.set("a.excalidraw", {
      content: "corrupt",
      hash: "corrupt",
      modifiedAt: 1,
    });
    await store.reconcile("a.excalidraw");
    await expect(store.reload("a.excalidraw")).rejects.toThrow();
    expect(store.get("a.excalidraw")?.content).toBe(content("initial"));
  });
  it("blocks close and workspace switches on unresolved conflicts", async () => {
    const { fs, store } = await setup();
    store.change("a.excalidraw", content("local"), 0);
    fs.files.set("a.excalidraw", disk("external"));
    await store.reconcile("a.excalidraw");
    await expect(store.close("a.excalidraw")).rejects.toThrow("Resolve");
    await expect(store.flush()).rejects.toThrow("Resolve");
    expect(store.getSnapshot()).toHaveLength(1);
  });
  it("retains unsaved contents and supports retry after a write error", async () => {
    const { fs, store } = await setup();
    const save = fs.save.bind(fs);
    fs.save = async () => {
      throw new Error("disk full");
    };
    store.change("a.excalidraw", content("local"), 0);
    await expect(store.save("a.excalidraw")).rejects.toThrow("disk full");
    expect(store.get("a.excalidraw")).toMatchObject({
      dirty: true,
      error: "disk full",
      saving: false,
    });
    fs.save = save;
    await store.save("a.excalidraw");
    expect(store.get("a.excalidraw")).toMatchObject({
      dirty: false,
      error: null,
    });
  });
  it("holds a clean external replacement for a version choice", async () => {
    const { fs, store } = await setup();
    store.change("a.excalidraw", content("app-written"), 0);
    await store.save("a.excalidraw");
    fs.files.set("a.excalidraw", disk("incoming"));
    await store.reconcile("a.excalidraw");
    expect(store.get("a.excalidraw")).toMatchObject({
      content: content("app-written"),
      dirty: false,
      conflict: { disk: disk("incoming") },
    });
    await store.reload("a.excalidraw");
    expect(store.get("a.excalidraw")?.content).toBe(content("incoming"));
    expect([...fs.files.values()].some((file) => file.content === content("app-written"))).toBe(true);
  });
  it("checkpoints a dirty conflict and creates one stable create-only sibling", async () => {
    const { fs, store } = await setup();
    store.change("a.excalidraw", content("local"), 0);
    fs.files.set("a.excalidraw", disk("incoming"));
    await store.reconcile("a.excalidraw");
    const copy = store.get("a.excalidraw")?.conflict?.copyPath;
    expect(copy).toMatch(/^a-local-[0-9a-f]+\.excalidraw$/);
    expect(fs.files.get(copy ?? "")?.content).toBe(content("local"));
    expect((await fs.recovery("a.excalidraw")).pending?.content).toBe(content("local"));
    await store.reconcile("a.excalidraw");
    expect(store.get("a.excalidraw")?.conflict?.copyPath).toBe(copy);
    expect(fs.writes.filter((text) => text === content("local"))).toHaveLength(1);
  });
  it("recovers a checkpoint after a crash before workspace write", async () => {
    const fs = new MemoryFs();
    await fs.checkpoint("a.excalidraw", content("recovered"), disk("initial").hash);
    const store = new Documents(fs, () => {});
    stores.push(store);
    await store.open("a.excalidraw");
    expect(store.get("a.excalidraw")).toMatchObject({
      content: content("recovered"),
      dirty: true,
      conflict: { disk: disk("initial") },
    });
    expect(fs.files.get("a.excalidraw")).toEqual(disk("initial"));
  });
  it("opens recovered work while a cloud file is unavailable", async () => {
    const fs = new MemoryFs();
    await fs.checkpoint("a.excalidraw", content("recovered"), disk("initial").hash);
    fs.read = async () => { throw new Error("download in progress"); };
    const store = new Documents(fs, () => {});
    stores.push(store);
    await store.open("a.excalidraw");
    expect(store.get("a.excalidraw")?.content).toBe(content("recovered"));
    expect(store.get("a.excalidraw")?.conflict?.disk).toBeNull();
  });
  it("opens the last app-written version when the cloud file disappears", async () => {
    const { fs, store } = await setup();
    store.change("a.excalidraw", content("written"), 0);
    await store.save("a.excalidraw");
    store.dispose();
    fs.files.delete("a.excalidraw");
    const restarted = new Documents(fs, () => {});
    stores.push(restarted);
    await restarted.open("a.excalidraw");
    expect(restarted.get("a.excalidraw")?.content).toBe(content("written"));
    expect(restarted.get("a.excalidraw")?.conflict?.disk).toBeNull();
  });
  it("recognizes an uncertain save once its exact bytes appear on disk", async () => {
    const { fs, store } = await setup();
    store.change("a.excalidraw", content("local"), 0);
    fs.files.set("a.excalidraw", disk("local"));
    await store.reconcile("a.excalidraw");
    expect(store.get("a.excalidraw")).toMatchObject({
      dirty: false,
      savedHash: disk("local").hash,
      conflict: null,
    });
  });
  it("retains the checkpoint after an uncertain save result", async () => {
    const { fs, store } = await setup();
    fs.save = async (path, text, expected) => {
      await fs.checkpoint(path, text, expected);
      throw { code: "uncertain", message: "Provider still working" };
    };
    store.change("a.excalidraw", content("local"), 0);
    await expect(store.save("a.excalidraw")).rejects.toMatchObject({ code: "uncertain" });
    expect((await fs.recovery("a.excalidraw")).pending?.content).toBe(content("local"));
    expect(store.get("a.excalidraw")).toMatchObject({ dirty: true, error: "Provider still working" });
  });
  it("does not write the workspace when local checkpointing fails", async () => {
    const { fs, store } = await setup();
    fs.checkpoint = async () => { throw new Error("recovery disk full"); };
    store.change("a.excalidraw", content("local"), 0);
    await expect(store.save("a.excalidraw")).rejects.toThrow("recovery disk full");
    expect(fs.files.get("a.excalidraw")).toEqual(disk("initial"));
    expect(store.get("a.excalidraw")?.error).toContain("recovery disk full");
  });
  it("never overwrites an unrelated file at the stable conflict-copy path", async () => {
    const { fs, store } = await setup();
    store.change("a.excalidraw", content("local"), 0);
    const hash = await fs.checkpoint("a.excalidraw", content("local"), disk("initial").hash);
    const copy = `a-local-${hash.slice(0, 16)}.excalidraw`;
    fs.files.set(copy, disk("unrelated"));
    fs.files.set("a.excalidraw", disk("incoming"));
    await store.reconcile("a.excalidraw");
    expect(fs.files.get(copy)).toEqual(disk("unrelated"));
    expect(store.get("a.excalidraw")?.error).toContain("Could not create local version");
    expect(store.get("a.excalidraw")?.content).toBe(content("local"));
  });
  it("keeps each tab's scene isolated and follows folder renames", async () => {
    const { fs, store } = await setup();
    fs.files.set("folder/b.excalidraw", disk("b"));
    await store.open("folder/b.excalidraw");
    store.change("a.excalidraw", content("local"), 0);
    store.moved("folder", "moved");
    expect(store.get("moved/b.excalidraw")?.content).toBe(content("b"));
    expect(store.get("a.excalidraw")?.content).toBe(content("local"));
  });
});
