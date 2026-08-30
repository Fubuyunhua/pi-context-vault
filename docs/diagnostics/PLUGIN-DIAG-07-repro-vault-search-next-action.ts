import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../src/artifacts/store.ts";
import { ObservationRuntime } from "../../src/observations/virtualization.ts";

const marker = "NEXT_ACTION_DEEP_MARKER_7f31";
const root = await mkdtemp(join(tmpdir(), "vault-next-action-repro-"));
try {
  const artifactsRoot = join(root, "artifacts");
  await mkdir(artifactsRoot);
  const runtime = new ObservationRuntime({
    store: new ArtifactStore({ artifactsRoot, metadataRoot: join(root, "metadata") }),
    archiveThresholdBytes: 1,
    receiptMaxBytes: 512,
    projectId: "project",
    projectRoot: root,
    sessionId: "session",
  });
  const content = `${"unrelated-prefix|".repeat(1100)}\n${marker}\nAuthoritative detail line two.\n`;
  const archived = await runtime.virtualize({ toolCallId: "deep", toolName: "pressure_log", text: content, isError: false });
  const search = await runtime.search({ query: marker, maxBytes: 4096 });
  const hit = search.results[0];
  if (!hit) throw new Error("search unexpectedly missed the marker");
  const exactNextAction: any = hit.nextAction;
  const exactGet = await runtime.get(exactNextAction.arguments);
  const queryGet = await runtime.get({ id: exactNextAction.arguments.id, query: marker });
  const output = {
    observationId: archived.observationId,
    contentBytes: Buffer.byteLength(content),
    receiptContainsMarker: archived.replacement?.includes(marker) ?? false,
    searchContainsMarker: hit.matches.some((match) => match.text.includes(marker)),
    searchMatches: hit.matches,
    nextAction: exactNextAction,
    nextActionGet: {
      byteStart: exactGet.evidence?.byteStart,
      byteEnd: exactGet.evidence?.byteEnd,
      truncated: exactGet.evidence?.truncated,
      containsMarker: exactGet.evidence?.text.includes(marker) ?? false,
    },
    queryGetContainsMarker: queryGet.matches?.some((match) => match.text.includes(marker)) ?? false,
    reproduced: !(exactGet.evidence?.text.includes(marker) ?? false) && (queryGet.matches?.some((match) => match.text.includes(marker)) ?? false),
  };
  console.log(JSON.stringify(output, null, 2));
  if (!output.reproduced) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
