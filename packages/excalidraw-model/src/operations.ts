import { z } from "zod";
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  ExcalidrawLinearElement,
} from "@excalidraw/excalidraw/element/types";
import { canonical, type Scene } from "./index.ts";

const id = z.string().min(1).max(160);
const coordinate = z.number().min(-1_000_000).max(1_000_000);
const dimension = z.number().positive().max(100_000);
const text = z.string().max(20_000);
const types = [
  "rectangle",
  "ellipse",
  "diamond",
  "text",
  "arrow",
  "line",
] as const;

/** Editable visual properties; unknown fields are rejected rather than discarded. */
export const styleSchema = z.strictObject({
  strokeColor: z.string().max(100).optional(),
  backgroundColor: z.string().max(100).optional(),
  fillStyle: z.enum(["solid", "hachure", "cross-hatch", "zigzag"]).optional(),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  strokeWidth: z.number().min(0).max(20).optional(),
  roughness: z.number().min(0).max(3).optional(),
  opacity: z.number().min(0).max(100).optional(),
});

/** Stable semantic element description accepted by creation tools. */
export const nodeSchema = z.strictObject({
  id,
  type: z.enum(types),
  x: coordinate,
  y: coordinate,
  width: dimension.optional(),
  height: z.number().min(0).max(100_000).optional(),
  text: text.optional(),
  style: styleSchema.optional(),
});

/** Absolute updates are safe to repeat after re-reading the current revision. */
export const patchSchema = nodeSchema.omit({ id: true, type: true }).partial();

/** Operations that can be committed individually or together in one atomic save. */
export const operationSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), element: nodeSchema }),
  z.strictObject({ op: z.literal("update"), id, changes: patchSchema }),
  z.strictObject({ op: z.literal("delete"), id }),
  z.strictObject({
    op: z.literal("connect"),
    id,
    from: id,
    to: id,
    label: text.optional(),
    style: styleSchema.optional(),
  }),
  z.strictObject({ op: z.literal("move"), id, x: coordinate, y: coordinate }),
  z.strictObject({
    op: z.literal("resize"),
    id,
    width: dimension,
    height: dimension,
  }),
  z.strictObject({ op: z.literal("set_text"), id, text }),
  z.strictObject({
    op: z.literal("group"),
    ids: z.array(id).min(2).max(500),
    groupId: id,
  }),
  z.strictObject({ op: z.literal("ungroup"), groupId: id }),
]);

/** A validated semantic mutation of an Excalidraw scene. */
export type Operation = z.infer<typeof operationSchema>;
type Node = z.infer<typeof nodeSchema>;
type Patch = z.infer<typeof patchSchema>;
type Element = ExcalidrawElement;
type Point = [number, number];

function nonce(): number {
  return Math.floor(Math.random() * 2_147_483_646) + 1;
}

function semanticId(element: Element): string {
  const value: unknown = element.customData?.semanticId;
  return typeof value === "string" && value ? value : element.id;
}

function find(elements: readonly Element[], id: string): Element {
  const matches = elements.filter(
    (item) => !item.isDeleted && (item.id === id || semanticId(item) === id),
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? `Ambiguous element ID: ${id}`
        : `Element not found: ${id}`,
    );
  const element = matches[0];
  if (!element) throw new Error(`Element not found: ${id}`);
  return element;
}

function ensureUnused(elements: readonly Element[], id: string) {
  if (elements.some((item) => item.id === id || semanticId(item) === id))
    throw new Error(
      `Element ID already exists (including deleted elements): ${id}`,
    );
}

function editable(element: Element) {
  if (!types.some((type) => type === element.type))
    throw new Error(
      `Editing ${element.type} elements is not supported; existing data is preserved.`,
    );
  if (element.locked)
    throw new Error(`Element is locked: ${semanticId(element)}`);
  if (element.type === "text" && element.containerId)
    throw new Error("Edit the text container instead of its bound label.");
}

function replace(elements: Element[], updated: Element) {
  const index = elements.findIndex((item) => item.id === updated.id);
  if (index < 0) throw new Error(`Element disappeared: ${updated.id}`);
  const original = elements[index];
  if (!original) throw new Error(`Element disappeared: ${updated.id}`);
  if (canonical(original) === canonical(updated)) return;
  elements[index] = {
    ...updated,
    version: (original.version ?? 0) + 1,
    versionNonce: nonce(),
    updated: Date.now(),
  };
}

