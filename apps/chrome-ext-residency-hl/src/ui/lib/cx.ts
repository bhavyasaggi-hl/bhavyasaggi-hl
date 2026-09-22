/** Joins class names, dropping falsy entries. */

export function cx(...parts: readonly (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ');
}
