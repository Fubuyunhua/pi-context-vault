import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildRepoMap, loadRepoMapSnapshot, RepoMapSearch } from "../src/repo-map/index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string | Uint8Array>, git = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "context-vault-map-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  if (git) await execFileAsync("git", ["init", "-q"], { cwd: root });
  return root;
}

describe("initial repository map", () => {
  it("honors gitignore, built-in exclusions, and configured exclusions", async () => {
    const root = await fixture(
      {
        ".gitignore": "ignored.ts\ncache/\n",
        "src/visible.ts": "export const visible = true;",
        "ignored.ts": "export const secret = true;",
        "cache/result.js": "export const cached = true;",
        "node_modules/pkg/index.js": "export const dependency = true;",
        "generated/client.ts": "export const generated = true;",
      },
      true,
    );

    const snapshot = await buildRepoMap({ projectRoot: root, exclude: ["generated/**"] });
    expect(snapshot.files.map((file) => file.path)).toContain("src/visible.ts");
    expect(snapshot.files.map((file) => file.path)).not.toEqual(
      expect.arrayContaining(["ignored.ts", "cache/result.js", "node_modules/pkg/index.js", "generated/client.ts"]),
    );
  });

  it("honors root gitignore rules before a repository is initialized", async () => {
    const root = await fixture({
      ".gitignore": "# generated output\n*.log\ntemporary/\n",
      "debug.log": "not indexed",
      "temporary/cache.txt": "not indexed",
      "notes.txt": "indexed",
    });

    const snapshot = await buildRepoMap({ projectRoot: root });
    expect(snapshot.files.map((file) => file.path)).toEqual([".gitignore", "notes.txt"]);
  });

  it("extracts TS/JS imports, exports, symbols, signatures, and dependencies", async () => {
    const root = await fixture({
      "src/types.ts": "export interface User { id: string }\nexport type UserId = string;",
      "src/service.ts": [
        'import type { User } from "./types.js";',
        'export { UserId } from "./types.js";',
        "export class UserService { find(id: string): Promise<User> { throw new Error(id); } }",
        "export function createUser(name: string, active = true): User { return { id: name }; }",
        "const internalCount: number = 0;",
      ].join("\n"),
      "src/widget.jsx": "export const Widget = ({ title }) => <h1>{title}</h1>;",
      "README.md": "User service architecture and usage",
    });

    const snapshot = await buildRepoMap({ projectRoot: root });
    const service = snapshot.files.find((file) => file.path === "src/service.ts");
    expect(service).toMatchObject({ kind: "semantic", language: "typescript" });
    expect(service?.imports).toEqual([
      expect.objectContaining({ source: "./types.js", names: ["User"], typeOnly: true }),
    ]);
    expect(service?.exports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "UserId", source: "./types.js" }),
        expect.objectContaining({ name: "UserService" }),
        expect.objectContaining({ name: "createUser" }),
      ]),
    );
    expect(service?.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "UserService", kind: "class", signature: "class UserService" }),
        expect.objectContaining({
          name: "createUser",
          kind: "function",
          signature: "function createUser(name: string, active?: boolean): User",
        }),
        expect.objectContaining({ name: "internalCount", kind: "variable", signature: "const internalCount: number" }),
      ]),
    );
    expect(service?.dependencies).toEqual(["./types.js"]);
    expect(snapshot.files.find((file) => file.path === "README.md")).toMatchObject({
      kind: "lexical",
      lexicalTerms: expect.arrayContaining(["user", "service", "architecture"]),
    });
    expect(snapshot.files.find((file) => file.path === "src/widget.jsx")).toMatchObject({
      kind: "semantic",
      language: "javascript",
    });
  });

  it.each([
    ["ts", "typescript"],
    ["tsx", "typescript"],
    ["mts", "typescript"],
    ["cts", "typescript"],
    ["js", "javascript"],
    ["jsx", "javascript"],
    ["mjs", "javascript"],
    ["cjs", "javascript"],
  ] as const)("semantically indexes .%s files", async (extension, language) => {
    const root = await fixture({ [`src/module.${extension}`]: "export function supported(value) { return value; }" });
    const snapshot = await buildRepoMap({ projectRoot: root });

    expect(snapshot.files[0]).toMatchObject({ kind: "semantic", language });
    expect(snapshot.files[0]?.symbols).toEqual([expect.objectContaining({ name: "supported", kind: "function" })]);
  });

  it("indexes CommonJS dependencies and exports", async () => {
    const root = await fixture({
      "src/legacy.cjs":
        'const utility = require("./utility.cjs");\nexports.run = utility;\nmodule.exports.stop = () => {};',
      "src/utility.cjs": "module.exports = () => true;",
    });
    const snapshot = await buildRepoMap({ projectRoot: root });
    const legacy = snapshot.files.find((file) => file.path === "src/legacy.cjs");

    expect(legacy?.imports).toEqual([{ source: "./utility.cjs", names: ["utility"], typeOnly: false }]);
    expect(legacy?.dependencies).toEqual(["./utility.cjs"]);
    expect(legacy?.exports).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "run" }), expect.objectContaining({ name: "stop" })]),
    );
    expect(snapshot.files.find((file) => file.path === "src/utility.cjs")?.exports).toEqual([
      expect.objectContaining({ name: "default" }),
    ]);
  });

  it("captures the supported top-level declaration and module forms", async () => {
    const root = await fixture({
      "src/all.ts": [
        'import DefaultThing, * as Helpers from "pkg";',
        'import "side-effect";',
        'export * from "./public.js";',
        "export { localValue };",
        "export interface Shape { size: number }",
        "export type Identifier = string;",
        "export enum Mode { Fast }",
        "export namespace Feature {}",
        "export default function namedDefault(...values: string[]): number { return values.length; }",
        'function defaults(label = "item", count = 2, value?) { return [label, count, value]; }',
        "let localValue = 1;",
        "var legacyValue = 2;",
      ].join("\n"),
    });
    const file = (await buildRepoMap({ projectRoot: root })).files[0];

    expect(file?.dependencies).toEqual(["pkg", "side-effect", "./public.js"]);
    expect(file?.imports).toEqual(
      expect.arrayContaining([
        { source: "pkg", names: ["DefaultThing", "Helpers"], typeOnly: false },
        { source: "side-effect", names: [], typeOnly: false },
      ]),
    );
    expect(file?.exports.map((item) => item.name)).toEqual(
      expect.arrayContaining(["*", "localValue", "Shape", "Identifier", "Mode", "Feature", "namedDefault", "default"]),
    );
    expect(file?.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Shape", kind: "interface" }),
        expect.objectContaining({ name: "Identifier", kind: "type" }),
        expect.objectContaining({ name: "Mode", kind: "enum" }),
        expect.objectContaining({ name: "Feature", kind: "namespace" }),
        expect.objectContaining({
          name: "namedDefault",
          signature: "function namedDefault(...values: string[]): number",
        }),
        expect.objectContaining({
          name: "defaults",
          signature: "function defaults(label?: string, count?: number, value?)",
        }),
        expect.objectContaining({ name: "localValue", signature: "let localValue" }),
        expect.objectContaining({ name: "legacyValue", signature: "var legacyValue" }),
      ]),
    );
  });

  it("ranks relevant files and symbols in the top five", async () => {
    const root = await fixture({
      "src/auth/session-manager.ts": "export class SessionManager { refreshAccessToken(): string { return 'token'; } }",
      "src/auth/token-store.ts": "export function persistRefreshToken(token: string): void { void token; }",
      "src/billing/invoice.ts": "export function createInvoice(): void {}",
      "src/catalog/product.ts": "export interface Product { sku: string }",
      "src/server/health.ts": "export const healthCheck = () => 'ok';",
      "README.md": "Application documentation",
      "CHANGELOG.md": "Release history",
    });
    const snapshot = await buildRepoMap({ projectRoot: root });
    const search = new RepoMapSearch(snapshot);

    const results = search.query("refresh access token session", { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);
    expect(results.map((result) => result.path)).toContain("src/auth/session-manager.ts");
    expect(results.findIndex((result) => result.path === "src/auth/session-manager.ts")).toBeLessThan(2);
    expect(results[0]?.matchedSymbols).toContain("SessionManager");
  });

  it("persists an atomic versioned snapshot with provenance", async () => {
    const root = await fixture({ "src/index.mts": "export const start = (): void => {};" });
    const outputPath = join(root, "state", "repo-map.json");
    const built = await buildRepoMap({ projectRoot: root, outputPath });
    const loaded = await loadRepoMapSnapshot(outputPath);

    expect(loaded).toEqual(built);
    expect(loaded.schemaVersion).toBe(1);
    expect(loaded.provenance).toMatchObject({
      generator: "pi-context-vault",
      parser: "typescript-compiler-api",
    });
    expect(loaded.provenance.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(loaded);
  });

  it("rejects invalid snapshots and query limits", async () => {
    const root = await fixture({ "src/index.ts": "export const start = true;", "invalid.json": "{}" });
    await expect(loadRepoMapSnapshot(join(root, "invalid.json"))).rejects.toThrow("invalid repository map snapshot");
    const search = new RepoMapSearch(await buildRepoMap({ projectRoot: root }));
    expect(() => search.query("start", { limit: 0 })).toThrow("positive integer");
    expect(search.query("term-that-does-not-exist")).toEqual([]);
  });

  it("degrades malformed and unsupported files without aborting the scan", async () => {
    const root = await fixture({
      "src/good.cts": "export function healthy(value: number): number { return value; }",
      "src/broken.ts": "export function broken( {",
      "src/program.py": "def useful_worker():\n    return True\n",
      "assets/data.bin": new Uint8Array([0, 1, 2, 3]),
    });

    const snapshot = await buildRepoMap({ projectRoot: root });
    expect(snapshot.files.find((file) => file.path === "src/good.cts")?.kind).toBe("semantic");
    expect(snapshot.files.find((file) => file.path === "src/broken.ts")).toMatchObject({
      kind: "lexical",
      degradedReason: expect.stringContaining("parse"),
    });
    expect(snapshot.files.find((file) => file.path === "src/program.py")).toMatchObject({
      kind: "lexical",
      lexicalTerms: expect.arrayContaining(["useful_worker"]),
    });
    expect(snapshot.files.map((file) => file.path)).not.toContain("assets/data.bin");
    expect(snapshot.warnings).toEqual([expect.objectContaining({ path: "src/broken.ts", code: "parse-error" })]);
  });
});
