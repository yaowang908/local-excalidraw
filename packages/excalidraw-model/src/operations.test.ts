import { describe, expect, it } from "vitest";
import { emptyScene, parseScene } from "./index.ts";
import {
  applyOperations,
  describeScene,
  type Operation,
} from "./operations.ts";

const nodes: Operation[] = [
  {
    op: "add",
    element: { id: "api", type: "rectangle", x: 100, y: 100, text: "API" },
  },
  {
    op: "add",
    element: { id: "redis", type: "ellipse", x: 400, y: 300, text: "Redis" },
  },
];
const connected = () =>
  applyOperations(emptyScene(), [
    ...nodes,
    {
      op: "connect",
      id: "request",
      from: "api",
      to: "redis",
      label: "INCR + TTL",
    },
  ]);

describe("semantic editing", () => {
  it("style-only changes preserve existing label metrics from other fonts", () => {
    const scene = connected();
    scene.elements = scene.elements.map((item) =>
      item.type === "text"
        ? { ...item, fontFamily: 2, width: 123, height: 27 }
        : item,
    );
    const updated = applyOperations(scene, [
      { op: "update", id: "api", changes: { style: { strokeColor: "#f00" } } },
    ]);
    expect(updated.elements.find((item) => item.id === "api-label")).toEqual(
      scene.elements.find((item) => item.id === "api-label"),
    );
  });
  it("creates portable shapes and labels with stable semantic IDs", () => {
    const scene = connected();
    expect(parseScene(JSON.stringify(scene))).toEqual(scene);
    expect(describeScene(scene)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "api", text: "API", type: "rectangle" }),
        expect.objectContaining({
          id: "request",
          from: "api",
          to: "redis",
          text: "INCR + TTL",
        }),
      ]),
    );
    expect(describeScene(scene)).toHaveLength(3);
    const api = scene.elements.find((item) => item.id === "api");
    expect(api?.customData).toEqual({ semanticId: "api" });
    expect(api?.boundElements).toContainEqual({ id: "request", type: "arrow" });
    expect(scene.elements.find((item) => item.id === "request")).toMatchObject({
      startBinding: { elementId: "api" },
      endBinding: { elementId: "redis" },
    });
  });

  it("moves/resizes nodes together with bound text and connectors", () => {
    const before = connected();
    const after = applyOperations(before, [
      { op: "move", id: "redis", x: 700, y: 100 },
      { op: "resize", id: "api", width: 250, height: 140 },
    ]);
    const arrow = after.elements.find((item) => item.id === "request");
    expect(arrow).toMatchObject({
      startBinding: { elementId: "api" },
      endBinding: { elementId: "redis" },
    });
    expect(arrow?.x).toBeGreaterThan(350);
    expect(arrow?.x).toBeLessThanOrEqual(358);
    const label = after.elements.find((item) => item.id === "redis-label");
    expect(label?.x).toBeGreaterThan(700);
    expect(before.elements.find((item) => item.id === "redis")?.x).toBe(400);
    expect(arrow?.version).toBeGreaterThan(
      before.elements.find((item) => item.id === "request")?.version ?? 0,
    );
  });

  it("preserves unknown metadata, assets, and untouched elements", () => {
    const scene = parseScene(
      JSON.stringify({
        ...connected(),
        source: "foreign",
        metadata: { owner: "user" },
        files: { embedded: { dataURL: "data:image/png;base64,AAAA" } },
      }),
    );
    const original = scene.elements[0];
    if (!original) throw new Error("Missing fixture");
    scene.elements = [
      { ...original, customData: { semanticId: "api", custom: "preserve" } },
      ...scene.elements.slice(1),
    ];
    const after = applyOperations(scene, [
      {
        op: "update",
        id: "api",
        changes: { style: { backgroundColor: "#d3f9d8" } },
      },
    ]);
    expect(after.files).toEqual(scene.files);
    expect(after.metadata).toEqual(scene.metadata);
    expect(after.source).toBe("foreign");
    expect(after.elements[0]?.customData).toEqual({
      semanticId: "api",
      custom: "preserve",
    });
    expect(after.elements.find((item) => item.id === "redis")).toEqual(
      scene.elements.find((item) => item.id === "redis"),
    );
  });

  it("rejects duplicate IDs, missing elements and invalid batches without changing input", () => {
    const scene = connected(),
      original = JSON.stringify(scene);
    expect(() => applyOperations(scene, nodes)).toThrow("already exists");
    expect(() =>
      applyOperations(scene, [
        { op: "move", id: "api", x: 20, y: 20 },
        { op: "delete", id: "missing" },
      ]),
    ).toThrow("not found");
    expect(JSON.stringify(scene)).toBe(original);
    expect(() =>
      applyOperations(scene, [
        { op: "resize", id: "api", width: -1, height: 30 },
      ]),
    ).toThrow();
    expect(() =>
      applyOperations(scene, [
        { op: "connect", id: "self", from: "api", to: "api" },
      ]),
    ).toThrow("Self");
  });

  it("deletion removes labels and dangling bindings but retains unrelated connectors", () => {
    const after = applyOperations(connected(), [{ op: "delete", id: "api" }]);
    expect(describeScene(after).map((item) => item.id)).toEqual([
      "redis",
      "request",
    ]);
    expect(
      after.elements.find((item) => item.id === "api-label")?.isDeleted,
    ).toBe(true);
    expect(after.elements.find((item) => item.id === "request")).toMatchObject({
      startBinding: null,
      endBinding: { elementId: "redis" },
    });
    expect(() => applyOperations(after, [nodes[0] as Operation])).toThrow(
      "already exists",
    );
    const noArrow = applyOperations(after, [{ op: "delete", id: "request" }]);
    expect(
      noArrow.elements.find((item) => item.id === "redis")?.boundElements,
    ).not.toContainEqual({ id: "request", type: "arrow" });
  });

  it("sets and wraps text without replacing element IDs", () => {
    const scene = applyOperations(connected(), [
      {
        op: "set_text",
        id: "api",
        text: "A much longer API server name\n第二行",
      },
    ]);
    expect(describeScene(scene).find((item) => item.id === "api")?.text).toBe(
      "A much longer API server name\n第二行",
    );
    expect(
      scene.elements.find((item) => item.id === "api-label"),
    ).toMatchObject({ containerId: "api", fontFamily: 3 });
    const standalone = applyOperations(scene, [
      {
        op: "add",
        element: { id: "title", type: "text", x: 0, y: 0, text: "Title" },
      },
      { op: "set_text", id: "title", text: "Changed" },
    ]);
    expect(
      describeScene(standalone).find((item) => item.id === "title")?.text,
    ).toBe("Changed");
  });

  it("groups attached labels, preserves nested groups, and ungroups only the requested group", () => {
    const grouped = applyOperations(connected(), [
      { op: "group", ids: ["api", "redis"], groupId: "services" },
      { op: "group", ids: ["api", "redis", "request"], groupId: "system" },
      { op: "ungroup", groupId: "system" },
    ]);
    expect(
      grouped.elements.find((item) => item.id === "api-label")?.groupIds,
    ).toEqual(["services"]);
    expect(
      grouped.elements.find((item) => item.id === "request")?.groupIds,
    ).toEqual([]);
  });

  it("does not revise unchanged elements and handles empty scenes", () => {
    expect(describeScene(emptyScene())).toEqual([]);
    const scene = connected();
    expect(
      applyOperations(scene, [{ op: "update", id: "api", changes: {} }]),
    ).toEqual(scene);
    expect(
      applyOperations(scene, [{ op: "set_text", id: "api", text: "API" }]),
    ).toEqual(scene);
  });

  it("rejects locked nodes and unsupported bound geometry instead of damaging it", () => {
    const scene = connected();
    scene.elements = scene.elements.map((item) =>
      item.id === "api" ? { ...item, locked: true } : item,
    );
    expect(() =>
      applyOperations(scene, [{ op: "move", id: "api", x: 0, y: 0 }]),
    ).toThrow("locked");
    expect(() =>
      applyOperations(scene, [{ op: "move", id: "request", x: 0, y: 0 }]),
    ).toThrow("connected nodes");
  });

  it("keeps long labels inside their shape and supports text resizing", () => {
    const scene = applyOperations(emptyScene(), [
      {
        op: "add",
        element: {
          id: "box",
          type: "diamond",
          x: 0,
          y: 0,
          width: 100,
          height: 60,
          text: "A long label that needs more space",
        },
      },
      {
        op: "add",
        element: { id: "text", type: "text", x: 0, y: 200, text: "Title" },
      },
      { op: "resize", id: "text", width: 120, height: 50 },
    ]);
    const box = scene.elements.find((item) => item.id === "box");
    const label = scene.elements.find((item) => item.id === "box-label");
    expect(label?.height ?? Infinity).toBeLessThanOrEqual(
      (box?.height ?? 0) / 2 - 20,
    );
    expect(scene.elements.find((item) => item.id === "text")).toMatchObject({
      fontSize: 40,
      width: 120,
      height: 50,
    });
  });

  it("reads existing drawings with stale bindings without failing the whole diagram", () => {
    const scene = connected();
    scene.elements = scene.elements.filter(
      (item) => item.id !== "api" && item.id !== "api-label",
    );
    expect(
      describeScene(scene).find((item) => item.id === "request"),
    ).toMatchObject({ from: "api", to: "redis" });
  });
});
