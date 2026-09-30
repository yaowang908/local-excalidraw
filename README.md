# Local Excalidraw

A macOS desktop workspace for ordinary `.excalidraw` files. Built with Tauri 2,
React, TypeScript, and the official Excalidraw editor. Files are the source of
truth; there is no database, account, or hosted backend.

<img width="1441" height="960" alt="CleanShot 2026-09-30 at 00 04 56" src="https://github.com/user-attachments/assets/993501dd-28ca-47ca-a969-8e0b2cd52f08" />


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
Opening another folder keeps the current workspace in its own window and opens
the new folder in another window. Choosing a folder already open focuses that
window. Open windows and their tabs return after a normal app quit; closing one
window removes it from the next launch.
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

## Read-only viewing on another device

Open a folder and click **Start** under Read-only viewer in the file sidebar.
The app then starts an HTTP viewer on its private LAN address at port 43871,
or an available port if that one is occupied, and shows its full URL. Open it
on a device on the same local network. **Stop** closes the viewer, as does
closing its window. Each start creates a fresh access path; treat
the URL as a private link. If the Mac has no private LAN address, the app shows
an error instead of opening a listener on every interface. Stop and start the
viewer after switching networks to get an address for the new connection. In
desktop development mode, restart the dev command after changing the viewer
page so its served assets are rebuilt.

Each window's viewer lists and reads only `.excalidraw` drawings inside its own
folder. Folder access uses the same path checks as desktop reads, so parent
traversal, hidden files, and symlinks are excluded.
The server has no edit route and does not expose local recovery files. It serves
the last saved file contents, not an unsaved canvas. Requests to slow cloud files
return a retryable unavailable response instead of blocking the app.

This is plain HTTP for a trusted local network. Anyone with the URL and network
access can view the selected drawings while the app runs; do not forward the
link or expose the port to the internet. The viewer stops when the app quits.

## Editing and conflicts

- Each tab keeps its own canvas, viewport, selection, and undo history in memory.
- Autosave runs 750 ms after document content stops changing. Selection, pan,
  zoom, and initial scene restoration do not rewrite an untouched file.
- Closing a tab or window, and a normal quit flush pending saves.
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
| Cmd+O       | Open workspace in a window                              |
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
prevention. Cloud sync clients and other devices do not honor the local lock.
The desktop preserves the last app-written drawing and any pending save under
`~/Library/Application Support/app.local-excalidraw.desktop/recovery/`, outside
the chosen workspace. It compares these checkpoints with the workspace file on
restart and asks which version to use when they differ. A dirty incoming change
also gets a create-only sibling drawing before the original can be replaced.
Resolved versions are removed or replaced; recovery records use an OS lock so
multiple desktop processes cannot race while updating them.

The desktop lists the workspace root first and loads subfolders when expanded.
Native events and paced checks re-read open drawings and visible folders without
content-scanning the whole tree. Slow provider operations run outside the app's
workspace state lock and return a retryable error after 15 seconds. A timed-out
write may still finish later; its checkpoint remains until the file is read
again. macOS File Provider paths under `~/Library/CloudStorage` or
`~/Library/Mobile Documents` use coordinated reads and replacements. Other sync
folders use ordinary filesystem I/O with the same local checkpoint and conflict
handling. A local save does not confirm cloud upload or remote acceptance.

The native write primitive accepts a retry with identical bytes without another
write. MCP requires a current hash and does not automatically retry semantic
operations; after an uncertain result, re-read and reconcile before retrying.
Stable IDs and create-only writes prevent duplicate creation or replacement.
A crash during replacement leaves either the old or new complete
file; a hidden temporary file can remain after an abrupt process kill. Changes
within the autosave debounce window can still be lost before a checkpoint is
written. A file provider that never returns may keep a background I/O worker
occupied; the desktop limits these workers and remains available for other files.

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
