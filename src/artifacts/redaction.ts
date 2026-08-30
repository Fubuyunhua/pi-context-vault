export interface RedactionResult {
  content: string;
  redactionCount: number;
}

const REDACTED = "[REDACTED]";
const SECRET_KEY_SUFFIX =
  /(?:api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|private[_-]?key)$/i;
const WHITESPACE = /\s/u;

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
 * Return the earliest start within an ASCII assignment key accepted by the
 * legacy secret-key grammar. A terminal secret name is always accepted; it
 * may extend left through separator-delimited alphanumeric namespace parts.
 */
function secretKeyStart(key: string): number | undefined {
  const suffix = SECRET_KEY_SUFFIX.exec(key);
  if (suffix === null) return undefined;

  let start = suffix.index;
  while (start > 0 && (key[start - 1] === "_" || key[start - 1] === "-")) {
    const segmentEnd = start - 1;
    let segmentStart = segmentEnd;
    while (segmentStart > 0 && isAsciiAlphaNumeric(key[segmentStart - 1] as string)) segmentStart -= 1;
    if (segmentStart === segmentEnd) break;
    start = segmentStart;
  }
  return start;
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
    if (assignment === undefined || secretKeyStart(assignment.key) === undefined) {
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
    const relativeSecretStart = assignment === undefined ? undefined : secretKeyStart(assignment.key);
    const secretStart =
      assignment === undefined || relativeSecretStart === undefined
        ? undefined
        : assignment.keyStart + relativeSecretStart;
    if (
      assignment === undefined ||
      secretStart === undefined ||
      assignment.trailingQuote !== undefined ||
      isWordCharacter(input[secretStart - 1])
    ) {
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

  replace(
    /-----BEGIN ((?:RSA |EC |OPENSSH )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
    (_match, keyType) => `-----BEGIN ${keyType}-----\n${REDACTED}\n-----END ${keyType}-----`,
  );
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
