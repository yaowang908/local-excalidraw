# Development and releases

## Build from source

### macOS

Requirements: Apple Silicon Mac, Xcode Command Line Tools, Node.js 22.12+ or 24, and Rust 1.89+. The MCP server requires Node.js 24+.

From the repository root:

```sh
npm ci
npm run desktop
```

`npm run dev` starts a browser preview; native file access requires the desktop app. To build a local app bundle:

```sh
npm run bundle
open "apps/desktop/src-tauri/target/release/bundle/macos/Local Excalidraw.app"
```

### Linux

Requirements: A recent Linux distribution (tested on Ubuntu 22.04+), Node.js 22.12+ or 24, and Rust 1.89+.

Install Tauri dependencies:

```sh
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-ugly gstreamer1.0-libav patchelf
```

The GStreamer and patchelf packages are required for bundling the AppImage with media framework support (YouTube embeds). The AppImage bundles GStreamer so it plays embedded media without requiring host libraries.

Build and run:

```sh
npm ci
npm run desktop
```

To build Linux packages (AppImage and .deb):

```sh
npm run bundle
# Output:
#   apps/desktop/src-tauri/target/release/bundle/appimage/Local Excalidraw_<version>_amd64.AppImage
#   apps/desktop/src-tauri/target/release/bundle/deb/local-excalidraw_<version>_amd64.deb
```

For MCP setup, build the native helper with `npm run build:mcp` and the browser viewer with `npm run build`. See [the MCP guide](../apps/mcp/README.md).

## Checks

```sh
npm run typecheck
npm test
npm run test:rust
npm run build
npm run test:e2e
```

Browser and viewer tests need localhost listeners. Rust tests exercise the native filesystem, macOS coordination, recovery, and viewer lifecycle; browser tests run the real editor with a simulated native IPC boundary.

The repository read-allowlist integration test runs real shell commands through
an installed Codex CLI, without calling a model. Run it separately:

```sh
LOCAL_EXCALIDRAW_TEST_CODEX=/absolute/path/to/codex \
  cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml \
  installed_cli_enforces_the_repository_read_allowlist -- --ignored
```

The README screenshot uses sample drawings with sharing disabled. Regenerate it
with `npm run test:e2e -- --grep 'captures the README sample'`, inspect
`output/playwright/readme-sample.png`, then copy it to `docs/assets/workspace.png`.

## Release process

1. Prepare a PR with the changes, documentation, and next version. Keep the root and workspace package versions, local model dependency versions, Tauri app version, and plugin version aligned. Regenerate the npm lockfile after updating package metadata.
2. Run the checks and merge the approved PR into `main`.
3. Tag the merged commit as `v<version>` and push that tag. [The release workflow](../.github/workflows/release.yml) verifies the root version, builds on both macOS and Linux, ad-hoc signs the macOS app, verifies its signature, and publishes all assets to GitHub Releases.
4. Verify the workflow and release assets, then edit the generated release notes to describe the user-visible changes. The macOS release is Apple Silicon only and is not notarized. Linux releases include AppImage and .deb packages for x86_64.
5. Download the published macOS ZIP and calculate its SHA-256. Update `Casks/local-excalidraw.rb` in [yaowang908/homebrew-tap](https://github.com/yaowang908/homebrew-tap) with that version and checksum. Validate the cask and submit a tap PR. Homebrew picks up the change after that PR is merged.

Use the checksum of the published asset, because a locally built archive can differ. If a workflow or upload fails, inspect the existing tag, run, and release before retrying; do not overwrite published tags or assets blindly.
