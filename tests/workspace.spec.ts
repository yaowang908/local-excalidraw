import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

type TestScene = {
  type: string;
  version: number;
  source: string;
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
};
type TestRecoveryVersion = {
  content: string;
  hash: string;
  baseHash: string | null;
};
declare global {
  interface Window {
    testWorkspace: {
      files: Record<string, string>;
      saves: string[];
      embedBase: string;
      embedError: string | null;
      external: (path: string, scene: TestScene) => void;
      codexRequests: { command: string; args: Record<string, unknown> }[];
      codexEvent: (message: Record<string, unknown>) => void;
    };
  }
}

const initial: TestScene = {
  type: "excalidraw",
  version: 2,
  source: "fixture",
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
  elements: [
    {
      id: "api",
      type: "rectangle",
      x: 200,
      y: 200,
      width: 200,
      height: 110,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "#dbe4ff",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 3 },
      seed: 12,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
    },
  ],
};

// The browser runs the real editor and document controller. Only the native IPC
// boundary is simulated; native disk, locks, and OS watcher are covered by cargo test.
test.beforeEach(async ({ page }) => {
  await page.addInitScript((scene) => {
    Object.defineProperty(window, "isTauri", { value: true });
    const files: Record<string, string> = {
      "architecture/api.excalidraw": JSON.stringify(scene),
      "scratch.excalidraw": JSON.stringify({ ...scene, elements: [] }),
    };
    const folders = new Set(["architecture"]);
    const recoveries = new Map<string, {
      written: TestRecoveryVersion | null;
      pending: TestRecoveryVersion | null;
    }>();
    const callbacks = new Map<number, (payload: unknown) => void>();
    const listeners = new Map<string, number[]>();
    const codexRequests: { command: string; args: Record<string, unknown> }[] = [];
    const codexTools = new Map<number, { path: string }>();
    let callbackId = 0;
    const hash = (content: string) => content;
    const snapshot = (path: string) => {
      const content = files[path];
      if (content === undefined)
        throw { code: "missing", message: "File removed" };
      return { content, hash: hash(content), modifiedAt: 1 };
    };
    const emit = () => {
      for (const id of listeners.get("workspace-changed") ?? [])
        callbacks.get(id)?.({
          event: "workspace-changed",
          payload: { root: "/workspace", error: null },
        });
    };
    type Entry = {
      path: string;
      name: string;
      kind: string;
      children: Entry[];
    };
    const tree = (directory = ""): Entry[] => {
      const children: Entry[] = [];
      for (const path of [...folders, ...Object.keys(files)]) {
        const parent = path.includes("/")
          ? path.slice(0, path.lastIndexOf("/"))
          : "";
        if (parent !== directory) continue;
        children.push({
          path,
          name: path.split("/").pop() ?? path,
          kind: folders.has(path) ? "folder" : "drawing",
          children: [],
        });
      }
      return children;
    };
    window.testWorkspace = {
      files,
      saves: [],
      embedBase: "https://www.youtube.com/embed",
      embedError: null,
      external: (path, value) => {
        files[path] = JSON.stringify(value);
        emit();
      },
      codexRequests,
      codexEvent: (message) => {
        if (message.method === "item/tool/call") {
          const params = message.params as { arguments: { path: string } };
          codexTools.set(Number(message.id), { path: params.arguments.path });
        }
        for (const id of listeners.get("codex-event") ?? [])
          callbacks.get(id)?.({ event: "codex-event", payload: { sessionId: "codex-session", message } });
      },
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main", windowLabel: "main" },
        },
        transformCallback: (callback: (payload: unknown) => void) => {
          const id = ++callbackId;
          callbacks.set(id, callback);
          return id;
        },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          const path = String(args.path ?? "");
          if (command.startsWith("codex_")) {
            codexRequests.push({ command, args });
            if (command === "codex_start") return { sessionId: "codex-session", threadId: "codex-thread", turns: [] };
            if (command === "codex_read_tool") return snapshot(codexTools.get(Number(args.requestId))?.path ?? "");
            if (command === "codex_write_tool") {
              const target = codexTools.get(Number(args.requestId))?.path ?? "";
              files[target] = String(args.content);
              emit();
              return snapshot(target);
            }
            return;
          }
          if (command === "load_preferences")
            return {
              workspacePath: "/workspace",
              openTabs: [],
              activeTab: null,
            };
          if (command === "viewer_url") return null;
          if (command === "read_recovery")
            return { root: "/workspace", path, written: null, pending: null, ...recoveries.get(path) };
          if (command === "checkpoint_document") {
            const content = String(args.content);
            const pending = {
              content,
              hash: hash(content),
              baseHash: typeof args.baseHash === "string" ? args.baseHash : null,
            };
            recoveries.set(path, { written: recoveries.get(path)?.written ?? null, pending });
            return pending.hash;
          }
          if (command === "accept_external") {
            const disk = snapshot(path);
            recoveries.set(path, {
              written: { content: disk.content, hash: disk.hash, baseHash: disk.hash },
              pending: null,
            });
            return;
          }
          if (command === "youtube_embed_base") {
            if (window.testWorkspace.embedError)
              throw new Error(window.testWorkspace.embedError);
            return window.testWorkspace.embedBase;
          }
          if (
            command === "save_preferences" ||
            command === "reveal_entry" ||
            command === "exit_app"
          )
            return;
          if (command === "open_workspace" || command === "plugin:dialog|open")
            return "/workspace";
          if (command === "list_entries") return tree(args.path == null ? "" : path);
          if (command === "read_document") return snapshot(path);
          if (command === "save_document") {
            const existing = files[path];
            if (
              (existing === undefined ? null : hash(existing)) !==
              args.expectedHash
            )
              throw { code: "conflict", message: "File changed externally" };
            files[path] = String(args.content);
            const content = files[path];
            const pending = recoveries.get(path)?.pending ?? null;
            recoveries.set(path, {
              written: { content, hash: hash(content), baseHash: typeof args.expectedHash === "string" ? args.expectedHash : null },
              pending: pending?.hash === hash(content) ? null : pending,
            });
            window.testWorkspace.saves.push(path);
            emit();
            return snapshot(path);
          }
          if (command === "create_folder") {
            folders.add(path);
            emit();
            return;
          }
          if (command === "move_entry") {
            const from = String(args.from);
            const to = String(args.to);
            for (const key of Object.keys(files))
              if (key === from || key.startsWith(`${from}/`)) {
                files[to + key.slice(from.length)] = String(files[key]);
                delete files[key];
              }
            for (const key of [...folders])
              if (key === from || key.startsWith(`${from}/`)) {
                folders.add(to + key.slice(from.length));
                folders.delete(key);
              }
            emit();
            return;
          }
          if (command === "trash_entry") {
            delete files[path];
            emit();
            return;
          }
          if (command === "plugin:event|listen") {
            const event = String(args.event);
            const id = Number(args.handler);
            listeners.set(event, [...(listeners.get(event) ?? []), id]);
            return id;
          }
          if (command === "plugin:event|unlisten") return;
          throw new Error(`Unhandled test command: ${command}`);
        },
      },
    });
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
      value: {
        unregisterListener: (_event: string, id: number) =>
          callbacks.delete(id),
      },
    });
  }, initial);
  await page.goto("/");
  await page.getByRole("button", { name: "architecture", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "api", exact: true }),
  ).toBeVisible();
});

