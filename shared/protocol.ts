import {
  CURSOR_FLAG_DRAWING,
  FRAME_CURSORS,
  FRAME_OPS,
  FRAME_SNAPSHOT,
  MAX_POINTS_PER_STROKE,
  OP_BEGIN,
  OP_DELETE,
  OP_END,
  OP_POINTS,
  OP_RESTORE,
  WORLD_H,
  WORLD_W,
} from "./constants";

export const PROTOCOL_VERSION = 1;

/**
 * A stroke id carries its author in the high 16 bits, so a client can mint one
 * the instant a pointer goes down — no round trip before the first point — and
 * the server still authorises `begin`/`points`/`end` by comparing the id's
 * author against the socket's own. Erase and restore deliberately accept any
 * id: the board is shared, so anyone may rub anything out.
 */
export function makeStrokeId(author: number, ordinal: number): number {
  return (((author & 0xffff) << 16) | (ordinal & 0xffff)) >>> 0;
}

export function strokeAuthor(strokeId: number): number {
  return (strokeId >>> 16) & 0xffff;
}

export type Op =
  | {
      t: typeof OP_BEGIN;
      stroke: number;
      author: number;
      color: number;
      width: number;
      x: number;
      y: number;
    }
  /**
   * `from` is the index of the batch's first point within the stroke. It rides
   * all the way into the stream because a gateway can only dedupe against what
   * it has already tailed back: a client replaying onto a second gateway while
   * the first one's append is still in flight would otherwise get both copies
   * written, and every replica would draw the line back on itself.
   */
  | { t: typeof OP_POINTS; stroke: number; from: number; pts: number[] }
  | { t: typeof OP_END; stroke: number }
  | { t: typeof OP_DELETE; stroke: number }
  | { t: typeof OP_RESTORE; stroke: number };

export type Stroke = {
  id: number;
  author: number;
  color: number;
  width: number;
  complete: boolean;
  /** Flat x,y pairs in world units. */
  pts: number[];
};

export type CursorWire = {
  author: number;
  x: number;
  y: number;
  color: number;
  drawing: boolean;
};

export type Person = { author: number; name: string; color: number };

export type ClientMessage =
  | { t: "hello"; session: string; name: string; color: number }
  | { t: "begin"; stroke: number; color: number; width: number; x: number; y: number }
  /**
   * `from` is the index of the first point of this batch within the stroke, so
   * a client that replays after a reconnect cannot double-append. Without it a
   * replayed batch draws the line back on itself, which is the one artefact a
   * mid-stroke failover would otherwise leave on screen.
   */
  | { t: "pts"; stroke: number; from: number; p: number[] }
  | { t: "end"; stroke: number }
  | { t: "erase"; strokes: number[] }
  | { t: "restore"; strokes: number[] }
  | { t: "cursor"; x: number; y: number; drawing: boolean }
  | { t: "ping"; c: number };

export type ServerMessage =
  | {
      t: "welcome";
      author: number;
      board: string;
      pod: string;
      replica: number;
      replicas: number;
      leader: boolean;
      release: string;
      region: string;
      strokes: number;
    }
  | { t: "meta"; replica: number; replicas: number; leader: boolean }
  | { t: "presence"; people: Person[] }
  | { t: "pong"; c: number }
  | { t: "rejected"; reason: string };

export function clampX(value: number): number {
  return value < 0 ? 0 : value > WORLD_W - 1 ? WORLD_W - 1 : Math.round(value);
}

export function clampY(value: number): number {
  return value < 0 ? 0 : value > WORLD_H - 1 ? WORLD_H - 1 : Math.round(value);
}

function opBytes(op: Op): number {
  switch (op.t) {
    case OP_BEGIN:
      return 13;
    case OP_POINTS:
      return 9 + (op.pts.length >> 1) * 4;
    default:
      return 5;
  }
}

