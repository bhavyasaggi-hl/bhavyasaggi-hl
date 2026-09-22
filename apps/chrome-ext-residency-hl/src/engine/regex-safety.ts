/**
 * Rejects regular expressions that can backtrack catastrophically.
 *
 * A policy is data, but `matches` hands it to the JavaScript engine, and
 * `^(a+)+$` against forty characters takes over a minute — inside the service
 * worker, that is a hang for the whole session. There is no way to time-box a
 * running regex in JavaScript, so the pattern is screened before it is ever
 * compiled.
 *
 * The screen is star height: a quantified group whose body also contains an
 * expanding quantifier. That is the shape behind essentially every real-world
 * ReDoS, and it is what `safe-regex` checks — without the 200 KB dependency
 * tree. It is a heuristic: conservative in the direction of rejecting a pattern
 * that would have been fine, never of accepting one that hangs on this shape.
 */

/** Longest subject a pattern is ever run against, as a second line of defence. */
export const MAX_MATCH_INPUT = 8 * 1024;

/** Repetitions above this make a bounded quantifier behave like an unbounded one. */
const LARGE_REPEAT = 10;

interface Frame {
  /** The group body contains a quantifier that can expand. */
  expanding: boolean;
}

function markExpanding(stack: readonly Frame[]): void {
  const frame = stack.at(-1);
  if (frame !== undefined) {
    frame.expanding = true;
  }
}

function isExpandingQuantifier(
  pattern: string,
  at: number,
): { readonly expanding: boolean; readonly next: number } {
  const char = pattern[at];
  if (char === '*' || char === '+') {
    return { expanding: true, next: at + 1 };
  }
  if (char !== '{') {
    return { expanding: false, next: at };
  }
  const close = pattern.indexOf('}', at);
  if (close === -1) {
    return { expanding: false, next: at };
  }
  const body = pattern.slice(at + 1, close);
  const match = /^(?<min>\d*)(?<comma>,?)(?<max>\d*)$/u.exec(body);
  if (match === null) {
    return { expanding: false, next: at };
  }
  const max = match.groups?.['max'] ?? '';
  const unbounded = match.groups?.['comma'] === ',' && max === '';
  const large = max !== '' && Number(max) >= LARGE_REPEAT;
  return { expanding: unbounded || large, next: close + 1 };
}

/**
 * Returns a reason when `pattern` looks vulnerable, or `null` when it passes.
 * A pattern that is not valid at all is left to `new RegExp` to report.
 */
/** The verdict of scanning one atom: where to resume, and whether it is fatal. */
interface Step {
  readonly next: number;
  readonly risk?: string;
}

const NESTED_QUANTIFIERS =
  'nested quantifiers can backtrack catastrophically — rewrite without a repeated group that itself repeats';

/** `\d+` expands exactly like `a+`; an escape is one atom whatever it escapes. */
function stepEscape(pattern: string, cursor: number, stack: readonly Frame[]): Step {
  const after = isExpandingQuantifier(pattern, cursor + 2);
  if (after.expanding) {
    markExpanding(stack);
  }
  return { next: Math.max(after.next, cursor + 2) };
}

/** A character class is one atom too, however long it runs. */
function stepClass(pattern: string, cursor: number, stack: readonly Frame[]): Step {
  const end = pattern.indexOf(']', cursor + 1);
  const after = isExpandingQuantifier(pattern, end === -1 ? pattern.length : end + 1);
  if (after.expanding) {
    markExpanding(stack);
  }
  return { next: after.next };
}

/**
 * Closing a group is where the risk is decided: a group that repeats, whose
 * body also repeats, is the star-height shape this screen exists to catch.
 */
function stepGroupClose(pattern: string, cursor: number, stack: Frame[]): Step {
  const closed = stack.pop() ?? { expanding: false };
  const after = isExpandingQuantifier(pattern, cursor + 1);
  if (after.expanding && closed.expanding) {
    return { next: after.next, risk: NESTED_QUANTIFIERS };
  }
  const parent = stack.at(-1);
  if (parent !== undefined && (closed.expanding || after.expanding)) {
    parent.expanding = true;
  }
  return { next: after.next };
}

/** Any other character is a literal atom. */
function stepLiteral(pattern: string, cursor: number, stack: readonly Frame[]): Step {
  const after = isExpandingQuantifier(pattern, cursor + 1);
  if (!after.expanding) {
    return { next: cursor + 1 };
  }
  markExpanding(stack);
  return { next: after.next };
}

/**
 * Returns a reason when `pattern` looks vulnerable, or `null` when it passes.
 * A pattern that is not valid at all is left to `new RegExp` to report.
 */
export function catastrophicRisk(pattern: string): string | null {
  const stack: Frame[] = [{ expanding: false }];
  let cursor = 0;

  while (cursor < pattern.length) {
    const char = pattern[cursor];
    let step: Step;
    if (char === '\\') {
      step = stepEscape(pattern, cursor, stack);
    } else if (char === '[') {
      step = stepClass(pattern, cursor, stack);
    } else if (char === '(') {
      stack.push({ expanding: false });
      step = { next: cursor + 1 };
    } else if (char === ')') {
      step = stepGroupClose(pattern, cursor, stack);
    } else {
      step = stepLiteral(pattern, cursor, stack);
    }
    if (step.risk !== undefined) {
      return step.risk;
    }
    // Every branch consumes at least one character, so the scan terminates.
    cursor = Math.max(step.next, cursor + 1);
  }

  return null;
}
