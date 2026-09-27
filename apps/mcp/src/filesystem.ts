import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const binary = fileURLToPath(
  new URL(
    "../../../packages/filesystem/target/release/excalidraw-fs",
    import.meta.url,
  ),
);
const snapshotSchema = z.object({
  content: z.string(),
  hash: z.string(),
  modifiedAt: z.number(),
});

/** Exact bytes and revision returned by the shared native filesystem. */
export type Snapshot = z.infer<typeof snapshotSchema>;

/** An actionable filesystem failure, including optimistic concurrency conflicts. */
export class WorkspaceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

/** Workspace-scoped native I/O shared with the desktop, without a second lock implementation. */
export class WorkspaceFs {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  private async request(request: Record<string, unknown>): Promise<unknown> {
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > 64 * 1024 * 1024)
      throw new WorkspaceError("size", "Request exceeds 64 MiB.");
    return new Promise((resolve, reject) => {
      const child = execFile(
        binary,
        ["--workspace", this.root],
        {
          encoding: "utf8",
          maxBuffer: 128 * 1024 * 1024,
          timeout: 15_000,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new WorkspaceError(
                "io",
                `Native filesystem failed; run npm run build:mcp if missing. Re-read before retrying a write. ${error.message} ${stderr.trim()}`,
              ),
            );
            return;
          }
          try {
            const result = z
              .discriminatedUnion("ok", [
                z.object({ ok: z.literal(true), value: z.unknown() }),
                z.object({
                  ok: z.literal(false),
                  error: z.object({ code: z.string(), message: z.string() }),
                }),
              ])
              .parse(JSON.parse(stdout) as unknown);
            if (!result.ok)
              throw new WorkspaceError(result.error.code, result.error.message);
            resolve(result.value);
          } catch (error) {
            reject(error);
          }
        },
      );
      child.stdin?.on("error", (error: Error) =>
        reject(
          new WorkspaceError(
            "io",
            `Cannot send filesystem request: ${error.message}. Re-read before retrying.`,
          ),
        ),
      );
      child.stdin?.end(input);
    });
  }

  /** Recursively list supported files; native validation also applies to subdirectories. */
  async list(path = ""): Promise<unknown> {
    return this.request({ operation: "list", path });
  }

  /** Read a drawing without changing its formatting or modification time. */
  async read(path: string): Promise<Snapshot> {
    return snapshotSchema.parse(
      await this.request({ operation: "read", path }),
    );
  }

  /** Null means create-only; existing documents require their exact current SHA-256 hash. */
  async save(
    path: string,
    content: string,
    expectedHash: string | null,
  ): Promise<Snapshot> {
    return snapshotSchema.parse(
      await this.request({
        operation: "save",
        path,
        content,
        expected_hash: expectedHash,
      }),
    );
  }
}
