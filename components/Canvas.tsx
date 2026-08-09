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

export type Tool = "pen" | "eraser";

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
    a.eraser === b.eraser
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
    let gesture: Tool = "pen";
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

    const world = (event: { clientX: number; clientY: number }) => {
      const point = toWorld(
        renderer.viewport,
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      return { x: clampX(point.x), y: clampY(point.y) };
    };

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

    const start = (point: { x: number; y: number }) => {
      const net = live.current.net;
      if (!net || net.author === 0) return;

      ordinal = Math.max(ordinal, board.nextOrdinal(net.author));
      const id = makeStrokeId(net.author, ordinal++);
      const { color, width } = live.current;
      drawing = board.beginLocal(id, net.author, color, width, point.x, point.y);
      renderer.begin(drawing);
      net.begin(id, color, width, point.x, point.y);
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
      if (!live.current.enabled || pointer !== null) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      pointer = event.pointerId;
      gesture = live.current.tool;

      const point = world(event);
      at = point;
      hover = point;
      if (gesture === "eraser") wipe(point, point);
      else start(point);
    };

    const onMove = (event: PointerEvent) => {
      const point = world(event);
      hover = point;
      renderer.invalidate();

      if (event.pointerId !== pointer) return;
      event.preventDefault();

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
        const next = world(sample);

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
      if (event.pointerId !== pointer) return;
      pointer = null;
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

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("contextmenu", onMenu);

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

      const { tool, color, width, enabled } = live.current;
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
