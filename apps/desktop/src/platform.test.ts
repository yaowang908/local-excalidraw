import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("platform detection", () => {
  const originalNavigator = global.navigator;

  function mockNavigator(platform: string): void {
    Object.defineProperty(global, "navigator", {
      value: { platform },
      writable: true,
      configurable: true,
    });
  }

  afterEach(() => {
    Object.defineProperty(global, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
    vi.resetModules();
  });

  describe("on macOS", () => {
    beforeEach(() => {
      mockNavigator("MacIntel");
    });

    it("detects mac platform and returns mac-specific modifier key", async () => {
      const { isMac, modifierKey, shiftModifierKey } = await import("./platform");
      expect(isMac).toBe(true);
      expect(modifierKey()).toBe("⌘");
      expect(shiftModifierKey()).toBe("⇧⌘");
    });

    it("returns mac-specific folder chooser prompt", async () => {
      const { folderChooserPrompt } = await import("./platform");
      expect(folderChooserPrompt()).toContain("on your Mac");
    });

    it("returns Finder for reveal label", async () => {
      const { revealLabel } = await import("./platform");
      expect(revealLabel()).toBe("Reveal in Finder");
    });

    it("returns macOS trash descriptions", async () => {
      const { trashDescription } = await import("./platform");
      expect(trashDescription(true)).toContain("macOS Trash");
      expect(trashDescription(false)).toContain("macOS Trash");
    });
  });

  describe("on Linux", () => {
    beforeEach(() => {
      mockNavigator("Linux x86_64");
    });

    it("detects linux platform and returns Ctrl modifier key", async () => {
      const { isMac, modifierKey, shiftModifierKey } = await import("./platform");
      expect(isMac).toBe(false);
      expect(modifierKey()).toBe("Ctrl+");
      expect(shiftModifierKey()).toBe("Ctrl+Shift+");
    });

    it("returns generic folder chooser prompt", async () => {
      const { folderChooserPrompt } = await import("./platform");
      expect(folderChooserPrompt()).toContain("on your computer");
      expect(folderChooserPrompt()).not.toContain("Mac");
    });

    it("returns Files for reveal label", async () => {
      const { revealLabel } = await import("./platform");
      expect(revealLabel()).toBe("Show in Files");
    });

    it("returns generic trash descriptions without macOS", async () => {
      const { trashDescription } = await import("./platform");
      expect(trashDescription(true)).not.toContain("macOS");
      expect(trashDescription(false)).not.toContain("macOS");
      expect(trashDescription(true)).toContain("trash");
      expect(trashDescription(false)).toContain("trash");
    });
  });

  describe("on Windows", () => {
    beforeEach(() => {
      mockNavigator("Win32");
    });

    it("detects windows platform and returns Ctrl modifier key", async () => {
      const { isMac, modifierKey } = await import("./platform");
      expect(isMac).toBe(false);
      expect(modifierKey()).toBe("Ctrl+");
    });

    it("returns Explorer for reveal label", async () => {
      const { revealLabel } = await import("./platform");
      expect(revealLabel()).toBe("Show in Explorer");
    });
  });

  describe("on unknown platform", () => {
    beforeEach(() => {
      mockNavigator("Unknown");
    });

    it("falls back to non-mac defaults", async () => {
      const { isMac, modifierKey, revealLabel } = await import("./platform");
      expect(isMac).toBe(false);
      expect(modifierKey()).toBe("Ctrl+");
      expect(revealLabel()).toBe("Show in File Manager");
    });
  });
});
