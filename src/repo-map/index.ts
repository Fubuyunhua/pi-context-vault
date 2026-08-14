import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import MiniSearch from "minisearch";
import ts from "typescript";
import { atomicWriteFile } from "../state/atomic.js";

const execFileAsync = promisify(execFile);
export const REPO_MAP_SCHEMA_VERSION = 1;
const SEMANTIC_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const BUILT_IN_EXCLUDED_SEGMENTS = new Set([".git", ".pi", "node_modules", "dist", "build"]);

export type RepoMapFileKind = "semantic" | "lexical";
export type RepoMapLanguage = "typescript" | "javascript" | "text";

export interface RepoMapImport {
  source: string;
  names: string[];
  typeOnly: boolean;
}

export interface RepoMapExport {
  name: string;
  source?: string;
  typeOnly: boolean;
}

export interface RepoMapSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "enum" | "variable" | "namespace";
  signature: string;
  exported: boolean;
  line: number;
}

export interface RepoMapFile {
  path: string;
  kind: RepoMapFileKind;
  language: RepoMapLanguage;
  contentHash: string;
  sizeBytes: number;
  lexicalTerms: string[];
  imports: RepoMapImport[];
  exports: RepoMapExport[];
  symbols: RepoMapSymbol[];
  dependencies: string[];
  degradedReason?: string;
}

export interface RepoMapWarning {
  path: string;
  code: "parse-error" | "read-error";
  message: string;
}

export interface RepoMapSnapshot {
  schemaVersion: 1;
  provenance: {
    generator: "pi-context-vault";
    generatorVersion: "0.1.0";
    parser: "typescript-compiler-api";
    typescriptVersion: string;
    generatedAt: string;
    projectRoot: string;
  };
  files: RepoMapFile[];
  warnings: RepoMapWarning[];
}

export interface BuildRepoMapOptions {
  projectRoot: string;
  exclude?: string[];
  outputPath?: string;
}

export interface RepoMapQueryOptions {
  limit?: number;
}

export interface RepoMapQueryResult {
  path: string;
  score: number;
  kind: RepoMapFileKind;
  matchedSymbols: string[];
  symbols: RepoMapSymbol[];
  dependencies: string[];
}

interface SearchDocument {
  id: string;
  path: string;
  fileName: string;
  symbols: string;
  signatures: string;
  exports: string;
  imports: string;
  terms: string;
}

function slash(path: string): string {
  return path.split(sep).join("/");
}

function globExpression(pattern: string): RegExp {
  let source = pattern.replace(/^\.\//, "").replace(/^\//, "");
  const anchored = pattern.startsWith("/");
  const directory = source.endsWith("/");
  if (directory) source += "**";
  let expression = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "*" && source[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character?.replace(/[|\\{}()[\]^$+?.]/g, "\\$&") ?? "";
  }
  const prefix = anchored || source.includes("/") ? "^" : "(^|.*/)";
  return new RegExp(`${prefix}${expression}${directory ? "" : "$"}`);
}

function exclusionMatcher(patterns: string[]): (path: string) => boolean {
  const expressions = patterns.filter((pattern) => pattern.trim() && !pattern.startsWith("!")).map(globExpression);
  return (path) => {
    const parts = path.split("/");
    return parts.some((part) => BUILT_IN_EXCLUDED_SEGMENTS.has(part)) || expressions.some((regex) => regex.test(path));
  };
}

async function gitFiles(projectRoot: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: projectRoot,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.toString("utf8").split("\0").filter(Boolean).map(slash);
  } catch {
    return undefined;
  }
}

async function fallbackFiles(projectRoot: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (BUILT_IN_EXCLUDED_SEGMENTS.has(entry.name)) return;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) output.push(slash(relative(projectRoot, absolute)));
      }),
    );
  }
  await walk(projectRoot);
  return output;
}