function base(node: Node) {
  return {
    id: node.id,
    x: node.x,
    y: node.y,
    width: node.width ?? 180,
    height: node.height ?? 100,
    angle: 0 as Element["angle"],
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid" as const,
    strokeWidth: 2,
    strokeStyle: "solid" as const,
    roundness: null,
    roughness: 1,
    opacity: 100,
    seed: nonce(),
    version: 1,
    versionNonce: nonce(),
    index: null,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    customData: { semanticId: node.id },
    ...node.style,
  };
}

// New text uses Excalidraw's bundled monospace font. Width estimates allow the
// desktop to restore font metrics without needing a browser in the MCP process.
function textMetrics(
  value: string,
  fontSize: number,
  maxWidth = 100_000,
  lineHeight = 1.25,
) {
  const lines: string[] = [];
  let widest = 0;
  for (const paragraph of value.replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    let width = 0;
    for (const character of paragraph) {
      const advance =
        fontSize * ((character.codePointAt(0) ?? 0) > 255 ? 1 : 0.6);
      if (line && width + advance > maxWidth) {
        lines.push(line);
        widest = Math.max(widest, width);
        line = "";
        width = 0;
      }
      line += character;
      width += advance;
    }
    lines.push(line);
    widest = Math.max(widest, width);
  }
  return {
    text: lines.join("\n"),
    width: Math.max(1, widest),
    height: Math.max(1, lines.length) * fontSize * lineHeight,
  };
}

function makeText(
  node: Node,
  containerId: string | null = null,
): ExcalidrawTextElement {
  const value = node.text ?? "";
  return {
    ...base(node),
    ...textMetrics(value, 20, node.width),
    type: "text",
    fontSize: 20,
    fontFamily: 3,
    originalText: value,
    textAlign: containerId ? "center" : "left",
    verticalAlign: containerId ? "middle" : "top",
    containerId,
    autoResize: node.width === undefined,
    lineHeight: 1.25 as ExcalidrawTextElement["lineHeight"],
  };
}

function linear(element: Element): element is ExcalidrawLinearElement {
  return element.type === "arrow" || element.type === "line";
}

function labelFor(
  elements: readonly Element[],
  element: Element,
): ExcalidrawTextElement | undefined {
  return elements.find(
    (item): item is ExcalidrawTextElement =>
      item.type === "text" &&
      !item.isDeleted &&
      item.containerId === element.id,
  );
}

function center(element: Element): Point {
  return [element.x + element.width / 2, element.y + element.height / 2];
}

function pointAtMiddle(element: Element): Point {
  if (!linear(element) || element.points.length < 2) return center(element);
  const left = element.points[Math.floor((element.points.length - 1) / 2)];
  const right = element.points[Math.ceil((element.points.length - 1) / 2)];
  if (!left || !right) return center(element);
  return [
    element.x + (left[0] + right[0]) / 2,
    element.y + (left[1] + right[1]) / 2,
  ];
}

function positionLabel(elements: Element[], container: Element) {
  const label = labelFor(elements, container);
  if (!label) return;
  if (label.locked) throw new Error(`Bound label is locked: ${label.id}`);
  const inset =
    container.type === "diamond" ? 0.5 : container.type === "ellipse" ? 0.7 : 1;
  const available = linear(container)
    ? 300
    : Math.max(20, container.width * inset - 20);
  const metrics = textMetrics(
    label.originalText ?? label.text,
    label.fontSize,
    available,
    label.lineHeight,
  );
  if (!linear(container)) {
    container = {
      ...container,
      width: Math.max(container.width, (metrics.width + 20) / inset),
      height: Math.max(container.height, (metrics.height + 20) / inset),
    };
    replace(elements, container);
  }
  const point = pointAtMiddle(container);
  replace(elements, {
    ...label,
    ...metrics,
    x: point[0] - metrics.width / 2,
    y: point[1] - metrics.height / 2,
    angle: container.angle,
    groupIds: container.groupIds,
    frameId: container.frameId,
  });
}

