import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractTelemetryFrame, frameTelemetry } from "../src/telemetry-frame.js";

describe("Vault telemetry framing", () => {
  it("round-trips one bounded Vault-only frame", () => {
    const payload = { extension: { id: "context-vault", version: "0.2.0" }, telemetry: { archiveAttemptCount: 1 } };
    const framed = frameTelemetry(payload);
    expect(extractTelemetryFrame(`prefix\n${framed}\nsuffix`)).toEqual(payload);
    expect(framed).not.toContain("repoMap");
  });

  it("rejects missing and duplicate frames", () => {
    expect(() => extractTelemetryFrame("plain output")).toThrow("found 0");
    const frame = frameTelemetry({ ok: true });
    expect(() => extractTelemetryFrame(`${frame}\n${frame}`)).toThrow("found 2");
  });

  it("rejects truncated, length-corrupt, hash-corrupt, and invalid JSON payloads", () => {
    const frame = frameTelemetry({ value: "evidence" });
    expect(() => extractTelemetryFrame(frame.replace("\n@@END_CONTEXT_VAULT_TELEMETRY@@", ""))).toThrow("truncated");
    expect(() =>
      extractTelemetryFrame(frame.replace(/@@CONTEXT_VAULT_TELEMETRY_V1@@ \d+/u, (row) => `${row}0`)),
    ).toThrow("length mismatch");
    expect(() => extractTelemetryFrame(frame.replace(/[a-f0-9]{64}/u, "0".repeat(64)))).toThrow("hash mismatch");

    const invalidPayload = "not-json";
    const invalidFrame = frameTelemetry(invalidPayload).replace(JSON.stringify(invalidPayload), invalidPayload);
    const bytes = Buffer.byteLength(invalidPayload, "utf8");
    const hash = createHash("sha256").update(invalidPayload).digest("hex");
    const coherentInvalid = invalidFrame.replace(
      /@@CONTEXT_VAULT_TELEMETRY_V1@@ \d+ [a-f0-9]{64}/u,
      `@@CONTEXT_VAULT_TELEMETRY_V1@@ ${bytes} ${hash}`,
    );
    expect(() => extractTelemetryFrame(coherentInvalid)).toThrow();
  });
});
