#!/usr/bin/env node
import { realpath, stat, access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { WorkspaceFs } from "./filesystem.ts";
import { createServer } from "./server.ts";

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--workspace" || !args[1])
    throw new Error("Usage: excalidraw-mcp --workspace <directory>");
  const root = await realpath(args[1]);
  if (!(await stat(root)).isDirectory())
    throw new Error("Workspace must be a directory.");
  await access(
    fileURLToPath(
      new URL(
        "../../../packages/filesystem/target/release/excalidraw-fs",
        import.meta.url,
      ),
    ),
    constants.X_OK,
  );
  serveStdio(() => createServer(new WorkspaceFs(root)));
} catch (error) {
  process.stderr.write(
    `Cannot start Local Excalidraw MCP: ${error instanceof Error ? error.message : String(error)}. Build first with npm run build:mcp.\n`,
  );
  process.exitCode = 1;
}
