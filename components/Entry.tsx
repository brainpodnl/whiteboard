"use client";

import { useState } from "react";
import { BrainpodMark } from "@/components/Marks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { COLOR_COUNT, MAX_NAME_LENGTH } from "@/shared/constants";
import { USER_COLORS } from "@/lib/palette";
import { cn } from "@/lib/utils";

type Props = {
  name: string;
  color: number;
  onStart: (name: string, color: number) => void;
};

export default function Entry({ name: initial, color: initialColor, onStart }: Props) {
  const [name, setName] = useState(initial);
  const [color, setColor] = useState(initialColor);

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center overflow-y-auto bg-[radial-gradient(ellipse_70%_60%_at_50%_45%,rgb(12_11_9/0.9),rgb(12_11_9/0.66))] px-5 py-8">
      <form
        className="animate-rise flex w-full max-w-sm flex-col items-center text-center"
        onSubmit={(event) => {
          event.preventDefault();
          onStart(name.trim() || initial, color);
        }}
      >
        <BrainpodMark className="h-5 w-auto text-bone" />

        <h1 className="mt-5 font-sans text-4xl font-medium tracking-tight text-bone sm:text-5xl">
          Whiteboard
        </h1>

        <p className="mt-3 text-note text-faint sm:text-sm">
          One board, no pan and no zoom — what you draw lands in the same place on
          everyone&rsquo;s screen.
        </p>

        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={MAX_NAME_LENGTH}
          placeholder="Your name"
          aria-label="Your name"
          autoComplete="off"
          spellCheck={false}
          className="mt-7 text-center"
        />

        <div
          role="radiogroup"
          aria-label="Your colour"
          className="mt-4 flex items-center justify-center gap-1.5"
        >
          {USER_COLORS.slice(0, COLOR_COUNT).map((swatch, index) => (
            <button
              key={swatch}
              type="button"
              role="radio"
              aria-checked={index === color}
              aria-label={`Colour ${index + 1}`}
              onClick={() => setColor(index)}
              className="grid size-9 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-beam/60"
            >
              <span
                className={cn(
                  "block rounded-full transition-all",
                  index === color ? "size-7 ring-2 ring-bone/80" : "size-5 hover:size-6",
                )}
                style={{ background: swatch }}
              />
            </button>
          ))}
        </div>

        <Button type="submit" size="lg" className="mt-6 w-full">
          Start drawing
        </Button>

        <p className="hud-label mt-5">No signup, no cookies</p>
      </form>
    </div>
  );
}
