import type { HTMLAttributes } from "react";

function cn(...parts: Array<string | undefined | false>) {
  return parts.filter(Boolean).join(" ");
}

/**
 * shadcn-style: spreads props onto the DOM node, so the rendered <div>
 * carries BOTH data-oid (this file) and data-oid-call (where <Card> was
 * used). The overlay edits whichever location owns the class token.
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-xl border border-slate-800 bg-slate-900 p-6", className)}
      {...props}
    />
  );
}
