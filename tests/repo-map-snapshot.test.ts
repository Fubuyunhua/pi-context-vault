import { describe, expect, it } from "vitest";
import { canonicalizeJcs } from "../src/repo-map/canonical.js";
import type { RepoMapFile, RepoMapSnapshot } from "../src/repo-map/index.js";
import {
  computeRepositorySnapshotContentIdentity,
  REPO_MAP_ANALYZER_CAPABILITY_VERSION,
  type RepositoryCheckpointInput,
  RepositoryCheckpointStore,
  RepositorySnapshotUnavailableError,
} from "../src/repo-map/snapshot.js";

const A_HASH = "a".repeat(64);
const B_HASH = "b".repeat(64);

function file(path = "src/a.ts", contentHash = A_HASH): RepoMapFile {
  return {
    path,
    kind: "semantic",
    language: "typescript",
    contentHash,
    sizeBytes: 12,
    lexicalTerms: ["alpha"],
    imports: [],
    exports: [{ name: "alpha", typeOnly: false }],
    symbols: [
      {
        name: "alpha",
        kind: "variable",
        signature: "const alpha = 1",
        exported: true,
        line: 1,
      },
    ],
    dependencies: [],
  };
}

function snapshot(files: RepoMapFile[] = [file()]): RepoMapSnapshot {
  return {
    schemaVersion: 1,
    provenance: {
      generator: "pi-context-vault",
      generatorVersion: "0.1.0",
      parser: "typescript-compiler-api",
      typescriptVersion: "5.9.3",
      javaParser: "java-parser@3.0.1",
      generatedAt: "2025-01-01T00:00:00.000Z",
      projectRoot: "/private/project/root",
    },
    files,
    warnings: [],
  };
}

function checkpoint(map = snapshot()): RepositoryCheckpointInput {
  return {
    snapshot: map,
    gitHead: "head-a",
    dirtyFiles: [],
    workspaceRevision: "legacy-revision-a",
    freshness: "fresh",
    pendingPaths: [],
    generation: 3,
  };
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`missing fixture ${label}`);
  return value;
}

function published(input: RepositoryCheckpointInput): ReturnType<RepositoryCheckpointStore["captureCurrent"]> {
  const store = new RepositoryCheckpointStore();
  expect(store.publish(input)).toBe(true);
  return store.captureCurrent();
}

