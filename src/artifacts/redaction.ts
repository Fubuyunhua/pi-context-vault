export interface RedactionResult {
  content: string;
  redactionCount: number;
}

const REDACTED = "[REDACTED]";
const PRIVATE_KEY_TYPES = ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY"] as const;
const PRIVATE_KEY_BEGIN_PREFIX = "-----BEGIN ";
const PRIVATE_KEY_END_PREFIX = "-----END ";
const SECRET_KEY_EXACT =
  /^(?:api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|private[_-]?key)$/i;
const MAX_SECRET_KEY_TERMINAL_LENGTH = 32;
const WHITESPACE = /\s/u;

type PrivateKeyType = (typeof PRIVATE_KEY_TYPES)[number];

interface AssignmentKey {
  key: string;
  keyStart: number;
  trailingQuote?: string;
}

function isAsciiAlphaNumeric(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isKeyCharacter(character: string): boolean {
  return isAsciiAlphaNumeric(character) || character === "_" || character === "-";
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && (isAsciiAlphaNumeric(character) || character === "_");
}

function isQuote(character: string | undefined): character is '"' | "'" {
  return character === '"' || character === "'";
}

function assignmentKeyBefore(input: string, separatorIndex: number): AssignmentKey | undefined {
  let cursor = separatorIndex;
  while (cursor > 0 && WHITESPACE.test(input[cursor - 1] as string)) cursor -= 1;

  const trailingQuote = isQuote(input[cursor - 1]) ? input[cursor - 1] : undefined;
  if (trailingQuote !== undefined) cursor -= 1;

  const keyEnd = cursor;
  while (cursor > 0 && isKeyCharacter(input[cursor - 1] as string)) cursor -= 1;
  if (cursor === keyEnd) return undefined;

  const keyStart = cursor;
  return {
    key: input.slice(keyStart, keyEnd),
    keyStart,
    trailingQuote,
  };
}

/**
 * Return every start within an ASCII assignment key accepted by the legacy
 * secret-key grammar. Retaining the less-greedy starts is required because
 * the unquoted legacy regex retries a terminal suffix when a greedy namespace
 * extension does not begin at a word boundary (for example `_foo-token`).
 */
function secretKeyStarts(key: string): number[] {
  const starts = new Set<number>();
  const firstPossibleTerminal = Math.max(0, key.length - MAX_SECRET_KEY_TERMINAL_LENGTH);
  for (let terminalStart = firstPossibleTerminal; terminalStart < key.length; terminalStart += 1) {
    if (!SECRET_KEY_EXACT.test(key.slice(terminalStart))) continue;

    let start = terminalStart;
    starts.add(start);
    while (start > 0 && (key[start - 1] === "_" || key[start - 1] === "-")) {
      const segmentEnd = start - 1;
      let segmentStart = segmentEnd;
      while (segmentStart > 0 && isAsciiAlphaNumeric(key[segmentStart - 1] as string)) segmentStart -= 1;
      if (segmentStart === segmentEnd) break;
      start = segmentStart;
      starts.add(start);
    }
  }
  return [...starts].sort((left, right) => left - right);
}

function privateKeyTypeAt(input: string, markerIndex: number, prefix: string): PrivateKeyType | undefined {
  for (const keyType of PRIVATE_KEY_TYPES) {
    if (input.startsWith(`${prefix}${keyType}-----`, markerIndex)) return keyType;
  }
  return undefined;
}

function replacePrivateKeys(input: string): { content: string; count: number } {
  const endPositions = new Map<PrivateKeyType, number[]>(PRIVATE_KEY_TYPES.map((keyType) => [keyType, []]));
  let markerCursor = 0;
  while (markerCursor < input.length) {
    const markerIndex = input.indexOf(PRIVATE_KEY_END_PREFIX, markerCursor);
    if (markerIndex < 0) break;
    const keyType = privateKeyTypeAt(input, markerIndex, PRIVATE_KEY_END_PREFIX);
    if (keyType !== undefined) endPositions.get(keyType)?.push(markerIndex);
    markerCursor = markerIndex + PRIVATE_KEY_END_PREFIX.length;
  }

  const endCursors = new Map<PrivateKeyType, number>(PRIVATE_KEY_TYPES.map((keyType) => [keyType, 0]));
  const output: string[] = [];
  let outputStart = 0;
  let count = 0;
  let cursor = 0;
  while (cursor < input.length) {
    const beginIndex = input.indexOf(PRIVATE_KEY_BEGIN_PREFIX, cursor);
    if (beginIndex < 0) break;
    const keyType = privateKeyTypeAt(input, beginIndex, PRIVATE_KEY_BEGIN_PREFIX);
    if (keyType === undefined) {
      cursor = beginIndex + PRIVATE_KEY_BEGIN_PREFIX.length;
      continue;
    }

    const beginMarker = `${PRIVATE_KEY_BEGIN_PREFIX}${keyType}-----`;
    const endMarker = `${PRIVATE_KEY_END_PREFIX}${keyType}-----`;
    const positions = endPositions.get(keyType) as number[];
    let endCursor = endCursors.get(keyType) as number;
    const contentStart = beginIndex + beginMarker.length;
    while (endCursor < positions.length && (positions[endCursor] as number) < contentStart) endCursor += 1;
    endCursors.set(keyType, endCursor);
    const endIndex = positions[endCursor];
    if (endIndex === undefined) {
      cursor = beginIndex + PRIVATE_KEY_BEGIN_PREFIX.length;
      continue;
    }

    const matchEnd = endIndex + endMarker.length;
    output.push(input.slice(outputStart, beginIndex), `${beginMarker}\n${REDACTED}\n${endMarker}`);
    outputStart = matchEnd;
    count += 1;
    cursor = matchEnd;
  }

  if (count === 0) return { content: input, count: 0 };
  output.push(input.slice(outputStart));
  return { content: output.join(""), count };
}

function skipWhitespace(input: string, start: number): number {
  let cursor = start;
  while (cursor < input.length && WHITESPACE.test(input[cursor] as string)) cursor += 1;
  return cursor;
}

function replaceQuotedAssignments(input: string): { content: string; count: number } {
  const output: string[] = [];
  let outputStart = 0;
  let count = 0;
  let cursor = 0;

  while (cursor < input.length) {
    const character = input[cursor];
    if (character !== ":" && character !== "=") {
      cursor += 1;
      continue;
    }

    const assignment = assignmentKeyBefore(input, cursor);
    if (assignment === undefined || secretKeyStarts(assignment.key).length === 0) {
      cursor += 1;
      continue;
    }

    const quoteIndex = skipWhitespace(input, cursor + 1);
    const quote = input[quoteIndex];
    if (!isQuote(quote)) {
      cursor += 1;
      continue;
    }

    let closingQuote = quoteIndex + 1;
    while (
      closingQuote < input.length &&
      input[closingQuote] !== quote &&
      input[closingQuote] !== "\r" &&
      input[closingQuote] !== "\n"
    ) {
      closingQuote += 1;
    }
    if (input[closingQuote] !== quote) {
      cursor += 1;
      continue;
    }

    output.push(input.slice(outputStart, quoteIndex + 1), REDACTED);
    outputStart = closingQuote;
    count += 1;
    cursor = closingQuote + 1;
  }

  if (count === 0) return { content: input, count: 0 };
  output.push(input.slice(outputStart));
  return { content: output.join(""), count };
}

function replaceUnquotedAssignments(input: string): { content: string; count: number } {
  const output: string[] = [];
  let outputStart = 0;
  let count = 0;
  let cursor = 0;

  while (cursor < input.length) {
    const character = input[cursor];
    if (character !== ":" && character !== "=") {
      cursor += 1;
      continue;
    }

    const assignment = assignmentKeyBefore(input, cursor);
    let secretStart: number | undefined;
    if (assignment !== undefined && assignment.trailingQuote === undefined) {
      secretStart = secretKeyStarts(assignment.key)
        .map((relativeStart) => assignment.keyStart + relativeStart)
        .find((start) => !isWordCharacter(input[start - 1]));
    }
    if (secretStart === undefined) {
      cursor += 1;
      continue;
    }

    const valueStart = skipWhitespace(input, cursor + 1);
    if (valueStart >= input.length || isQuote(input[valueStart])) {
      cursor += 1;
      continue;
    }

    let valueEnd = valueStart;
    while (
      valueEnd < input.length &&
      !WHITESPACE.test(input[valueEnd] as string) &&
      input[valueEnd] !== "," &&
      input[valueEnd] !== ";"
    ) {
      valueEnd += 1;
    }
    if (valueEnd === valueStart) {
      cursor += 1;
      continue;
    }

    output.push(input.slice(outputStart, valueStart), REDACTED);
    outputStart = valueEnd;
    count += 1;
    cursor = valueEnd;
  }

  if (count === 0) return { content: input, count: 0 };
  output.push(input.slice(outputStart));
  return { content: output.join(""), count };
}

export function redactSecrets(input: string): RedactionResult {
  let content = input;
  let redactionCount = 0;

  const replace = (pattern: RegExp, replacement: (...matches: string[]) => string): void => {
    content = content.replace(pattern, (...args: unknown[]) => {
      redactionCount += 1;
      return replacement(...(args.slice(0, -2) as string[]));
    });
  };

  const privateKeys = replacePrivateKeys(content);
  content = privateKeys.content;
  redactionCount += privateKeys.count;

  replace(/(\bAuthorization\s*[:=]\s*["']?Bearer\s+)[^\s"',;]+/gi, (_match, prefix) => `${prefix}${REDACTED}`);

  const quotedAssignments = replaceQuotedAssignments(content);
  content = quotedAssignments.content;
  redactionCount += quotedAssignments.count;

  const unquotedAssignments = replaceUnquotedAssignments(content);
  content = unquotedAssignments.content;
  redactionCount += unquotedAssignments.count;

  replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, () => REDACTED);
  replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi,
    (_match, prefix, suffix) => `${prefix}${REDACTED}${suffix}`,
  );

  return { content, redactionCount };
}
