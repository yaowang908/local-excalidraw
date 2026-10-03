# Using Local Excalidraw

## Folders and drawings

Open a workspace folder and expand folders in the sidebar to browse drawings. Use **New drawing** or **New folder** to create entries. Each entry’s actions menu supports renaming, moving, and moving to Trash. Drawings remain ordinary files in the selected folder.

Open several drawings as tabs, or open another workspace in its own window. Open windows and tabs return after a normal quit. **Fit content** brings the whole drawing into view. Drawing links open in your default browser; YouTube embeds can play inside the canvas and need an internet connection. Other embedded frame hosts are blocked.

## Saving and recovery

The app autosaves and keeps recovery copies outside the workspace. Clean tabs reload external changes. When an incoming revision conflicts with local edits, the app preserves versions and offers **Use incoming**, **Make mine primary**, **Open incoming**, **Keep both**, **Retry read**, and **Save mine as…**. Read the conflict message before choosing a version.

**Saved locally** confirms a local save, not a completed OneDrive or other cloud upload. If a cloud-only drawing is unavailable, let the provider download it or make it available offline. Do not replace an unavailable drawing with an empty file.

Desktop and MCP writes share advisory locks, content-hash checks, and atomic replacement. A crash during replacement leaves an old or new complete drawing; an uncertain write response requires a fresh read before retrying. Other apps and cloud clients do not honor those locks and can still race a save. Recovery and lock waits use monotonic timeouts; wall-clock timestamps do not determine write order.

## Read-only sharing on your network

Start **Read-only viewer** in the sidebar and open its URL on another device on your local network. It serves saved drawings from that window’s workspace. Unsaved edits are not included. Stop the viewer in the sidebar, or quit the app, to end access.

Treat the URL as private: anyone with the URL and network access can view the workspace’s drawings.

## MCP and Codex previews

The optional MCP server can edit saved drawings while the desktop app is closed. Its `preview_diagram` tool returns a local read-only browser URL for one drawing. The panel refreshes saved revisions about every two seconds while preserving pan and zoom, and stops when the MCP connection closes.

The desktop LAN viewer and MCP loopback preview are separate. See [MCP setup and tool details](../apps/mcp/README.md) for builds, connection settings, write limits, and preview instructions.

The [Codex plugin](../plugins/local-excalidraw/) includes the editing skill and MCP configuration. Its checked-in configuration is personal: update the Node executable, source checkout, and drawing workspace paths before using it on another machine. The installed macOS app does not bundle the MCP server.
