import { describe, expect, it } from "vitest";
import { canonical, emptyScene, mergeEditorScene, parseScene } from "./index";

describe("portable scenes", () => {
  it("round trips an empty standard drawing", () => {
    const scene = emptyScene();
    expect(parseScene(JSON.stringify(scene))).toEqual(scene);
  });
  it.each([
    "garbage",
    "null",
    "[]",
    '{"type":"other","elements":[]}',
    '{"type":"excalidraw","elements":[{}]}',
  ])("rejects malformed scenes: %s", (content) => {
    expect(() => parseScene(content)).toThrow();
  });
  it("rejects duplicated identities", () => {
    const element = {
      id: "a",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    };
    expect(() =>
      parseScene(
        JSON.stringify({ ...emptyScene(), elements: [element, element] }),
      ),
    ).toThrow("duplicate");
  });
  it("preserves unknown metadata and embedded assets when editing", () => {
    const original = parseScene(
      JSON.stringify({
        ...emptyScene(),
        source: "another-editor",
        metadata: { title: "Architecture" },
        files: { image: { dataURL: "data:image/png;base64,AAA" } },
      }),
    );
    const merged = parseScene(
      mergeEditorScene(original, JSON.stringify(emptyScene())),
    );
    expect(merged.source).toBe("another-editor");
    expect(merged.metadata).toEqual({ title: "Architecture" });
    expect(merged.files).toEqual(original.files);
  });
  it("ignores object-key order but preserves element order", () => {
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });
});