describe("repository snapshot checkpoint foundation", () => {
  it("uses the shared exact streaming snapshot-content identity helper", () => {
    const captured = published(checkpoint());
    const computed = computeRepositorySnapshotContentIdentity(captured.snapshot);
    expect(computed.identity).toBe(captured.snapshotContentIdentity);
    expect(computed.canonicalBytes).toBeGreaterThan(0);
  });

  it("includes complete file/analyzer content and excludes trust/freshness axes from content identity", () => {
    const base = checkpoint();
    const first = published(base);
    const warningSnapshot = structuredClone(base.snapshot);
    warningSnapshot.warnings.push({ path: "src/a.ts", code: "parse-error", message: "private parser text" });
    const warningOnly: RepositoryCheckpointInput = { ...base, snapshot: warningSnapshot };
    expect(published(warningOnly).snapshotContentIdentity).toBe(first.snapshotContentIdentity);

    const headOnly: RepositoryCheckpointInput = {
      ...base,
      gitHead: "head-b",
      workspaceRevision: "legacy-revision-b",
    };
    const changedHead = published(headOnly);
    expect(changedHead.snapshotContentIdentity).toBe(first.snapshotContentIdentity);
    expect(changedHead.gitHead).toBe("head-b");
    expect(changedHead.workspaceRevision).toBe("legacy-revision-b");

    const changedTrustAxes: RepositoryCheckpointInput = {
      ...base,
      freshness: "stale",
      pendingPaths: ["src/z.ts"],
      dirtyFiles: [{ path: "src/z.ts", contentHash: "deleted" }],
      generation: 99,
      runtimeError: new Error("private runtime text"),
    };
    const changedAxes = published(changedTrustAxes);
    expect(changedAxes.snapshotContentIdentity).toBe(first.snapshotContentIdentity);
    expect(changedAxes.generation).toBe(99);

    const changedFile = checkpoint(snapshot([file("src/a.ts", B_HASH)]));
    expect(published(changedFile).snapshotContentIdentity).not.toBe(first.snapshotContentIdentity);
    const changedAnalyzer = checkpoint();
    changedAnalyzer.snapshot.provenance.typescriptVersion = "5.9.4";
    expect(published(changedAnalyzer).snapshotContentIdentity).not.toBe(first.snapshotContentIdentity);
  });

  it("canonicalizes and byte-sorts handle paths while rejecting every collision and escape", () => {
    const canonical: RepositoryCheckpointInput = {
      ...checkpoint(snapshot([file("z.ts"), file("./a//b.ts", B_HASH)])),
      dirtyFiles: [
        { path: "z.ts", contentHash: A_HASH },
        { path: "a/./b.ts", contentHash: B_HASH },
      ],
      pendingPaths: ["é.ts", "a.ts"],
    };
    const handle = published(canonical);
    expect(handle.snapshot.files.map(({ path }) => path)).toEqual(["a/b.ts", "z.ts"]);
    expect(handle.dirtyFiles.map(({ path }) => path)).toEqual(["a/b.ts", "z.ts"]);
    expect(handle.pendingPaths).toEqual(["a.ts", "é.ts"]);

    for (const input of [
      checkpoint(snapshot([file("a//b.ts"), file("a/./b.ts", B_HASH)])),
      checkpoint(snapshot([file("same.ts"), file("same.ts", B_HASH)])),
      { ...checkpoint(), pendingPaths: ["a//b.ts", "a/./b.ts"] },
      { ...checkpoint(), dirtyFiles: [{ path: "../escape.ts", contentHash: A_HASH }] },
      checkpoint(snapshot([file("bad\ud800.ts")])),
    ]) {
      const store = new RepositoryCheckpointStore();
      expect(store.publish(input)).toBe(false);
      expect(() => store.captureCurrent()).toThrow(
        expect.objectContaining({
          reason: "invalid-checkpoint",
          message: "repository snapshot unavailable: invalid checkpoint",
        }),
      );
    }
  });

  it("maps only fixed diagnostics, collapses duplicates, sorts, and applies exact class bounds", () => {
    const map = snapshot([]);
    map.warnings.push(
      { path: "a//same.ts", code: "read-error", message: "SECRET one" },
      { path: "a/./same.ts", code: "read-error", message: "/absolute/private two" },
      { path: "/absolute/private.ts", code: "parse-error", message: "SECRET three" },
    );
    for (let index = 0; index < 35; index += 1) {
      map.warnings.push({
        path: `errors/${index.toString().padStart(2, "0")}.ts`,
        code: "read-error",
        message: `raw ${index}`,
      });
    }
    for (let index = 0; index < 130; index += 1) {
      map.warnings.push({
        path: `warnings/${index.toString().padStart(3, "0")}.ts`,
        code: "parse-error",
        message: `raw ${index}`,
      });
    }
    const input: RepositoryCheckpointInput = {
      ...checkpoint(map),
      runtimeError: new Error("runtime SECRET /private/root"),
    };
    const handle = published(input);

    expect(handle.errors).toHaveLength(32);
    expect(handle.warnings).toHaveLength(128);
    expect(handle.errors.find((row) => row.path === "a/same.ts")).toMatchObject({
      code: "read-error",
      phase: "indexing",
      message: "repository snapshot read failed",
      occurrenceCount: 2,
    });
    expect(handle.errors.at(-1)).toEqual({
      severity: "error",
      code: "diagnostics-truncated",
      phase: "runtime",
      message: "6 additional error diagnostics omitted",
      occurrenceCount: 1,
      omittedCount: 6,
    });
    expect(handle.warnings.at(-1)).toEqual({
      severity: "warning",
      code: "diagnostics-truncated",
      phase: "runtime",
      message: "4 additional warning diagnostics omitted",
      occurrenceCount: 1,
      omittedCount: 4,
    });
    expect(handle.warnings.some((row) => row.code === "parse-error" && row.path === undefined)).toBe(true);
    expect(JSON.stringify(handle)).not.toContain("SECRET");
    expect(JSON.stringify(handle)).not.toContain("/absolute/private");
    expect(handle.snapshot.warnings.every(({ message }) => message.startsWith("repository snapshot "))).toBe(true);
  });

  it("owns checkpoint input and every returned handle deeply in both directions", () => {
    const source = snapshot();
    const store = new RepositoryCheckpointStore();
    expect(store.publish(checkpoint(source))).toBe(true);
    const sourceFile = source.files[0];
    const sourceSymbol = sourceFile?.symbols[0];
    if (!sourceSymbol) throw new Error("missing source fixture symbol");
    sourceSymbol.name = "mutatedAfterPublication";
    source.files.push(file("src/later.ts", B_HASH));

    const first = store.captureCurrent();
    expect(first.snapshot.files).toHaveLength(1);
    expect(first.snapshot.files[0]?.symbols[0]?.name).toBe("alpha");
    expect(Object.isFrozen(first.snapshot.files[0]?.symbols)).toBe(true);
    const capturedSymbol = first.snapshot.files[0]?.symbols[0];
    if (!capturedSymbol) throw new Error("missing captured fixture symbol");
    expect(() => {
      (capturedSymbol as { name: string }).name = "callerMutation";
    }).toThrow(TypeError);
    const second = store.captureCurrent();
    expect(second).not.toBe(first);
    expect(second.snapshot).not.toBe(first.snapshot);
    expect(second.snapshot.files[0]?.symbols[0]?.name).toBe("alpha");
  });

  it("recomputes identity despite an injected repeated contentVersion and never bypasses changed-input validation", () => {
    const store = new RepositoryCheckpointStore();
    const first = checkpoint();
    (first as unknown as Record<string, unknown>).contentVersion = 7;
    expect(store.publish(first)).toBe(true);
    const firstIdentity = store.captureCurrent().snapshotContentIdentity;

    const changed = checkpoint(snapshot([file("src/a.ts", B_HASH)]));
    (changed as unknown as Record<string, unknown>).contentVersion = 7;
    expect(store.publish(changed)).toBe(true);
    const latestValid = store.captureCurrent();
    expect(latestValid.snapshotContentIdentity).not.toBe(firstIdentity);

    const oversized = checkpoint(snapshot([file(`${"x".repeat(4_097)}.ts`)]));
    (oversized as unknown as Record<string, unknown>).contentVersion = 7;
    expect(store.publish(oversized)).toBe(false);
    const boundedFallback = store.captureCurrent();
    expect(boundedFallback.snapshot).toEqual(latestValid.snapshot);
    expect(boundedFallback.snapshotContentIdentity).toBe(latestValid.snapshotContentIdentity);
    expect(boundedFallback.generation).toBe(latestValid.generation);
    expect(boundedFallback.workspaceRevision).toBe(latestValid.workspaceRevision);
    expect(boundedFallback.freshness).toBe("stale");
    expect(boundedFallback.errors).toContainEqual({
      severity: "error",
      code: "runtime-operation-error",
      phase: "runtime",
      message: "repository snapshot runtime operation failed",
      occurrenceCount: 1,
    });

    const invalid = checkpoint(snapshot([file("src/a.ts")]));
    required(required(invalid.snapshot.files[0], "invalid file").symbols[0], "invalid symbol").signature =
      "PRIVATE_INVALID\ud800";
    (invalid as unknown as Record<string, unknown>).contentVersion = 7;
    expect(store.publish(invalid)).toBe(false);
    const invalidFallback = store.captureCurrent();
    expect(invalidFallback.snapshot).toEqual(latestValid.snapshot);
    expect(invalidFallback.snapshotContentIdentity).toBe(latestValid.snapshotContentIdentity);
    expect(JSON.stringify(invalidFallback)).not.toContain("PRIVATE_INVALID");
  });

  it("reconstructs only allowlisted schema-1 fields at every snapshot level", () => {
    const richFile = file();
    richFile.imports = [{ source: "./dep", names: ["dep"], typeOnly: false }];
    required(richFile.symbols[0], "rich symbol").relationships = { extends: ["Base"], implements: [], permits: [] };
    const clean = snapshot([richFile]);
    clean.warnings.push({ path: "src/a.ts", code: "parse-error", message: "raw" });
    const injected = structuredClone(clean);
    const injectedFile = required(injected.files[0], "injected file");
    const injectedImport = required(injectedFile.imports[0], "injected import");
    const injectedExport = required(injectedFile.exports[0], "injected export");
    const injectedSymbol = required(injectedFile.symbols[0], "injected symbol");
    const injectedRelationships = required(injectedSymbol.relationships, "injected relationships");
    const injectedWarning = required(injected.warnings[0], "injected warning");
    for (const target of [
      injected,
      injected.provenance,
      injectedFile,
      injectedImport,
      injectedExport,
      injectedSymbol,
      injectedRelationships,
      injectedWarning,
    ]) {
      (target as unknown as Record<string, unknown>).extraSecretField = "SECRET_EXTRA_FIELD";
    }
    const cleanHandle = published(checkpoint(clean));
    const injectedHandle = published(checkpoint(injected));
    expect(injectedHandle.snapshotContentIdentity).toBe(cleanHandle.snapshotContentIdentity);
    expect(JSON.stringify(injectedHandle)).not.toContain("extraSecretField");
    expect(JSON.stringify(injectedHandle)).not.toContain("SECRET_EXTRA_FIELD");
  });

  it("includes every file-record category and analyzer axis while excluding order and provenance-only axes", () => {
    const rich = file("./src//Rich.java");
    rich.kind = "semantic";
    rich.language = "java";
    rich.lexicalTerms = ["rich", "java"];
    rich.imports = [{ source: "java.util.List", names: ["List"], typeOnly: false, static: false, wildcard: false }];
    rich.exports = [{ name: "Rich", source: "./other", typeOnly: false }];
    rich.symbols = [
      {
        name: "Rich",
        kind: "class",
        signature: "class Rich",
        exported: true,
        line: 2,
        container: "Outer",
        annotations: ["Deprecated"],
        modifiers: ["public"],
        typeParameters: ["T"],
        relationships: { extends: ["Base"], implements: ["Runnable"], permits: ["Child"] },
      },
    ];
    rich.dependencies = ["java.util.List"];
    rich.packageName = "example";
    rich.degradedReason = "partial";
    const base = checkpoint(snapshot([rich]));
    const identity = published(base).snapshotContentIdentity;
    const mutations: Array<(candidate: RepoMapSnapshot) => void> = [
      (candidate) => {
        required(candidate.files[0], "mutation file").path = "src/Other.java";
      },
      (candidate) => {
        required(candidate.files[0], "mutation file").kind = "lexical";
      },
      (candidate) => {
        required(candidate.files[0], "mutation file").language = "text";
      },
      (candidate) => {
        required(candidate.files[0], "mutation file").contentHash = B_HASH;
      },
      (candidate) => {
        required(candidate.files[0], "mutation file").sizeBytes += 1;
      },
      (candidate) => required(candidate.files[0], "mutation file").lexicalTerms.push("changed"),
      (candidate) => {
        required(required(candidate.files[0], "mutation file").imports[0], "mutation import").source = "java.util.Set";
      },
      (candidate) => {
        required(required(candidate.files[0], "mutation file").exports[0], "mutation export").name = "Other";
      },
      (candidate) => {
        required(required(candidate.files[0], "mutation file").symbols[0], "mutation symbol").signature =
          "class Rich<T>";
      },
      (candidate) => {
        const symbol = required(required(candidate.files[0], "mutation file").symbols[0], "mutation symbol");
        required(symbol.relationships, "mutation relationships").extends.push("OtherBase");
      },
      (candidate) => required(candidate.files[0], "mutation file").dependencies.push("other"),
      (candidate) => {
        required(candidate.files[0], "mutation file").packageName = "other";
      },
      (candidate) => {
        required(candidate.files[0], "mutation file").degradedReason = "different";
      },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(base.snapshot);
      mutate(candidate);
      expect(published(checkpoint(candidate)).snapshotContentIdentity).not.toBe(identity);
    }

    const changedJavaParser = structuredClone(base.snapshot);
    delete changedJavaParser.provenance.javaParser;
    expect(published(checkpoint(changedJavaParser)).snapshotContentIdentity).not.toBe(identity);

    const provenanceOnly = structuredClone(base.snapshot);
    provenanceOnly.provenance.generatedAt = "2026-02-03T04:05:06.000Z";
    provenanceOnly.provenance.projectRoot = "/different/private/root";
    expect(published(checkpoint(provenanceOnly)).snapshotContentIdentity).toBe(identity);

    const ordered = snapshot([file("z.ts", A_HASH), file("./a//b.ts", B_HASH)]);
    const reversedCanonical = snapshot([file("a/b.ts", B_HASH), file("z.ts", A_HASH)]);
    expect(published(checkpoint(ordered)).snapshotContentIdentity).toBe(
      published(checkpoint(reversedCanonical)).snapshotContentIdentity,
    );
  });

  it("deduplicates equal dirty entries but rejects conflicting hashes and raw-distinct canonical collisions", () => {
    const equal = published({
      ...checkpoint(),
      dirtyFiles: [
        { path: "src/a.ts", contentHash: A_HASH },
        { path: "src/a.ts", contentHash: A_HASH },
      ],
    });
    expect(equal.dirtyFiles).toEqual([{ path: "src/a.ts", contentHash: A_HASH }]);

    for (const dirtyFiles of [
      [
        { path: "src/a.ts", contentHash: A_HASH },
        { path: "src/a.ts", contentHash: B_HASH },
      ],
      [
        { path: "src//a.ts", contentHash: A_HASH },
        { path: "src/./a.ts", contentHash: A_HASH },
      ],
    ]) {
      const store = new RepositoryCheckpointStore();
      expect(store.publish({ ...checkpoint(), dirtyFiles })).toBe(false);
      expect(() => store.captureCurrent()).toThrow(expect.objectContaining({ reason: "invalid-checkpoint" }));
    }
  });

  it("validates in recorded field order and distinguishes exact and exceeded bounds", () => {
    const exactFile = file(`${"p".repeat(4_093)}.ts`);
    exactFile.lexicalTerms = Array.from({ length: 2_000 }, () => "term");
    exactFile.imports = [{ source: "./dep", names: Array.from({ length: 1_024 }, () => "name"), typeOnly: false }];
    required(exactFile.symbols[0], "exact symbol").signature = "s".repeat(16_384);
    expect(new RepositoryCheckpointStore().publish(checkpoint(snapshot([exactFile])))).toBe(true);

    const canonicalMap = snapshot();
    const canonicalBytes = Buffer.byteLength(
      canonicalizeJcs({
        identitySchema: "repository-snapshot-content/v1",
        analyzerCapabilityVersion: REPO_MAP_ANALYZER_CAPABILITY_VERSION,
        repositoryMapSchemaVersion: 1,
        analyzers: { typescriptVersion: "5.9.3", javaParser: "java-parser@3.0.1" },
        files: canonicalMap.files,
      }),
    );
    expect(
      new RepositoryCheckpointStore({ canonicalInputByteLimit: canonicalBytes }).publish(checkpoint(canonicalMap)),
    ).toBe(true);
    const canonicalOverflow = new RepositoryCheckpointStore({ canonicalInputByteLimit: canonicalBytes - 1 });
    expect(canonicalOverflow.publish(checkpoint(canonicalMap))).toBe(false);
    expect(() => canonicalOverflow.captureCurrent()).toThrow(
      expect.objectContaining({ reason: "snapshot-bound-exceeded" }),
    );

    const laterBound = file("../invalid-first.ts");
    laterBound.lexicalTerms = Array.from({ length: 2_001 }, () => "term");
    const invalidFirst = new RepositoryCheckpointStore();
    expect(invalidFirst.publish(checkpoint(snapshot([laterBound])))).toBe(false);
    expect(() => invalidFirst.captureCurrent()).toThrow(expect.objectContaining({ reason: "invalid-checkpoint" }));

    const rowInvalidFirst = file();
    rowInvalidFirst.imports = [
      { source: "bad\ud800", names: Array.from({ length: 1_025 }, () => "name"), typeOnly: false },
    ];
    const invalidRow = new RepositoryCheckpointStore();
    expect(invalidRow.publish(checkpoint(snapshot([rowInvalidFirst])))).toBe(false);
    expect(() => invalidRow.captureCurrent()).toThrow(expect.objectContaining({ reason: "invalid-checkpoint" }));

    const aggregateFile = file();
    aggregateFile.symbols = [
      {
        name: "Aggregate",
        kind: "class",
        signature: "class Aggregate",
        exported: false,
        line: 1,
        relationships: {
          extends: Array.from({ length: 10 }, () => "Extended"),
          implements: Array.from({ length: 10 }, () => "Implemented"),
          permits: Array.from({ length: 10 }, () => "Permitted"),
        },
      },
    ];
    const aggregate = new RepositoryCheckpointStore({ evidenceRowLimit: 30 });
    expect(aggregate.publish(checkpoint(snapshot([aggregateFile])))).toBe(false);
    expect(() => aggregate.captureCurrent()).toThrow(expect.objectContaining({ reason: "snapshot-bound-exceeded" }));
  });

  it("drops invalid-path compatibility warnings while retaining fixed pathless diagnostics", () => {
    const map = snapshot();
    map.warnings.push({ path: "/private/invalid.ts", code: "read-error", message: "SECRET warning" });
    const handle = published(checkpoint(map));
    expect(handle.snapshot.warnings).toEqual([]);
    expect(handle.errors).toContainEqual({
      severity: "error",
      code: "read-error",
      phase: "indexing",
      message: "repository snapshot read failed",
      occurrenceCount: 1,
    });
  });

  it("counts watcher duplicates without retaining duplicate strings and falls back at the production-bounded seam", () => {
    const store = new RepositoryCheckpointStore({ pendingPathInputLimit: 3 });
    expect(store.publish(checkpoint())).toBe(true);
    store.publishWatcherPath("src/repeated.ts");
    store.publishWatcherPath("src/repeated.ts");
    store.publishWatcherPath("src/repeated.ts");
    expect(store.captureCurrent().pendingPaths).toEqual(["src/repeated.ts"]);
    expect(store.publishWatcherPath("src/repeated.ts")).toBe(false);
    const fallback = store.captureCurrent();
    expect(fallback.pendingPaths).toEqual(["src/repeated.ts"]);
    expect(fallback.freshness).toBe("stale");
    expect(fallback.errors).toContainEqual({
      severity: "error",
      code: "runtime-operation-error",
      phase: "runtime",
      message: "repository snapshot runtime operation failed",
      occurrenceCount: 1,
    });
  });

  it("uses bounded public unavailable errors without stack, cause, or arbitrary text", () => {
    const empty = new RepositoryCheckpointStore();
    try {
      empty.captureCurrent();
      throw new Error("expected unavailable");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositorySnapshotUnavailableError);
      expect(error).toMatchObject({
        name: "RepositorySnapshotUnavailableError",
        code: "repository-snapshot-unavailable",
        reason: "no-published-checkpoint",
        retryable: true,
        message: "repository snapshot unavailable: no published checkpoint",
      });
      expect("stack" in (error as object)).toBe(false);
      expect("cause" in (error as object)).toBe(false);
    }

    const bounded = new RepositoryCheckpointStore();
    const oversized = checkpoint(snapshot([file(`${"a".repeat(4_097)}.ts`)]));
    expect(bounded.publish(oversized)).toBe(false);
    expect(() => bounded.captureCurrent()).toThrow(
      expect.objectContaining({
        reason: "snapshot-bound-exceeded",
        retryable: false,
        message: "repository snapshot unavailable: snapshot bound exceeded",
      }),
    );
  });
});
