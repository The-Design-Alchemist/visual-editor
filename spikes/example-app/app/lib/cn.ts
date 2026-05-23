/**
 * Minimal cn() — concatenates string args, ignoring falsy.
 * Real codebases would use clsx + tailwind-merge here; for the spike's
 * v0.2 verification this is enough to exercise the safety-analyzed
 * mutation path in packages/server/src/ast/className.ts.
 */
export function cn(...args: Array<string | false | null | undefined>): string {
  return args.filter(Boolean).join(" ");
}
