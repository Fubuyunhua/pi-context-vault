import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pi-context-vault-package-"));
const npmCli = process.env.npm_execpath;
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });

function assertDependencyAbsent(tree, forbidden) {
  const visit = (node, ancestry) => {
    for (const [name, dependency] of Object.entries(node?.dependencies ?? {})) {
      if (name === forbidden) throw new Error(`dependency tree contains ${forbidden} at ${ancestry}>${name}`);
      visit(dependency, `${ancestry}>${name}`);
    }
  };
  visit(tree, "root");
}

function walk(rootPath) {
  const files = [];
  const visit = (path, prefix = "") => {
    for (const name of readdirSync(path, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${name.name}` : name.name;
      if (name.isDirectory()) visit(join(path, name.name), relativePath);
      else files.push(relativePath);
    }
  };
  visit(rootPath);
  return files.sort();
}

try {
  if (!npmCli) throw new Error("package smoke must run through npm");
  const packed = JSON.parse(run(process.execPath, [npmCli, "pack", "--json", "--pack-destination", scratch]))[0];
  const expectedFiles = [
    "LICENSE",
    "README.md",
    "README.zh-CN.md",
    "extensions/index.ts",
    "package.json",
    "src/artifacts/redaction.ts",
    "src/artifacts/store.ts",
    "src/context/reduction.ts",
    "src/extension.ts",
    "src/observations/virtualization.ts",
    "src/state/atomic.ts",
    "src/state/config.ts",
    "src/state/project-state.ts",
    "src/telemetry-frame.ts",
    "src/telemetry.ts",
  ];
  const packedFiles = packed.files.map((entry) => entry.path).sort();
  if (JSON.stringify(packedFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`packed artifact file set mismatch: ${JSON.stringify(packedFiles)}`);
  }
  const files = new Set(packedFiles);
  const forbiddenPrefixes = ["src/repo-map/", "src/repo-context/", "src/bench/", "tests/", "docs/"];
  for (const path of files) {
    if (forbiddenPrefixes.some((prefix) => path.startsWith(prefix)))
      throw new Error(`packed artifact includes ${path}`);
    if (/bench|ablation|gold-task/iu.test(path)) throw new Error(`packed artifact includes research path ${path}`);
  }

  const install = join(scratch, "install");
  const project = join(scratch, "project");
  const agentRoot = join(scratch, "agent");
  mkdirSync(install, { recursive: true });
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeFileSync(
    join(project, ".pi", "context-vault.json"),
    JSON.stringify({ archivePolicy: "all", archiveMinBytes: 0, replacementThresholdBytes: 1 }),
  );
  writeFileSync(join(install, "package.json"), '{"name":"vault-smoke","private":true}\n');
  run(
    process.execPath,
    [
      npmCli,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      join(scratch, packed.filename),
      "@earendil-works/pi-coding-agent@0.84.1",
      "typebox@1.3.7",
    ],
    install,
  );
  const dependencyTree = JSON.parse(run(process.execPath, [npmCli, "ls", "--all", "--json"], install));
  for (const name of ["pi-repo-context", "chokidar", "java-parser", "minisearch"])
    assertDependencyAbsent(dependencyTree, name);

  const packedRoot = join(install, "node_modules", "pi-context-vault");
  const manifest = JSON.parse(readFileSync(join(packedRoot, "package.json"), "utf8"));
  if (manifest.name !== "pi-context-vault" || manifest.version !== "0.2.0")
    throw new Error("package identity mismatch");
  if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0)
    throw new Error("Vault has runtime dependencies");
  if (
    manifest.peerDependencies?.["@earendil-works/pi-coding-agent"] !== "0.84.1" ||
    manifest.peerDependencies?.typebox !== "1.3.7"
  ) {
    throw new Error("Vault peer versions exceed the tested compatibility surface");
  }
  for (const script of ["bench", "bench:plan", "bench:run", "bench:analyze", "bench:verify", "test:watcher"]) {
    if (manifest.scripts?.[script]) throw new Error(`packed manifest retains ${script}`);
  }
  const installedFiles = walk(packedRoot);
  if (JSON.stringify(installedFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`installed package file set mismatch: ${JSON.stringify(installedFiles)}`);
  }
  for (const path of installedFiles) {
    if (forbiddenPrefixes.some((prefix) => path.startsWith(prefix)))
      throw new Error(`installed package includes ${path}`);
    if (!path.endsWith(".ts")) continue;
    const text = readFileSync(join(packedRoot, path), "utf8");
    if (/from\s+["'][^"']*(?:repo-map|repo-context|bench)[^"']*["']/u.test(text)) {
      throw new Error(`forbidden source import in ${path}`);
    }
    if (
      /RepoMapRuntime|RepositoryGraph|FrozenMapCapsule|from\s+["'](?:chokidar|java-parser|minisearch)["']/u.test(text)
    ) {
      throw new Error(`forbidden repository symbol in ${path}`);
    }
  }
  if (existsSync(join(install, "node_modules", "pi-repo-context")))
    throw new Error("Repo Context unexpectedly installed");

  const loader = join(install, "load-packed-extension.mjs");
  writeFileSync(
    loader,
    `import{pathToFileURL}from"node:url";\nimport{readdir,readFile,stat}from"node:fs/promises";\nimport{join}from"node:path";\nconst{createJiti}=await import(pathToFileURL(process.argv[3]).href);\nconst jiti=createJiti(import.meta.url,{moduleCache:false});\nconst factory=await jiti.import(process.argv[2],{default:true});\nprocess.env.PI_CODING_AGENT_DIR=process.argv[5];\nconst handlers=new Map(),tools=new Map(),commands=[];\nfactory({on:(name,handler)=>handlers.set(name,handler),registerTool:(tool)=>tools.set(tool.name,tool),registerCommand:(name)=>commands.push(name)});\nconst actual={events:[...handlers.keys()].sort(),tools:[...tools.keys()].sort(),commands};\nconst expected={events:["context","session_shutdown","session_start","tool_result"],tools:["context_vault_obs_get","context_vault_obs_search","context_vault_status"],commands:["context-vault"]};\nif(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error("unexpected registration: "+JSON.stringify(actual));\nconst project=process.argv[4],agentRoot=process.argv[5];\nconst ctx={cwd:project,hasUI:false,sessionManager:{getSessionId:()=>"packed-session",getEntries:()=>[],getBranch:()=>[]},model:{contextWindow:10000},getSystemPrompt:()=>"system"};\nawait handlers.get("session_start")({},ctx);\nconst result=await handlers.get("tool_result")({toolName:"bash",toolCallId:"packed-call",content:[{type:"text",text:"packed evidence"}],isError:false},ctx);\nif(!result?.content?.[0]?.text?.includes("context_vault_observation_receipt"))throw new Error("packed archive did not produce receipt");\nconst receipt=JSON.parse(result.content[0].text);\nconst got=await tools.get("context_vault_obs_get").execute("get",{id:receipt.id},undefined,undefined,ctx);\nif(got.isError||!got.content?.[0]?.text?.includes("packed evidence"))throw new Error("packed get failed");\nconst searched=await tools.get("context_vault_obs_search").execute("search",{query:"packed"},undefined,undefined,ctx);\nif(searched.isError||!searched.content?.[0]?.text?.includes("packed"))throw new Error("packed search failed");\nconst projects=join(agentRoot,"context-vault","projects");\nconst [projectId]=await readdir(projects);\nconst rows=(await readdir(join(projects,projectId))).sort();\nif(JSON.stringify(rows)!==JSON.stringify(["artifacts","metadata"]))throw new Error("unexpected Vault state: "+JSON.stringify(rows));\nawait handlers.get("session_shutdown")({},ctx);\nconsole.log("packed-vault-registration-archive-get-search-state-ok");\n`,
  );
  const jiti = join(
    install,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "node_modules",
    "jiti",
    "lib",
    "jiti-static.mjs",
  );
  if (!existsSync(jiti)) throw new Error("Pi peer does not provide its TypeScript loader");
  const loaded = run(
    process.execPath,
    [loader, join(packedRoot, "extensions", "index.ts"), jiti, project, agentRoot],
    install,
  );
  if (!loaded.includes("packed-vault-registration-archive-get-search-state-ok"))
    throw new Error("packed Vault did not load");
  console.log("packed-observation-vault-install-load-cycle-ok");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