async function openApi(page: Page) {
  await page.getByRole("button", { name: "api", exact: true }).click();
  await expect(
    page.locator(".canvas-pane:not([hidden]) canvas.interactive"),
  ).toBeVisible();
  await expect(
    page.getByText("Saved locally", { exact: true }),
  ).toBeVisible();
}

async function drawRectangle(page: Page) {
  const canvas = page.locator(".canvas-pane:not([hidden]) canvas.interactive");
  await canvas.click({ position: { x: 600, y: 450 } });
  await page.keyboard.press("r");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas has no bounds");
  await page.mouse.move(bounds.x + 590, bounds.y + 430);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 730, bounds.y + 520, { steps: 5 });
  await page.mouse.up();
}

test("fits drawing content from the top-right button and hides Library", async ({ page }) => {
  await openApi(page);
  const editor = page.locator(".canvas-pane:not([hidden])");
  await expect(editor.locator(".default-sidebar-trigger")).toBeHidden();
  const fit = editor.getByRole("button", { name: "Fit content", exact: true });
  await expect(fit).toBeVisible();
  await fit.click();
  const zoom = editor.locator(".reset-zoom-button");
  const fittedZoom = await zoom.innerText();
  await editor.getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect(zoom).not.toHaveText(fittedZoom);
  await fit.click();
  await expect(zoom).toHaveText(fittedZoom);
});