function setText(elements: Element[], element: Element, value: string) {
  if (element.type === "text") {
    replace(elements, {
      ...element,
      ...textMetrics(
        value,
        element.fontSize,
        element.autoResize ? undefined : element.width,
        element.lineHeight,
      ),
      originalText: value,
    });
    return;
  }
  if (!["rectangle", "ellipse", "diamond", "arrow"].includes(element.type))
    throw new Error(`Text labels are not supported on ${element.type}.`);
  const existing = labelFor(elements, element);
  if (existing) {
    if (existing.locked)
      throw new Error(`Bound label is locked: ${existing.id}`);
    replace(elements, { ...existing, originalText: value });
  } else if (value) {
    const labelId = `${element.id}-label`;
    ensureUnused(elements, labelId);
    elements.push(
      makeText(
        { id: labelId, type: "text", x: element.x, y: element.y, text: value },
        element.id,
      ),
    );
    replace(elements, {
      ...element,
      boundElements: [
        ...(element.boundElements ?? []),
        { id: labelId, type: "text" },
      ],
    });
  }
  positionLabel(elements, find(elements, element.id));
}

function add(elements: Element[], node: Node) {
  ensureUnused(elements, node.id);
  if (node.type !== "line" && node.type !== "arrow" && node.height === 0)
    throw new Error("Shapes must have positive height.");
  if (node.type === "text") elements.push(makeText(node));
  else if (node.type === "arrow" || node.type === "line") {
    const points = [
      [0, 0],
      [node.width ?? 180, node.height ?? 0],
    ] as unknown as ExcalidrawLinearElement["points"];
    elements.push({
      ...base(node),
      height: node.height ?? 0,
      type: node.type,
      points,
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: node.type === "arrow" ? "arrow" : null,
      ...(node.type === "arrow" ? { elbowed: false } : {}),
    });
  } else elements.push({ ...base(node), type: node.type });
  if (node.text !== undefined && node.type !== "text")
    setText(elements, find(elements, node.id), node.text);
}

function endpoint(element: Element, toward: Point, gap = 8): Point {
  const [cx, cy] = center(element);
  const cos = Math.cos(element.angle),
    sin = Math.sin(element.angle);
  const dx = (toward[0] - cx) * cos + (toward[1] - cy) * sin;
  const dy = -(toward[0] - cx) * sin + (toward[1] - cy) * cos;
  const length = Math.hypot(dx, dy);
  if (length < 0.001)
    throw new Error("Connected elements must have distinct centers.");
  const rx = Math.max(1, element.width / 2),
    ry = Math.max(1, element.height / 2);
  const scale =
    element.type === "ellipse"
      ? 1 / Math.hypot(dx / rx, dy / ry)
      : element.type === "diamond"
        ? 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry)
        : 1 / Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry);
  const x = dx * (scale + gap / length),
    y = dy * (scale + gap / length);
  return [cx + x * cos - y * sin, cy + x * sin + y * cos];
}

function setPoints(
  elements: Element[],
  element: ExcalidrawLinearElement,
  points: Point[],
) {
  const first = points[0];
  if (!first) throw new Error("A line must have points.");
  const xs = points.map((point) => point[0]),
    ys = points.map((point) => point[1]);
  replace(elements, {
    ...element,
    x: first[0],
    y: first[1],
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    points: points.map((point) => [
      point[0] - first[0],
      point[1] - first[1],
    ]) as unknown as ExcalidrawLinearElement["points"],
  });
}

function refreshConnections(elements: Element[], changedId: string) {
  for (const arrow of [...elements]) {
    if (
      arrow.isDeleted ||
      !linear(arrow) ||
      (arrow.startBinding?.elementId !== changedId &&
        arrow.endBinding?.elementId !== changedId)
    )
      continue;
    if (
      arrow.locked ||
      arrow.angle !== 0 ||
      ("elbowed" in arrow && arrow.elbowed)
    )
      throw new Error(
        `Cannot adjust locked, rotated, or elbow arrow ${semanticId(arrow)}. Move this element in the desktop editor.`,
      );
    const points: Point[] = arrow.points.map((point) => [
      arrow.x + point[0],
      arrow.y + point[1],
    ]);
    if (points.length < 2) throw new Error(`Invalid arrow points: ${arrow.id}`);
    const start = arrow.startBinding
      ? find(elements, arrow.startBinding.elementId)
      : undefined;
    const end = arrow.endBinding
      ? find(elements, arrow.endBinding.elementId)
      : undefined;
    const towardStart = points.length === 2 && end ? center(end) : points[1];
    const towardEnd =
      points.length === 2 && start ? center(start) : points[points.length - 2];
    if (start && towardStart) points[0] = endpoint(start, towardStart);
    if (end && towardEnd) points[points.length - 1] = endpoint(end, towardEnd);
    setPoints(
      elements,
      {
        ...arrow,
        startBinding: arrow.startBinding
          ? { ...arrow.startBinding, focus: 0, gap: 8 }
          : null,
        endBinding: arrow.endBinding
          ? { ...arrow.endBinding, focus: 0, gap: 8 }
          : null,
      },
      points,
    );
    positionLabel(elements, find(elements, arrow.id));
  }
}

