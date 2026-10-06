# Local Excalidraw

A macOS app for editing and organizing ordinary `.excalidraw` files. Your drawings stay in folders you choose. No account or hosted backend is required.


## Features

- **Local files:** browse folders, create, rename, move, and trash drawings.
- **Workspaces and tabs:** open folders in separate windows and restore them after a normal quit.
- **Autosave and recovery:** keep local recovery copies and resolve conflicts with external edits.
- **Excalidraw editor:** draw, export images, follow links, and fit all content in view.
- **YouTube embeds:** play embedded videos inside drawings.
- **Read-only sharing:** view saved drawings from another device on your local network.
- **Optional MCP and Codex integration:** create and edit diagrams with tools, then preview saved changes in a live browser panel.

## Install

Requires an Apple Silicon Mac running macOS 12 or later.

```sh
brew install --cask yaowang908/tap/local-excalidraw
```

You can also download the app from [GitHub Releases](https://github.com/yaowang908/local-excalidraw/releases).

The app is ad-hoc signed but not notarized. If macOS blocks the first launch, open it once, then choose **Open Anyway** in **System Settings → Privacy & Security** if you trust the download. See [Apple’s guidance](https://support.apple.com/en-gb/102445).

Alternatively, after extracting the download and moving **Local Excalidraw.app** to `/Applications`, use Terminal to clear its extended attributes and launch it if you trust the download:

```sh
xattr -cr "/Applications/Local Excalidraw.app"
open "/Applications/Local Excalidraw.app"
```

## Get started

Open a workspace folder, select a drawing, or choose **New drawing**. Changes save automatically. The status **Saved locally** confirms a local save; your cloud provider handles syncing.

See the [usage guide](docs/usage.md) for recovery, conflict handling, and sharing. See [MCP setup](apps/mcp/README.md) for tool access and Codex previews; the MCP server and plugin require a source checkout.

## Development

Build instructions, checks, and the release process are in [the development guide](docs/development.md).
