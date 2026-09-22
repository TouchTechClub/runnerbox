import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Fake terminal block — always dark (a terminal is dark regardless of theme).
 * Lines are passed as children; use <TermLine> for prompt/comment styling.
 */
function Terminal({ className, title = "terminal", children, ...props }: ComponentProps<"div"> & { title?: string }) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-zinc-800 bg-zinc-950 text-zinc-300",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-1.5 border-b border-zinc-800 px-3 py-2">
        <span className="size-2.5 rounded-full bg-zinc-700" />
        <span className="size-2.5 rounded-full bg-zinc-700" />
        <span className="size-2.5 rounded-full bg-zinc-700" />
        <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
          {title}
        </span>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap p-3.5 font-mono text-xs leading-relaxed">
        {children}
      </pre>
    </div>
  );
}

function TermLine({
  prompt = false,
  comment = false,
  className,
  children,
}: {
  prompt?: boolean;
  comment?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn(comment && "text-zinc-600", className)}>
      {prompt ? <span className="mr-2 select-none text-emerald-400">$</span> : null}
      {children}
    </div>
  );
}

export { Terminal, TermLine };