function writeOp(view: DataView, at: number, op: Op): number {
  view.setUint8(at, op.t);
  view.setUint32(at + 1, op.stroke >>> 0, true);

  switch (op.t) {
    case OP_BEGIN:
      view.setUint16(at + 5, op.author & 0xffff, true);
      view.setUint8(at + 7, op.color & 0xff);
      view.setUint8(at + 8, op.width & 0xff);
      view.setUint16(at + 9, clampX(op.x), true);
      view.setUint16(at + 11, clampY(op.y), true);
      return at + 13;
    case OP_POINTS: {
      const count = op.pts.length >> 1;
      view.setUint16(at + 5, op.from & 0xffff, true);
      view.setUint16(at + 7, count, true);
      let cursor = at + 9;
      for (let i = 0; i < count; i++) {
        view.setUint16(cursor, clampX(op.pts[i * 2]), true);
        view.setUint16(cursor + 2, clampY(op.pts[i * 2 + 1]), true);
        cursor += 4;
      }
      return cursor;
    }
    default:
      return at + 5;
  }
}

function readOp(view: DataView, at: number): { op: Op; next: number } {
  const kind = view.getUint8(at);
  const stroke = view.getUint32(at + 1, true);

  switch (kind) {
    case OP_BEGIN:
      return {
        op: {
          t: OP_BEGIN,
          stroke,
          author: view.getUint16(at + 5, true),
          color: view.getUint8(at + 7),
          width: view.getUint8(at + 8),
          x: view.getUint16(at + 9, true),
          y: view.getUint16(at + 11, true),
        },
        next: at + 13,
      };
    case OP_POINTS: {
      const from = view.getUint16(at + 5, true);
      const count = view.getUint16(at + 7, true);
      const pts = new Array<number>(count * 2);
      let cursor = at + 9;
      for (let i = 0; i < count; i++) {
        pts[i * 2] = view.getUint16(cursor, true);
        pts[i * 2 + 1] = view.getUint16(cursor + 2, true);
        cursor += 4;
      }
      return { op: { t: OP_POINTS, stroke, from, pts }, next: cursor };
    }
    case OP_END:
      return { op: { t: OP_END, stroke }, next: at + 5 };
    case OP_DELETE:
      return { op: { t: OP_DELETE, stroke }, next: at + 5 };
    case OP_RESTORE:
      return { op: { t: OP_RESTORE, stroke }, next: at + 5 };
    default:
      throw new Error(`unknown op ${kind}`);
  }
}

/** The durable form written to the Valkey stream: one op, no frame header. */
export function encodeOp(op: Op): Uint8Array {
  const buffer = new ArrayBuffer(opBytes(op));
  writeOp(new DataView(buffer), 0, op);
  return new Uint8Array(buffer);
}

export function decodeOp(bytes: Uint8Array): Op {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return readOp(view, 0).op;
}

export function encodeOps(ops: Op[]): Uint8Array {
  let size = 4;
  for (const op of ops) size += opBytes(op);

  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, FRAME_OPS);
  view.setUint16(2, ops.length, true);

  let at = 4;
  for (const op of ops) at = writeOp(view, at, op);
  return new Uint8Array(buffer);
}

export function encodeSnapshot(strokes: Iterable<Stroke>): Uint8Array {
  const list = [...strokes];
  let size = 6;
  for (const stroke of list) size += 11 + (stroke.pts.length >> 1) * 4;

  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, FRAME_SNAPSHOT);
  view.setUint32(2, list.length, true);

  let at = 6;
  for (const stroke of list) {
    const count = stroke.pts.length >> 1;
    view.setUint32(at, stroke.id >>> 0, true);
    view.setUint16(at + 4, stroke.author & 0xffff, true);
    view.setUint8(at + 6, stroke.color & 0xff);
    view.setUint8(at + 7, stroke.width & 0xff);
    view.setUint8(at + 8, stroke.complete ? 1 : 0);
    view.setUint16(at + 9, count, true);
    at += 11;
    for (let i = 0; i < count; i++) {
      view.setUint16(at, stroke.pts[i * 2], true);
      view.setUint16(at + 2, stroke.pts[i * 2 + 1], true);
      at += 4;
    }
  }
  return new Uint8Array(buffer);
}