async function rootGitignorePatterns(projectRoot: string): Promise<string[]> {
  try {
    return (await readFile(join(projectRoot, ".gitignore"), "utf8"))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function enumerateFiles(projectRoot: string, exclude: string[]): Promise<string[]> {
  const fromGit = await gitFiles(projectRoot);
  const patterns = [...exclude, ...(fromGit ? [] : await rootGitignorePatterns(projectRoot))];
  const isExcluded = exclusionMatcher(patterns);
  return [...new Set(fromGit ?? (await fallbackFiles(projectRoot)))].filter((path) => !isExcluded(path)).sort();
}

function lexicalTerms(path: string, text: string): string[] {
  const terms = `${path} ${text}`.toLowerCase().match(/[\p{L}\p{N}_$-]{2,}/gu) ?? [];
  return [...new Set(terms)].slice(0, 2_000);
}

function isText(content: Buffer): boolean {
  return !content.subarray(0, 8_192).includes(0);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function exported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword) || hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function parameters(parameters: ts.NodeArray<ts.ParameterDeclaration>, source: ts.SourceFile): string {
  return parameters
    .map((parameter) => {
      const rest = parameter.dotDotDotToken ? "..." : "";
      const name = parameter.name.getText(source);
      const optional = parameter.questionToken || parameter.initializer ? "?" : "";
      let inferredType = "";
      if (!parameter.type && parameter.initializer) {
        if (
          parameter.initializer.kind === ts.SyntaxKind.TrueKeyword ||
          parameter.initializer.kind === ts.SyntaxKind.FalseKeyword
        ) {
          inferredType = "boolean";
        } else if (ts.isStringLiteral(parameter.initializer)) inferredType = "string";
        else if (ts.isNumericLiteral(parameter.initializer)) inferredType = "number";
      }
      const type = parameter.type ? `: ${parameter.type.getText(source)}` : inferredType ? `: ${inferredType}` : "";
      return `${rest}${name}${optional}${type}`;
    })
    .join(", ");
}

function declarationName(node: { name?: ts.DeclarationName }, source: ts.SourceFile, fallback: string): string {
  return node.name?.getText(source) ?? fallback;
}

function requiredModule(node: ts.Expression | undefined): string | undefined {
  if (
    node &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0] as ts.Expression)
  ) {
    return (node.arguments[0] as ts.StringLiteral).text;
  }
  return undefined;
}

function commonJsExportName(statement: ts.Statement): string | undefined {
  if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return undefined;
  const left = statement.expression.left;
  if (!ts.isPropertyAccessExpression(left)) return undefined;
  if (ts.isIdentifier(left.expression) && left.expression.text === "exports") return left.name.text;
  if (
    ts.isPropertyAccessExpression(left.expression) &&
    ts.isIdentifier(left.expression.expression) &&
    left.expression.expression.text === "module" &&
    left.expression.name.text === "exports"
  ) {
    return left.name.text;
  }
  if (ts.isIdentifier(left.expression) && left.expression.text === "module" && left.name.text === "exports") {
    return "default";
  }
  return undefined;
}