test("renders native YouTube embeds with an HTTP Referer under the desktop frame policy", async ({
  page,
}) => {
  // Only the native HTTP boundary is simulated; Rust tests exercise the actual listener.
  const server = createServer((request, response) => {
    const id = request.url?.split("/").pop() ?? "";
    response.writeHead(200, {
      "Content-Type": "text/html",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    response.end(
      `<iframe title="YouTube video player" src="https://www.youtube.com/embed/${id}"></iframe>`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test player address");
    const origin = `http://127.0.0.1:${address.port}`;
    await page.evaluate((base) => {
      window.testWorkspace.embedBase = base;
    }, `${origin}/fixture`);
    const config = JSON.parse(
      await readFile(resolve("apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
    ) as { app: { security: { csp: string } } };
    await page.evaluate((csp) => {
      const policy = document.createElement("meta");
      policy.httpEquiv = "Content-Security-Policy";
      policy.content = csp;
      document.head.append(policy);
    }, config.app.security.csp);

    const referrers: string[] = [];
    await page.route("https://www.youtube.com/embed/**", (route) => {
      referrers.push(route.request().headers().referer ?? "");
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>YouTube fixture</title><button>Play video</button>",
      });
    });
    const links = [
      "https://www.youtube.com/watch?v=gJrjgg1KVL4",
      "https://youtu.be/qw--VYLpxG4?si=aDfMJrqFoZM0WDB1",
      "https://vimeo.com/123456789",
      "https://example.com/video",
    ];
    const scene: TestScene = {
      ...initial,
      elements: links.map((link, index) => ({
        ...initial.elements[0],
        id: `embed-${index}`,
        type: "embeddable",
        x: 100 + (index % 2) * 450,
        y: 100 + Math.floor(index / 2) * 280,
        width: 400,
        height: 225,
        link,
      })),
    };
    await page.evaluate((scene) => {
      window.testWorkspace.external("architecture/api.excalidraw", scene);
    }, scene);
    await openApi(page);

    for (const id of ["gJrjgg1KVL4", "qw--VYLpxG4"]) {
      const frame = page
        .frameLocator(`iframe[src="${origin}/fixture/${id}"]`)
        .frameLocator(`iframe[src="https://www.youtube.com/embed/${id}"]`);
      await expect(frame.getByRole("button", { name: "Play video" })).toBeVisible();
    }
    await expect(page.locator(".canvas-pane iframe")).toHaveCount(2);
    expect(referrers).toEqual([`${origin}/`, `${origin}/`]);
    expect(await page.evaluate(() => window.testWorkspace.saves)).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("reports player setup failure while keeping the drawing editable", async ({
  page,
}) => {
  await page.evaluate(
    (scene) => {
      window.testWorkspace.embedError = "Player listener unavailable";
      window.testWorkspace.external("architecture/api.excalidraw", scene);
    },
    {
      ...initial,
      elements: [{
        ...initial.elements[0],
        type: "embeddable",
        width: 400,
        height: 225,
        link: "https://youtu.be/QkdkLdMBuL0",
      }],
    },
  );
  await openApi(page);
  await expect(page.getByRole("alert")).toHaveText(
    "Could not load YouTube player: Player listener unavailable",
  );
  await drawRectangle(page);
  await expect
    .poll(() => page.evaluate(() => window.testWorkspace.saves.length))
    .toBeGreaterThan(0);
});

test("loads an MCP-generated diagram in the real editor and preserves bindings after a canvas edit", async ({
  page,
}) => {
  const root = await mkdtemp("/private/tmp/excalidraw-render-test-");
  const client = new Client({ name: "browser-test", version: "1.0.0" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve("apps/mcp/src/index.ts"), "--workspace", root],
      }),
    );
    const result = await client.callTool({
      name: "create_diagram",
      arguments: {
        path: "architecture.excalidraw",
        elements: [
          {
            id: "browser",
            type: "rectangle",
            x: 100,
            y: 150,
            width: 180,
            height: 100,
            text: "Browser",
            style: { backgroundColor: "#dbe4ff" },
          },
          {
            id: "api",
            type: "rectangle",
            x: 400,
            y: 150,
            width: 180,
            height: 100,
            text: "API server",
            style: { backgroundColor: "#d3f9d8" },
          },
          {
            id: "db",
            type: "ellipse",
            x: 700,
            y: 150,
            width: 200,
            height: 100,
            text: "PostgreSQL",
            style: { backgroundColor: "#fff3bf" },
          },
        ],
        operations: [
          {
            op: "connect",
            id: "http",
            from: "browser",
            to: "api",
            label: "HTTPS",
          },
          { op: "connect", id: "sql", from: "api", to: "db", label: "SQL" },
        ],
      },
    });
    expect(result.isError).not.toBe(true);
    const scene = JSON.parse(
      await readFile(join(root, "architecture.excalidraw"), "utf8"),
    ) as TestScene;
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.evaluate(
      (scene) =>
        window.testWorkspace.external("architecture/api.excalidraw", scene),
      scene,
    );
    await openApi(page);
    await page.screenshot({ path: "output/playwright/mcp-diagram.png" });
    await drawRectangle(page);
    await expect
      .poll(() => page.evaluate(() => window.testWorkspace.saves.length))
      .toBe(1);
    const saved = await page.evaluate(
      () =>
        JSON.parse(
          window.testWorkspace.files["architecture/api.excalidraw"] ?? "{}",
        ) as TestScene,
    );
    expect(saved.elements.find((item) => item.id === "http")).toMatchObject({
      startBinding: { elementId: "browser" },
      endBinding: { elementId: "api" },
    });
    expect(
      saved.elements.find((item) => item.id === "api-label"),
    ).toMatchObject({ originalText: "API server", containerId: "api" });
    expect(saved.elements.filter((item) => !item.isDeleted)).toHaveLength(11);
    expect(pageErrors).toEqual([]);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("opens fixtures without rewriting, edits, autosaves, and keeps tab scenes", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await openApi(page);
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.testWorkspace.saves)).toEqual([]);
  await drawRectangle(page);
  await expect
    .poll(() => page.evaluate(() => window.testWorkspace.saves.length))
    .toBe(1);
  await page.getByRole("button", { name: "scratch", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "scratch", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "api", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(
          window.testWorkspace.files["architecture/api.excalidraw"] ?? "{}",
        ).elements.length,
    ),
  ).toBe(2);
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: "output/playwright/workspace.png" });
});

test("reloads clean external edits and protects dirty edits", async ({
  page,
}) => {
  await openApi(page);
  const canvas = page.locator(".canvas-pane:not([hidden]) canvas.static");
  const before = await canvas.screenshot();
  const external = { ...initial, appState: { viewBackgroundColor: "#f4fce3" } };
  await page.evaluate(
    (scene) =>
      window.testWorkspace.external("architecture/api.excalidraw", scene),
    external,
  );
  await expect.poll(async () => (await canvas.screenshot()).equals(before)).toBe(false);
  await drawRectangle(page);
  await page.evaluate(
    (scene) =>
      window.testWorkspace.external("architecture/api.excalidraw", scene),
    { ...external, appState: { viewBackgroundColor: "#fff4e6" } },
  );
  await expect(
    page.getByRole("region", { name: "File conflict" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Make mine primary", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "File conflict" }),
  ).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            window.testWorkspace.files["architecture/api.excalidraw"] ?? "{}",
          ).elements.length,
      ),
    )
    .toBe(2);
});

test("creates, renames, moves, and trashes drawings through reviewable dialogs", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "New drawing", exact: false })
    .first()
    .click();
  await page.getByLabel("Name", { exact: true }).fill("new-diagram");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "new-diagram", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Actions for new-diagram.excalidraw" })
    .click();
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  await page.getByLabel("Name", { exact: true }).fill("renamed.excalidraw");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "renamed", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Actions for renamed.excalidraw" })
    .click();
  await page.getByRole("menuitem", { name: "Move…", exact: true }).click();
  await page
    .getByLabel("Destination path")
    .fill("architecture/renamed.excalidraw");
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(window.testWorkspace.files["architecture/renamed.excalidraw"]),
      ),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "Actions for renamed.excalidraw" })
    .click();
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  await page
    .getByRole("button", { name: "Move to Trash", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "renamed", exact: true }),
  ).toBeHidden();
});

