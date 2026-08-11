"use client";

import { useEffect, useRef, type RefObject } from "react";
import { MAX_POINTS_PER_STROKE, WIDTHS } from "@/shared/constants";
import { clampX, clampY, makeStrokeId, type Stroke } from "@/shared/protocol";
import {
  Renderer,
  toWorld,
  type LocalCursor,
  type RemoteCursor,
} from "@/lib/render";
import type { Board } from "@/lib/board";
import type { Net } from "@/lib/net";

export type Tool = "pen" | "eraser" | "sticker";

/** World units. The eraser also allows for half the width of the stroke it tests. */
export const ERASER_RADIUS = 32;

type Props = {
  board: Board;
  net: Net | null;
  rendererRef: RefObject<Renderer | null>;
  cursorsRef: RefObject<RemoteCursor[]>;
  tool: Tool;
  color: number;
  width: number;
  sticker: number;
  enabled: boolean;
  onReady: (renderer: Renderer) => void;
  onHistory: () => void;
};

function same(a: LocalCursor | null, b: LocalCursor | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.color === b.color &&
    a.radius === b.radius &&
    a.eraser === b.eraser &&
    a.sticker?.index === b.sticker?.index &&
    a.sticker?.size === b.sticker?.size
  );
}

export default function Canvas(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef(props);
  live.current = props;

  const { board, rendererRef, cursorsRef } = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new Renderer(canvas);
    renderer.setMono(
      getComputedStyle(document.documentElement)
        .getPropertyValue("--font-jetbrains-mono")
        .trim() || "monospace",
    );
    rendererRef.current = renderer;
    live.current.onReady(renderer);

    let rect = canvas.getBoundingClientRect();
    let painted: RemoteCursor[] | null = null;
    let ordinal = 0;
    let pointer: number | null = null;
    let gesture: Tool | "pan" = "pen";
    let panFrom: { x: number; y: number } | null = null;
    let spaceHeld = false;
    /** Live touches, so a second finger can turn a drag into a pinch. */
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { gap: number; x: number; y: number } | null = null;
    let drawing: Stroke | null = null;
    let erased: number[] = [];
    let at = { x: 0, y: 0 };
    let hover: { x: number; y: number } | null = null;
    let marked: LocalCursor | null = null;
    let told = { x: -1, y: -1, drawing: false };

    const resize = () => {
      renderer.resize();
      rect = canvas.getBoundingClientRect();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    window.addEventListener("orientationchange", resize);

    /** Where the pointer is, which past the edge of the board is outside it. */
    const world = (event: { clientX: number; clientY: number }) =>
      toWorld(renderer.viewport, event.clientX - rect.left, event.clientY - rect.top);

    /** Onto the board, for the points a gesture actually commits. */
    const pin = (point: { x: number; y: number }) => ({
      x: clampX(point.x),
      y: clampY(point.y),
    });

    // Every erase invalidates the committed layer, and a drag can erase on each
    // pointer sample, so the rebake is collapsed onto the next frame.
    let stale = false;

    const wipe = (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const hits = board.strokesNear(from.x, from.y, to.x, to.y, ERASER_RADIUS);
      if (!hits.length) return;
      const gone = board.eraseLocal(hits);
      if (!gone.length) return;
      erased = erased.concat(gone);
      live.current.net?.erase(gone);
      stale = true;
    };

    const start = (raw: { x: number; y: number }) => {
      const net = live.current.net;
      if (!net || net.author === 0) return;

      const point = pin(raw);
      ordinal = Math.max(ordinal, board.nextOrdinal(net.author));
      const id = makeStrokeId(net.author, ordinal++);
      const { color, width } = live.current;
      drawing = board.beginLocal(id, net.author, color, width, point.x, point.y);
      renderer.begin(drawing);
      net.begin(id, color, width, point.x, point.y);
    };

    const place = (raw: { x: number; y: number }) => {
      const net = live.current.net;
      if (!net || net.author === 0) return;

      const point = pin(raw);
      ordinal = Math.max(ordinal, board.nextOrdinal(net.author));
      const id = makeStrokeId(net.author, ordinal++);
      const { sticker, width } = live.current;
      const stroke = board.stampLocal(id, net.author, sticker, width, point.x, point.y);
      renderer.stamp(stroke);
      net.stamp(id, sticker, width, point.x, point.y);
      live.current.onHistory();
    };

    const finish = () => {
      const stroke = drawing;
      drawing = null;
      if (!stroke) return;
      board.endLocal(stroke.id);
      renderer.end(stroke);
      live.current.net?.end(stroke.id);
      live.current.onHistory();
    };

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        // A second finger means the hand wants the board, not a line: close
        // whatever it had started rather than dragging it along the pinch.
        if (touches.size === 2) {
          if (drawing) finish();
          pointer = null;
          panFrom = null;
          pinch = null;
          hover = null;
          return;
        }
      }

      if (!live.current.enabled || pointer !== null || touches.size > 1) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      pointer = event.pointerId;

      if (spaceHeld || event.button === 1) {
        gesture = "pan";
        panFrom = { x: event.clientX, y: event.clientY };
        return;
      }

      gesture = live.current.tool;

      const point = world(event);
      at = point;
      hover = point;
      if (gesture === "eraser") wipe(point, point);
      else if (gesture === "sticker") place(point);
      else start(point);
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch" && touches.has(event.pointerId)) {
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (touches.size === 2) {
          event.preventDefault();
          const [a, b] = [...touches.values()];
          const gap = Math.hypot(a.x - b.x, a.y - b.y);
          const x = (a.x + b.x) / 2 - rect.left;
          const y = (a.y + b.y) / 2 - rect.top;

          if (pinch && pinch.gap > 0) {
            renderer.panBy(x - pinch.x, y - pinch.y);
            renderer.zoomAt(x, y, gap / pinch.gap);
          }
          pinch = { gap, x, y };
          return;
        }
      }

      const point = world(event);
      hover = point;
      renderer.invalidate();

      if (event.pointerId !== pointer) return;
      event.preventDefault();

      if (gesture === "pan") {
        if (panFrom) renderer.panBy(event.clientX - panFrom.x, event.clientY - panFrom.y);
        panFrom = { x: event.clientX, y: event.clientY };
        return;
      }

      // Coalesced samples are only populated for trusted events, so anything
      // synthesising input gets an empty list and would draw nothing at all.
      const coalesced =
        typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
      const samples = coalesced.length ? coalesced : [event];

      if (gesture === "eraser") {
        for (const sample of samples) {
          const next = world(sample);
          wipe(at, next);
          at = next;
        }
        return;
      }

      if (gesture === "sticker") return;

      let fresh: number[] = [];
      const push = () => {
        if (!drawing || !fresh.length) return;
        renderer.extend(drawing);
        live.current.net?.points(drawing.id, fresh);
        fresh = [];
      };

      for (const sample of samples) {
        const stroke = drawing;
        if (!stroke) break;
        const next = pin(world(sample));

        // A stroke that hits the wire's length cap is closed and continued from
        // the same point, so a long drag stays one unbroken line on screen.
        if (stroke.pts.length >= MAX_POINTS_PER_STROKE * 2) {
          push();
          finish();
          start(next);
          at = next;
          continue;
        }

        if (!board.appendLocal(stroke.id, next.x, next.y)) continue;
        fresh.push(next.x, next.y);
        at = next;
      }

      push();
    };

    const onUp = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        touches.delete(event.pointerId);
        if (touches.size < 2) pinch = null;
      }

      if (event.pointerId !== pointer) return;
      pointer = null;
      panFrom = null;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }

      if (drawing) finish();

      if (erased.length) {
        board.commitErase(erased);
        erased = [];
        live.current.onHistory();
      }

      if (event.pointerType !== "mouse") hover = null;
    };

    const onLeave = (event: PointerEvent) => {
      if (event.pointerId === pointer) return;
      hover = null;
      renderer.invalidate();
    };

    const onMenu = (event: Event) => event.preventDefault();

    /**
     * A trackpad reports a pinch as a wheel event with ctrl held, which is the
     * same shape the browser's own zoom uses — so this has to be preventable,
     * and the listener cannot be passive.
     */
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;

      if (event.ctrlKey || event.metaKey) {
        renderer.zoomAt(x, y, Math.exp((-event.deltaY * unit) / 320));
        return;
      }
      renderer.panBy(-event.deltaX * unit, -event.deltaY * unit);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }

      if (event.key === "0" && !event.metaKey && !event.ctrlKey) {
        renderer.resetView();
        return;
      }
      if (event.code !== "Space" || event.repeat) return;
      spaceHeld = true;
      event.preventDefault();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceHeld = false;
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("contextmenu", onMenu);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    let frame = requestAnimationFrame(function loop() {
      frame = requestAnimationFrame(loop);

      if (stale) {
        stale = false;
        renderer.setStrokes(board.strokes());
      }

      if (cursorsRef.current !== painted) {
        painted = cursorsRef.current;
        renderer.setCursors(painted);
      }

      const { tool, color, width, sticker, enabled } = live.current;
      const mark: LocalCursor | null =
        hover && enabled
          ? {
              x: hover.x,
              y: hover.y,
              color,
              radius:
                tool === "eraser"
                  ? ERASER_RADIUS
                  : (WIDTHS[width] ?? WIDTHS[0]) / 2 + 1,
              eraser: tool === "eraser",
              sticker: tool === "sticker" ? { index: sticker, size: width } : null,
            }
          : null;

      if (!same(mark, marked)) {
        marked = mark;
        renderer.setLocal(mark);
      }

      const held = drawing !== null;
      if (
        hover &&
        enabled &&
        (hover.x !== told.x || hover.y !== told.y || held !== told.drawing)
      ) {
        told = { x: hover.x, y: hover.y, drawing: held };
        live.current.net?.cursor(hover.x, hover.y, held);
      }

      renderer.draw();
    });

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("orientationchange", resize);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("contextmenu", onMenu);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      rendererRef.current = null;
      renderer.dispose();
    };
  }, [board, rendererRef, cursorsRef]);

  return (
    <canvas
      ref={canvasRef}
      aria-label="Whiteboard"
      className="absolute inset-0 h-full w-full touch-none cursor-none-canvas select-none"
    />
  );
}
