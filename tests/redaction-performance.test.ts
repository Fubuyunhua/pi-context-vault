import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { redactSecrets } from "../src/artifacts/redaction.js";
import { ArtifactStore } from "../src/artifacts/store.js";

const MEBIBYTE = 1024 * 1024;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function medianDurationFor(input: string, expectedContent: string, expectedCount: number): number {
  redactSecrets(input);
  const durations: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now();
    const result = redactSecrets(input);
    durations.push(performance.now() - started);
    expect(result).toEqual({ content: expectedContent, redactionCount: expectedCount });
  }
  durations.sort((left, right) => left - right);
  return durations[Math.floor(durations.length / 2)] as number;
}

function medianDuration(input: string): number {
  return medianDurationFor(input, input, 0);
}

describe("bounded secret redaction", () => {
  it("scales approximately linearly through a 1 MiB no-match line", { timeout: 20_000 }, () => {
    const sizes = [64, 128, 256, 512, 1024].map((kibibytes) => kibibytes * 1024);
    const durations = sizes.map((size) => medianDuration("x".repeat(size)));

    expect(durations[2]).toBeLessThan(2_000);
    expect(durations[4]).toBeLessThan(8_000);
    for (let index = 1; index < durations.length; index += 1) {
      expect(durations[index]).toBeLessThan((durations[index - 1] as number) * 3.5 + 50);
    }
  });

  it("scales approximately linearly across repeated unmatched private-key markers", { timeout: 20_000 }, () => {
    const marker = "-----BEGIN PRIVATE KEY-----";
    const counts = [2_048, 4_096, 8_192, 16_384, 32_768];
    const durations = counts.map((count) => medianDuration(marker.repeat(count)));

    expect(durations.at(-1)).toBeLessThan(8_000);
    for (let index = 1; index < durations.length; index += 1) {
      expect(durations[index]).toBeLessThan((durations[index - 1] as number) * 3.5 + 50);
    }
  });

  it("bounds adversarial separators, near-miss keys, and an unterminated quoted value", { timeout: 60_000 }, () => {
    const inputs = [
      "not_a_secretish=value;".repeat(Math.ceil(MEBIBYTE / 23)).slice(0, MEBIBYTE),
      "near-miss-key=value:=;".repeat(Math.ceil(MEBIBYTE / 22)).slice(0, MEBIBYTE),
      `TOKEN="${"x".repeat(MEBIBYTE)}`,
    ];

    for (const input of inputs) expect(medianDuration(input)).toBeLessThan(8_000);
  });

  it("avoids overlapping URL-regex retries on long hyphenated scheme/key near misses", { timeout: 20_000 }, () => {
    const sizes = [64, 128, 256, 512, 1024].map((kibibytes) => kibibytes * 1024);
    const durations = sizes.map((size) => {
      const suffix = "token=value";
      const input = `${"a-".repeat(Math.floor((size - suffix.length) / 2))}${suffix}`;
      const expected = `${input.slice(0, -"value".length)}[REDACTED]`;
      return medianDurationFor(input, expected, 1);
    });

    expect(durations[2]).toBeLessThan(2_000);
    expect(durations[4]).toBeLessThan(8_000);
    for (let index = 1; index < durations.length; index += 1) {
      expect(durations[index]).toBeLessThan((durations[index - 1] as number) * 3.5 + 50);
    }
  });

  it("redacts valid case-insensitive URL credentials near the end of a long line", () => {
    const prefix = `${"x".repeat(MEBIBYTE)};`;
    const input = `${prefix}HTTPS://user:p:a:ss@example.test/path`;
    expect(redactSecrets(input)).toEqual({
      content: `${prefix}HTTPS://user:[REDACTED]@example.test/path`,
      redactionCount: 1,
    });
  });

  it("redacts secret assignments near the end of a long single line without weakening key grammar", () => {
    const unicodeEvidence = "🙂漢字 remains visible";
    const prefix = `${"x".repeat(MEBIBYTE - 512)};message=${unicodeEvidence};`;
    const input =
      `${prefix}OPENAI_API_KEY="organization-secret";` +
      "AWS_SECRET_ACCESS_KEY=aws-secret;" +
      "foo-bar-auth-token='auth-secret';" +
      "client_secret=client-secret;" +
      '"password": "quoted-secret";' +
      'xxxTOKEN="quoted-suffix-secret";' +
      "xxxTOKEN=ordinary-value;status=healthy";

    const result = redactSecrets(input);

    expect(result.redactionCount).toBe(6);
    expect(result.content).toContain(`${prefix}OPENAI_API_KEY="[REDACTED]"`);
    expect(result.content).toContain(unicodeEvidence);
    expect(result.content).toContain("AWS_SECRET_ACCESS_KEY=[REDACTED]");
    expect(result.content).toContain("foo-bar-auth-token='[REDACTED]'");
    expect(result.content).toContain("client_secret=[REDACTED]");
    expect(result.content).toContain('"password": "[REDACTED]"');
    expect(result.content).toContain('xxxTOKEN="[REDACTED]"');
    expect(result.content).toContain("xxxTOKEN=ordinary-value");
    expect(result.content).toContain("status=healthy");
    expect(result.content).not.toContain("organization-secret");
    expect(result.content).not.toContain("aws-secret");
    expect(result.content).not.toContain("auth-secret");
    expect(result.content).not.toContain("client-secret");
    expect(result.content).not.toContain("quoted-secret");
    expect(result.content).not.toContain("quoted-suffix-secret");
  });

  it("preserves multiline credential and private-key redaction counts", () => {
    const input = [
      "Authorization: Bearer bearer-secret-token",
      "refresh_token=refresh-secret",
      "github_pat_abcdefghijklmnopqrstuvwxyz123456",
      "postgres://user:database-password@example.test/db",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "private-key-material",
      "-----END OPENSSH PRIVATE KEY-----",
      "ordinary output",
    ].join("\n");

    const result = redactSecrets(input);

    expect(result.redactionCount).toBe(5);
    expect(result.content).toContain("Authorization: Bearer [REDACTED]");
    expect(result.content).toContain("refresh_token=[REDACTED]");
    expect(result.content).toContain("postgres://user:[REDACTED]@example.test/db");
    expect(result.content).toContain(
      "-----BEGIN OPENSSH PRIVATE KEY-----\n[REDACTED]\n-----END OPENSSH PRIVATE KEY-----",
    );
    expect(result.content).toContain("ordinary output");
    expect(result.content).not.toContain("private-key-material");
    expect(result.content).not.toContain("database-password");
  });

  it("archives a 1 MiB Observation with a near-end secret within a bounded time", { timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "context-vault-redaction-scale-"));
    roots.push(root);
    const store = new ArtifactStore({
      artifactsRoot: join(root, "artifacts"),
      metadataRoot: join(root, "metadata"),
    });
    const secret = "one-mebibyte-secret-value";
    const content = `${"x".repeat(MEBIBYTE)};TOKEN=${secret}`;
    const started = performance.now();

    const archived = await store.archive({
      observationId: "one-mebibyte-observation",
      toolName: "read",
      sessionId: "session",
      content,
    });
    const duration = performance.now() - started;
    const persisted = await store.read(archived.artifactId);

    expect(duration).toBeLessThan(10_000);
    expect(archived.metadata.originalBytes).toBe(Buffer.byteLength(content));
    expect(archived.metadata.redactionCount).toBe(1);
    expect(persisted).toBe(`${"x".repeat(MEBIBYTE)};TOKEN=[REDACTED]`);
    expect(persisted).not.toContain(secret);
  });
});