test("collapses and resizes the Codex panel without losing its session or draft", async ({ page }) => {
  await openApi(page);
  await page.getByRole("button", { name: "Toggle Codex panel" }).click();
  const panel = page.getByRole("complementary", { name: "Codex chat" });
  await expect(panel).toBeVisible();
  await expect(panel.getByTitle("architecture/api.excalidraw")).toBeVisible();
  await panel.getByRole("button", { name: "Start session", exact: true }).click();
  await expect(panel.getByText("Connected", { exact: true })).toBeVisible();
  await panel.getByLabel("Message Codex").fill("Draft remains here");
  const before = await panel.boundingBox();
  await panel.getByRole("separator", { name: "Resize Codex panel" }).focus();
  await page.keyboard.press("ArrowLeft");
  const after = await panel.boundingBox();
  expect(after?.width).toBe((before?.width ?? 0) + 20);
  await panel.getByRole("button", { name: "Collapse Codex panel" }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "Toggle Codex panel" }).click();
  await expect(panel.getByLabel("Message Codex")).toHaveValue("Draft remains here");
  expect(await page.evaluate(() => window.testWorkspace.codexRequests.filter((request) => request.command === "codex_start").length)).toBe(1);
  await page.screenshot({ path: "output/playwright/codex-panel.png" });
});

