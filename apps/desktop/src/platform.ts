type Platform = "mac" | "linux" | "windows" | "other";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const platform = navigator.platform?.toLowerCase() ?? "";
  if (platform.includes("mac")) return "mac";
  if (platform.includes("linux")) return "linux";
  if (platform.includes("win")) return "windows";
  return "other";
}

const platform: Platform = detectPlatform();

export const isMac = platform === "mac";

export function modifierKey(): string {
  return isMac ? "⌘" : "Ctrl+";
}

export function shiftModifierKey(): string {
  return isMac ? "⇧⌘" : "Ctrl+Shift+";
}

export function folderChooserPrompt(): string {
  return isMac
    ? "Choose a folder on your Mac. Drawings stay as ordinary .excalidraw files, ready for any compatible editor."
    : "Choose a folder on your computer. Drawings stay as ordinary .excalidraw files, ready for any compatible editor.";
}

export function revealLabel(): string {
  if (isMac) return "Reveal in Finder";
  if (platform === "linux") return "Show in Files";
  if (platform === "windows") return "Show in Explorer";
  return "Show in File Manager";
}

export function trashDescription(isFolder: boolean): string {
  if (isMac) {
    return isFolder
      ? "The folder and all its contents will be moved to the macOS Trash."
      : "You can restore this drawing from the macOS Trash.";
  }
  return isFolder
    ? "The folder and all its contents will be moved to the trash."
    : "You can restore this drawing from the trash.";
}
