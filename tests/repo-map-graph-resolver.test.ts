import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeJcs, createDomainSeparatedId } from "../src/repo-map/canonical.js";
import {
  buildRepositoryGraph,
  buildRepositoryGraphAssembly,
  finalizeRepositoryGraphAssembly,
  type GraphBuildOptions,
} from "../src/repo-map/graph.js";
import type { RepoMapFile, RepoMapSnapshot, RepoMapSymbol } from "../src/repo-map/index.js";
import {
  type RepositoryCheckpointInput,
  RepositoryCheckpointStore,
  type RepositorySnapshotHandle,
} from "../src/repo-map/snapshot.js";

const HASH = "a".repeat(64);

function symbol(name: string, overrides: Partial<RepoMapSymbol> = {}): RepoMapSymbol {
  return {
    name,
    kind: "class",
    signature: `class ${name}`,
    exported: false,
    line: 1,
    ...overrides,
  };
}

function file(path: string, overrides: Partial<RepoMapFile> = {}): RepoMapFile {
  const extension = path.slice(path.lastIndexOf(".") + 1);
  return {
    path,
    kind: "semantic",
    language: extension === "java" ? "java" : "typescript",
    contentHash: HASH,
    sizeBytes: 1,
    lexicalTerms: [],
    imports: [],
    exports: [],
    symbols: [],
    dependencies: [],
    ...overrides,
  };
}

function handle(files: RepoMapFile[]): RepositorySnapshotHandle {
  const snapshot: RepoMapSnapshot = {
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
  const input: RepositoryCheckpointInput = {
    snapshot,
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

function graph(files: RepoMapFile[], options?: GraphBuildOptions) {
  const result = buildRepositoryGraph(handle(files), options);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error.code);
  return result;
}

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value as Record<string, unknown>)) expectDeepFrozen(nested, seen);
}

function edge(
  result: ReturnType<typeof graph>,
  raw: string,
  kind: "module-specifier" | "java-import-name" = "module-specifier",
) {
  const reference = result.graph.references.find(
    (item) =>
      item.descriptor.kind === kind &&
      item.descriptor.raw === raw &&
      (item.descriptor.kind !== "module-specifier" || item.descriptor.language === "typescript"),
  );
  const found = result.graph.edges.find(
    (item) =>
      item.referenceId === reference?.id && item.relation !== "EXPORTS_NAME" && item.relation !== "DEPENDS_ON_RAW",
  );
  if (!found) throw new Error(`missing edge for ${JSON.stringify(raw)}`);
  return found;
}

