import { WIDTHS, WORLD_H, WORLD_W } from "@/shared/constants";
import { isSticker, stickerGlyph, stickerSize, type Stroke } from "@/shared/protocol";
import { PALETTE, userColor } from "@/lib/palette";

/**
 * Ink is fill-heavy, so a full 3x backing store on a large window costs more
 * than the sharpness is worth. Past the cap the ratio slides down instead.
 */
const MAX_BACKING_PIXELS = 5_000_000;

/**
 * How many samples a live path may accumulate before its settled head is
 * flushed into the bake. The flush starts the next path at the midpoint the
 * previous one ended on, so the two halves join without overdraw.
 */
const SETTLE_POINTS = 192;

const GRID_STEP = 240;
const TAU = Math.PI * 2;
const SURFACE = "#111009";

/**
 * How long the camera must hold still before the committed layer is painted
 * again at the new zoom. Repainting every stroke per frame is what a pan cannot
 * afford, so a gesture rides on the existing bitmap, stretched, and pays for
 * sharpness once it stops.
 */
const SETTLE_MS = 90;

/** Whichever of these the platform has is the one that draws colour emoji. */
const EMOJI_STACK =
  '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla",sans-serif';

export type Viewport = {
  scale: number;
  ox: number;
  oy: number;
  width: number;
  height: number;
};

export type RemoteCursor = {
  author: number;
  x: number;
  y: number;
  color: number;
  name: string;
  drawing: boolean;
};

export type LocalCursor = {
  x: number;
  y: number;
  color: number;
  radius: number;
  eraser: boolean;
  /** Set while the sticker tool is armed: what a click would drop, and how big. */
  sticker: { index: number; size: number } | null;
};

/** The board filling the viewport, cropped rather than letterboxed. The view a tab opens on. */
export function fitViewport(width: number, height: number): Viewport {
  const scale = coverScale(width, height);
  return settleViewport(...centred(scale, width, height), width, height);
}

/** The camera that puts the middle of the board in the middle of the window. */
function centred(scale: number, width: number, height: number): [number, number, number] {
  return [scale, (width - WORLD_W * scale) / 2, (height - WORLD_H * scale) / 2];
}

export function coverScale(width: number, height: number): number {
  return Math.max(width / WORLD_W, height / WORLD_H);
}

/** Zoomed out far enough to hold the whole board, with room to spare around it. */
export function minScale(width: number, height: number): number {
  return Math.min(width / WORLD_W, height / WORLD_H) * 0.6;
}

export function maxScale(width: number, height: number): number {
  return coverScale(width, height) * 14;
}

/**
 * Settles a camera against the viewport: the zoom is bounded, and on each axis
 * the board is centred when it is smaller than the window and otherwise pinned
 * so its edge cannot be dragged inside the frame. Panning therefore never
 * strands the board off screen, and never opens a margin it does not have to.
 */
export function settleViewport(
  scale: number,
  ox: number,
  oy: number,
  width: number,
  height: number,
): Viewport {
  const bounded = clamp(scale, minScale(width, height), maxScale(width, height));
  const spanX = WORLD_W * bounded;
  const spanY = WORLD_H * bounded;

  return {
    scale: bounded,
    ox: spanX <= width ? (width - spanX) / 2 : clamp(ox, width - spanX, 0),
    oy: spanY <= height ? (height - spanY) / 2 : clamp(oy, height - spanY, 0),
    width,
    height,
  };
}

/**
 * Screen to world, deliberately unclamped: past the edge of the board there is
 * still somewhere to point, and a cursor that stops following the hand reads as
 * a broken window rather than a boundary. Callers clamp when they commit a point.
 */
export function toWorld(
  view: Viewport,
  x: number,
  y: number,
): { x: number; y: number } {
  if (view.scale <= 0) return { x: 0, y: 0 };
  return { x: (x - view.ox) / view.scale, y: (y - view.oy) / view.scale };
}

