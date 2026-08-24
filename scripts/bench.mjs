import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const sourceRoot = resolve("src/bench");
const buildRoot = await mkdtemp(join(tmpdir(), "context-vault-bench-"));

async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(path);
  }
  return result;
}

try {
  for (const source of await files(sourceRoot)) {
    const target = join(buildRoot, relative(sourceRoot, source).replace(/\.ts$/u, ".js"));
    await mkdir(dirname(target), { recursive: true });
    const transformed = ts.transpileModule(await readFile(source, "utf8"), {
      fileName: source,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        verbatimModuleSyntax: true,
      },
      reportDiagnostics: true,
    });
    const errors =
      transformed.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
    if (errors.length > 0)
      throw new Error(
        ts.formatDiagnostics(errors, {
          getCanonicalFileName: (name) => name,
          getCurrentDirectory: () => process.cwd(),
          getNewLine: () => "\n",
        }),
      );
    await writeFile(target, transformed.outputText);
  }
  if (process.argv[2] === "--smoke") console.log("bench-assets-ok");
  else await import(pathToFileURL(join(buildRoot, "cli.js")).href);
} finally {
  await rm(buildRoot, { recursive: true, force: true });
}