describe("repository graph S02c TS/JS resolver", () => {
  it("classifies invalid, unsupported, external, literal, substitution, extensionless, and index sources", () => {
    const sources = [
      "",
      "a\0b",
      "./a?raw",
      "/root",
      "C:\\root",
      "./bad\\path",
      "https:x",
      "node:",
      "node:fs",
      "pkg",
      "./literal.ts",
      "./present.js",
      "./exact",
      "./replace.js",
      "./module",
      "./folder/",
      "../../escape",
      "./.config",
      "./name.",
      "./Case",
    ];
    const result = graph([
      file("src/importer.ts", {
        imports: sources.map((source) => ({ source, names: [], typeOnly: false })),
      }),
      file("src/literal.ts"),
      file("src/present.js"),
      file("src/present.ts"),
      file("src/exact"),
      file("src/exact.ts"),
      file("src/exact/index.ts"),
      file("src/replace.ts"),
      file("src/replace.tsx"),
      file("src/module.ts"),
      file("src/module.js"),
      file("src/module/index.ts"),
      file("src/folder.ts"),
      file("src/folder/index.tsx"),
      file("src/case.ts"),
    ]);

    expect(edge(result, "")).toMatchObject({
      relation: "IMPORT_REFERENCE",
      resolution: { reason: "invalid-specifier" },
    });
    expect(edge(result, "a\0b")).toMatchObject({
      relation: "IMPORT_REFERENCE",
      resolution: { reason: "nul-specifier" },
    });
    expect(edge(result, "./a?raw").resolution.reason).toBe("query-or-fragment-unsupported");
    expect(edge(result, "/root").resolution.reason).toBe("absolute-specifier-unsupported");
    expect(edge(result, "C:\\root").resolution.reason).toBe("absolute-specifier-unsupported");
    expect(edge(result, "./bad\\path").resolution.reason).toBe("invalid-specifier");
    expect(edge(result, "https:x").resolution.reason).toBe("url-scheme-unsupported");
    expect(edge(result, "node:").resolution.reason).toBe("node-builtin-name-missing");
    expect(edge(result, "node:fs")).toMatchObject({
      relation: "IMPORTS_EXTERNAL",
      resolution: { status: "exact", rule: "tsjs-external-node-builtin" },
    });
    expect(edge(result, "pkg")).toMatchObject({
      relation: "IMPORTS_EXTERNAL",
      resolution: { status: "exact", rule: "tsjs-external-bare" },
    });
    expect(edge(result, "./literal.ts").resolution).toMatchObject({ status: "exact", rule: "tsjs-relative-literal" });
    expect(edge(result, "./present.js").resolution).toMatchObject({
      status: "exact",
      rule: "tsjs-relative-literal",
      candidates: [{ precedence: 0 }],
    });
    expect(edge(result, "./exact").resolution).toMatchObject({
      status: "exact",
      rule: "tsjs-relative-literal",
      candidates: [
        { precedence: 0, rule: "tsjs-relative-literal" },
        { precedence: 200, rule: "tsjs-extensionless-file" },
        { precedence: 300, rule: "tsjs-extensionless-index" },
      ],
    });
    expect(edge(result, "./replace.js").resolution).toMatchObject({
      status: "heuristic",
      rule: "tsjs-js-family-substitution",
      candidates: [
        { precedence: 100, rule: "tsjs-js-family-substitution" },
        { precedence: 101, rule: "tsjs-js-family-substitution" },
      ],
    });
    expect(edge(result, "./module").resolution).toMatchObject({
      status: "heuristic",
      rule: "tsjs-extensionless-file",
    });
    expect(edge(result, "./module").resolution.candidates.map((item) => item.precedence)).toEqual([200, 204, 300]);
    expect(edge(result, "./folder/").resolution).toMatchObject({
      status: "heuristic",
      rule: "tsjs-extensionless-index",
      candidates: [{ precedence: 301 }],
    });
    expect(edge(result, "../../escape")).toMatchObject({
      relation: "IMPORT_REFERENCE",
      resolution: { status: "unresolved", reason: "project-root-escape", candidates: [] },
    });
    expect(edge(result, "./.config").resolution.reason).toBe("no-candidate");
    expect(edge(result, "./name.").resolution.reason).toBe("no-candidate");
    expect(edge(result, "./Case").resolution.reason).toBe("no-candidate");
    expect(result.graph.externalModules).toHaveLength(2);
  });

  it("uses reference endpoints for every invalid/unsupported import and re-export class", () => {
    const cases = [
      ["", "invalid-specifier"],
      ["bad\0name", "nul-specifier"],
      ["./query?raw", "query-or-fragment-unsupported"],
      ["./fragment#raw", "query-or-fragment-unsupported"],
      ["/absolute", "absolute-specifier-unsupported"],
      ["\\absolute", "absolute-specifier-unsupported"],
      ["C:/absolute", "absolute-specifier-unsupported"],
      ["C:\\absolute", "absolute-specifier-unsupported"],
      ["./remaining\\slash", "invalid-specifier"],
      ["https:value", "url-scheme-unsupported"],
      ["Node:fs", "url-scheme-unsupported"],
      ["node:", "node-builtin-name-missing"],
      ["../../escape", "project-root-escape"],
    ] as const;
    const result = graph([
      file("src/main.ts", {
        imports: cases.map(([source]) => ({ source, names: [], typeOnly: false })),
        exports: cases.map(([source], index) => ({ name: `name${index}`, source, typeOnly: false })),
      }),
    ]);
    for (const [raw, reason] of cases) {
      const reference = result.graph.references.find(
        (item) =>
          item.descriptor.kind === "module-specifier" &&
          item.descriptor.language === "typescript" &&
          item.descriptor.raw === raw,
      );
      expect(reference, raw).toBeDefined();
      const related = result.graph.edges.filter((item) => item.referenceId === reference?.id);
      expect(related, raw).toHaveLength(2);
      expect(related, raw).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relation: "IMPORT_REFERENCE",
            resolution: expect.objectContaining({ status: "unresolved", reason, candidates: [] }),
          }),
          expect.objectContaining({
            relation: "REEXPORT_REFERENCE",
            resolution: expect.objectContaining({ status: "unresolved", reason, candidates: [] }),
          }),
        ]),
      );
      for (const unresolved of related) expect(unresolved).not.toHaveProperty("targetId");
    }
  });

  it("pins every JS-family suffix list and candidate truncation/omission", () => {
    const imports = ["./a.js", "./b.jsx", "./c.mjs", "./d.cjs", "./many"];
    const targets = [
      "src/a.ts",
      "src/a.tsx",
      "src/a.d.ts",
      "src/b.tsx",
      "src/b.d.ts",
      "src/c.mts",
      "src/c.d.mts",
      "src/d.cts",
      "src/d.d.cts",
      ...["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].map((suffix) => `src/many.${suffix}`),
      ...["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].map((suffix) => `src/many/index.${suffix}`),
    ];
    const result = graph(
      [
        file("src/main.ts", { imports: imports.map((source) => ({ source, names: [], typeOnly: false })) }),
        ...targets.map((path) => file(path)),
      ],
      { limits: { retainedCandidates: 1 } },
    );
    expect(edge(result, "./a.js").resolution.candidates[0]?.precedence).toBe(100);
    expect(edge(result, "./b.jsx").resolution.candidates[0]?.precedence).toBe(100);
    expect(edge(result, "./c.mjs").resolution.candidates[0]?.precedence).toBe(100);
    expect(edge(result, "./d.cjs").resolution.candidates[0]?.precedence).toBe(100);
    expect(edge(result, "./many").resolution).toMatchObject({ omittedCandidateCount: 15 });
  });

  it("uses re-export-specific relations and deduplicates literal external nodes while counting evidence", () => {
    const result = graph(
      [
        file("src/main.ts", {
          exports: [
            { name: "a", source: "pkg", typeOnly: false },
            { name: "b", source: "pkg", typeOnly: false },
            { name: "c", source: "pkg", typeOnly: false },
            { name: "d", source: "?bad", typeOnly: false },
          ],
        }),
      ],
      { limits: { retainedEvidence: 2 } },
    );
    const aggregated = edge(result, "pkg");
    expect(aggregated).toMatchObject({
      relation: "REEXPORTS_EXTERNAL",
      evidenceCount: 3,
      omittedEvidenceCount: 1,
    });
    expect(aggregated.evidence.map((item) => item.id)).toEqual([...aggregated.evidence.map((item) => item.id)].sort());
    expect(aggregated.evidence).toHaveLength(2);
    expect(edge(result, "?bad")).toMatchObject({ relation: "REEXPORT_REFERENCE" });
    expect(result.graph.externalModules).toHaveLength(1);
  });
});

