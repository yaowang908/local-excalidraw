import { randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse, type IncomingMessage } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceError, WorkspaceFs } from "./filesystem.ts";

const defaultAssets = fileURLToPath(new URL("../../desktop/dist/", import.meta.url));
const mime: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png",
};

/** Read-only loopback preview, scoped to one workspace and a random access URL. */
export class DiagramViewer {
  private server: Server | undefined;
  private closed = false;
  private starting: Promise<string> | undefined;
  private readonly prefix = `/view/${randomBytes(24).toString("hex")}/`;

  private readonly fs: WorkspaceFs;
  private readonly assets: string;

  constructor(fs: WorkspaceFs, assets = defaultAssets) {
    this.fs = fs;
    this.assets = assets;
  }

  /** Validate the drawing and lazily start the viewer; concurrent calls share one listener. */
  async preview(path: string): Promise<{ path: string; url: string }> {
    if (this.closed) throw new Error("Preview connection is closed");
    await this.fs.read(path);
    if (this.closed) throw new Error("Preview connection is closed");
    if (!this.starting) {
      this.starting = this.start().catch((error: unknown) => {
        this.starting = undefined;
        throw error;
      });
    }
    const origin = await this.starting;
    return { path, url: `${origin}${this.prefix}?${new URLSearchParams({ path, panel: "1", live: "1" })}` };
  }

  /** Stop previews when the MCP connection closes. */
  close(): void {
    this.closed = true;
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = undefined;
    this.starting = undefined;
  }

  private async start(): Promise<string> {
    try {
      await readFile(resolve(this.assets, "index.html"));
    } catch (error) {
      throw new Error(`Viewer assets unavailable; run npm run build. ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.closed) throw new Error("Preview connection is closed");
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          response.writeHead(error instanceof WorkspaceError ? 400 : 500, { "Content-Type": "text/plain" });
          response.end(`Cannot load preview: ${error instanceof Error ? error.message : String(error)}`);
        } else response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (this.closed) {
      server.close();
      throw new Error("Preview connection is closed");
    }
    server.unref();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Viewer has no TCP address");
    server.on("error", (error) => process.stderr.write(`Local Excalidraw viewer failed: ${error.message}\n`));
    return `http://127.0.0.1:${address.port}`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const address = this.server?.address();
    if (!address || typeof address === "string" || request.headers.host !== `127.0.0.1:${address.port}`) {
      response.writeHead(403).end("Invalid viewer host");
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (request.method !== "GET" || !url.pathname.startsWith(this.prefix) ||
      (request.headers.origin && request.headers.origin !== url.origin)) {
      response.writeHead(403).end("Preview access denied");
      return;
    }
    const route = url.pathname.slice(this.prefix.length);
    if (route === "api/file") {
      const path = url.searchParams.get("path") ?? "";
      const snapshot = await this.fs.read(path);
      response.setHeader("ETag", `"${snapshot.hash}"`);
      if (request.headers["if-none-match"] === `"${snapshot.hash}"`) {
        response.writeHead(304).end();
      } else response.writeHead(200, { "Content-Type": "application/json" }).end(snapshot.content);
      return;
    }
    if (route && !route.startsWith("assets/") && !route.startsWith("excalidraw-assets/")) {
      response.writeHead(404).end("Asset unavailable");
      return;
    }
    const root = await realpath(this.assets);
    const target = await realpath(resolve(root, decodeURIComponent(route || "index.html")));
    if (!target.startsWith(`${root}${sep}`)) {
      response.writeHead(404).end("Asset unavailable");
      return;
    }
    let body: Buffer | string = await readFile(target);
    if (extname(target) === ".css") body = body.toString().replaceAll("/assets/", `${this.prefix}assets/`);
    if (!route) body = body.toString().replaceAll('"/assets/', `"${this.prefix}assets/`);
    response.writeHead(200, { "Content-Type": mime[extname(target)] ?? "application/octet-stream" }).end(body);
  }
}
