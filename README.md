# Local Excalidraw

A macOS desktop workspace for ordinary `.excalidraw` files. Built with Tauri 2,
React, TypeScript, and the official Excalidraw editor. Files are the source of
truth; there is no database, account, or hosted backend.

The desktop and a local MCP server edit the same files, with shared locking,
atomic saves, and conflict protection. PNG rendering, version history, and crash
recovery are deferred.

## Run

Requirements: Apple Silicon Mac, Xcode Command Line Tools, Node.js 22.12+ or 24,
and Rust 1.89+ (a current stable toolchain is recommended).

```sh
npm ci
npm run desktop
```

Choose **Open workspace** and select a directory. Existing drawings appear in
the sidebar. Click a drawing to open a tab; use **New drawing** to create one.
Right-click a file or folder, or use its `…` button, to rename, move, reveal in
Finder, or move to the macOS Trash. Move destinations are workspace-relative
paths, and their parent folder must already exist.

```sh
npm run bundle
open "apps/desktop/src-tauri/target/release/bundle/macos/Local Excalidraw.app"
```

The local build is not signed with an Apple Developer identity or notarized for
distribution. `npm run dev` runs a browser preview; native file access requires
`npm run desktop` or the built app.

## Editing and conflicts

- Each tab keeps its own canvas, viewport, selection, and undo history in memory.
- Autosave runs 750 ms after document content stops changing. Selection, pan,
  zoom, and initial scene restoration do not rewrite an untouched file.
- Closing a tab, switching workspaces, and a normal quit flush pending saves.
  An unresolved conflict or failed save prevents discarding the buffer.
- Clean drawings reload automatically when the disk hash changes. The status bar
  shows **Updated externally**. Native notifications are backed by a two-second
  content-polling watcher when the OS drops events. Polling reads workspace files,
  so choose a directory dedicated to drawings rather than an entire home folder.
- Dirty drawings retain their local buffer and offer **Reload external**,
  **Keep my version**, and **Save mine as…**. Keeping a version still checks the
  external hash; a second intervening write raises another conflict.
- External deletion or invalid JSON preserves the current canvas. Save it under
  a new name, explicitly keep it to recreate a deleted file, or repair the disk
  version and reload it.
- Embedded image data, element metadata, and unknown document-level fields are
  retained. `.excalidrawlib` entries import into an open drawing's library;
  library-file editing and persistence are not part of this milestone.

YouTube video embeddables render as players. Double-click a player to activate
it, then click **Play**. Watch, short-link, Shorts, and embed video URLs are
supported, including start times. Playback requires an internet connection.
The native app serves a small player wrapper on a random loopback port with a
per-launch URL token so YouTube receives an HTTP Referer. This endpoint serves
only player HTML, exposes no files or native commands, and closes with the app.
Requests are read-only and safe to retry; the port and URL change after a restart
without rewriting drawing links. Videos load directly from YouTube. Other frame
hosts remain blocked.

## Keyboard shortcuts

| Shortcut    | Action                                                  |
| ----------- | ------------------------------------------------------- |
| Cmd+O       | Open workspace                                          |
| Cmd+Shift+O | Open drawing; opens its parent as a workspace if needed |
| Cmd+N       | New drawing                                             |
| Cmd+Shift+N | New folder                                              |
| Cmd+S       | Save active drawing                                     |
| Cmd+W       | Save and close active tab                               |
| Cmd+B       | Toggle sidebar                                          |

Standard Excalidraw shortcuts remain available inside the active canvas.
The shell and editor follow the system light/dark appearance.

## Codex / MCP

The separate TypeScript stdio server exposes 14 semantic tools for creating,
reading, editing, connecting, and grouping diagram elements. It works while the
desktop is closed. Node.js **24+** is required for its native TypeScript support.

```sh
npm run build:mcp
npm run mcp -- --workspace /absolute/path/to/drawings
```

Codex launches the server itself; you do not need to keep that terminal running.
See [MCP setup and tool contracts](apps/mcp/README.md) for configuration and an
atomic editing example. The native helper must be rebuilt after filesystem-code
changes; no Rust toolchain is needed while an already-built server is running.

For the current checkout, `local_excalidraw` is registered in Codex against
`/Users/yaowang/Downloads/localExclidraw`. Restart Codex to load the new tools, then
try: “Use local_excalidraw to move Redis below PostgreSQL in mcp-demo.excalidraw.”

## Filesystem guarantees and limits

