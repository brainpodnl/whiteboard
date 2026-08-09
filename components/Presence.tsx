"use client";

import type { Person } from "@/shared/protocol";
import { userColor } from "@/lib/palette";
import { cn } from "@/lib/utils";

const VISIBLE = 8;

export default function Presence({
  people,
  self,
  className,
}: {
  people: Person[];
  self: number;
  className?: string;
}) {
  if (!people.length) return null;

  const ordered = [...people].sort((a, b) =>
    a.author === self ? -1 : b.author === self ? 1 : a.author - b.author,
  );
  const shown = ordered.slice(0, VISIBLE);
  const hidden = ordered.length - shown.length;

  return (
    <div
      className={cn(
        "flex max-w-[9.5rem] flex-col gap-1 rounded-2xl border border-edge bg-hull/80 px-3 py-2 backdrop-blur-sm sm:max-w-[11rem]",
        className,
      )}
    >
      <p className="hud-label">{people.length} here</p>

      {shown.map((person) => (
        <div key={person.author} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: userColor(person.color) }}
          />
          <span
            className={cn(
              "truncate font-mono text-[11px] tracking-[0.04em]",
              person.author === self ? "text-bone" : "text-faint",
            )}
          >
            {person.name}
          </span>
        </div>
      ))}

      {hidden > 0 ? (
        <p className="font-mono text-[11px] tracking-[0.04em] text-ash">
          +{hidden} more
        </p>
      ) : null}
    </div>
  );
}


