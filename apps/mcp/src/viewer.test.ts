import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyScene } from "@local-excalidraw/model";
import { WorkspaceFs } from "./filesystem.ts";
import { DiagramViewer } from "./viewer.ts";

let root: string;
let assets: string;
let fs: WorkspaceFs;
let viewer: DiagramViewer;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "excalidraw-preview-test-")));
  assets = join(root, "web");
  await mkdir(join(assets, "assets"), { recursive: true });
  await writeFile(join(assets, "index.html"), '<script src="/assets/main.js"></script>');
  await writeFile(join(assets, "assets/main.js"), "export {};");
  fs = new WorkspaceFs(root);
  await fs.save("system.excalidraw", JSON.stringify(emptyScene()), null);
  viewer = new DiagramViewer(fs, assets);
});
afterEach(async () => {
  viewer.close();
  await rm(root, { recursive: true, force: true });
});

describe("loopback drawing preview", () => {
  it("shares the listener across concurrent previews and serves token-scoped assets", async () => {
    const previews = await Promise.all([viewer.preview("system.excalidraw"), viewer.preview("system.excalidraw")]);
    expect(previews[0]).toEqual(previews[1]);
    const preview = previews[0];
    if (!preview) throw new Error("Missing preview");
    const url = new URL(preview.url);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.searchParams.get("panel")).toBe("1");
    const response = await fetch(url);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toContain(`${url.pathname}assets/main.js`);
    expect((await fetch(new URL(`${url.pathname}assets/main.js`, url))).status).toBe(200);
  });

  it("serves full scenes and detects revisions without writing files", async () => {
    const { url } = await viewer.preview("system.excalidraw");
    const endpoint = new URL("api/file?path=system.excalidraw", url);
    const first = await fetch(endpoint);
    const hash = first.headers.get("etag");
    expect(await first.json()).toEqual(emptyScene());
    if (!hash) throw new Error("Missing ETag");
    expect((await fetch(endpoint, { headers: { "If-None-Match": hash } })).status).toBe(304);
    const snapshot = await fs.read("system.excalidraw");
    const next = emptyScene();
    next.appState.viewBackgroundColor = "#eeeeee";
    await fs.save("system.excalidraw", JSON.stringify(next), snapshot.hash);
    const changed = await fetch(endpoint, { headers: { "If-None-Match": hash } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(hash);
    expect(await changed.json()).toEqual(next);
  });

  it("rejects missing files, traversal, foreign origins, hosts, unscoped requests and writes", async () => {
    await expect(viewer.preview("missing.excalidraw")).rejects.toThrow();
    await expect(viewer.preview("../system.excalidraw")).rejects.toThrow();
    const { url } = await viewer.preview("system.excalidraw");
    expect((await fetch(new URL("/", url))).status).toBe(403);
    expect((await fetch(url, { method: "POST" })).status).toBe(403);
    expect((await fetch(url, { headers: { Origin: "https://example.com" } })).status).toBe(403);
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(url, { headers: { Host: "example.com" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject);
    });
    expect(hostStatus).toBe(403);
    expect((await fetch(new URL("api/file?path=../system.excalidraw", url))).status).toBe(400);
    expect((await fetch(new URL("api/file?path=missing.excalidraw", url))).status).toBe(400);
  });

  it("does not start a listener if the connection closes during a preview request", async () => {
    const pending = viewer.preview("system.excalidraw");
    viewer.close();
    await expect(pending).rejects.toThrow("connection is closed");
    await expect(viewer.preview("system.excalidraw")).rejects.toThrow("connection is closed");
  });

  it("reports missing build assets and can retry after they become available", async () => {
    viewer.close();
    const missingAssets = join(root, "missing-web");
    viewer = new DiagramViewer(fs, missingAssets);
    await expect(viewer.preview("system.excalidraw")).rejects.toThrow("npm run build");
    await mkdir(missingAssets);
    await writeFile(join(missingAssets, "index.html"), "viewer");
    const { url } = await viewer.preview("system.excalidraw");
    expect(await (await fetch(url)).text()).toBe("viewer");
    viewer.close();
    await expect(fetch(url)).rejects.toThrow();
  });
});
