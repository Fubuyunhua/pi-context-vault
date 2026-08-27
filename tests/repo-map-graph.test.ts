import { describe, expect, it } from "vitest";
import { canonicalizeJcs } from "../src/repo-map/canonical.js";
import {
  buildRepositoryGraphAssembly,
  type GraphAssemblyBuildOptions,
  type GraphAssemblyBuildSuccess,
} from "../src/repo-map/graph.js";
import type { RepoMapFile, RepoMapSnapshot, RepoMapSymbol } from "../src/repo-map/index.js";
import {
  type RepositoryCheckpointInput,
  RepositoryCheckpointStore,
  type RepositorySnapshotHandle,
} from "../src/repo-map/snapshot.js";

const A_HASH = "a".repeat(64);
const B_HASH = "b".repeat(64);

function symbol(overrides: Partial<RepoMapSymbol> = {}): RepoMapSymbol {
  return {
    name: "alpha",
    kind: "function",
    signature: "function alpha(): void",
    exported: false,
    line: 1,
    ...overrides,
  };
}

function file(path = "src/a.ts", overrides: Partial<RepoMapFile> = {}): RepoMapFile {
  return {
    path,
    kind: "semantic",
    language: "typescript",
    contentHash: A_HASH,
    sizeBytes: 12,
    lexicalTerms: ["alpha"],
    imports: [],
    exports: [],
    symbols: [],
    dependencies: [],
    ...overrides,
  };
}

function snapshot(files: RepoMapFile[]): RepoMapSnapshot {
  return {
    schemaVersion: 1,
    provenance: {
      generator: "pi-context-vault",
      generatorVersion: "0.1.0",
      parser: "typescript-compiler-api",
      typescriptVersion: "5.9.3",
      javaParser: "java-parser@3.0.1",
      generatedAt: "2025-01-01T00:00:00.000Z",
      projectRoot: "/private/project",
    },
    files,
    warnings: [],
  };
}

function handle(files: RepoMapFile[]): RepositorySnapshotHandle {
  const input: RepositoryCheckpointInput = {
    snapshot: snapshot(files),
    gitHead: "head",
    dirtyFiles: [],
    workspaceRevision: "revision",
    freshness: "fresh",
    pendingPaths: [],
    generation: 1,
  };
  const store = new RepositoryCheckpointStore();
  expect(store.publish(input)).toBe(true);
  return store.captureCurrent();
}

interface MutableHandleFixture extends Record<string, unknown> {
  snapshot: Record<string, unknown> & {
    files: Record<string, unknown>[];
    warnings: unknown[];
  };
  errors: unknown[];
  warnings: unknown[];
}

function mutableHandle(files: RepoMapFile[] = [file()]): MutableHandleFixture {
  return structuredClone(handle(files)) as unknown as MutableHandleFixture;
}

function success(files: RepoMapFile[], options?: GraphAssemblyBuildOptions): GraphAssemblyBuildSuccess {
  const result = buildRepositoryGraphAssembly(handle(files), options);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error.code);
  return result;
}

function edge(successful: GraphAssemblyBuildSuccess, relation: string) {
  const found = successful.assembly.edges.find((candidate) => candidate.relation === relation);
  if (!found) throw new Error(`missing edge ${relation}`);
  return found;
}

