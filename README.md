# Local Excalidraw

A macOS app for organizing and editing ordinary `.excalidraw` files in folders you choose. Your drawings stay in those folders; there is no account or hosted backend.

<img width="1441" height="960" alt="Local Excalidraw screenshot" src="https://github.com/user-attachments/assets/993501dd-28ca-47ca-a969-8e0b2cd52f08" />

## Install with Homebrew

```sh
brew install --cask yaowang908/tap/local-excalidraw
```

The app is currently distributed without Apple Developer signing or notarization. macOS may show a warning the first time you open it.

## Use the app

Open a workspace folder to see its drawings. Select a drawing to edit it; use **New drawing** to create one. You can open multiple folders, each in its own window. Open windows and tabs return after a normal quit.

The app autosaves drawings and keeps recovery copies outside the workspace. If an external change conflicts with unsaved work, it preserves both versions and lets you choose how to proceed. Cloud providers remain responsible for syncing; a local save does not mean the provider has uploaded it.

To view drawings on another device on your local network, start **Read-only viewer** in the sidebar. The viewer serves only drawings from that window’s workspace and stops when you stop it or quit the app. Treat its URL as private: anyone with the URL and network access can view those drawings. It does not serve unsaved edits.

YouTube links embedded in drawings can play in the app and require an internet connection. Other embedded frame hosts are blocked.

## Build from source

Requirements: Apple Silicon Mac, Xcode Command Line Tools, Node.js 22.12+ or 24, and Rust 1.89+.

```sh
npm ci
npm run desktop
```

To create a local app bundle:

```sh
npm run bundle
open "apps/desktop/src-tauri/target/release/bundle/macos/Local Excalidraw.app"
```

`npm run dev` starts a browser preview; native file access requires the desktop app.

## MCP server

The optional stdio MCP server can create and edit drawings in a workspace, including while the desktop app is closed. Node.js 24+ is required.

```sh
npm run build:mcp
npm run mcp -- --workspace /absolute/path/to/drawings
```

See [MCP setup and tool details](apps/mcp/README.md).

## Development checks

```sh
npm run typecheck
npm test
npm run test:rust
npm run build
```

Local locks coordinate saves between the desktop app and MCP server. Other apps and cloud sync clients do not honor those locks, so external edits can still race with a save. See [Excalidraw’s integration docs](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/integration) for editor details.
