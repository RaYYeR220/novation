/** Joins class names, skipping falsy parts. Callers pass layout classes, not overrides of a primitive's own look. */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