describe("repository graph S02c Java resolver", () => {
  const top = (path: string, packageName: string | undefined, name: string, overrides: Partial<RepoMapFile> = {}) =>
    file(path, {
      language: "java",
      ...(packageName === undefined ? {} : { packageName }),
      symbols: [symbol(name)],
      ...overrides,
    });

  it("resolves exact, duplicate, immediate nested, deep, static, wildcard, missing flags, malformed, and degraded imports", () => {
    const imports = [
      { source: "p.A", names: [], typeOnly: false, static: false, wildcard: false },
      { source: "dup.D", names: [], typeOnly: false, static: false, wildcard: false },
      { source: "p.Outer.Inner", names: [], typeOnly: false, static: false, wildcard: false },
      { source: "p.Outer.Deep.Inner", names: [], typeOnly: false, static: false, wildcard: false },
      { source: "p.A.member", names: [], typeOnly: false, static: true, wildcard: false },
      { source: "p.*", names: [], typeOnly: false, static: false, wildcard: true },
      { source: "p.A", names: [], typeOnly: false },
      { source: "", names: [], typeOnly: false, static: false, wildcard: false },
      { source: "p..A", names: [], typeOnly: false, static: false, wildcard: false },
      { source: "p.\0A", names: [], typeOnly: false, static: false, wildcard: false },
      { source: "gone.G", names: [], typeOnly: false, static: false, wildcard: false },
      { source: "missing.Owner.member", names: [], typeOnly: false, static: true, wildcard: false },
    ];
    const result = graph([
      top("Use.java", "use", "Use", { imports }),
      top("A.java", "p", "A"),
      top("D1.java", "dup", "D"),
      top("D2.java", "dup", "D"),
      file("Outer.java", {
        language: "java",
        packageName: "p",
        symbols: [symbol("Outer"), symbol("Inner", { container: "Outer" })],
      }),
      top("Gone.java", "gone", "G", { degradedReason: "parse-error" }),
    ]);

    const exact = result.graph.edges.find(
      (item) => item.relation === "JAVA_IMPORTS_TYPE" && item.resolution.rule === "java-explicit-top-level-fqn",
    );
    expect(exact?.resolution.status).toBe("exact");
    expect(edge(result, "dup.D", "java-import-name").resolution.reason).toBe("java-duplicate-fqn");
    expect(edge(result, "p.Outer.Inner", "java-import-name").resolution).toMatchObject({
      status: "heuristic",
      rule: "java-immediate-container-heuristic",
    });
    expect(edge(result, "p.Outer.Deep.Inner", "java-import-name").resolution.reason).toBe(
      "java-deep-nested-unsupported",
    );
    expect(edge(result, "p.A.member", "java-import-name")).toMatchObject({
      relation: "JAVA_IMPORTS_STATIC_OWNER",
      resolution: { status: "exact", rule: "java-explicit-static-owner-fqn" },
    });
    expect(edge(result, "p.*", "java-import-name")).toMatchObject({
      relation: "JAVA_IMPORT_NAME",
      resolution: { reason: "java-wildcard-unsupported" },
    });
    const missing = result.graph.edges.find(
      (item) => item.relation === "JAVA_IMPORT_NAME" && item.resolution.reason === "java-import-flags-missing",
    );
    expect(missing).toBeDefined();
    expect(edge(result, "", "java-import-name").resolution.reason).toBe("invalid-specifier");
    expect(edge(result, "p..A", "java-import-name").resolution.reason).toBe("invalid-specifier");
    expect(edge(result, "p.\0A", "java-import-name").resolution.reason).toBe("nul-specifier");
    expect(edge(result, "gone.G", "java-import-name").resolution.reason).toBe("no-candidate");
    expect(edge(result, "missing.Owner.member", "java-import-name").resolution.reason).toBe(
      "java-static-owner-missing",
    );
  });

  it("pins Java targets, ambiguity, file deduplication, exact suppression, and eligibility filters", () => {
    const imports = [
      "q.Exact",
      "q.Owner.member",
      "q.Container.Inner",
      "amb.Container.Inner",
      "dup.Owner.member",
      "suppress.Outer.Inner",
      "bad.Function",
      "lex.L",
      "degraded.D",
    ].map((source, index) => ({
      source,
      names: [],
      typeOnly: false,
      static: index === 1 || index === 4,
      wildcard: false,
    }));
    const result = graph([
      top("Use.java", "use", "Use", { imports }),
      top("Exact.java", "q", "Exact", { symbols: [symbol("Exact"), symbol("Exact")] }),
      top("Owner.java", "q", "Owner"),
      file("Container.java", {
        language: "java",
        packageName: "q",
        symbols: [symbol("Container"), symbol("Inner", { container: "Container" })],
      }),
      file("Amb1.java", {
        language: "java",
        packageName: "amb",
        symbols: [symbol("Container"), symbol("Inner", { container: "Container" })],
      }),
      file("Amb2.java", {
        language: "java",
        packageName: "amb",
        symbols: [symbol("Container"), symbol("Inner", { container: "Container" })],
      }),
      top("Dup1.java", "dup", "Owner"),
      top("Dup2.java", "dup", "Owner"),
      top("ExactNestedSpelling.java", "suppress.Outer", "Inner"),
      file("SuppressedHeuristic.java", {
        language: "java",
        packageName: "suppress",
        symbols: [symbol("Outer"), symbol("Inner", { container: "Outer" })],
      }),
      top("Function.java", "bad", "Function", { symbols: [symbol("Function", { kind: "function" })] }),
      top("Lexical.java", "lex", "L", { kind: "lexical" }),
      top("Degraded.java", "degraded", "D", { degradedReason: "parse-error" }),
    ]);
    const idFor = (path: string) =>
      result.graph.files.find((candidate) => candidate.descriptor.canonicalPath === path)?.id;

    const exact = edge(result, "q.Exact", "java-import-name");
    expect(exact).toMatchObject({
      targetId: idFor("Exact.java"),
      resolution: {
        status: "exact",
        rule: "java-explicit-top-level-fqn",
        candidates: [{ id: idFor("Exact.java"), precedence: 0 }],
      },
    });
    expect(exact.resolution.candidates).toHaveLength(1);

    expect(edge(result, "q.Owner.member", "java-import-name")).toMatchObject({
      targetId: idFor("Owner.java"),
      resolution: { candidates: [{ id: idFor("Owner.java"), precedence: 0 }] },
    });
    expect(edge(result, "q.Container.Inner", "java-import-name")).toMatchObject({
      targetId: idFor("Container.java"),
      resolution: { status: "heuristic", candidates: [{ id: idFor("Container.java"), precedence: 100 }] },
    });
    expect(edge(result, "amb.Container.Inner", "java-import-name").resolution).toMatchObject({
      status: "unresolved",
      reason: "ambiguous-highest-precedence",
    });
    const ambiguousContainer = edge(result, "amb.Container.Inner", "java-import-name");
    expect(ambiguousContainer.resolution.candidates).toHaveLength(2);
    expect(ambiguousContainer.resolution.candidates.map((candidate) => candidate.id)).toEqual(
      [...ambiguousContainer.resolution.candidates.map((candidate) => candidate.id)].sort(),
    );
    const duplicateStatic = edge(result, "dup.Owner.member", "java-import-name");
    expect(duplicateStatic.resolution.reason).toBe("java-duplicate-fqn");
    expect(duplicateStatic).not.toHaveProperty("targetId");
    expect(duplicateStatic.resolution.candidates.map((candidate) => candidate.id)).toEqual(
      [...duplicateStatic.resolution.candidates.map((candidate) => candidate.id)].sort(),
    );

    const suppressed = edge(result, "suppress.Outer.Inner", "java-import-name");
    expect(suppressed).toMatchObject({
      targetId: idFor("ExactNestedSpelling.java"),
      resolution: { status: "exact", candidates: [{ precedence: 0 }] },
    });
    expect(suppressed.resolution.candidates).toHaveLength(1);
    for (const raw of ["bad.Function", "lex.L", "degraded.D"]) {
      expect(edge(result, raw, "java-import-name").resolution.reason).toBe("no-candidate");
    }
  });

  it("supports default-package immediate containers and does not filter unexported top-level types", () => {
    const result = graph([
      top("Use.java", "use", "Use", {
        imports: [
          { source: "Outer.Inner", names: [], typeOnly: false, static: false, wildcard: false },
          { source: "Visible", names: [], typeOnly: false, static: false, wildcard: false },
        ],
      }),
      file("Outer.java", {
        language: "java",
        symbols: [symbol("Outer"), symbol("Inner", { container: "Outer" })],
      }),
      top("Visible.java", undefined, "Visible"),
    ]);
    expect(edge(result, "Outer.Inner", "java-import-name").resolution.status).toBe("heuristic");
    expect(edge(result, "Visible", "java-import-name").resolution.status).toBe("exact");
  });
});

