import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

/** Portable Excalidraw document, including extension fields owned by other tools. */
export interface Scene {
  type: "excalidraw";
  version: number;
  source: string;
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
  [key: string]: unknown;
}

/** Narrow JSON objects without weakening callers' type checking. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse portable scenes; reject malformed input before it reaches the editor. */
export function parseScene(content: string): Scene {
  const value: unknown = JSON.parse(content);
  if (
    !isRecord(value) ||
    value.type !== "excalidraw" ||
    !Array.isArray(value.elements)
  ) {
    throw new Error("This file is not an Excalidraw drawing.");
  }
  const ids = new Set<string>();
  const supported = new Set([
    "rectangle",
    "ellipse",
    "diamond",
    "text",
    "arrow",
    "line",
    "freedraw",
    "image",
    "frame",
    "magicframe",
    "embeddable",
    "iframe",
  ]);
  for (const element of value.elements) {
    if (
      !isRecord(element) ||
      typeof element.id !== "string" ||
      !element.id ||
      ids.has(element.id) ||
      typeof element.type !== "string" ||
      !supported.has(element.type) ||
      ![element.x, element.y, element.width, element.height].every(
        (v) => typeof v === "number" && Number.isFinite(v),
      )
    ) {
      throw new Error("The drawing contains an invalid or duplicate element.");
    }
    ids.add(element.id);
  }
  if (value.appState !== undefined && !isRecord(value.appState))
    throw new Error("Invalid drawing appState.");
  if (value.files !== undefined && !isRecord(value.files))
    throw new Error("Invalid embedded image data.");
  return {
    ...value,
    version: typeof value.version === "number" ? value.version : 2,
    source:
      typeof value.source === "string" ? value.source : "local-excalidraw",
    appState: value.appState ?? {},
    files: value.files ?? {},
  } as Scene;
}

/** A standard empty drawing that can also be opened in excalidraw.com. */
export function emptyScene(): Scene {
  return {
    type: "excalidraw",
    version: 2,
    source: "local-excalidraw",
    elements: [],
    appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
    files: {},
  };
}

/** Stable comparison independent of object-key ordering and formatting. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!isRecord(item)) return item;
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [key, item[key]]),
    );
  });
}

/** Preserve document metadata and embedded assets when the editor emits a scene. */
export function mergeEditorScene(original: Scene, serialized: string): string {
  const edited = parseScene(serialized);
  return JSON.stringify(
    {
      ...original,
      ...edited,
      source: original.source,
      files: { ...original.files, ...edited.files },
    },
    null,
    2,
  );
}
