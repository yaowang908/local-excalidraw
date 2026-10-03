# Local Excalidraw MCP

A local stdio server built with the official MCP TypeScript SDK. No API key, account, or hosted service is required. A read-only loopback HTTP
viewer starts only when `preview_diagram` is called. The configured workspace is the
only directory exposed by its tools. The desktop does not need to be running.

## Build and connect

From the repository root, with Node.js 24+ and Rust 1.89+ installed:

```sh
npm ci
npm run build:mcp
```

Register with Codex using absolute paths (substitute your own checkout and workspace):

```sh
codex mcp add local_excalidraw -- \
  /absolute/path/to/node \
  /absolute/path/to/Local-exclidraw/apps/mcp/src/index.ts \
  --workspace /absolute/path/to/drawings
codex mcp get local_excalidraw
```

Restart Codex after adding the server. The app and CLI share this configuration;
see the [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
Use an absolute Node executable path when a GUI launch does not inherit your
shell's `nvm` setup. Update that path if you remove the selected Node installation.

`npm run mcp -- --workspace /absolute/path/to/drawings` runs the server manually.
It waits for MCP messages on stdin. Only protocol messages go to stdout; errors
go to stderr. Rebuild with `npm run build:mcp` after changing native sources.

The filesystem binary lives at `packages/filesystem/target/release/excalidraw-fs`.
The server resolves it relative to its own source, so it works from any working
directory. Both it and the desktop use `packages/filesystem`, including the same
advisory lock, path checks, content hashes, fsync, and atomic rename implementation.

## Preview in Codex’s side panel

Build the browser viewer once (and rebuild after changing its source):

```sh
npm run build
```

After restarting the connected MCP server, ask Codex to preview a saved drawing.
Call `preview_diagram` with a workspace-relative `path`, then open the returned
`url` with Codex’s `open_in_codex` tool:

```json
{
  "target": { "type": "browser", "url": "<returned preview URL>" },
  "placement": "right"
}
```

The panel shows the Excalidraw canvas with pan and zoom. It polls saved revisions
about every two seconds and updates without resetting the viewport. Unsaved
changes in the desktop app are not shown. A read failure keeps the last displayed
scene and shows an error until the file becomes readable again.

The server binds only to `127.0.0.1` on a dynamically assigned port. The random
access URL is local to that MCP connection; closing or restarting the connection
stops the viewer and invalidates old URLs. Concurrent preview requests share the
listener. Reads use the same native workspace validation as the editing tools;
there are no HTTP write routes. This is a browser panel, rather than a registered
plugin file viewer or a new item in Codex’s Tools menu. It does not require the
desktop app to run.

## Tools

All diagram paths are relative to the configured root. Parent folders must exist;
create folders using the desktop. Reads return a SHA-256 `hash` and compact
elements; existing binary assets stay in the file, outside tool responses.

| Tool               | Input beyond `path`                                           | Behavior                                           |
| ------------------ | ------------------------------------------------------------- | -------------------------------------------------- |
| `list_files`       | Optional directory `path`                                     | Recursively list folders, drawings, libraries      |
| `preview_diagram`  | —                                                             | Return a live read-only local browser preview URL   |
| `read_diagram`     | —                                                             | Read simplified elements and current hash          |
| `get_elements`     | Optional `ids`, `type`                                        | Filter the simplified element view                 |
| `create_diagram`   | Optional `elements`, `operations`                             | Create-only atomic save; never overwrite           |
| `add_element`      | `expectedHash`, `element`                                     | Add a shape/text/line with a unique stable ID      |
| `update_element`   | `expectedHash`, `id`, `changes`                               | Set absolute geometry, text, or style              |
| `delete_element`   | `expectedHash`, `id`                                          | Tombstone element/label; detach connectors         |
| `connect_elements` | `expectedHash`, `id`, `from`, `to`, optional `label`, `style` | Create bound arrow and label                       |
| `move_element`     | `expectedHash`, `id`, `x`, `y`                                | Set position; update connected arrows              |
| `resize_element`   | `expectedHash`, `id`, `width`, `height`                       | Resize shape or text                               |
| `set_text`         | `expectedHash`, `id`, `text`                                  | Edit standalone text or container label            |
| `group_elements`   | `expectedHash`, `ids`, `groupId`                              | Add group membership including bound labels        |
| `ungroup_elements` | `expectedHash`, `groupId`                                     | Remove one group's membership                      |
| `save_diagram`     | `expectedHash`, optional `operations`                         | Commit a batch once; empty batch verifies revision |

Each mutation **saves immediately** and returns the next `hash`. There is no
unsaved MCP session state. Use `save_diagram` for multiple operations that must
commit together. No operation is written if any member of a batch fails.

### Atomic batch example

First call `read_diagram` with `{"path":"system.excalidraw"}`. Use its hash:

```json
{
  "path": "system.excalidraw",
  "expectedHash": "<hash returned by read_diagram>",
  "operations": [
    {
      "op": "add",
      "element": {
        "id": "redis",
        "type": "ellipse",
        "x": 460,
        "y": 420,
        "width": 200,
        "height": 110,
        "text": "Redis",
        "style": { "backgroundColor": "#ffe3e3" }
      }
    },
    {
      "op": "connect",
      "id": "cache-write",
      "from": "api",
      "to": "redis",
      "label": "INCR + TTL"
    }
  ]
}
```

Supported batch operations: `add`, `update`, `delete`, `connect`, `move`, `resize`,
`set_text`, `group`, `ungroup`. Their fields match the corresponding tools above.
Individual tools omit the `op` field. Batches are capped at 500 operations.

## Safety and editing limits

- A hash mismatch returns an MCP error with `code: "conflict"`; it never silently
  retries or overwrites. Re-read and reconcile after a conflict, timeout, or
  disconnected response. A retry may conflict even if the first call succeeded.
- Create-only writes and caller-supplied stable IDs prevent duplicated creation.
  IDs remain reserved after deletion. Native element IDs also work on drawings
  without semantic metadata; ambiguous IDs produce an error.
- Scenes preserve unknown metadata, other element kinds, and embedded images.
  Editable kinds are rectangle, ellipse, diamond, text, arrow, and line.
- New labels use bundled monospace text. Text metrics are estimated without a
  browser; Excalidraw restores the exact font metrics when opened. Long labels
  wrap and can increase a container's height. Text resizing may wrap onto more lines.
- Connections bind to shapes or standalone text. Straight and ordinary polyline
  connectors follow moved nodes. Locked, rotated, or elbow connectors that would
  need geometry updates cause the edit to fail; adjust those in the desktop.
  Move connected nodes instead of directly moving their bound arrows.
- Existing images, frames, freehand strokes, and embeds remain intact, but their
  geometry is not editable through these semantic tools. PNG rendering is deferred.
- Internal symlinks, parent traversal, hidden paths, and absolute document paths
  are rejected. The native helper accepts at most 64 MiB per request, including
  serialized assets. This is a local workspace boundary, not a sandbox against a
  hostile process replacing directory components while I/O is in progress.
- Cooperative writes serialize under the shared lock. An unrelated writer that
  ignores it can race the final hash check and rename. Lock timeouts use a
  monotonic clock; wall-clock timestamps are only Excalidraw display metadata.
  Crash during commit leaves the old or new complete file; an abandoned hidden
  temporary file may remain. No edit journal or automatic rollback is maintained.

In the desktop, clean files reload automatically. Dirty files retain the local
buffer and show the existing conflict choices. Polling backs up native watcher
events, so updates normally appear within about two seconds if native events
are unavailable. Rebuilt unsigned macOS apps may need Downloads access granted
again in the macOS permission prompt.
