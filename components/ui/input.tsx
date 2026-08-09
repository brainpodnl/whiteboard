import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-12 w-full rounded-full border border-edge bg-panel/70 px-5 font-mono text-base tracking-[0.12em] text-bone uppercase placeholder:tracking-normal placeholder:text-ash placeholder:normal-case transition-colors outline-none focus-visible:border-beam/70 focus-visible:ring-2 focus-visible:ring-beam/25",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