function update(elements: Element[], id: string, patch: Patch) {
  const element = find(elements, id);
  editable(element);
  const geometry =
    patch.x !== undefined ||
    patch.y !== undefined ||
    patch.width !== undefined ||
    patch.height !== undefined;
  if (linear(element) && geometry) {
    if (
      element.startBinding ||
      element.endBinding ||
      element.angle !== 0 ||
      ("elbowed" in element && element.elbowed)
    )
      throw new Error(
        "Move or resize the connected nodes instead of a bound, rotated, or elbow arrow.",
      );
    const width = patch.width ?? element.width,
      height = patch.height ?? element.height;
    const originX = patch.x ?? element.x,
      originY = patch.y ?? element.y;
    if (
      (element.width === 0 && width !== 0) ||
      (element.height === 0 && height !== 0)
    )
      throw new Error(
        "Cannot expand a zero-sized line axis; recreate the line with the desired dimensions.",
      );
    setPoints(
      elements,
      element,
      element.points.map(([x, y]) => [
        originX + x * (element.width ? width / element.width : 1),
        originY + y * (element.height ? height / element.height : 1),
      ]),
    );
  } else if (
    element.type === "text" &&
    (patch.width !== undefined || patch.height !== undefined)
  ) {
    const fontSize =
      patch.height === undefined
        ? element.fontSize
        : (element.fontSize * patch.height) / Math.max(1, element.height);
    const width = patch.width ?? element.width;
    replace(elements, {
      ...element,
      ...textMetrics(
        element.originalText ?? element.text,
        fontSize,
        width,
        element.lineHeight,
      ),
      fontSize,
      width,
      autoResize: false,
      x: patch.x ?? element.x,
      y: patch.y ?? element.y,
    });
  } else {
    if (patch.height === 0)
      throw new Error("Shapes must have positive height.");
    replace(elements, {
      ...element,
      x: patch.x ?? element.x,
      y: patch.y ?? element.y,
      width: patch.width ?? element.width,
      height: patch.height ?? element.height,
    });
  }
  const latest = find(elements, id);
  if (patch.style) replace(elements, { ...latest, ...patch.style });
  if (patch.text !== undefined)
    setText(elements, find(elements, id), patch.text);
  else if (geometry) positionLabel(elements, find(elements, id));
  if (geometry || patch.text !== undefined)
    refreshConnections(elements, element.id);
}

function connect(
  elements: Element[],
  operation: Extract<Operation, { op: "connect" }>,
) {
  const from = find(elements, operation.from),
    to = find(elements, operation.to);
  for (const node of [from, to]) {
    editable(node);
    if (!["rectangle", "ellipse", "diamond", "text"].includes(node.type))
      throw new Error("Connections require shapes or standalone text.");
  }
  if (from.id === to.id) throw new Error("Self-connections are not supported.");
  const start = endpoint(from, center(to)),
    end = endpoint(to, center(from));
  add(elements, {
    id: operation.id,
    type: "arrow",
    x: start[0],
    y: start[1],
    style: operation.style,
  });
  const arrow = find(elements, operation.id);
  if (!linear(arrow)) throw new Error("Expected an arrow.");
  setPoints(
    elements,
    {
      ...arrow,
      startBinding: { elementId: from.id, focus: 0, gap: 8 },
      endBinding: { elementId: to.id, focus: 0, gap: 8 },
    },
    [start, end],
  );
  for (const node of [from, to])
    replace(elements, {
      ...node,
      boundElements: [
        ...(node.boundElements ?? []),
        { id: arrow.id, type: "arrow" },
      ],
    });
  if (operation.label !== undefined)
    setText(elements, find(elements, arrow.id), operation.label);
}

