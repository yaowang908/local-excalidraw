import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyScene } from "@local-excalidraw/model";
import { CodexChat, type CodexTransport } from "./codex";
import { Documents } from "./documents";
import type { DocumentFs } from "./filesystem";

const initial = { content: JSON.stringify(emptyScene()), hash: "a".repeat(64), modifiedAt: 1 };
const stores: Documents[] = [];
const chats: CodexChat[] = [];
afterEach(() => { stores.splice(0).forEach((store) => store.dispose()); chats.splice(0).forEach((chat) => chat.dispose()); });

class Transport implements CodexTransport {
  requests: { command: string; args: Record<string, unknown> }[] = [];
  handler: (event: unknown) => void = () => {};
  disk = { ...initial };
  unlisten = vi.fn();
  fail: string | null = null;
  async listen(handler: (event: unknown) => void): Promise<() => void> { this.handler = handler; return this.unlisten; }
  async invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
    this.requests.push({ command, args });
    if (this.fail === command) throw new Error(`${command} failed`);
    let value: unknown;
    if (command === "codex_start") value = { sessionId: "session", threadId: "thread", turns: [] };
    if (command === "codex_read_tool") value = this.disk;
    if (command === "codex_write_tool") {
      this.disk = { content: String(args.content), hash: "b".repeat(64), modifiedAt: 2 };
      value = this.disk;
    }
    return value as T;
  }
  emit(method: string, params: Record<string, unknown>, id?: number, sessionId = "session") {
    this.handler({ sessionId, message: { method, params: { threadId: "thread", ...params }, ...(id === undefined ? {} : { id }) } });
  }
}

async function setup() {
  const transport = new Transport();
  const fs: DocumentFs = {
    read: async () => transport.disk,
    save: async (_path, content, expected) => {
      if (expected !== transport.disk.hash) throw { code: "conflict", message: "Changed" };
      transport.disk = { content, hash: "c".repeat(64), modifiedAt: 2 };
      return transport.disk;
    },
    recovery: async () => ({ root: "/workspace", path: "a.excalidraw", written: null, pending: null }),
    checkpoint: async () => "d".repeat(64),
    acceptExternal: async () => {},
  };
  const documents = new Documents(fs, () => {});
  stores.push(documents);
  await documents.open("a.excalidraw");
  documents.change("a.excalidraw", initial.content, 0);
  const chat = new CodexChat("/workspace", documents, "a.excalidraw", transport);
  chats.push(chat);
  await chat.connect("");
  return { chat, transport, documents };
}

