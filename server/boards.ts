import {
  KIND_INK,
  KIND_STICKER,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES_PER_BOARD,
  OP_BEGIN,
  OP_DELETE,
  OP_END,
  OP_POINTS,
  OP_RESTORE,
  OP_STAMP,
} from "../shared/constants";
import { encodeSnapshot, pointsTail, type Op, type Stroke } from "../shared/protocol";

export type StoredStroke = Stroke & { deleted: boolean };

const MAX_COORDS = MAX_POINTS_PER_STROKE * 2;

/**
 * One board as every replica sees it. The Valkey stream gives a single total
 * order, so applying that order to this structure lands every replica on
 * byte-identical state — which is the only reason a client can be handed a
 * snapshot by one pod and keep receiving ops from another.
 *
 * Every mutation is therefore idempotent, because a client whose gateway died
 * mid-stroke reconnects elsewhere and replays: `begin` for a known stroke keeps
 * the stroke it already has, and `end` on a finished one changes nothing.
 */
export class BoardState {
  private readonly strokes = new Map<number, StoredStroke>();
  private live = 0;

  get strokeCount(): number {
    return this.live;
  }

  has(stroke: number): boolean {
    return this.strokes.has(stroke);
  }

  isComplete(stroke: number): boolean {
    return this.strokes.get(stroke)?.complete === true;
  }

  isDeleted(stroke: number): boolean {
    return this.strokes.get(stroke)?.deleted === true;
  }

  /** The stroke's point count, or -1 when this board has never seen it. */
  pointCount(stroke: number): number {
    const entry = this.strokes.get(stroke);
    return entry ? entry.pts.length >> 1 : -1;
  }

  /** Replaces the whole board, as hydration from a snapshot or from Postgres does. */
  reset(strokes: StoredStroke[]): void {
    this.strokes.clear();
    this.live = 0;
    for (const stroke of strokes) {
      this.strokes.set(stroke.id, stroke);
      if (!stroke.deleted) this.live++;
    }
  }

  /** Returns whether the op changed anything, so replays are never fanned out. */
  apply(op: Op): boolean {
    switch (op.t) {
      case OP_BEGIN: {
        if (this.strokes.has(op.stroke)) return false;
        this.evict();
        this.strokes.set(op.stroke, {
          id: op.stroke,
          author: op.author,
          kind: KIND_INK,
          color: op.color,
          width: op.width,
          complete: false,
          deleted: false,
          pts: [op.x, op.y],
        });
        this.live++;
        return true;
      }
      case OP_STAMP: {
        if (this.strokes.has(op.stroke)) return false;
        this.evict();
        this.strokes.set(op.stroke, {
          id: op.stroke,
          author: op.author,
          kind: KIND_STICKER,
          color: op.sticker,
          width: op.size,
          complete: true,
          deleted: false,
          pts: [op.x, op.y],
        });
        this.live++;
        return true;
      }
      case OP_POINTS: {
        const entry = this.strokes.get(op.stroke);
        if (!entry) return false;
        const tail = pointsTail(entry.pts.length >> 1, op.from, op.pts);
        if (!tail) return false;
        const room = MAX_COORDS - entry.pts.length;
        if (room <= 0) return false;
        const count = Math.min(room, tail.length);
        for (let i = 0; i < count; i++) entry.pts.push(tail[i]);
        return count > 0;
      }
      case OP_END: {
        const entry = this.strokes.get(op.stroke);
        if (!entry || entry.complete) return false;
        entry.complete = true;
        return true;
      }
      case OP_DELETE: {
        const entry = this.strokes.get(op.stroke);
        if (!entry || entry.deleted) return false;
        entry.deleted = true;
        this.live--;
        return true;
      }
      case OP_RESTORE: {
        const entry = this.strokes.get(op.stroke);
        if (!entry || !entry.deleted) return false;
        entry.deleted = false;
        this.live++;
        return true;
      }
    }
  }

  snapshot(): Uint8Array {
    return encodeSnapshot(this.liveStrokes());
  }

  *liveStrokes(): Generator<Stroke> {
    for (const entry of this.strokes.values()) {
      if (!entry.deleted) yield entry;
    }
  }

  /**
   * Insertion order is stream order on every replica, so dropping the oldest
   * strokes is a decision they all reach identically without coordinating.
   */
  private evict(): void {
    while (this.strokes.size >= MAX_STROKES_PER_BOARD) {
      const oldest = this.strokes.keys().next();
      if (oldest.done) return;
      const entry = this.strokes.get(oldest.value);
      if (entry && !entry.deleted) this.live--;
      this.strokes.delete(oldest.value);
    }
  }
}