function analyzeSemantic(
  path: string,
  text: string,
): Pick<RepoMapFile, "imports" | "exports" | "symbols" | "dependencies"> {
  const extension = extname(path).toLowerCase();
  const scriptKind =
    extension === ".tsx"
      ? ts.ScriptKind.TSX
      : extension === ".jsx"
        ? ts.ScriptKind.JSX
        : extension === ".js" || extension === ".mjs" || extension === ".cjs"
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostics =
    (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const message = ts.flattenDiagnosticMessageText(diagnostics[0]?.messageText ?? "unknown parse error", " ");
    throw new Error(`parse error: ${message}`);
  }

  const imports: RepoMapImport[] = [];
  const exports: RepoMapExport[] = [];
  const symbols: RepoMapSymbol[] = [];
  const dependencies = new Set<string>();

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const sourceName = statement.moduleSpecifier.text;
      dependencies.add(sourceName);
      const clause = statement.importClause;
      const names: string[] = [];
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        names.push(clause.namedBindings.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        names.push(...clause.namedBindings.elements.map((element) => element.name.text));
      }
      imports.push({ source: sourceName, names, typeOnly: Boolean(clause?.isTypeOnly) });
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      const sourceName =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;
      if (sourceName) dependencies.add(sourceName);
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          exports.push({
            name: element.name.text,
            ...(sourceName ? { source: sourceName } : {}),
            typeOnly: statement.isTypeOnly || element.isTypeOnly,
          });
        }
      } else exports.push({ name: "*", ...(sourceName ? { source: sourceName } : {}), typeOnly: statement.isTypeOnly });
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      exports.push({ name: "default", typeOnly: false });
      continue;
    }

    const assignedExport = commonJsExportName(statement);
    if (assignedExport) {
      exports.push({ name: assignedExport, typeOnly: false });
      continue;
    }

    let symbol: RepoMapSymbol | undefined;
    if (ts.isFunctionDeclaration(statement)) {
      const name = declarationName(statement, source, "default");
      const signature = `function ${name}(${parameters(statement.parameters, source)})${statement.type ? `: ${statement.type.getText(source)}` : ""}`;
      symbol = { name, kind: "function", signature, exported: exported(statement), line: lineOf(source, statement) };
    } else if (ts.isClassDeclaration(statement)) {
      const name = declarationName(statement, source, "default");
      symbol = {
        name,
        kind: "class",
        signature: `class ${name}`,
        exported: exported(statement),
        line: lineOf(source, statement),
      };
    } else if (ts.isInterfaceDeclaration(statement)) {
      const name = statement.name.text;
      symbol = {
        name,
        kind: "interface",
        signature: `interface ${name}`,
        exported: exported(statement),
        line: lineOf(source, statement),
      };
    } else if (ts.isTypeAliasDeclaration(statement)) {
      const name = statement.name.text;
      symbol = {
        name,
        kind: "type",
        signature: `type ${name} = ${statement.type.getText(source)}`,
        exported: exported(statement),
        line: lineOf(source, statement),
      };
    } else if (ts.isEnumDeclaration(statement)) {
      const name = statement.name.text;
      symbol = {
        name,
        kind: "enum",
        signature: `enum ${name}`,
        exported: exported(statement),
        line: lineOf(source, statement),
      };
    } else if (ts.isModuleDeclaration(statement)) {
      const name = statement.name.getText(source);
      symbol = {
        name,
        kind: "namespace",
        signature: `namespace ${name}`,
        exported: exported(statement),
        line: lineOf(source, statement),
      };
    }
    if (symbol) {
      symbols.push(symbol);
      if (symbol.exported) {
        exports.push({ name: symbol.name, typeOnly: symbol.kind === "interface" || symbol.kind === "type" });
        if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword) && symbol.name !== "default") {
          exports.push({ name: "default", typeOnly: false });
        }
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const keyword =
        statement.declarationList.flags & ts.NodeFlags.Const
          ? "const"
          : statement.declarationList.flags & ts.NodeFlags.Let
            ? "let"
            : "var";
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(source);
        const required = requiredModule(declaration.initializer);
        if (required) {
          dependencies.add(required);
          imports.push({ source: required, names: [name], typeOnly: false });
        }
        const signature = `${keyword} ${name}${declaration.type ? `: ${declaration.type.getText(source)}` : ""}`;
        symbols.push({
          name,
          kind: "variable",
          signature,
          exported: exported(statement),
          line: lineOf(source, declaration),
        });
        if (exported(statement)) exports.push({ name, typeOnly: false });
      }
    }
  }
  return { imports, exports, symbols, dependencies: [...dependencies] };
}

function baseFile(path: string, content: Buffer): Omit<RepoMapFile, "kind" | "language"> {
  const text = content.toString("utf8");
  return {
    path,
    contentHash: createHash("sha256").update(content).digest("hex"),
    sizeBytes: content.byteLength,
    lexicalTerms: lexicalTerms(path, text),
    imports: [],
    exports: [],
    symbols: [],
    dependencies: [],
  };
}

