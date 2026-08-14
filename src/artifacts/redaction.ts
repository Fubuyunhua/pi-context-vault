export interface RedactionResult {
  content: string;
  redactionCount: number;
}

const REDACTED = "[REDACTED]";

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

  const secretKey =
    "(?:(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|private[_-]?key))";
  replace(
    new RegExp(`(["']?${secretKey}["']?\\s*[:=]\\s*)(["'])([^\\r\\n]*?)\\2`, "gi"),
    (_match, prefix, quote) => `${prefix}${quote}${REDACTED}${quote}`,
  );
  replace(
    new RegExp(`(\\b${secretKey}\\b\\s*[:=]\\s*)(?!["'])([^\\s,;]+)`, "gi"),
    (_match, prefix) => `${prefix}${REDACTED}`,
  );
  replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, () => REDACTED);
  replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi,
    (_match, prefix, suffix) => `${prefix}${REDACTED}${suffix}`,
  );

  return { content, redactionCount };
}