export function encodeCursors(cursors: CursorWire[]): Uint8Array {
  const buffer = new ArrayBuffer(4 + cursors.length * 8);
  const view = new DataView(buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, FRAME_CURSORS);
  view.setUint16(2, cursors.length, true);

  let at = 4;
  for (const cursor of cursors) {
    view.setUint16(at, cursor.author & 0xffff, true);
    view.setUint16(at + 2, clampX(cursor.x), true);
    view.setUint16(at + 4, clampY(cursor.y), true);
    view.setUint8(at + 6, cursor.color & 0xff);
    view.setUint8(at + 7, cursor.drawing ? CURSOR_FLAG_DRAWING : 0);
    at += 8;
  }
  return new Uint8Array(buffer);
}

export type Frame =
  | { kind: typeof FRAME_SNAPSHOT; strokes: Stroke[] }
  | { kind: typeof FRAME_OPS; ops: Op[] }
  | { kind: typeof FRAME_CURSORS; cursors: CursorWire[] };

export function decodeFrame(data: ArrayBuffer): Frame | null {
  const view = new DataView(data);
  if (view.byteLength < 4 || view.getUint8(0) !== PROTOCOL_VERSION) return null;

  const kind = view.getUint8(1);

  if (kind === FRAME_OPS) {
    const count = view.getUint16(2, true);
    const ops: Op[] = [];
    let at = 4;
    for (let i = 0; i < count; i++) {
      const { op, next } = readOp(view, at);
      ops.push(op);
      at = next;
    }
    return { kind: FRAME_OPS, ops };
  }

  if (kind === FRAME_SNAPSHOT) {
    const count = view.getUint32(2, true);
    const strokes: Stroke[] = [];
    let at = 6;
    for (let i = 0; i < count; i++) {
      const id = view.getUint32(at, true);
      const author = view.getUint16(at + 4, true);
      const color = view.getUint8(at + 6);
      const width = view.getUint8(at + 7);
      const complete = view.getUint8(at + 8) === 1;
      const points = view.getUint16(at + 9, true);
      at += 11;
      const pts = new Array<number>(points * 2);
      for (let p = 0; p < points; p++) {
        pts[p * 2] = view.getUint16(at, true);
        pts[p * 2 + 1] = view.getUint16(at + 2, true);
        at += 4;
      }
      strokes.push({ id, author, color, width, complete, pts });
    }
    return { kind: FRAME_SNAPSHOT, strokes };
  }

  if (kind === FRAME_CURSORS) {
    const count = view.getUint16(2, true);
    const cursors: CursorWire[] = [];
    let at = 4;
    for (let i = 0; i < count; i++) {
      cursors.push({
        author: view.getUint16(at, true),
        x: view.getUint16(at + 2, true),
        y: view.getUint16(at + 4, true),
        color: view.getUint8(at + 6),
        drawing: (view.getUint8(at + 7) & CURSOR_FLAG_DRAWING) !== 0,
      });
      at += 8;
    }
    return { kind: FRAME_CURSORS, cursors };
  }

  return null;
}

/**
 * The points of `batch` that a stroke of `have` points has not already got,
 * given the batch starts at point index `from` within the stroke (the `begin`
 * point is index 0). Returns null when there is nothing to append: either the
 * batch replays points already applied, or it starts past the end of the
 * stroke, where concatenating would splice the line across a gap it never drew.
 *
 * Every place that applies an op runs this — gateway, replica board state,
 * compaction and the browser — so all four reach the same result from the same
 * stream, whatever order the duplicates arrive in.
 */
export function pointsTail(have: number, from: number, batch: number[]): number[] | null {
  if (have >= MAX_POINTS_PER_STROKE) return null;
  if (from > have) return null;
  if (from + (batch.length >> 1) <= have) return null;

  const tail = batch.slice((have - from) * 2);
  return tail.length ? tail : null;
}

/** Postgres stores a stroke's points as packed uint16 pairs rather than JSON. */
export function packPoints(pts: number[]): Buffer {
  const buffer = Buffer.allocUnsafe(pts.length * 2);
  for (let i = 0; i < pts.length; i++) buffer.writeUInt16LE(pts[i] & 0xffff, i * 2);
  return buffer;
}

export function unpackPoints(buffer: Buffer): number[] {
  const pts = new Array<number>(buffer.length >> 1);
  for (let i = 0; i < pts.length; i++) pts[i] = buffer.readUInt16LE(i * 2);
  return pts;
}
