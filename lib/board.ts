import {
  MAX_POINTS_PER_STROKE,
  OP_BEGIN,
  OP_DELETE,
  OP_END,
  OP_POINTS,
  OP_RESTORE,
  WIDTHS,
} from "@/shared/constants";
import { pointsTail, strokeAuthor, type Op, type Stroke } from "@/shared/protocol";

/**
 * What the painter has to do about a change. `rebake` supersedes every other
 * change in the same batch, because the board has already settled by the time
 * the list is handed over.
 */
export type BoardChange =
  | { kind: "rebake" }
  | { kind: "begin"; stroke: Stroke }
  | { kind: "points"; stroke: Stroke }
  | { kind: "end"; stroke: Stroke };

/** What an undo or a redo asks the server to do. */
export type Intent = { kind: "erase" | "restore"; strokes: number[] };

type Entry = { drew: boolean; strokes: number[] };
type Bounds = { x0: number; y0: number; x1: number; y1: number };

const HISTORY_LIMIT = 200;
const REBAKE: BoardChange[] = [{ kind: "rebake" }];

export class Board {
  private strokeMap = new Map<number, Stroke>();
  private graves = new Map<number, Stroke>();
  private order = new Map<number, number>();
  private extent = new Map<number, Bounds>();
  private next = 0;
  private resorted = false;

  private past: Entry[] = [];
  private future: Entry[] = [];

  /** Ids minted by this client. Their local copy outranks the server's echo. */
  private mine = new Set<number>();
  /** Local strokes the server has not yet echoed the end of. */
  private unacked = new Set<number>();

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Live strokes in paint order, oldest first. */
  strokes(): Stroke[] {
    if (this.resorted) {
      const sorted = [...this.strokeMap.values()].sort(
        (a, b) => (this.order.get(a.id) ?? 0) - (this.order.get(b.id) ?? 0),
      );
      this.strokeMap.clear();
      for (const stroke of sorted) this.strokeMap.set(stroke.id, stroke);
      this.resorted = false;
    }
    return [...this.strokeMap.values()];
  }

  get(id: number): Stroke | undefined {
    return this.strokeMap.get(id);
  }

  /**
   * One past the highest stroke ordinal this author already has here. A reloaded
   * tab keeps its session, so the server hands back the same author id — minting
   * from zero again would re-use a live stroke's id, and the server treats
   * `begin` on a known stroke as a no-op, so the new line would silently join
   * the old one instead of appearing.
   */
  nextOrdinal(author: number): number {
    let next = 0;
    const consider = (id: number) => {
      if (strokeAuthor(id) === author) next = Math.max(next, (id & 0xffff) + 1);
    };
    for (const id of this.strokeMap.keys()) consider(id);
    for (const id of this.graves.keys()) consider(id);
    return next;
  }

  /**
   * Adopts a full board state. Strokes this client authored but has not seen
   * echoed back are carried over untouched — a snapshot that lands mid-drag
   * would otherwise truncate the line under the user's own finger.
   */
  snapshot(strokes: Stroke[]): BoardChange[] {
    for (const stroke of strokes) {
      if (stroke.complete) this.unacked.delete(stroke.id);
    }

    const carried: Stroke[] = [];
    for (const id of this.unacked) {
      const stroke = this.strokeMap.get(id);
      if (stroke) carried.push(stroke);
    }

    this.strokeMap.clear();
    this.order.clear();
    this.extent.clear();
    this.next = 0;
    this.resorted = false;

    for (const stroke of strokes) {
      if (!this.unacked.has(stroke.id)) this.insert(stroke);
    }
    for (const stroke of carried) this.insert(stroke);

    return REBAKE;
  }

  apply(ops: Op[]): BoardChange[] {
    const changes: BoardChange[] = [];

    for (const op of ops) {
      switch (op.t) {
        case OP_BEGIN: {
          if (this.mine.has(op.stroke) || this.strokeMap.has(op.stroke)) break;
          const stroke: Stroke = {
            id: op.stroke,
            author: op.author,
            color: op.color,
            width: op.width,
            complete: false,
            pts: [op.x, op.y],
          };
          this.insert(stroke);
          changes.push({ kind: "begin", stroke });
          break;
        }

        case OP_POINTS: {
          if (this.mine.has(op.stroke)) break;
          const stroke = this.strokeMap.get(op.stroke);
          if (!stroke || stroke.complete) break;
          const tail = pointsTail(stroke.pts.length >> 1, op.from, op.pts);
          if (!tail) break;
          for (const value of tail) stroke.pts.push(value);
          this.extent.delete(stroke.id);
          changes.push({ kind: "points", stroke });
          break;
        }

        case OP_END: {
          this.unacked.delete(op.stroke);
          if (this.mine.has(op.stroke)) break;
          const stroke = this.strokeMap.get(op.stroke);
          if (!stroke || stroke.complete) break;
          stroke.complete = true;
          changes.push({ kind: "end", stroke });
          break;
        }

        case OP_DELETE: {
          this.unacked.delete(op.stroke);
          if (this.bury(op.stroke)) changes.push({ kind: "rebake" });
          break;
        }

        case OP_RESTORE: {
          if (this.exhume(op.stroke)) changes.push({ kind: "rebake" });
          break;
        }
      }
    }

    return changes;
  }

  beginLocal(
    id: number,
    author: number,
    color: number,
    width: number,
    x: number,
    y: number,
  ): Stroke {
    const stroke: Stroke = { id, author, color, width, complete: false, pts: [x, y] };
    this.mine.add(id);
    this.unacked.add(id);
    this.insert(stroke);
    return stroke;
  }

