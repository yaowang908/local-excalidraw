import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { emptyScene, parseScene } from "@local-excalidraw/model";
import { WorkspaceFs } from "./filesystem.ts";

const entrypoint = fileURLToPath(new URL("./index.ts", import.meta.url));
const returned = z.object({
  path: z.string(),
  hash: z.string(),
  elements: z.array(
    z.object({ id: z.string(), text: z.string().optional() }).passthrough(),
  ),
});
let root: string;
let client: Client;
let fs: WorkspaceFs;
const clients: Client[] = [];

async function connect() {
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint, "--workspace", root],
      cwd: tmpdir(),
    }),
  );
  return client;
}

async function call(
  name: string,
  args: Record<string, unknown>,
  peer = client,
) {
  const result = await peer.callTool({ name, arguments: args });
  const first = result.content[0];
  if (!first || first.type !== "text")
    throw new Error("Expected JSON tool response");
  const data: unknown = first.text.startsWith("{")
    ? JSON.parse(first.text)
    : { message: first.text };
  return { isError: result.isError ?? false, data };
}

async function create() {
  const result = await call("create_diagram", {
    path: "system.excalidraw",
    elements: [
      { id: "api", type: "rectangle", x: 100, y: 100, text: "API" },
      { id: "db", type: "diamond", x: 500, y: 100, text: "Database" },
    ],
  });
  expect(result.isError).toBe(false);
  return returned.parse(result.data);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "excalidraw-mcp-test-")));
  fs = new WorkspaceFs(root);
  client = await connect();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((peer) => peer.close()));
  await rm(root, { recursive: true, force: true });
});

