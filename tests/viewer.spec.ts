import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";

const revision = z.object({ hash: z.string() });
const preview = z.object({ url: z.string() });

test("MCP preview renders in a narrow panel, refreshes saved edits and stops on disconnect", async ({ page }) => {
  const root = await mkdtemp("/private/tmp/excalidraw-panel-test-");
  const client = new Client({ name: "panel-test", version: "1.0.0" });
  const errors: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().endsWith("favicon.ico")) errors.push(`${response.status()}: ${response.url()}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [resolve("apps/mcp/src/index.ts"), "--workspace", root],
    }));
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const result = await client.callTool({ name, arguments: args });
      const first = result.content[0];
      if (result.isError || !first || first.type !== "text") throw new Error(`Tool ${name} failed: ${JSON.stringify(result.content)}`);
      return JSON.parse(first.text) as unknown;
    };
    const created = revision.parse(await call("create_diagram", {
      path: "panel.excalidraw",
      elements: [
        { id: "api", type: "rectangle", x: 100, y: 100, text: "API" },
        { id: "cache", type: "ellipse", x: 570, y: 100, text: "Redis" },
      ],
      operations: [{ op: "connect", id: "lookup", from: "api", to: "cache", label: "Cache lookup" }],
    }));
    const { url } = preview.parse(await call("preview_diagram", { path: "panel.excalidraw" }));
    await page.setViewportSize({ width: 620, height: 760 });
    await page.goto(url);
    await expect(page.locator(".excalidraw__canvas.interactive")).toBeVisible();
    await expect(page.locator(".viewer-sidebar")).toHaveCount(0);
    await expect(page.locator(".viewer-main")).toHaveCSS("height", "760px");
    const canvas = page.locator(".excalidraw__canvas.static");
    const before = await canvas.screenshot();
    await call("set_text", { path: "panel.excalidraw", expectedHash: created.hash, id: "api", text: "Gateway" });
    await expect.poll(async () => (await canvas.screenshot()).equals(before), { timeout: 10_000 }).toBe(false);
    await page.screenshot({ path: "/private/tmp/local-excalidraw-panel.png" });
    expect(errors).toEqual([]);
    await client.close();
    await expect.poll(async () => {
      try { await fetch(url); return false; } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return true;
      }
    }).toBe(true);
    await expect(page.getByRole("alert")).toContainText("Preview unavailable");
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