  /** Appends a sample unless it repeats the last one. Returns false if dropped. */
  appendLocal(id: number, x: number, y: number): boolean {
    const stroke = this.strokeMap.get(id);
    if (!stroke || stroke.complete) return false;
    if (stroke.pts.length >= MAX_POINTS_PER_STROKE * 2) return false;

    const at = stroke.pts.length;
    if (at >= 2 && stroke.pts[at - 2] === x && stroke.pts[at - 1] === y) return false;

    stroke.pts.push(x, y);
    this.extent.delete(id);
    return true;
  }

  endLocal(id: number): Stroke | undefined {
    const stroke = this.strokeMap.get(id);
    if (!stroke || stroke.complete) return undefined;
    stroke.complete = true;
    this.remember({ drew: true, strokes: [id] });
    return stroke;
  }

  /** Removes strokes without touching history; `commitErase` closes the gesture. */
  eraseLocal(ids: number[]): number[] {
    return ids.filter((id) => this.bury(id));
  }

  /** Files a whole eraser drag as one undoable step. */
  commitErase(ids: number[]): void {
    if (ids.length) this.remember({ drew: false, strokes: ids });
  }

  /**
   * Reverses this client's last own action and applies it locally. The caller
   * sends the returned intent and rebakes: both directions touch the z-order.
   */
  undo(): Intent | null {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push(entry);
    return this.enact(entry.drew ? "erase" : "restore", entry.strokes);
  }

  redo(): Intent | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push(entry);
    return this.enact(entry.drew ? "restore" : "erase", entry.strokes);
  }

  /**
   * Ids of live strokes whose path passes within `radius` world units of the
   * segment the pointer just travelled. Bounding boxes reject the board in bulk
   * before any per-segment work.
   */
  strokesNear(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    radius: number,
  ): number[] {
    const hits: number[] = [];
    const lowX = Math.min(ax, bx);
    const highX = Math.max(ax, bx);
    const lowY = Math.min(ay, by);
    const highY = Math.max(ay, by);

    for (const stroke of this.strokeMap.values()) {
      const reach = radius + (WIDTHS[stroke.width] ?? WIDTHS[0]) / 2;
      const box = this.bounds(stroke);
      if (
        highX < box.x0 - reach ||
        lowX > box.x1 + reach ||
        highY < box.y0 - reach ||
        lowY > box.y1 + reach
      ) {
        continue;
      }

      const pts = stroke.pts;
      if (pts.length === 2) {
        if (pointSegment(pts[0], pts[1], ax, ay, bx, by) <= reach) hits.push(stroke.id);
        continue;
      }

      for (let i = 0; i + 3 < pts.length; i += 2) {
        const distance = segmentSegment(
          pts[i],
          pts[i + 1],
          pts[i + 2],
          pts[i + 3],
          ax,
          ay,
          bx,
          by,
        );
        if (distance <= reach) {
          hits.push(stroke.id);
          break;
        }
      }
    }

    return hits;
  }

  private enact(kind: Intent["kind"], strokes: number[]): Intent {
    for (const id of strokes) {
      if (kind === "erase") this.bury(id);
      else this.exhume(id);
    }
    return { kind, strokes };
  }

  private remember(entry: Entry): void {
    this.past.push(entry);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
  }

  private insert(stroke: Stroke): void {
    this.graves.delete(stroke.id);
    this.strokeMap.set(stroke.id, stroke);
    if (!this.order.has(stroke.id)) this.order.set(stroke.id, this.next++);
  }

  private bury(id: number): boolean {
    const stroke = this.strokeMap.get(id);
    if (!stroke) return false;
    this.strokeMap.delete(id);
    this.graves.set(id, stroke);
    return true;
  }

  private exhume(id: number): boolean {
    const stroke = this.graves.get(id);
    if (!stroke || this.strokeMap.has(id)) return false;
    this.graves.delete(id);
    this.strokeMap.set(id, stroke);
    if (!this.order.has(id)) this.order.set(id, this.next++);
    this.resorted = true;
    return true;
  }

  private bounds(stroke: Stroke): Bounds {
    const cached = this.extent.get(stroke.id);
    if (cached) return cached;

    const pts = stroke.pts;
    const box: Bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < box.x0) box.x0 = pts[i];
      if (pts[i] > box.x1) box.x1 = pts[i];
      if (pts[i + 1] < box.y0) box.y0 = pts[i + 1];
      if (pts[i + 1] > box.y1) box.y1 = pts[i + 1];
    }

    if (stroke.complete) this.extent.set(stroke.id, box);
    return box;
  }
}

function pointSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const span = dx * dx + dy * dy;
  const t = span > 0 ? clamp01(((px - ax) * dx + (py - ay) * dy) / span) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function segmentSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  if (crosses(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    pointSegment(ax, ay, cx, cy, dx, dy),
    pointSegment(bx, by, cx, cy, dx, dy),
    pointSegment(cx, cy, ax, ay, bx, by),
    pointSegment(dx, dy, ax, ay, bx, by),
  );
}

function crosses(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = side(cx, cy, dx, dy, ax, ay);
  const d2 = side(cx, cy, dx, dy, bx, by);
  const d3 = side(ax, ay, bx, by, cx, cy);
  const d4 = side(ax, ay, bx, by, dx, dy);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function side(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