describe("native Codex conversation", () => {
  it("streams messages and uses the completed item as the final text", async () => {
    const { chat, transport } = await setup();
    await chat.send("Add a box", "a.excalidraw");
    transport.emit("item/agentMessage/delta", { itemId: "answer", delta: "Added " });
    transport.emit("item/agentMessage/delta", { itemId: "answer", delta: "a box." });
    transport.emit("item/completed", { item: { id: "answer", type: "agentMessage", text: "Added a box." } });
    transport.emit("turn/completed", { turn: { id: "turn", status: "completed" } });
    expect(chat.getSnapshot()).toMatchObject({ phase: "ready", entries: [
      { role: "user", target: "a.excalidraw", text: "Add a box" }, { role: "assistant", text: "Added a box." },
    ] });
  });
  it("rejects unauthorized targets and grant changes during an active turn", async () => {
    const { chat, transport } = await setup();
    await expect(chat.send("Edit", "other.excalidraw")).rejects.toThrow("Allow");
    await chat.send("Edit", "a.excalidraw");
    await expect(chat.setAllowed([])).rejects.toThrow("Stop");
    expect(transport.requests.filter((request) => request.command === "codex_send")).toHaveLength(1);
  });
  it("edits through native IPC and updates the real document controller", async () => {
    const { chat, transport, documents } = await setup();
    await chat.send("Add a box", "a.excalidraw");
    transport.emit("item/tool/call", { tool: "edit_diagram", arguments: {
      path: "a.excalidraw", expectedHash: initial.hash,
      operations: [{ op: "add", element: { id: "box", type: "rectangle", x: 10, y: 20 } }],
    } }, 7);
    await vi.waitFor(() => expect(documents.get("a.excalidraw")?.savedHash).toBe("b".repeat(64)));
    expect(JSON.parse(transport.disk.content).elements).toMatchObject([{ id: "box" }]);
    expect(documents.get("a.excalidraw")?.dirty).toBe(false);
    expect(transport.requests.find((request) => request.command === "codex_write_tool")?.args.requestId).toBe(7);
  });
  it("fails stale hashes and duplicate requests without writing twice", async () => {
    const { chat, transport } = await setup();
    await chat.send("Edit", "a.excalidraw");
    const args = { tool: "edit_diagram", arguments: { path: "a.excalidraw", expectedHash: "old", operations: [] } };
    transport.emit("item/tool/call", args, 8);
    transport.emit("item/tool/call", args, 8);
    await vi.waitFor(() => expect(transport.requests.filter((request) => request.command === "codex_reply_tool")).toHaveLength(1));
    expect(transport.requests.some((request) => request.command === "codex_write_tool")).toBe(false);
    expect(chat.getSnapshot().error).toContain("changed");
  });
  it("rejects invalid operations and reads only explicitly allowed drawings", async () => {
    const { chat, transport } = await setup();
    await chat.send("Edit", "a.excalidraw");
    transport.emit("item/tool/call", { tool: "read_diagram", arguments: { path: "other.excalidraw" } }, 9);
    await vi.waitFor(() => expect(transport.requests.some((request) => request.command === "codex_reply_tool")).toBe(true));
    expect(transport.requests.some((request) => request.command === "codex_read_tool")).toBe(false);
    transport.emit("item/tool/call", { tool: "edit_diagram", arguments: { path: "a.excalidraw", expectedHash: initial.hash, operations: [{ op: "unknown" }] } }, 10);
    await vi.waitFor(() => expect(transport.requests.filter((request) => request.command === "codex_reply_tool")).toHaveLength(2));
    expect(transport.requests.some((request) => request.command === "codex_write_tool")).toBe(false);
  });
  it("retains conversation across disconnect/resume and ignores obsolete events", async () => {
    const { chat, transport } = await setup();
    transport.emit("item/agentMessage/delta", { itemId: "answer", delta: "Hello" });
    transport.emit("item/agentMessage/delta", { itemId: "obsolete", delta: "Ignore" }, undefined, "old-session");
    await chat.disconnect();
    await chat.connect("");
    expect(transport.requests.filter((request) => request.command === "codex_start").at(-1)?.args.threadId).toBe("thread");
    expect(chat.getSnapshot().entries).toHaveLength(1);
    chat.dispose();
    expect(transport.unlisten).toHaveBeenCalledOnce();
  });
  it("reports process failure, failed turns, and interrupt status", async () => {
    const { chat, transport } = await setup();
    await chat.send("Edit", "a.excalidraw");
    await chat.interrupt();
    transport.emit("turn/completed", { turn: { status: "interrupted" } });
    expect(chat.getSnapshot().entries.at(-1)?.text).toBe("Stopped");
    transport.emit("turn/completed", { turn: { status: "failed", error: { message: "Sign in required" } } });
    expect(chat.getSnapshot().error).toBe("Sign in required");
    transport.emit("local/disconnected", {});
    expect(chat.getSnapshot().phase).toBe("disconnected");
    expect(chat.getSnapshot().entries[0]?.text).toBe("Edit");
  });
  it("does not automatically retry a failed turn start", async () => {
    const { chat, transport } = await setup();
    transport.fail = "codex_send";
    await expect(chat.send("Edit", "a.excalidraw")).rejects.toThrow("failed");
    expect(transport.requests.filter((request) => request.command === "codex_send")).toHaveLength(1);
    expect(chat.getSnapshot()).toMatchObject({ phase: "ready", error: "codex_send failed" });
  });
});
