import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyScene } from "@local-excalidraw/model";
import { Documents } from "./documents";
import type { DiskSnapshot, DocumentFs } from "./filesystem";

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
  writes: string[] = [];
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
    if ((this.files.get(path)?.hash ?? null) !== expected)
      throw { code: "conflict", message: "Disk changed" };
    const saved = { content: text, hash: `hash-${text}`, modifiedAt: 2 };
    this.files.set(path, saved);
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
  it("ignores out-of-order watcher reads", async () => {
    const { fs, store } = await setup();
    const first = deferred<DiskSnapshot>();
    const second = deferred<DiskSnapshot>();
    let calls = 0;
    fs.read = () => (++calls === 1 ? first.promise : second.promise);
    const oldRead = store.reconcile("a.excalidraw");
    const newRead = store.reconcile("a.excalidraw");
    second.resolve(disk("latest"));
    await newRead;
    first.resolve(disk("old"));
    await oldRead;
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
