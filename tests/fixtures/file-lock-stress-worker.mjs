import { createServer } from "vite";

const [mode, first, second, workerText, countText] = process.argv.slice(2);
const vite = await createServer({ appType: "custom", logLevel: "silent", server: { middlewareMode: true } });

try {
  if (mode === "artifact") {
    const { ArtifactStore } = await vite.ssrLoadModule("/src/artifacts/store.ts");
    const store = new ArtifactStore({ artifactsRoot: first, metadataRoot: second });
    const worker = Number(workerText);
    const count = Number(countText);
    for (let index = 0; index < count; index += 1) {
      await store.archive({
        observationId: `worker-${worker}-observation-${index}`,
        toolName: "stress",
        sessionId: `worker-${worker}`,
        content: `artifact from ${worker}:${index}`,
      });
    }
  } else if (mode === "artifact-compact") {
    const { ArtifactStore } = await vite.ssrLoadModule("/src/artifacts/store.ts");
    const store = new ArtifactStore({
      artifactsRoot: first,
      metadataRoot: second,
      metadataCompactionThresholdBytes: 0,
      metadataCompactionThresholdObsoleteRecords: 1,
      metadataCompactionThresholdObsoleteRatio: 0,
    });
    await store.archive({
      observationId: "shared-observation",
      toolName: "subprocess-compaction",
      sessionId: "subprocess",
      content: workerText,
    });
  } else {
    throw new Error(`Unknown stress mode: ${mode}`);
  }
} finally {
  await vite.close();
}