test("pins the sent drawing target and applies an agent edit while the panel is collapsed", async ({ page }) => {
  await openApi(page);
  await page.getByRole("button", { name: "Toggle Codex panel" }).click();
  const panel = page.getByRole("complementary", { name: "Codex chat" });
  await panel.getByLabel("Message Codex").fill("Add a worker node");
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect(panel.getByText("Working", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Collapse Codex panel" }).click();
  await page.getByRole("button", { name: "scratch", exact: true }).click();
  await page.evaluate(() => window.testWorkspace.codexEvent({
    id: 7, method: "item/tool/call", params: {
      threadId: "codex-thread", turnId: "turn", tool: "edit_diagram", arguments: {
        path: "architecture/api.excalidraw", expectedHash: window.testWorkspace.files["architecture/api.excalidraw"],
        operations: [{ op: "add", element: { id: "worker", type: "rectangle", x: 500, y: 200, text: "Worker" } }],
      },
    },
  }));
  await expect.poll(() => page.evaluate(() => JSON.parse(window.testWorkspace.files["architecture/api.excalidraw"] ?? "{}").elements.some((element: { id: string }) => element.id === "worker"))).toBe(true);
  await page.evaluate(() => {
    window.testWorkspace.codexEvent({ method: "item/agentMessage/delta", params: { threadId: "codex-thread", itemId: "answer", delta: "Added the worker node." } });
    window.testWorkspace.codexEvent({ method: "turn/completed", params: { threadId: "codex-thread", turn: { status: "completed" } } });
  });
  await page.getByRole("button", { name: "Toggle Codex panel" }).click();
  await expect(panel.getByText("Added the worker node.")).toBeVisible();
  await expect(panel.locator(".codex-message-user header")).toContainText("architecture/api.excalidraw");
  await expect(panel.getByRole("button", { name: "Allow drawing", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "Allow drawing", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Revoke access to scratch.excalidraw" })).toBeVisible();
  await page.getByRole("tab", { name: "api", exact: true }).click();
  await expect(page.getByRole("region", { name: "File conflict" })).toBeHidden();
  const requests = await page.evaluate(() => window.testWorkspace.codexRequests);
  expect(requests.find((request) => request.command === "codex_send")?.args.target).toBe("architecture/api.excalidraw");
  expect(requests.filter((request) => request.command === "codex_write_tool")).toHaveLength(1);
  await page.screenshot({ path: "output/playwright/codex-edited.png" });
});

test("requires drawing access and supports ending and resuming the local session", async ({ page }) => {
  await openApi(page);
  await page.getByRole("button", { name: "Toggle Codex panel" }).click();
  const panel = page.getByRole("complementary", { name: "Codex chat" });
  await panel.getByRole("button", { name: "Revoke access to architecture/api.excalidraw" }).click();
  await expect(panel.getByRole("button", { name: "Start session", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Allow drawing", exact: true }).click();
  await panel.getByRole("button", { name: "Start session", exact: true }).click();
  await panel.getByRole("button", { name: "End session", exact: true }).click();
  await panel.getByRole("button", { name: "Resume session", exact: true }).click();
  await expect(panel.getByText("Connected", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.testWorkspace.codexRequests.filter((request) => request.command === "codex_start").at(-1)?.args.threadId)).toBe("codex-thread");
});

test("preserves an unsent Codex draft when a drawing conflict blocks the turn", async ({ page }) => {
  await openApi(page);
  await drawRectangle(page);
  await page.evaluate((scene) => window.testWorkspace.external("architecture/api.excalidraw", scene),
    { ...initial, appState: { viewBackgroundColor: "#fff4e6" } });
  await expect(page.getByRole("region", { name: "File conflict" })).toBeVisible();
  await page.getByRole("button", { name: "Toggle Codex panel" }).click();
  const panel = page.getByRole("complementary", { name: "Codex chat" });
  await panel.getByLabel("Message Codex").fill("Keep this request");
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect(panel.getByRole("alert")).toContainText("Resolve the conflict");
  await expect(panel.getByLabel("Message Codex")).toHaveValue("Keep this request");
  expect(await page.evaluate(() => window.testWorkspace.codexRequests.some((request) => request.command === "codex_send"))).toBe(false);
});
