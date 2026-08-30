import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/artifacts/redaction.js";

const REDACTED = "[REDACTED]";

function legacyRedactSecrets(input: string): { content: string; redactionCount: number } {
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

function assignmentCompatibilityCorpus(): string[] {
  const boundaryPrefixes = ["", "_", "__", "a", "a_", "a-", "-", ".", " ", "🙂", "'", '"'];
  const keys = [
    "foo-token",
    "auth-token",
    "refresh-token",
    "client-secret",
    "api_key",
    "OPENAI_API_KEY",
    "secret_access_key",
    "private-key",
    "password",
    "passwd",
    "secret",
    "not_a_secretish",
  ];
  const separators = ["=", ":", " = ", " : "];
  const values = ["ordinary-value", '"quoted value"', "'single quoted value'", "value,tail", "value;tail"];
  const suffixes = ["", "\nstatus=healthy", ";next=value"];
  const corpus: string[] = [];
  for (const boundary of boundaryPrefixes) {
    for (const key of keys) {
      for (const separator of separators) {
        for (const value of values) {
          for (const suffix of suffixes) corpus.push(`${boundary}${key}${separator}${value}${suffix}`);
        }
      }
    }
  }
  return corpus;
}

describe("redaction compatibility", () => {
  it("matches the legacy assignment grammar and counts across deterministic boundary prefixes", () => {
    const corpus = assignmentCompatibilityCorpus();
    expect(corpus.length).toBe(8_640);
    for (const input of corpus) expect(redactSecrets(input)).toEqual(legacyRedactSecrets(input));
  });

  it.each(["_foo-token", "_auth-token", "_refresh-token", "_client-secret"])(
    "retries a valid word-boundary suffix for %s",
    (key) => {
      expect(redactSecrets(`${key}=legacy-secret`)).toEqual({
        content: `${key}=${REDACTED}`,
        redactionCount: 1,
      });
    },
  );

  it("preserves complete and mixed private-key block behavior", () => {
    const input = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "outer material",
      "-----BEGIN EC PRIVATE KEY-----",
      "inner material",
      "-----END EC PRIVATE KEY-----",
      "-----END RSA PRIVATE KEY-----",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "openssh material",
      "-----END OPENSSH PRIVATE KEY-----",
      "-----BEGIN PRIVATE KEY-----",
      "unterminated material",
    ].join("\n");

    expect(redactSecrets(input)).toEqual(legacyRedactSecrets(input));
    expect(redactSecrets(input)).toEqual({
      content: [
        "-----BEGIN RSA PRIVATE KEY-----",
        REDACTED,
        "-----END RSA PRIVATE KEY-----",
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        REDACTED,
        "-----END OPENSSH PRIVATE KEY-----",
        "-----BEGIN PRIVATE KEY-----",
        "unterminated material",
      ].join("\n"),
      redactionCount: 2,
    });
  });
});