Native saves hold an exclusive advisory `flock` on
`<workspace>/.excalidraw-workspace.lock`, verify the SHA-256 hash of the current
file, write a temporary file in the same directory, sync it, check the hash
again, atomically rename, and sync the parent directory. Existing file permissions
are preserved. New drawings use a no-clobber operation.

The lock file is a persistent inode: **do not delete it while any writer is
running**. Desktop and MCP use the same Rust filesystem crate and OS-level
exclusive `flock` for their compare-and-save operation. MCP prepares its scene
from a snapshot, then verifies that snapshot's hash under the lock before commit.
A PID file or a lock on the
drawing itself is not equivalent. Locks are released by the OS on process exit;
the acquisition timeout uses a monotonic clock. Modification timestamps are
informational and are never used to decide whether a file changed.

Cooperating writers are serialized. An unrelated editor that ignores the lock
can still write between the final hash check and rename; ordinary filesystem
APIs do not provide compare-and-swap against arbitrary external writers. This
remaining race is an accepted limitation, not a guarantee of universal conflict
prevention. Use local storage; network shares and synchronization providers are
outside the locking guarantee.

The native write primitive accepts a retry with identical bytes without another
write. MCP requires a current hash and does not automatically retry semantic
operations; after an uncertain result, re-read and reconcile before retrying.
Stable IDs and create-only writes prevent duplicate creation or replacement.
A crash during replacement leaves either the old or new complete
file; a hidden temporary file can remain after an abrupt process kill. Changes
within the autosave debounce window can be lost on a force quit or crash because
recovery snapshots are deferred.

Workspace paths are canonicalized and checked by path components. Absolute
document paths, parent traversal, hidden paths, and symlinks inside the workspace
are rejected. The directory picker may select a symlinked root; it is resolved
once to its canonical directory. This protects normal workspace operations,
not a hostile local process actively replacing path components during I/O.

Only workspace location and tab paths are stored in
`~/Library/Application Support/app.local-excalidraw.desktop/preferences.json`.
Drawings are never stored in preferences or localStorage. Multiple app instances
share safe drawing locks but may replace each other's lightweight session
preferences; one desktop instance is recommended.

## Verify

```sh
npm run build:mcp
npm run typecheck
npm test
npm run test:rust
npx playwright install chromium
npm run test:e2e
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path packages/filesystem/Cargo.toml --all-targets -- -D warnings
npm run bundle
```

Vitest uses the official MCP client to spawn the actual stdio server and native
helper, covering all 14 tools, simultaneous writers, stale revisions, batch
rollback, path boundaries, and asset preservation. It also covers parsing,
semantic operations, metadata/asset preservation, document transitions,
debouncing, conflict choices, out-of-order reads, and edits made during saves,
reloads, and close. Rust tests use real temporary directories, concurrent writers,
atomic replacement, permissions, symlinks, and the OS file watcher. Playwright
runs the real Excalidraw UI (including an MCP-generated drawing) with a simulated
Tauri IPC boundary; it is not a native WebView driver. Native smoke checks also
exercised create, autosave, and external reload against a real workspace on
macOS. The MCP smoke check created Browser → API → PostgreSQL, opened it in the
native app, then added Redis and an INCR + TTL connection through MCP. The open
canvas reloaded automatically with the new elements and **Updated externally**.

Dependency overrides patch the Nano ID and lodash-es versions pulled in by
Excalidraw. Keep them until upstream pins compatible patched releases.

## Code map

```text
apps/desktop/src/
  App.tsx          Workspace, tabs, shortcuts, and conflict controls
  Canvas.tsx       Excalidraw integration and content serialization
  documents.ts    Editor-independent autosave and reconciliation state
  filesystem.ts   Small typed native filesystem boundary
apps/desktop/src-tauri/src/
  lib.rs          Native commands, watcher events, and preferences
apps/mcp/src/
  index.ts        Workspace-scoped stdio entrypoint
  server.ts       Semantic MCP tools and revision checks
  filesystem.ts   Typed bridge to the shared native filesystem binary
packages/filesystem/src/
  lib.rs          Canonical paths, flock, hashing, atomic saves, file operations
  watcher.rs      Native notifications and content polling fallback
  bin/            JSON stdin/stdout filesystem helper
packages/excalidraw-model/src/
  index.ts        Shared scene parsing, comparison, and preservation
  operations.ts   Semantic shapes, labels, connections, groups, and mutations
```

Design reference: [tyrchen/excaliapp](https://github.com/tyrchen/excaliapp).
This is an independent implementation of the supplied spec. Editor integration
follows [Excalidraw's documentation](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/integration).
The workspace symbol uses [Lucide](https://lucide.dev/), licensed under ISC.
