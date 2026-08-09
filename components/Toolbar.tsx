"use client";

import { useEffect, useRef } from "react";
import { Eraser, Pen, Redo2, Undo2 } from "lucide-react";
import { COLOR_COUNT, WIDTHS } from "@/shared/constants";
import { USER_COLORS, userColor } from "@/lib/palette";
import { cn } from "@/lib/utils";
import type { Tool } from "@/components/Canvas";

type Props = {
  tool: Tool;
  color: number;
  width: number;
  canUndo: boolean;
  canRedo: boolean;
  onTool: (tool: Tool) => void;
  onColor: (color: number) => void;
  onWidth: (width: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  className?: string;
};

export default function Toolbar(props: Props) {
  const {
    tool,
    color,
    width,
    canUndo,
    canRedo,
    onTool,
    onColor,
    onWidth,
    onUndo,
    onRedo,
    className,
  } = props;

  const live = useRef(props);
  live.current = props;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }

      const api = live.current;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) api.onRedo();
        else api.onUndo();
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "e" || event.key === "E") api.onTool("eraser");
      else if (event.key === "p" || event.key === "P") api.onTool("pen");
      else if (event.key >= "1" && event.key <= "8") {
        api.onColor(Number(event.key) - 1);
        api.onTool("pen");
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className={cn(
        "flex max-w-[calc(100vw-1.5rem)] flex-wrap items-center justify-center gap-x-1 gap-y-2 rounded-3xl border border-edge bg-hull/80 px-2.5 py-2 backdrop-blur-sm sm:rounded-full",
        className,
      )}
    >
      <div role="radiogroup" aria-label="Ink colour" className="flex items-center gap-1">
        {USER_COLORS.slice(0, COLOR_COUNT).map((swatch, index) => {
          const active = index === color && tool === "pen";
          return (
            <button
              key={swatch}
              type="button"
              role="radio"
              aria-checked={index === color}
              aria-label={`Colour ${index + 1}`}
              title={`Colour ${index + 1} (${index + 1})`}
              onClick={() => {
                onColor(index);
                onTool("pen");
              }}
              className="grid size-8 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-beam/60"
            >
              <span
                className={cn(
                  "block rounded-full transition-all",
                  active ? "size-6 ring-2 ring-bone/80" : "size-4 hover:size-5",
                )}
                style={{ background: swatch }}
              />
            </button>
          );
        })}
      </div>

      <Divider />

      <div role="radiogroup" aria-label="Stroke width" className="flex items-center gap-0.5">
        {WIDTHS.map((value, index) => {
          const active = index === width;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={`Width ${value}`}
              onClick={() => onWidth(index)}
              className={cn(
                "grid size-8 place-items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-beam/60",
                active ? "bg-panel" : "hover:bg-panel/60",
              )}
            >
              <span
                className="block rounded-full"
                style={{
                  width: 3 + index * 3,
                  height: 3 + index * 3,
                  background: active ? userColor(color) : "var(--color-ash)",
                }}
              />
            </button>
          );
        })}
      </div>

      <Divider />

      <div className="flex items-center gap-0.5">
        <Tile
          label="Pen"
          hint="P"
          active={tool === "pen"}
          onClick={() => onTool("pen")}
        >
          <Pen className="size-4" />
        </Tile>
        <Tile
          label="Eraser"
          hint="E"
          active={tool === "eraser"}
          onClick={() => onTool("eraser")}
        >
          <Eraser className="size-4" />
        </Tile>
      </div>

      <Divider />

      <div className="flex items-center gap-0.5">
        <Tile label="Undo" hint="⌘Z" disabled={!canUndo} onClick={onUndo}>
          <Undo2 className="size-4" />
        </Tile>
        <Tile label="Redo" hint="⇧⌘Z" disabled={!canRedo} onClick={onRedo}>
          <Redo2 className="size-4" />
        </Tile>
      </div>
    </div>
  );
}

function Tile({
  label,
  hint,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  hint: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={`${label} (${hint})`}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid size-9 place-items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-beam/60 disabled:pointer-events-none disabled:opacity-35",
        active ? "bg-panel text-bone" : "text-ash hover:bg-panel/60 hover:text-faint",
      )}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span aria-hidden className="mx-1 hidden h-5 w-px bg-edge sm:block" />;
}