type Live = {
  stroke: Stroke;
  path: Path2D;
  /** Index of the last sample consumed into `path`; -1 while it is empty. */
  through: number;
  /** Value `through` held when the path was last flushed into the bake. */
  flushed: number;
};

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bake: HTMLCanvasElement;
  private baked: CanvasRenderingContext2D;

  private complete: Stroke[] = [];
  private live = new Map<number, Live>();
  private cursors: RemoteCursor[] = [];
  private local: LocalCursor | null = null;

  private view: Viewport = fitViewport(0, 0);
  /** The camera the committed layer was painted for; null until the first bake. */
  private bakedView: Viewport | null = null;
  private movedAt = 0;
  private dpr = 1;
  private pixelWidth = 0;
  private pixelHeight = 0;
  private mono = "monospace";
  private dirty = true;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2d canvas unavailable");

    this.canvas = canvas;
    this.ctx = ctx;
    this.bake = document.createElement("canvas");

    const baked = this.bake.getContext("2d", { alpha: false });
    if (!baked) throw new Error("2d canvas unavailable");
    this.baked = baked;

    this.resize();
  }

  get viewport(): Viewport {
    return this.view;
  }

  /** Moves the camera, bounded so the board can never be stranded off screen. */
  setView(scale: number, ox: number, oy: number): void {
    const next = settleViewport(scale, ox, oy, this.view.width, this.view.height);
    if (
      next.scale === this.view.scale &&
      next.ox === this.view.ox &&
      next.oy === this.view.oy
    ) {
      return;
    }
    this.view = next;
    this.movedAt = performance.now();
    this.dirty = true;
  }

  panBy(dx: number, dy: number): void {
    this.setView(this.view.scale, this.view.ox + dx, this.view.oy + dy);
  }

  /** Zooms about a screen point, so whatever is under the pointer stays under it. */
  zoomAt(x: number, y: number, factor: number): void {
    const { width, height, scale, ox, oy } = this.view;
    const next = clamp(scale * factor, minScale(width, height), maxScale(width, height));
    const k = next / scale;
    this.setView(next, x - (x - ox) * k, y - (y - oy) * k);
  }

  resetView(): void {
    const { width, height } = this.view;
    this.setView(...centred(coverScale(width, height), width, height));
  }

  setMono(family: string): void {
    this.mono = family || "monospace";
    this.dirty = true;
  }

  /** Matches the backing store to the element. Rebakes when the size moved. */
  resize(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width <= 0 || height <= 0) return;

    const dpr = backingRatio(width, height);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (pixelWidth === this.pixelWidth && pixelHeight === this.pixelHeight) return;

    this.dpr = dpr;
    this.pixelWidth = pixelWidth;
    this.pixelHeight = pixelHeight;
    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    this.bake.width = pixelWidth;
    this.bake.height = pixelHeight;
    this.view =
      this.view.width > 0 && this.view.height > 0
        ? settleViewport(this.view.scale, this.view.ox, this.view.oy, width, height)
        : fitViewport(width, height);
    this.rebake();
  }

  /**
   * Replaces everything and repaints the committed layer from scratch. This is
   * the snapshot path, the resize path, and the only way to remove a stroke:
   * ink is destructive, so a stroke anywhere in the z-order has to be painted
   * over by repainting its neighbours. Cost is linear in total samples, a few
   * milliseconds for a busy board, so it must not run per frame.
   */
  setStrokes(strokes: Iterable<Stroke>): void {
    this.complete = [];
    const seen = new Set<number>();

    for (const stroke of strokes) {
      if (stroke.complete) {
        this.complete.push(stroke);
        continue;
      }
      seen.add(stroke.id);
      const live = this.live.get(stroke.id);
      if (live) live.stroke = stroke;
      else this.live.set(stroke.id, blank(stroke));
    }

    for (const id of [...this.live.keys()]) {
      if (!seen.has(id)) this.live.delete(id);
    }

    this.rebake();
  }

  begin(stroke: Stroke): void {
    const live = blank(stroke);
    live.through = tracePath(live.path, stroke.pts, -1, false);
    this.live.set(stroke.id, live);
    this.dirty = true;
  }

  /** Extends an in-flight path with whatever samples the stroke has gained. */
  extend(stroke: Stroke): void {
    const live = this.live.get(stroke.id);
    if (!live) {
      this.begin(stroke);
      return;
    }

    live.stroke = stroke;
    live.through = tracePath(live.path, stroke.pts, live.through, false);
    this.dirty = true;

    if (live.through - live.flushed < SETTLE_POINTS) return;

    this.paint(this.baked, stroke, live.path);
    const head = live.through;
    live.path = new Path2D();
    live.path.moveTo(
      (stroke.pts[head * 2] + stroke.pts[head * 2 + 2]) / 2,
      (stroke.pts[head * 2 + 1] + stroke.pts[head * 2 + 3]) / 2,
    );
    live.flushed = head;
  }

  end(stroke: Stroke): void {
    const live = this.live.get(stroke.id);
    this.live.delete(stroke.id);

    if (stroke.pts.length < 4) this.dot(this.baked, stroke);
    else if (live) {
      tracePath(live.path, stroke.pts, live.through, true);
      this.paint(this.baked, stroke, live.path);
    } else {
      const path = new Path2D();
      tracePath(path, stroke.pts, -1, true);
      this.paint(this.baked, stroke, path);
    }

    this.complete.push(stroke);
    this.dirty = true;
  }

  /** A sticker arrives whole, so it goes straight into the committed layer. */
  stamp(stroke: Stroke): void {
    this.sticker(this.baked, stroke);
    this.complete.push(stroke);
    this.dirty = true;
  }

  setCursors(cursors: RemoteCursor[]): void {
    this.cursors = cursors;
    this.dirty = true;
  }

  setLocal(cursor: LocalCursor | null): void {
    this.local = cursor;
    this.dirty = true;
  }

  invalidate(): void {
    this.dirty = true;
  }

  draw(): void {
    if (this.pixelWidth <= 0) return;

    if (this.stale() && performance.now() - this.movedAt >= SETTLE_MS) this.rebake();
    if (!this.dirty) return;
    this.dirty = false;

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    this.blit(ctx);

    for (const live of this.live.values()) {
      if (live.stroke.pts.length < 4) this.dot(ctx, live.stroke);
      else this.paint(ctx, live.stroke, live.path);
    }

    this.drawCursors(ctx);
  }

  dispose(): void {
    this.live.clear();
    this.complete = [];
    this.cursors = [];
    this.bake.width = 0;
    this.bake.height = 0;
  }

  private stale(): boolean {
    const baked = this.bakedView;
    return (
      !!baked &&
      (baked.scale !== this.view.scale ||
        baked.ox !== this.view.ox ||
        baked.oy !== this.view.oy)
    );
  }

  /**
   * Puts the committed layer on screen. While the camera is ahead of the bake,
   * the bitmap is stretched into place instead of being repainted — the board
   * softens for a few frames mid-gesture rather than dropping them.
   */
  private blit(ctx: CanvasRenderingContext2D): void {
    const baked = this.bakedView;
    if (!baked || !this.stale()) {
      ctx.drawImage(this.bake, 0, 0);
      return;
    }

    const k = this.view.scale / baked.scale;
    ctx.fillStyle = PALETTE.void;
    ctx.fillRect(0, 0, this.pixelWidth, this.pixelHeight);
    ctx.setTransform(
      k,
      0,
      0,
      k,
      (this.view.ox - baked.ox * k) * this.dpr,
      (this.view.oy - baked.oy * k) * this.dpr,
    );
    ctx.drawImage(this.bake, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private rebake(): void {
    const ctx = this.baked;
    this.bakedView = this.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = PALETTE.void;
    ctx.fillRect(0, 0, this.pixelWidth, this.pixelHeight);
    this.drawSurface(ctx);

    this.world(ctx);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Neighbouring strokes that share a colour and a width go into one path, so
    // a board of one author's scribbles costs a handful of stroke() calls.
    let color = -1;
    let width = -1;
    let open = false;

    for (const stroke of this.complete) {
      if (isSticker(stroke)) {
        if (open) {
          ctx.stroke();
          open = false;
        }
        this.sticker(ctx, stroke);
        color = -1;
        continue;
      }

      if (stroke.pts.length < 4) {
        if (open) {
          ctx.stroke();
          open = false;
        }
        this.dot(ctx, stroke);
        color = -1;
        continue;
      }

      if (stroke.color !== color || stroke.width !== width) {
        if (open) {
          ctx.stroke();
          open = false;
        }
        color = stroke.color;
        width = stroke.width;
        ctx.strokeStyle = userColor(color);
        ctx.lineWidth = this.lineWidth(width);
      }

      if (!open) {
        ctx.beginPath();
        open = true;
      }
      tracePath(ctx, stroke.pts, -1, true);
    }

    if (open) ctx.stroke();

    for (const live of this.live.values()) {
      live.path = new Path2D();
      live.flushed = -1;
      live.through = tracePath(live.path, live.stroke.pts, -1, false);
    }

    this.dirty = true;
  }

  private drawSurface(ctx: CanvasRenderingContext2D): void {
    const { scale, ox, oy } = this.view;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const width = WORLD_W * scale;
    const height = WORLD_H * scale;
    ctx.fillStyle = SURFACE;
    ctx.fillRect(ox, oy, width, height);

    ctx.strokeStyle = PALETTE.edge;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    for (let x = GRID_STEP; x < WORLD_W; x += GRID_STEP) {
      ctx.moveTo(ox + x * scale, oy);
      ctx.lineTo(ox + x * scale, oy + height);
    }
    for (let y = GRID_STEP; y < WORLD_H; y += GRID_STEP) {
      ctx.moveTo(ox, oy + y * scale);
      ctx.lineTo(ox + width, oy + y * scale);
    }
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.strokeRect(ox + 0.5, oy + 0.5, width - 1, height - 1);
  }

  private drawCursors(ctx: CanvasRenderingContext2D): void {
    const { scale, ox, oy } = this.view;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.lineJoin = "round";
    ctx.font = `10px ${this.mono}`;
    ctx.textBaseline = "middle";

    for (const cursor of this.cursors) {
      const x = ox + cursor.x * scale;
      const y = oy + cursor.y * scale;
      const color = userColor(cursor.color);

      ctx.save();
      ctx.translate(x, y);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, 12.5);
      ctx.lineTo(3.1, 9.4);
      ctx.lineTo(5.4, 14.2);
      ctx.lineTo(7.3, 13.3);
      ctx.lineTo(5.1, 8.7);
      ctx.lineTo(9, 8.7);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.strokeStyle = PALETTE.void;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fill();
      ctx.restore();

      if (!cursor.name) continue;
      const label = ctx.measureText(cursor.name).width;
      ctx.globalAlpha = 0.72;
      ctx.fillStyle = PALETTE.void;
      ctx.fillRect(x + 11, y + 10, label + 8, 14);
      ctx.globalAlpha = cursor.drawing ? 1 : 0.8;
      ctx.fillStyle = color;
      ctx.fillText(cursor.name, x + 15, y + 17.5);
      ctx.globalAlpha = 1;
    }

    const local = this.local;
    if (!local) return;

    const x = ox + local.x * scale;
    const y = oy + local.y * scale;

    if (local.sticker) {
      ctx.globalAlpha = 0.6;
      ctx.font = `${stickerSize(local.sticker.size) * scale}px ${EMOJI_STACK}`;
      ctx.textAlign = "center";
      ctx.fillText(stickerGlyph(local.sticker.index), x, y);
      ctx.textAlign = "start";
      ctx.globalAlpha = 1;
      return;
    }

    ctx.beginPath();
    ctx.arc(x, y, Math.max(3, local.radius * scale), 0, TAU);
    ctx.strokeStyle = local.eraser ? PALETTE.bone : userColor(local.color);
    ctx.globalAlpha = local.eraser ? 0.55 : 0.85;
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private paint(
    ctx: CanvasRenderingContext2D,
    stroke: Stroke,
    path: Path2D,
  ): void {
    this.world(ctx);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = userColor(stroke.color);
    ctx.lineWidth = this.lineWidth(stroke.width);
    ctx.stroke(path);
  }

  private sticker(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
    if (stroke.pts.length < 2) return;
    const size = stickerSize(stroke.width);
    this.world(ctx);
    ctx.font = `${size}px ${EMOJI_STACK}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(stickerGlyph(stroke.color), stroke.pts[0], stroke.pts[1]);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }

  private dot(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
    if (stroke.pts.length < 2) return;
    this.world(ctx);
    ctx.beginPath();
    ctx.arc(stroke.pts[0], stroke.pts[1], this.lineWidth(stroke.width) / 2, 0, TAU);
    ctx.fillStyle = userColor(stroke.color);
    ctx.fill();
  }

  private world(ctx: CanvasRenderingContext2D): void {
    const k = this.view.scale * this.dpr;
    ctx.setTransform(k, 0, 0, k, this.view.ox * this.dpr, this.view.oy * this.dpr);
  }

  /** World units, floored so the thinnest pen never falls below a screen pixel. */
  private lineWidth(index: number): number {
    const width = WIDTHS[index] ?? WIDTHS[0];
    return this.view.scale > 0 ? Math.max(width, 1 / this.view.scale) : width;
  }
}

/**
 * Traces samples `through+1` onward onto `sink`, curving through the midpoint
 * of every pair so the line reads as a curve rather than a chain of segments.
 * Returns the new watermark. A trace that stops early leaves the pen on a
 * midpoint, which is exactly where the next trace resumes — that is what lets
 * a stroke be appended to without re-pathing what came before.
 */
function tracePath(
  sink: CanvasPath,
  pts: number[],
  through: number,
  final: boolean,
): number {
  const last = (pts.length >> 1) - 1;
  if (last < 1) return through;

  let cursor = through;
  if (cursor < 0) {
    sink.moveTo(pts[0], pts[1]);
    cursor = 0;
  }

  for (let i = cursor + 1; i <= last - 1; i++) {
    sink.quadraticCurveTo(
      pts[i * 2],
      pts[i * 2 + 1],
      (pts[i * 2] + pts[i * 2 + 2]) / 2,
      (pts[i * 2 + 1] + pts[i * 2 + 3]) / 2,
    );
    cursor = i;
  }

  if (final) {
    sink.lineTo(pts[last * 2], pts[last * 2 + 1]);
    cursor = last;
  }

  return cursor;
}

function blank(stroke: Stroke): Live {
  return { stroke, path: new Path2D(), through: -1, flushed: -1 };
}

function backingRatio(width: number, height: number): number {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const area = width * height;
  if (area * ratio * ratio <= MAX_BACKING_PIXELS) return ratio;
  return Math.max(1, Math.sqrt(MAX_BACKING_PIXELS / area));
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