describe("real stdio MCP and native filesystem", () => {
  it("advertises the complete editing interface and read/write annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "list_files",
        "read_diagram",
        "preview_diagram",
        "create_diagram",
        "get_elements",
        "add_element",
        "update_element",
        "delete_element",
        "connect_elements",
        "move_element",
        "resize_element",
        "set_text",
        "group_elements",
        "ungroup_elements",
        "save_diagram",
      ].sort(),
    );
    expect(
      tools.find((tool) => tool.name === "read_diagram")?.annotations
        ?.readOnlyHint,
    ).toBe(true);
    expect(
      tools.find((tool) => tool.name === "delete_element")?.annotations
        ?.readOnlyHint,
    ).toBe(false);
  });

  it("creates, connects, edits, groups and saves a portable diagram through MCP", async () => {
    let current = await create();
    for (const [name, args] of [
      [
        "connect_elements",
        { id: "query", from: "api", to: "db", label: "SQL" },
      ],
      [
        "add_element",
        {
          element: {
            id: "redis",
            type: "ellipse",
            x: 300,
            y: 400,
            text: "Redis",
          },
        },
      ],
      ["move_element", { id: "api", x: 20, y: 30 }],
      ["resize_element", { id: "db", width: 240, height: 150 }],
      [
        "update_element",
        { id: "redis", changes: { style: { backgroundColor: "#d3f9d8" } } },
      ],
      ["set_text", { id: "query", text: "Prepared SQL" }],
      ["group_elements", { ids: ["api", "db"], groupId: "backend" }],
      ["ungroup_elements", { groupId: "backend" }],
      ["delete_element", { id: "redis" }],
    ] as const) {
      const result = await call(name, {
        path: current.path,
        expectedHash: current.hash,
        ...args,
      });
      expect(result.isError, JSON.stringify(result.data)).toBe(false);
      current = returned.parse(result.data);
    }
    const saved = parseScene(await readFile(join(root, current.path), "utf8"));
    expect(
      saved.elements.find((item) => item.id === "query-label"),
    ).toMatchObject({ originalText: "Prepared SQL", containerId: "query" });
    expect(saved.elements.find((item) => item.id === "redis")?.isDeleted).toBe(
      true,
    );
    const read = await call("get_elements", {
      path: current.path,
      ids: ["api"],
    });
    expect(
      returned.parse(read.data).elements.map((element) => element.id),
    ).toEqual(["api"]);
    const before = await stat(join(root, current.path));
    expect(
      (
        await call("save_diagram", {
          path: current.path,
          expectedHash: current.hash,
        })
      ).isError,
    ).toBe(false);
    expect((await stat(join(root, current.path))).mtimeMs).toBe(before.mtimeMs);
  });

  it("rejects stale writes and retries without duplicating or overwriting", async () => {
    const original = await create();
    const first = await call("set_text", {
      path: original.path,
      expectedHash: original.hash,
      id: "api",
      text: "First writer",
    });
    expect(first.isError).toBe(false);
    const retry = await call("set_text", {
      path: original.path,
      expectedHash: original.hash,
      id: "api",
      text: "First writer",
    });
    expect(retry).toMatchObject({ isError: true, data: { code: "conflict" } });
    expect((await fs.read(original.path)).hash).toBe(
      returned.parse(first.data).hash,
    );
    expect(await call("create_diagram", { path: original.path })).toMatchObject(
      { isError: true, data: { code: "conflict" } },
    );
  });

  it("allows only one of two MCP processes to commit the same revision", async () => {
    const initial = await create(),
      second = await connect();
    const results = await Promise.all([
      call("set_text", {
        path: initial.path,
        expectedHash: initial.hash,
        id: "api",
        text: "Writer A",
      }),
      call(
        "set_text",
        {
          path: initial.path,
          expectedHash: initial.hash,
          id: "api",
          text: "Writer B",
        },
        second,
      ),
    ]);
    expect(results.filter((result) => !result.isError)).toHaveLength(1);
    expect(results.find((result) => result.isError)).toMatchObject({
      data: { code: "conflict" },
    });
  });

  it("shares the native desktop compare-and-save lock across processes", async () => {
    const original = await fs.save(
      "race.excalidraw",
      JSON.stringify(emptyScene()),
      null,
    );
    const writes = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        fs.save(
          "race.excalidraw",
          JSON.stringify({ ...emptyScene(), writer: index }),
          original.hash,
        ),
      ),
    );
    expect(
      writes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      writes.filter((result) => result.status === "rejected"),
    ).toHaveLength(7);
    expect(
      parseScene((await fs.read("race.excalidraw")).content).writer,
    ).toBeTypeOf("number");
  });

  it("batch failures leave exact bytes and mtime unchanged; successful batches commit together", async () => {
    const original = await create(),
      before = await fs.read(original.path);
    expect(
      await call("save_diagram", {
        path: original.path,
        expectedHash: original.hash,
        operations: [
          { op: "move", id: "api", x: 700, y: 20 },
          { op: "delete", id: "missing" },
        ],
      }),
    ).toMatchObject({ isError: true });
    expect(await fs.read(original.path)).toEqual(before);
    const result = await call("save_diagram", {
      path: original.path,
      expectedHash: original.hash,
      operations: [
        { op: "move", id: "api", x: 700, y: 20 },
        { op: "set_text", id: "db", text: "PostgreSQL" },
      ],
    });
    expect(result.isError).toBe(false);
    const elements = returned.parse(result.data).elements;
    expect(elements.find((item) => item.id === "api")).toMatchObject({
      x: 700,
      y: 20,
    });
    expect(elements.find((item) => item.id === "db")).toMatchObject({
      text: "PostgreSQL",
    });
  });

  it("rejects traversal, absolute paths, hidden files, symlinks, and malformed arguments", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "excalidraw-outside-")));
    try {
      await symlink(outside, join(root, "linked"));
      for (const path of [
        "../escape.excalidraw",
        join(outside, "absolute.excalidraw"),
        "linked/escape.excalidraw",
        ".hidden.excalidraw",
      ]) {
        expect(await call("create_diagram", { path })).toMatchObject({
          isError: true,
          data: { code: "path" },
        });
      }
      expect(await call("list_files", { path: "linked" })).toMatchObject({
        isError: true,
      });
      expect(
        await call("create_diagram", { path: "not-a-drawing.txt" }),
      ).toMatchObject({ isError: true });
      expect(
        await call("move_element", {
          path: "a.excalidraw",
          id: "api",
          x: 0,
          y: 0,
        }),
      ).toMatchObject({ isError: true });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("preserves assets/metadata and lists only supported files", async () => {
    await mkdir(join(root, "architecture"));
    const content = JSON.stringify({
      ...emptyScene(),
      source: "existing",
      custom: { keep: true },
      files: { image: { dataURL: "data:image/png;base64,AAAA" } },
    });
    await writeFile(join(root, "architecture/assets.excalidraw"), content);
    await writeFile(join(root, "architecture/notes.md"), "not a diagram");
    const original = await fs.read("architecture/assets.excalidraw");
    const result = await call("add_element", {
      path: "architecture/assets.excalidraw",
      expectedHash: original.hash,
      element: {
        id: "title",
        type: "text",
        x: 20,
        y: 20,
        text: "Assets preserved",
      },
    });
    expect(result.isError).toBe(false);
    const after = parseScene(
      (await fs.read("architecture/assets.excalidraw")).content,
    );
    expect(after.files).toEqual(parseScene(content).files);
    expect(after.custom).toEqual({ keep: true });
    const listed = await call("list_files", { path: "architecture" });
    expect(JSON.stringify(listed.data)).toContain("assets.excalidraw");
    expect(JSON.stringify(listed.data)).not.toContain("notes.md");
  });
});