async function indexFile(projectRoot: string, path: string): Promise<{ file?: RepoMapFile; warning?: RepoMapWarning }> {
  try {
    const absolute = resolve(projectRoot, path);
    const info = await lstat(absolute);
    if (!info.isFile()) return {};
    const content = await readFile(absolute);
    if (!isText(content)) return {};
    const base = baseFile(path, content);
    const extension = extname(path).toLowerCase();
    if (!SEMANTIC_EXTENSIONS.has(extension)) return { file: { ...base, kind: "lexical", language: "text" } };
    const language: RepoMapLanguage = [".js", ".jsx", ".mjs", ".cjs"].includes(extension) ? "javascript" : "typescript";
    try {
      return { file: { ...base, ...analyzeSemantic(path, content.toString("utf8")), kind: "semantic", language } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        file: { ...base, kind: "lexical", language, degradedReason: message },
        warning: { path, code: "parse-error", message },
      };
    }
  } catch (error) {
    return {
      warning: { path, code: "read-error", message: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function buildRepoMap(options: BuildRepoMapOptions): Promise<RepoMapSnapshot> {
  const projectRoot = await realpath(resolve(options.projectRoot));
  const paths = await enumerateFiles(projectRoot, options.exclude ?? []);
  const indexed = await Promise.all(paths.map((path) => indexFile(projectRoot, path)));
  const snapshot: RepoMapSnapshot = {
    schemaVersion: REPO_MAP_SCHEMA_VERSION,
    provenance: {
      generator: "pi-context-vault",
      generatorVersion: "0.1.0",
      parser: "typescript-compiler-api",
      typescriptVersion: ts.version,
      generatedAt: new Date().toISOString(),
      projectRoot,
    },
    files: indexed.flatMap(({ file }) => (file ? [file] : [])),
    warnings: indexed.flatMap(({ warning }) => (warning ? [warning] : [])),
  };
  if (options.outputPath) await atomicWriteFile(options.outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

export async function loadRepoMapSnapshot(path: string): Promise<RepoMapSnapshot> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<RepoMapSnapshot>;
  if (parsed.schemaVersion !== REPO_MAP_SCHEMA_VERSION || !Array.isArray(parsed.files) || !parsed.provenance) {
    throw new Error(`Unsupported or invalid repository map snapshot: ${path}`);
  }
  return parsed as RepoMapSnapshot;
}

export class RepoMapSearch {
  readonly #snapshot: RepoMapSnapshot;
  readonly #index: MiniSearch<SearchDocument>;

  constructor(snapshot: RepoMapSnapshot) {
    this.#snapshot = snapshot;
    this.#index = new MiniSearch<SearchDocument>({
      fields: ["path", "fileName", "symbols", "signatures", "exports", "imports", "terms"],
      storeFields: ["path"],
      searchOptions: {
        boost: { symbols: 4, fileName: 3, path: 2.5, signatures: 2, exports: 2, imports: 1.5, terms: 1 },
        fuzzy: 0.15,
        prefix: true,
      },
    });
    this.#index.addAll(
      snapshot.files.map((file) => ({
        id: file.path,
        path: file.path,
        fileName: basename(file.path),
        symbols: file.symbols.map((symbol) => symbol.name).join(" "),
        signatures: file.symbols.map((symbol) => symbol.signature).join(" "),
        exports: file.exports.map((item) => item.name).join(" "),
        imports: file.imports.flatMap((item) => [item.source, ...item.names]).join(" "),
        terms: file.lexicalTerms.join(" "),
      })),
    );
  }

  query(query: string, options: RepoMapQueryOptions = {}): RepoMapQueryResult[] {
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("query limit must be a positive integer");
    const queryTerms = query.toLowerCase().match(/[\p{L}\p{N}_$-]{2,}/gu) ?? [];
    const found = this.#index.search(query).slice(0, limit);
    return found.flatMap((result) => {
      const file = this.#snapshot.files.find((candidate) => candidate.path === result.id);
      if (!file) return [];
      return [
        {
          path: file.path,
          score: result.score,
          kind: file.kind,
          matchedSymbols: file.symbols
            .filter((symbol) => queryTerms.some((term) => symbol.name.toLowerCase().includes(term)))
            .map((symbol) => symbol.name),
          symbols: file.symbols,
          dependencies: file.dependencies,
        },
      ];
    });
  }
}