describe("repository graph S02b assembly", () => {
  it("pins compact domain-separated golden IDs and deterministic serialization", () => {
    const first = success([
      file("./src//a.ts", {
        symbols: [symbol({ exported: true })],
        exports: [{ name: "alpha", typeOnly: false }],
      }),
    ]);
    const second = success([
      file("src/a.ts", {
        symbols: [symbol({ exported: true })],
        exports: [{ name: "alpha", typeOnly: false }],
      }),
    ]);

    expect(first.assembly.files[0]?.id).toBe("file:sha256:g9zK0T3zcXFUeLNzYnT06jBUQBOmWBTY_4WLvpvMIjU");
    expect(first.assembly.symbols[0]?.id).toBe("symbol:sha256:h9nuEtOEYBO8jt3XOkM-0iVwfj6BL6jj6NwmcnyTrMI");
    expect(first.assembly.references[0]?.id).toBe("reference:sha256:5f_M5P2oyJ6oc8V7vWiMtBroauBrl2MfjCVpeqHtcUc");
    expect(edge(first, "DECLARES").id).toBe("edge:sha256:2UJQHGJeqVU76K8IaEXD_Y95VD2RaUS_66zM-95WFaM");
    expect(edge(first, "DECLARES").evidence[0]?.id).toBe("evidence:sha256:lX37sbg8HfAVD_14pbz_OK7wiDYf6JeWRMhwOsGsOoc");
    expect(canonicalizeJcs(first.assembly)).toBe(canonicalizeJcs(second.assembly));
    expect(first.assembly.canonicalInputBytesUsed).toBeGreaterThan(0);
    expect(Object.isFrozen(first.assembly)).toBe(true);
    expect(Object.isFrozen(first.assembly.symbols[0]?.row)).toBe(true);
  });

  it("deeply owns and freezes files, metadata, symbols, references, evidence, edges, and work items", () => {
    const source = mutableHandle([
      file("owned.ts", {
        imports: [{ source: "./other.ts", names: ["other"], typeOnly: false }],
        exports: [{ name: "owned", typeOnly: false }],
        symbols: [symbol({ name: "owned", exported: true })],
        dependencies: ["./other.ts"],
      }),
    ]);
    const result = buildRepositoryGraphAssembly(source);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.error.code);
    const assembly = result.assembly;
    const exportEdge = assembly.edges.find(({ relation }) => relation === "EXPORTS_NAME");
    const work = assembly.resolverWorkItems[0];
    expect(exportEdge).toBeDefined();
    expect(work).toBeDefined();
    for (const value of [
      assembly,
      assembly.files,
      assembly.files[0],
      assembly.files[0]?.descriptor,
      assembly.fileResolverMetadata,
      assembly.fileResolverMetadata[0],
      assembly.symbols,
      assembly.symbols[0],
      assembly.symbols[0]?.descriptor,
      assembly.symbols[0]?.row,
      assembly.references,
      assembly.references[0],
      assembly.references[0]?.descriptor,
      assembly.edges,
      exportEdge,
      exportEdge?.descriptor,
      exportEdge?.evidence,
      exportEdge?.evidence[0],
      exportEdge?.evidence[0]?.descriptor,
      exportEdge?.evidence[0]?.explanation,
      assembly.resolverWorkItems,
      work,
      work?.evidence,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    const sourceFile = source.snapshot.files[0];
    if (!sourceFile) throw new Error("missing ownership source");
    sourceFile.path = "mutated.ts";
    const sourceSymbols = sourceFile.symbols as Array<Record<string, unknown>>;
    const sourceSymbol = sourceSymbols[0];
    if (!sourceSymbol) throw new Error("missing ownership symbol");
    sourceSymbol.name = "mutated";
    expect(assembly.files[0]?.descriptor.canonicalPath).toBe("owned.ts");
    expect(assembly.symbols[0]?.row.name).toBe("owned");
    expect(() => (assembly.edges as unknown as unknown[]).push(exportEdge)).toThrow();
  });

  it("is invariant to source file order and sorts every output array by contract keys", () => {
    const a = file("a.ts", {
      contentHash: A_HASH,
      imports: [{ source: "./z.ts", names: ["z"], typeOnly: false }],
      exports: [{ name: "a", typeOnly: false }],
      symbols: [symbol({ name: "a", signature: "a" })],
    });
    const z = file("z.ts", {
      contentHash: B_HASH,
      imports: [{ source: "./a.ts", names: ["a"], typeOnly: false }],
      dependencies: ["./a.ts"],
      symbols: [symbol({ name: "z", signature: "z" })],
    });
    const forward = success([a, z]);
    const reverse = success([z, a]);

    expect(canonicalizeJcs(forward.assembly)).toBe(canonicalizeJcs(reverse.assembly));
    for (const values of [
      forward.assembly.files.map(({ id }) => id),
      forward.assembly.fileResolverMetadata.map(({ fileId }) => fileId),
      forward.assembly.symbols.map(({ id }) => id),
      forward.assembly.references.map(({ id }) => id),
    ]) {
      expect(values).toEqual([...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
    }
    const compareOptional = (left: string | undefined, right: string | undefined): number => {
      if (left === undefined) return right === undefined ? 0 : -1;
      if (right === undefined) return 1;
      return Buffer.compare(Buffer.from(left), Buffer.from(right));
    };
    const orderedEdges = [...forward.assembly.edges].sort(
      (left, right) =>
        Buffer.compare(Buffer.from(left.sourceId), Buffer.from(right.sourceId)) ||
        Buffer.compare(Buffer.from(left.relation), Buffer.from(right.relation)) ||
        compareOptional(left.referenceId, right.referenceId) ||
        compareOptional(left.targetId, right.targetId) ||
        Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)),
    );
    expect(forward.assembly.edges).toEqual(orderedEdges);
    const orderedWork = [...forward.assembly.resolverWorkItems].sort(
      (left, right) =>
        Buffer.compare(Buffer.from(left.sourceFileId), Buffer.from(right.sourceFileId)) ||
        Buffer.compare(Buffer.from(left.workKind), Buffer.from(right.workKind)) ||
        Buffer.compare(Buffer.from(left.referenceId), Buffer.from(right.referenceId)) ||
        Buffer.compare(Buffer.from(left.evidence.id), Buffer.from(right.evidence.id)),
    );
    expect(forward.assembly.resolverWorkItems).toEqual(orderedWork);
  });

  it("preserves exact resolver metadata for Java package and degraded-file filtering", () => {
    const built = success([
      file("src/Ready.java", { language: "java", packageName: "com.example" }),
      file("src/Broken.java", { language: "java", packageName: "com.example.bad", degradedReason: "parse-error" }),
    ]);
    const metadataByPath = new Map(
      built.assembly.fileResolverMetadata.map((metadata) => [
        built.assembly.files.find(({ id }) => id === metadata.fileId)?.descriptor.canonicalPath,
        metadata,
      ]),
    );
    expect(metadataByPath.get("src/Ready.java")).toMatchObject({
      packageName: "com.example",
      degradedReason: null,
    });
    expect(metadataByPath.get("src/Broken.java")).toMatchObject({
      packageName: "com.example.bad",
      degradedReason: "parse-error",
    });
  });

  it("preserves same-name, overload, default, and Java container rows with exact occurrence ordinals", () => {
    const typescript = file("same.ts", {
      symbols: [
        symbol({ name: "same", signature: "same(x: string): void", line: 1, exported: false }),
        symbol({ name: "same", signature: "same(x: string): void", line: 9, exported: true }),
        symbol({ name: "same", signature: "same(x: number): void", line: 10 }),
        symbol({ name: "default", kind: "class", signature: "class default", line: 11 }),
      ],
    });
    const java = file("Container.java", {
      language: "java",
      symbols: [
        symbol({ name: "run", kind: "method", signature: "run()", container: "Outer" }),
        symbol({ name: "run", kind: "method", signature: "run()", container: "Inner" }),
      ],
    });
    const built = success([typescript, java]);
    const tsRows = built.assembly.symbols
      .filter(
        ({ descriptor }) =>
          descriptor.fileId ===
          built.assembly.files.find(({ descriptor }) => descriptor.canonicalPath === "same.ts")?.id,
      )
      .sort((left, right) => left.recordedRowOrdinal - right.recordedRowOrdinal);
    expect(tsRows.map(({ descriptor }) => descriptor.occurrenceOrdinal)).toEqual([1, 2, 1, 1]);
    expect(tsRows.map(({ descriptor }) => descriptor.container)).toEqual([null, null, null, null]);
    expect(tsRows[0]?.id).not.toBe(tsRows[1]?.id);
    expect(tsRows[2]?.descriptor.signature).toBe("same(x: number): void");
    expect(tsRows[3]?.descriptor.name).toBe("default");

    const javaRows = built.assembly.symbols
      .filter(({ descriptor }) => descriptor.language === "java")
      .sort((left, right) => left.recordedRowOrdinal - right.recordedRowOrdinal);
    expect(javaRows.map(({ descriptor }) => [descriptor.container, descriptor.occurrenceOrdinal])).toEqual([
      ["Outer", 1],
      ["Inner", 1],
    ]);
    expect(built.assembly.edges.filter(({ relation }) => relation === "DECLARES")).toHaveLength(6);
    expect(built.assembly.edges.filter(({ relation }) => relation === "ANALYZER_EXPORT_FLAG")).toHaveLength(1);
  });

  it("emits only resolver-independent endpoint-safe edges and stable deferred work", () => {
    const built = success([
      file("src/a.ts", {
        imports: [
          { source: "./b.js", names: ["b"], typeOnly: false },
          { source: "react", names: ["default"], typeOnly: false },
        ],
        exports: [{ name: "renamed", source: "node:fs", typeOnly: false }],
        dependencies: ["./b.js"],
        symbols: [symbol({ exported: true })],
      }),
      file("Thing.java", {
        language: "java",
        imports: [{ source: "java.util.List", names: ["List"], typeOnly: false, static: false, wildcard: false }],
        symbols: [
          symbol({
            name: "Thing",
            kind: "class",
            signature: "class Thing",
            relationships: { extends: ["Base"], implements: ["Runnable"], permits: ["Child"] },
          }),
        ],
      }),
    ]);

    expect(new Set(built.assembly.edges.map(({ relation }) => relation))).toEqual(
      new Set([
        "DECLARES",
        "ANALYZER_EXPORT_FLAG",
        "EXPORTS_NAME",
        "DEPENDS_ON_RAW",
        "JAVA_EXTENDS_NAME",
        "JAVA_IMPLEMENTS_NAME",
        "JAVA_PERMITS_NAME",
      ]),
    );
    expect(built.assembly.resolverWorkItems.map(({ workKind }) => workKind).sort()).toEqual([
      "java-import",
      "tsjs-import",
      "tsjs-import",
      "tsjs-reexport",
    ]);
    expect(built.assembly).not.toHaveProperty("complete");
    expect(built.assembly).not.toHaveProperty("externalModules");
    expect(JSON.stringify(built.assembly)).not.toContain("external-module:sha256:");
    expect(JSON.stringify(built.assembly)).not.toContain('"resolution"');
    for (const graphEdge of built.assembly.edges) {
      expect(graphEdge.sourceId).toBe(graphEdge.descriptor.sourceId);
      expect(graphEdge.relation).toBe(graphEdge.descriptor.relation);
      if (graphEdge.descriptor.descriptorKind === "direct") {
        expect(graphEdge.targetId).toBe(graphEdge.descriptor.targetId);
        expect(graphEdge).not.toHaveProperty("referenceId");
      } else {
        expect(graphEdge.referenceId).toBe(graphEdge.descriptor.referenceId);
        expect(graphEdge).not.toHaveProperty("targetId");
      }
    }
  });

  it("uses exact row and nested ordinals and does not invent evidence for absent rows", () => {
    const built = success([
      file("Ordinal.java", {
        language: "java",
        imports: [
          { source: "p.A", names: ["A"], typeOnly: false, static: false, wildcard: false },
          { source: "p.A", names: ["A"], typeOnly: false, static: false, wildcard: false },
        ],
        symbols: [
          symbol({
            name: "Ordinal",
            kind: "class",
            signature: "class Ordinal",
            relationships: { extends: ["A", "A"], implements: [], permits: [] },
          }),
        ],
      }),
    ]);
    const workEvidence = built.assembly.resolverWorkItems
      .map(({ evidence }) => evidence)
      .sort((left, right) => left.descriptor.recordedRowOrdinal - right.descriptor.recordedRowOrdinal);
    expect(workEvidence.map(({ descriptor }) => [descriptor.recordedRowOrdinal, descriptor.occurrenceOrdinal])).toEqual(
      [
        [0, 1],
        [1, 2],
      ],
    );
    expect(workEvidence.every(({ descriptor }) => descriptor.recordedNestedOrdinal === null)).toBe(true);

    const heritage = edge(built, "JAVA_EXTENDS_NAME");
    expect(heritage.evidenceCount).toBe(2);
    expect(
      heritage.evidence
        .map(({ descriptor }) => [descriptor.recordedNestedOrdinal, descriptor.occurrenceOrdinal])
        .sort(([left], [right]) => Number(left) - Number(right)),
    ).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(built.assembly.edges.some(({ relation }) => relation.includes("IMPORT"))).toBe(false);
  });

  it("collapses duplicate semantic edges, retains sorted evidence prefixes, and counts all contributions", () => {
    const built = success(
      [
        file("dup.ts", {
          exports: [
            { name: "same", typeOnly: false },
            { name: "same", typeOnly: false },
            { name: "same", typeOnly: false },
          ],
        }),
      ],
      { limits: { retainedEvidence: 2 } },
    );
    const exportsName = edge(built, "EXPORTS_NAME");
    expect(exportsName.evidenceCount).toBe(3);
    expect(exportsName.evidence).toHaveLength(2);
    expect(exportsName.omittedEvidenceCount).toBe(1);
    expect(exportsName.evidence.map(({ id }) => id)).toEqual(
      [...exportsName.evidence.map(({ id }) => id)].sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      ),
    );
    expect(built.assembly.references).toHaveLength(1);

    const bounded = buildRepositoryGraphAssembly(
      handle([
        file("dup.ts", {
          exports: [
            { name: "x", typeOnly: false },
            { name: "x", typeOnly: false },
          ],
        }),
      ]),
      {
        limits: { references: 1 },
      },
    );
    expect(bounded).toMatchObject({ ok: false, error: { code: "count-bound-exceeded", limit: 1, observed: 2 } });
  });

  it("fails closed on unknown, untrusted, invalid Unicode, enums, hashes, and identity collisions", () => {
    expect(buildRepositoryGraphAssembly(null)).toEqual({
      ok: false,
      error: {
        code: "invalid-snapshot",
        phase: "validate",
        message: "repository graph build failed: invalid snapshot",
      },
    });
    const base = structuredClone(handle([file()])) as unknown as {
      snapshot: { files: Array<{ symbols: RepoMapSymbol[] }> };
    };
    const baseFile = base.snapshot.files[0];
    if (!baseFile) throw new Error("missing base file");
    baseFile.symbols.push(symbol({ name: "bad\ud800" }));
    expect(buildRepositoryGraphAssembly(base)).toMatchObject({
      ok: false,
      error: { code: "invalid-unicode", phase: "validate" },
    });

    const badEnum = structuredClone(handle([file()]));
    (badEnum.snapshot.files[0] as { language: string }).language = "rust";
    expect(buildRepositoryGraphAssembly(badEnum)).toMatchObject({ ok: false, error: { code: "invalid-enum" } });

    const badHash = structuredClone(handle([file()]));
    (badHash.snapshot.files[0] as { contentHash: string }).contentHash = "SECRET";
    expect(buildRepositoryGraphAssembly(badHash)).toMatchObject({
      ok: false,
      error: { code: "invalid-hash", message: "repository graph build failed: invalid content hash" },
    });
    expect(JSON.stringify(buildRepositoryGraphAssembly(badHash))).not.toContain("SECRET");

    const malformedId = buildRepositoryGraphAssembly(handle([file("a.ts")]), {
      createId: (prefix) => `${prefix}${"A".repeat(42)}`,
    });
    expect(malformedId).toMatchObject({ ok: false, error: { code: "identity-collision", phase: "identify" } });
    const wrongPrefix = buildRepositoryGraphAssembly(handle([file("a.ts")]), {
      createId: () => `wrong:sha256:${"A".repeat(43)}`,
    });
    expect(wrongPrefix).toMatchObject({ ok: false, error: { code: "identity-collision", phase: "identify" } });

    const collision = buildRepositoryGraphAssembly(handle([file("a.ts"), file("b.ts", { contentHash: B_HASH })]), {
      createId: (prefix) => `${prefix}${"A".repeat(43)}`,
    });
    expect(collision).toMatchObject({ ok: false, error: { code: "identity-collision", phase: "identify" } });
  });

  it("recomputes the shared snapshot identity and rejects a stale but shape-valid identity", () => {
    const forged = structuredClone(handle([file("identity.ts")])) as unknown as {
      snapshotContentIdentity: string;
      snapshot: { files: Array<{ sizeBytes: number }> };
    };
    const source = forged.snapshot.files[0];
    if (!source) throw new Error("missing identity fixture");
    source.sizeBytes += 1;
    expect(buildRepositoryGraphAssembly(forged)).toMatchObject({
      ok: false,
      error: {
        code: "invalid-snapshot",
        phase: "validate",
        message: "repository graph build failed: invalid snapshot",
      },
    });
    expect(forged.snapshotContentIdentity).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("rejects non-owned, exotic, unknown, sparse, inherited, and malformed forged data without leakage", () => {
    const forgedValues: unknown[] = [];

    const classHandle = mutableHandle();
    class ForeignFile {}
    classHandle.snapshot.files[0] = Object.assign(new ForeignFile(), classHandle.snapshot.files[0]);
    forgedValues.push(classHandle);

    const inheritedHandle = mutableHandle();
    inheritedHandle.snapshot.files[0] = Object.create(inheritedHandle.snapshot.files[0]);
    forgedValues.push(inheritedHandle);

    const accessorHandle = mutableHandle([file("accessor.ts", { symbols: [symbol()] })]);
    const accessorSymbols = accessorHandle.snapshot.files[0]?.symbols as Record<string, unknown>[];
    const accessorSymbol = accessorSymbols[0];
    if (!accessorSymbol) throw new Error("missing accessor fixture");
    Object.defineProperty(accessorSymbol, "name", {
      enumerable: true,
      get() {
        throw new Error("PRIVATE GETTER TEXT");
      },
    });
    forgedValues.push(accessorHandle);

    const proxyHandle = mutableHandle();
    const proxyFile = proxyHandle.snapshot.files[0];
    if (!proxyFile) throw new Error("missing proxy fixture");
    proxyHandle.snapshot.files[0] = new Proxy(proxyFile, {});
    forgedValues.push(proxyHandle);

    const throwingProxy = new Proxy(mutableHandle(), {
      ownKeys() {
        throw new Error("PRIVATE PROXY TEXT");
      },
    });
    forgedValues.push(throwingProxy);

    const sparseHandle = mutableHandle();
    const sparseFile = sparseHandle.snapshot.files[0];
    if (!sparseFile) throw new Error("missing sparse fixture");
    sparseFile.dependencies = new Array(1);
    forgedValues.push(sparseHandle);

    const inheritedArrayHandle = mutableHandle();
    const inheritedFile = inheritedArrayHandle.snapshot.files[0];
    if (!inheritedFile) throw new Error("missing inherited-array fixture");
    const inheritedDependencies = inheritedFile.dependencies as unknown[];
    Object.setPrototypeOf(inheritedDependencies, []);
    forgedValues.push(inheritedArrayHandle);

    const unknownHandle = mutableHandle();
    const unknownFile = unknownHandle.snapshot.files[0];
    if (!unknownFile) throw new Error("missing unknown-field fixture");
    unknownFile.unexpected = "PRIVATE UNKNOWN TEXT";
    forgedValues.push(unknownHandle);

    const diagnosticHandle = mutableHandle();
    diagnosticHandle.errors.push({
      severity: "error",
      code: "read-error",
      phase: "indexing",
      message: "PRIVATE MALFORMED DIAGNOSTIC",
      occurrenceCount: 1,
      unexpected: true,
    });
    forgedValues.push(diagnosticHandle);

    const warningHandle = mutableHandle();
    warningHandle.snapshot.warnings.push({
      path: "src/a.ts",
      code: "parse-error",
      message: "PRIVATE MALFORMED WARNING",
    });
    forgedValues.push(warningHandle);

    for (const forged of forgedValues) {
      const result = buildRepositoryGraphAssembly(forged);
      expect(result).toEqual({
        ok: false,
        error: {
          code: "invalid-snapshot",
          phase: "validate",
          message: "repository graph build failed: invalid snapshot",
        },
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
    }
  });

  it("accepts the exact production path and model-string byte boundaries", () => {
    const maximumPath = `${"p".repeat(4_093)}.ts`;
    const maximumString = "é".repeat(8_192);
    expect(Buffer.byteLength(maximumPath)).toBe(4_096);
    expect(Buffer.byteLength(maximumString)).toBe(16_384);
    const built = success([file(maximumPath, { dependencies: [maximumString] })]);
    expect(built.assembly.files[0]?.descriptor.canonicalPath).toBe(maximumPath);
    expect(built.assembly.references[0]?.descriptor).toMatchObject({ raw: maximumString });
  });

  it("exposes one cumulative canonical-input counter and defers final graph serialization bounds", () => {
    const sourceHandle = handle([
      file("counter.ts", {
        imports: [{ source: "./other.ts", names: ["other"], typeOnly: false }],
        symbols: [symbol()],
      }),
    ]);
    const first = buildRepositoryGraphAssembly(sourceHandle);
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw new Error(first.error.code);
    const used = first.assembly.canonicalInputBytesUsed;
    expect(used).toBeGreaterThan(0);
    expect(buildRepositoryGraphAssembly(sourceHandle, { limits: { canonicalInputBytes: used } })).toMatchObject({
      ok: true,
      assembly: { canonicalInputBytesUsed: used },
    });
    expect(buildRepositoryGraphAssembly(sourceHandle, { limits: { canonicalInputBytes: used - 1 } })).toMatchObject({
      ok: false,
      error: { code: "canonical-input-bound-exceeded", phase: "identify", limit: used - 1 },
    });
    expect(first).not.toHaveProperty("serializedBytes");
    expect(first.assembly).not.toHaveProperty("serializedBytes");
  });

  it("rejects every limit increase, malformed override, and obsolete intermediate serialization limit", () => {
    const sourceHandle = handle([file("limits.ts")]);
    for (const limits of [
      { files: 100_001 },
      { pathBytes: 4_097 },
      { stringBytes: 16_385 },
      { retainedEvidence: 65 },
      { canonicalInputBytes: 256 * 1024 * 1024 + 1 },
      { files: -1 },
      { files: Number.NaN },
    ]) {
      expect(buildRepositoryGraphAssembly(sourceHandle, { limits })).toMatchObject({
        ok: false,
        error: { code: "invalid-snapshot", phase: "validate" },
      });
    }
    expect(
      buildRepositoryGraphAssembly(sourceHandle, {
        limits: { serializedBytes: 1 },
      } as unknown as GraphAssemblyBuildOptions),
    ).toMatchObject({ ok: false, error: { code: "invalid-snapshot", phase: "validate" } });
  });

  it("enforces practical count, canonical-input, and string limit seams without partial topology", () => {
    const twoSymbols = handle([file("bounds.ts", { symbols: [symbol({ name: "a" }), symbol({ name: "b" })] })]);
    expect(buildRepositoryGraphAssembly(twoSymbols, { limits: { symbols: 1 } })).toMatchObject({
      ok: false,
      error: { code: "count-bound-exceeded", limit: 1, observed: 2 },
    });
    expect(
      buildRepositoryGraphAssembly(handle([file("bounds.ts")]), { limits: { canonicalInputBytes: 1 } }),
    ).toMatchObject({
      ok: false,
      error: { code: "canonical-input-bound-exceeded", phase: "identify", limit: 1 },
    });
    expect(buildRepositoryGraphAssembly(handle([file("bounds.ts")]))).toMatchObject({ ok: true });
    expect(
      buildRepositoryGraphAssembly(handle([file("bounds.ts", { dependencies: ["x".repeat(81)] })]), {
        limits: { stringBytes: 80 },
      }),
    ).toMatchObject({ ok: false, error: { code: "nested-bound-exceeded", limit: 80, observed: 81 } });
    for (const failed of [buildRepositoryGraphAssembly(twoSymbols, { limits: { symbols: 1 } })]) {
      expect(failed).not.toHaveProperty("assembly");
      expect(failed).not.toHaveProperty("graph");
    }
  });
});