describe("repository graph S02c finalization contract", () => {
  it("returns exact JCS bytes, only Graph v1 fields, deterministic ordering, and a deeply frozen graph", () => {
    const files = [file("z.ts", { imports: [{ source: "pkg", names: [], typeOnly: false }] }), file("a.ts")];
    const first = graph(files);
    const second = graph([...files].reverse());
    expect(first.serializedBytes).toBe(2429);
    expect(first.graph.externalModules[0]?.id).toBe(
      "external-module:sha256:VmCdx7siaXynj0Sg5XeK_PBAxSki-tSviS0ZT2sa6Sg",
    );
    expect(first.graph.edges.map((item) => item.id)).toEqual([
      "edge:sha256:PbkPyr_VzIfVPEWENDE1VCRWK6KQ4hCBtTMtwtgHFDA",
    ]);
    expect(createHash("sha256").update(canonicalizeJcs(first.graph)).digest("hex")).toBe(
      "b66cc425fcfcf638075273221edea84d49fca919c6b082a43547f345187272c8",
    );
    expect(first.serializedBytes).toBe(Buffer.byteLength(canonicalizeJcs(first.graph), "utf8"));
    expect(canonicalizeJcs(first.graph)).toBe(canonicalizeJcs(second.graph));
    expect(Object.keys(first.graph).sort()).toEqual(
      [
        "analyzerCapabilityVersion",
        "complete",
        "edges",
        "externalModules",
        "files",
        "graphSchemaVersion",
        "references",
        "snapshotContentIdentity",
        "symbols",
      ].sort(),
    );
    expect(first.graph.complete).toBe(true);
    expect(first.graph).not.toHaveProperty("fileResolverMetadata");
    expect(first.graph).not.toHaveProperty("resolverWorkItems");
    expect(first.graph).not.toHaveProperty("canonicalInputBytesUsed");
    expect(Object.keys(first.graph.files[0] ?? {}).sort()).toEqual(
      ["contentHash", "descriptor", "fileKind", "id", "language", "nodeKind", "sizeBytes"].sort(),
    );
    expect(Object.keys(first.graph.files[0]?.descriptor ?? {})).toEqual(["canonicalPath"]);
    expect(Object.keys(first.graph.externalModules[0] ?? {}).sort()).toEqual(["descriptor", "id", "nodeKind"].sort());
    expect(Object.keys(first.graph.externalModules[0]?.descriptor ?? {}).sort()).toEqual(
      ["language", "literalSpecifier", "moduleKind"].sort(),
    );
    expect(Object.keys(first.graph.references[0] ?? {}).sort()).toEqual(["descriptor", "id"]);
    const finalEdge = first.graph.edges[0];
    expect(finalEdge).toBeDefined();
    expect(Object.keys(finalEdge?.resolution ?? {}).sort()).toEqual(
      ["candidates", "omittedCandidateCount", "reason", "rule", "status"].sort(),
    );
    expect(Object.keys(finalEdge?.evidence[0] ?? {}).sort()).toEqual(["descriptor", "explanation", "id"]);
    expectDeepFrozen(first.graph);

    const symbolResult = graph([file("symbol.ts", { symbols: [symbol("Frozen")] })]);
    const frozenSymbol = symbolResult.graph.symbols[0];
    expect(Object.keys(frozenSymbol ?? {}).sort()).toEqual(
      ["descriptor", "id", "nodeKind", "recordedRowOrdinal", "row"].sort(),
    );
    expect(Object.keys(frozenSymbol?.descriptor ?? {}).sort()).toEqual(
      ["container", "fileId", "language", "name", "occurrenceOrdinal", "signature", "symbolKind"].sort(),
    );
    expectDeepFrozen(symbolResult.graph);
  });

  it("enforces exact serialized and canonical continuation boundaries without partial topology", () => {
    const successful = graph([file("a.ts", { imports: [{ source: "pkg", names: [], typeOnly: false }] })]);
    expect(
      buildRepositoryGraph(handle([file("a.ts", { imports: [{ source: "pkg", names: [], typeOnly: false }] })]), {
        limits: { serializedGraphBytes: successful.serializedBytes },
      }),
    ).toMatchObject({ ok: true });
    const failed = buildRepositoryGraph(
      handle([file("a.ts", { imports: [{ source: "pkg", names: [], typeOnly: false }] })]),
      { limits: { serializedGraphBytes: successful.serializedBytes - 1 } },
    );
    expect(failed).toEqual({
      ok: false,
      error: {
        code: "serialized-graph-bound-exceeded",
        phase: "serialize",
        message: "repository graph build failed: serialized graph bound exceeded",
        limit: successful.serializedBytes - 1,
        observed: expect.any(Number),
      },
    });
    expect(failed).not.toHaveProperty("graph");

    const assembled = buildRepositoryGraphAssembly(
      handle([file("a.ts", { imports: [{ source: "pkg", names: [], typeOnly: false }] })]),
    );
    if (!assembled.ok) throw new Error(assembled.error.code);
    const work = assembled.assembly.resolverWorkItems[0];
    if (!work) throw new Error("missing work");
    const externalDescriptor = {
      language: "typescript" as const,
      moduleKind: "bare" as const,
      literalSpecifier: "pkg",
    };
    const externalId = createDomainSeparatedId(
      "external-module:sha256:",
      "repository-graph/external-module",
      externalDescriptor,
    );
    const finalEdgeDescriptor = {
      descriptorKind: "reference" as const,
      sourceId: work.sourceFileId,
      relation: "IMPORTS_EXTERNAL" as const,
      referenceId: work.referenceId,
    };
    const finalCanonicalBytes =
      assembled.assembly.canonicalInputBytesUsed +
      Buffer.byteLength(
        canonicalizeJcs({ domain: "repository-graph/external-module", payload: externalDescriptor, version: 1 }),
        "utf8",
      ) +
      Buffer.byteLength(
        canonicalizeJcs({ domain: "repository-graph/edge", payload: finalEdgeDescriptor, version: 1 }),
        "utf8",
      );
    expect(externalId).toMatch(/^external-module:sha256:/u);
    expect(
      finalizeRepositoryGraphAssembly(assembled.assembly, {
        limits: { canonicalInputBytes: finalCanonicalBytes },
      }),
    ).toMatchObject({ ok: true });
    expect(
      finalizeRepositoryGraphAssembly(assembled.assembly, {
        limits: { canonicalInputBytes: finalCanonicalBytes - 1 },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "canonical-input-bound-exceeded", phase: "identify", limit: finalCanonicalBytes - 1 },
    });
  });

  it("authenticates the non-transferable assembly boundary before reading untrusted values", () => {
    const assembled = buildRepositoryGraphAssembly(handle([file("a.ts", { symbols: [symbol("A")] })]));
    if (!assembled.ok) throw new Error(assembled.error.code);
    const invalid = {
      ok: false,
      error: {
        code: "invalid-snapshot",
        phase: "resolve",
        message: "repository graph build failed: invalid snapshot",
      },
    } as const;
    expect(finalizeRepositoryGraphAssembly(assembled.assembly)).toMatchObject({ ok: true });

    const decremented = structuredClone(assembled.assembly) as { canonicalInputBytesUsed: number };
    decremented.canonicalInputBytesUsed -= 1;
    expect(finalizeRepositoryGraphAssembly(decremented)).toEqual(invalid);

    const extra = structuredClone(assembled.assembly) as unknown as Record<string, unknown>;
    extra.extra = true;
    const extraFile = (extra.files as Array<{ descriptor: Record<string, unknown> }>)[0];
    if (extraFile) extraFile.descriptor.extra = true;
    expect(finalizeRepositoryGraphAssembly(extra)).toEqual(invalid);

    let trapCount = 0;
    const proxied = new Proxy(assembled.assembly, {
      get() {
        trapCount += 1;
        throw new Error("proxy trap must not run");
      },
    });
    expect(finalizeRepositoryGraphAssembly(proxied)).toEqual(invalid);
    expect(trapCount).toBe(0);

    let getterCount = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "files", {
      get() {
        getterCount += 1;
        throw new Error("getter must not run");
      },
      enumerable: true,
    });
    expect(finalizeRepositoryGraphAssembly(accessor)).toEqual(invalid);
    expect(getterCount).toBe(0);

    const accessorArrayClone = structuredClone(assembled.assembly) as unknown as { edges: unknown[] };
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, "0", {
      get() {
        getterCount += 1;
        throw new Error("array getter must not run");
      },
      enumerable: true,
    });
    accessorArrayClone.edges = accessorArray;
    expect(finalizeRepositoryGraphAssembly(accessorArrayClone)).toEqual(invalid);
    expect(getterCount).toBe(0);

    const forged = structuredClone(assembled.assembly) as unknown as {
      edges: unknown[];
      resolverWorkItems: unknown[];
    };
    forged.edges = new Proxy([], {
      get() {
        trapCount += 1;
        throw new Error("nested array trap must not run");
      },
    });
    forged.resolverWorkItems = new Array(1_000_001);
    expect(finalizeRepositoryGraphAssembly(forged)).toEqual(invalid);
    expect(trapCount).toBe(0);

    const oversizedEdges = structuredClone(assembled.assembly) as unknown as { edges: unknown[] };
    oversizedEdges.edges = new Array(1_000_001);
    expect(finalizeRepositoryGraphAssembly(oversizedEdges)).toEqual(invalid);

    class ForgedAssembly {}
    expect(finalizeRepositoryGraphAssembly(new ForgedAssembly())).toEqual(invalid);

    const zeroEvidence = structuredClone(assembled.assembly) as unknown as {
      edges: Array<{ evidence: unknown[]; evidenceCount: number }>;
    };
    if (zeroEvidence.edges[0]) {
      zeroEvidence.edges[0].evidence = [];
      zeroEvidence.edges[0].evidenceCount = 0;
    }
    expect(finalizeRepositoryGraphAssembly(zeroEvidence)).toEqual(invalid);
  });

  it("preserves stable custom IDs across assembly/finalize and rejects a mismatched factory", () => {
    const stableId = (prefix: string, domain: string, payload: unknown) =>
      createDomainSeparatedId(prefix, domain, payload);
    const source = handle([
      file("a.ts", {
        symbols: [symbol("A")],
        imports: [{ source: "pkg", names: [], typeOnly: false }],
      }),
    ]);
    const assembled = buildRepositoryGraphAssembly(source, { createId: stableId });
    if (!assembled.ok) throw new Error(assembled.error.code);
    const finalized = finalizeRepositoryGraphAssembly(assembled.assembly, { createId: stableId });
    const oneShot = buildRepositoryGraph(source, { createId: stableId });
    expect(finalized).toMatchObject({ ok: true });
    expect(oneShot).toMatchObject({ ok: true });
    if (!finalized.ok || !oneShot.ok) throw new Error("custom ID build failed");
    expect(finalized.serializedBytes).toBe(oneShot.serializedBytes);
    expect(canonicalizeJcs(finalized.graph)).toBe(canonicalizeJcs(oneShot.graph));

    let changed = false;
    const changingId = (prefix: string, domain: string, payload: unknown) => {
      const id = createDomainSeparatedId(prefix, domain, payload);
      return changed ? `${prefix}${"A".repeat(43)}` : id;
    };
    const custom = buildRepositoryGraphAssembly(handle([file("mismatch.ts")]), { createId: changingId });
    if (!custom.ok) throw new Error(custom.error.code);
    changed = true;
    expect(finalizeRepositoryGraphAssembly(custom.assembly, { createId: changingId })).toMatchObject({
      ok: false,
      error: { code: "invalid-snapshot", phase: "resolve" },
    });
  });

  it("continues count limits before dedup and detects resolver-created identity collisions", () => {
    const duplicateExternal = handle([
      file("a.ts", {
        imports: [
          { source: "pkg", names: [], typeOnly: false },
          { source: "pkg", names: [], typeOnly: false },
        ],
      }),
    ]);
    expect(buildRepositoryGraph(duplicateExternal, { limits: { externalModules: 1 } })).toMatchObject({
      ok: false,
      error: { code: "count-bound-exceeded", phase: "resolve", limit: 1, observed: 2 },
    });
    expect(
      buildRepositoryGraph(handle([file("a.ts", { imports: [{ source: "pkg", names: [], typeOnly: false }] })]), {
        limits: { edges: 0 },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "count-bound-exceeded", phase: "resolve", limit: 0, observed: 1 },
    });
    let seededAssemblyEdgeId: string | undefined;
    const crossStageFactory = (prefix: string, domain: string, payload: unknown) => {
      const relation =
        typeof payload === "object" && payload !== null && "relation" in payload
          ? (payload as { relation?: unknown }).relation
          : undefined;
      const normal = createDomainSeparatedId(prefix, domain, payload);
      if (domain === "repository-graph/edge" && relation === "DECLARES") seededAssemblyEdgeId = normal;
      if (domain === "repository-graph/edge" && relation === "IMPORTS_EXTERNAL") {
        if (seededAssemblyEdgeId === undefined) throw new Error("missing seeded edge");
        return seededAssemblyEdgeId;
      }
      return normal;
    };
    expect(
      buildRepositoryGraph(
        handle([
          file("seed.ts", {
            symbols: [symbol("Seed")],
            imports: [{ source: "pkg", names: [], typeOnly: false }],
          }),
        ]),
        { createId: crossStageFactory },
      ),
    ).toMatchObject({ ok: false, error: { code: "identity-collision", phase: "identify" } });

    const collisionId = `${"external-module:sha256:"}${"A".repeat(43)}`;
    const collisionFactory = (prefix: string, domain: string, payload: unknown) =>
      domain === "repository-graph/external-module" ? collisionId : createDomainSeparatedId(prefix, domain, payload);
    expect(
      buildRepositoryGraph(
        handle([
          file("a.ts", {
            imports: [
              { source: "one", names: [], typeOnly: false },
              { source: "two", names: [], typeOnly: false },
            ],
          }),
        ]),
        { createId: collisionFactory },
      ),
    ).toMatchObject({ ok: false, error: { code: "identity-collision", phase: "identify" } });
  });

  it("rejects retained-candidate overrides outside 1..32", () => {
    expect(buildRepositoryGraph(handle([file("a.ts")]), { limits: { retainedCandidates: 0 } })).toMatchObject({
      ok: false,
      error: { code: "invalid-snapshot", phase: "validate" },
    });
    expect(buildRepositoryGraph(handle([file("a.ts")]), { limits: { retainedCandidates: 33 } })).toMatchObject({
      ok: false,
      error: { code: "invalid-snapshot", phase: "validate" },
    });
  });
});
