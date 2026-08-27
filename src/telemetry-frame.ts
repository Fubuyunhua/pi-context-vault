import { createHash } from "node:crypto";

const PREFIX = "@@CONTEXT_VAULT_TELEMETRY_V1@@";
const SUFFIX = "@@END_CONTEXT_VAULT_TELEMETRY@@";

export function frameTelemetry(value: unknown): string {
  const payload = JSON.stringify(value);
  const bytes = Buffer.byteLength(payload, "utf8");
  const hash = createHash("sha256").update(payload, "utf8").digest("hex");
  return `${PREFIX} ${bytes} ${hash}\n${payload}\n${SUFFIX}`;
}

export function extractTelemetryFrame(output: string): unknown {
  const header = new RegExp(`${PREFIX} (\\d+) ([a-f0-9]{64})\\n`, "gu");
  const matches = [...output.matchAll(header)];
  if (matches.length !== 1) throw new Error(`Expected exactly one telemetry frame, found ${matches.length}`);
  const match = matches[0];
  const start = (match.index ?? 0) + match[0].length;
  const end = output.indexOf(`\n${SUFFIX}`, start);
  if (end < 0) throw new Error("Telemetry frame is truncated");
  const payload = output.slice(start, end);
  if (Buffer.byteLength(payload, "utf8") !== Number(match[1])) throw new Error("Telemetry frame length mismatch");
  const hash = createHash("sha256").update(payload, "utf8").digest("hex");
  if (hash !== match[2]) throw new Error("Telemetry frame hash mismatch");
  return JSON.parse(payload) as unknown;
}