function remove(elements: Element[], id: string) {
  const element = find(elements, id);
  editable(element);
  const removed = new Set([element.id]);
  const label = labelFor(elements, element);
  if (label) removed.add(label.id);
  for (const item of [...elements]) {
    if (removed.has(item.id)) {
      if (item.locked) throw new Error(`Element is locked: ${item.id}`);
      replace(elements, { ...item, isDeleted: true, boundElements: null });
    } else if (!item.isDeleted) {
      const boundElements =
        item.boundElements?.filter((bound) => !removed.has(bound.id)) ?? null;
      const changed = { ...item, boundElements };
      if (linear(changed)) {
        replace(elements, {
          ...changed,
          startBinding:
            changed.startBinding && removed.has(changed.startBinding.elementId)
              ? null
              : changed.startBinding,
          endBinding:
            changed.endBinding && removed.has(changed.endBinding.elementId)
              ? null
              : changed.endBinding,
        });
      } else replace(elements, changed);
    }
  }
}

/** Apply a validated batch to a copy. Failure never leaves a partially edited input. */
export function applyOperations(
  scene: Scene,
  input: readonly Operation[],
): Scene {
  const operations = z.array(operationSchema).max(500).parse(input);
  const elements: Element[] = [...scene.elements];
  for (const operation of operations) {
    switch (operation.op) {
      case "add":
        add(elements, operation.element);
        break;
      case "update":
        update(elements, operation.id, operation.changes);
        break;
      case "delete":
        remove(elements, operation.id);
        break;
      case "connect":
        connect(elements, operation);
        break;
      case "move":
        update(elements, operation.id, { x: operation.x, y: operation.y });
        break;
      case "resize":
        update(elements, operation.id, {
          width: operation.width,
          height: operation.height,
        });
        break;
      case "set_text":
        update(elements, operation.id, { text: operation.text });
        break;
      case "group": {
        const selected = new Set<string>();
        const selectedNodes = new Set<string>();
        for (const id of operation.ids) {
          const item = find(elements, id);
          editable(item);
          selected.add(item.id);
          selectedNodes.add(item.id);
          const label = labelFor(elements, item);
          if (label) selected.add(label.id);
        }
        if (selectedNodes.size < 2)
          throw new Error("A group needs at least two distinct elements.");
        for (const item of [...elements])
          if (selected.has(item.id)) {
            if (item.locked) throw new Error(`Element is locked: ${item.id}`);
            replace(elements, {
              ...item,
              groupIds: [
                ...new Set([...(item.groupIds ?? []), operation.groupId]),
              ],
            });
          }
        break;
      }
      case "ungroup":
        for (const item of [...elements])
          if (!item.isDeleted && item.groupIds?.includes(operation.groupId)) {
            if (item.locked) throw new Error(`Element is locked: ${item.id}`);
            replace(elements, {
              ...item,
              groupIds: item.groupIds.filter(
                (group) => group !== operation.groupId,
              ),
            });
          }
        break;
    }
  }
  return { ...scene, elements };
}

/** Compact semantic view; bound labels are folded into their containers. Assets stay on disk. */
export function describeScene(scene: Scene) {
  return scene.elements
    .filter(
      (element) =>
        !element.isDeleted && !(element.type === "text" && element.containerId),
    )
    .map((element) => {
      const label = labelFor(scene.elements, element);
      const bindingId = (id: string | undefined) => {
        if (!id) return null;
        const target = scene.elements.find(
          (item) => item.id === id && !item.isDeleted,
        );
        return target ? semanticId(target) : id;
      };
      return {
        id: semanticId(element),
        elementId: element.id,
        type: element.type,
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        angle: element.angle,
        locked: element.locked,
        groupIds: element.groupIds ?? [],
        text:
          element.type === "text"
            ? (element.originalText ?? element.text)
            : (label?.originalText ?? label?.text),
        style: {
          strokeColor: element.strokeColor,
          backgroundColor: element.backgroundColor,
          strokeWidth: element.strokeWidth,
          strokeStyle: element.strokeStyle,
          fillStyle: element.fillStyle,
          roughness: element.roughness,
          opacity: element.opacity,
        },
        ...(linear(element)
          ? {
              from: bindingId(element.startBinding?.elementId),
              to: bindingId(element.endBinding?.elementId),
            }
          : {}),
      };
    });
}
