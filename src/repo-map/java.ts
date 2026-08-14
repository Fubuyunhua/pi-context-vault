import { type CstNode, type IToken, parse } from "java-parser";
import type { RepoMapExport, RepoMapImport, RepoMapSymbol } from "./index.js";

const MAX_JAVA_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_BRACE_NESTING = 512;
const MODIFIERS = new Set([
  "public",
  "protected",
  "private",
  "abstract",
  "static",
  "final",
  "sealed",
  "non-sealed",
  "strictfp",
  "native",
  "synchronized",
  "transient",
  "volatile",
  "default",
]);

export interface JavaAnalysis {
  packageName?: string;
  imports: RepoMapImport[];
  exports: RepoMapExport[];
  symbols: RepoMapSymbol[];
  dependencies: string[];
}

function childNodes(node: CstNode): CstNode[] {
  return Object.values(node.children)
    .flat()
    .filter((item) => "name" in item) as CstNode[];
}

function allTokens(node: CstNode): IToken[] {
  const output: IToken[] = [];
  const visit = (current: CstNode): void => {
    for (const items of Object.values(current.children)) {
      for (const item of items) {
        if ("image" in item) output.push(item as IToken);
        else visit(item as CstNode);
      }
    }
  };
  visit(node);
  return output.sort((left, right) => left.startOffset - right.startOffset);
}

function descendants(node: CstNode, name: string): CstNode[] {
  const found: CstNode[] = [];
  const visit = (current: CstNode): void => {
    for (const child of childNodes(current)) {
      if (child.name === name) found.push(child);
      visit(child);
    }
  };
  visit(node);
  return found;
}

function firstDescendant(node: CstNode, name: string): CstNode | undefined {
  return descendants(node, name)[0];
}

function images(node: CstNode): string[] {
  return allTokens(node).map((token) => token.image);
}

function render(tokens: readonly string[]): string {
  let output = "";
  let previous = "";
  for (const token of tokens) {
    if (token === ";") break;
    const noSpaceBefore = [",", ")", "]", ">", ".", "::", "..."].includes(token);
    const noSpaceAfterPrevious = ["(", "[", "<", ".", "@", "::"].includes(previous);
    const identifierGeneric = token === "<" && previous.length > 0 && !MODIFIERS.has(previous);
    const callOrParameters = token === "(";
    const separator =
      output && !noSpaceBefore && !noSpaceAfterPrevious && !identifierGeneric && !callOrParameters ? " " : "";
    output += `${separator}${token}`;
    if (token === ",") output += " ";
    previous = token;
  }
  return output.replace(/\s+/gu, " ").trim();
}

function withoutAnnotations(node: CstNode): IToken[] {
  const excluded = new Set<number>();
  for (const annotation of descendants(node, "annotation")) {
    for (const token of allTokens(annotation)) excluded.add(token.startOffset);
  }
  return allTokens(node).filter((token) => !excluded.has(token.startOffset));
}

function beforeBody(node: CstNode): IToken[] {
  const tokens = withoutAnnotations(node);
  const cutoff = tokens.findIndex((token) => token.image === "{" || token.image === ";");
  return cutoff < 0 ? tokens : tokens.slice(0, cutoff);
}

function annotationNames(node: CstNode): string[] {
  const modifierNodes = childNodes(node).filter((child) => child.name.endsWith("Modifier"));
  return modifierNodes
    .flatMap((modifier) => descendants(modifier, "annotation"))
    .map((annotation) => {
      const tokenImages = images(annotation);
      const end = tokenImages.indexOf("(");
      return tokenImages
        .slice(1, end < 0 ? undefined : end)
        .filter((token) => token !== ".")
        .join(".");
    });
}

function modifierNames(node: CstNode): string[] {
  return childNodes(node)
    .filter((child) => child.name.endsWith("Modifier"))
    .flatMap((modifier) => withoutAnnotations(modifier))
    .map((token) => token.image)
    .filter((token) => MODIFIERS.has(token));
}

function tokenLine(node: CstNode, image?: string): number {
  const tokens = withoutAnnotations(node);
  return (image ? tokens.find((token) => token.image === image) : tokens[0])?.startLine ?? node.location.startLine;
}

function splitTopLevel(tokens: readonly string[], delimiter = ","): string[][] {
  const parts: string[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (["<", "(", "["].includes(token)) depth += 1;
    if ([">", ")", "]"].includes(token)) depth -= 1;
    if (token === delimiter && depth === 0) parts.push([]);
    else parts.at(-1)?.push(token);
  }
  return parts.filter((part) => part.length > 0);
}

function nodeList(node: CstNode, name: string): string[] {
  const relationship = childNodes(node).find((child) => child.name === name);
  if (!relationship) return [];
  const tokens = images(relationship).slice(1);
  return splitTopLevel(tokens).map(render);
}

function typeParameters(node: CstNode): string[] {
  const parameters = childNodes(node).find((child) => child.name === "typeParameters");
  if (!parameters) return [];
  const tokens = images(parameters);
  return splitTopLevel(tokens.slice(1, -1)).map(render);
}

function identifier(node: CstNode, name = "typeIdentifier"): string | undefined {
  const target = firstDescendant(node, name);
  return target ? allTokens(target)[0]?.image : undefined;
}

function typeKind(node: CstNode): RepoMapSymbol["kind"] {
  if (firstDescendant(node, "enumDeclaration")) return "enum";
  if (firstDescendant(node, "recordDeclaration")) return "record";
  if (firstDescendant(node, "annotationInterfaceDeclaration")) return "annotation";
  if (node.name === "interfaceDeclaration") return "interface";
  return "class";
}

function declarationNode(node: CstNode): CstNode | undefined {
  return childNodes(node).find((child) =>
    [
      "normalClassDeclaration",
      "enumDeclaration",
      "recordDeclaration",
      "normalInterfaceDeclaration",
      "annotationInterfaceDeclaration",
    ].includes(child.name),
  );
}

function declarationName(node: CstNode): string | undefined {
  const declaration = declarationNode(node);
  if (!declaration) return undefined;
  return (
    identifier(declaration) ?? allTokens(declaration).find((token) => token.tokenType.name === "Identifier")?.image
  );
}

function memberName(node: CstNode): string | undefined {
  if (node.name === "constructorDeclaration" || node.name === "compactConstructorDeclaration") {
    return (
      identifier(node, "simpleTypeName") ??
      allTokens(node).find((token) => token.tokenType.name === "Identifier")?.image
    );
  }
  if (
    node.name === "methodDeclaration" ||
    node.name === "interfaceMethodDeclaration" ||
    node.name === "annotationInterfaceElementDeclaration"
  ) {
    const declarator = firstDescendant(node, "methodDeclarator") ?? node;
    const tokens = allTokens(declarator);
    const open = tokens.findIndex((token) => token.image === "(");
    return [...tokens.slice(0, open < 0 ? undefined : open)]
      .reverse()
      .find((token) => token.tokenType.name === "Identifier")?.image;
  }
  return undefined;
}

function fieldNames(node: CstNode): string[] {
  return descendants(node, "variableDeclarator")
    .map((declarator) => firstDescendant(declarator, "variableDeclaratorId"))
    .flatMap((declarator) => (declarator ? [allTokens(declarator)[0]?.image] : []))
    .filter((name): name is string => Boolean(name));
}

function fieldSignature(node: CstNode, name: string): string {
  const tokens = withoutAnnotations(node).map((token) => token.image);
  const nameIndex = tokens.indexOf(name);
  return render(tokens.slice(0, nameIndex + 1));
}

function recordComponents(node: CstNode, container: string, output: RepoMapSymbol[]): void {
  for (const component of descendants(node, "recordComponent")) {
    const tokens = images(component);
    const name = [...allTokens(component)].reverse().find((token) => token.tokenType.name === "Identifier")?.image;
    if (!name) continue;
    output.push({
      name,
      kind: "field",
      signature: render(tokens),
      exported: true,
      line: tokenLine(component, name),
      container,
      annotations: annotationNames(component),
      modifiers: [],
    });
  }
}

function validateBounds(text: string): void {
  if (Buffer.byteLength(text, "utf8") > MAX_JAVA_SOURCE_BYTES)
    throw new Error("parse error: Java source exceeds 2 MiB");
  let nesting = 0;
  let maximum = 0;
  for (const character of text) {
    if (character === "{") maximum = Math.max(maximum, ++nesting);
    else if (character === "}") nesting = Math.max(0, nesting - 1);
    if (maximum > MAX_BRACE_NESTING) throw new Error("parse error: Java brace nesting exceeds 512");
  }
}

export function analyzeJava(text: string): JavaAnalysis {
  validateBounds(text);
  const root = parse(text) as CstNode;
  const imports: RepoMapImport[] = [];
  const exports: RepoMapExport[] = [];
  const symbols: RepoMapSymbol[] = [];
  const dependencies = new Set<string>();
  const packageDeclaration = firstDescendant(root, "packageDeclaration");
  const packageName = ((packageDeclaration?.children.Identifier ?? []) as IToken[])
    .map((token) => token.image)
    .join(".");

  for (const declaration of descendants(root, "importDeclaration")) {
    const tokens = images(declaration);
    const isStatic = tokens.includes("static");
    const wildcard = tokens.includes("*");
    const qualified = tokens.filter((token) => !["import", "static", ";", "*", "."].includes(token)).join(".");
    const pieces = qualified.split(".");
    const source = wildcard ? qualified : isStatic ? qualified : qualified;
    imports.push({
      source,
      names: wildcard ? [] : [pieces.at(-1) as string],
      typeOnly: false,
      static: isStatic,
      wildcard,
    });
    dependencies.add(source);
  }

  const walk = (node: CstNode, container?: string, implicitlyPublic = false): void => {
    let nextContainer = container;
    let nextImplicitlyPublic = implicitlyPublic;
    if (node.name === "classDeclaration" || node.name === "interfaceDeclaration") {
      const name = declarationName(node);
      const declaration = declarationNode(node);
      if (name && declaration) {
        const kind = typeKind(node);
        const relationships = {
          extends: nodeList(declaration, kind === "interface" ? "interfaceExtends" : "classExtends"),
          implements: nodeList(declaration, "classImplements"),
          permits: nodeList(declaration, kind === "interface" ? "interfacePermits" : "classPermits"),
        };
        const modifiers = modifierNames(node);
        const headerTokens = beforeBody(node).map((token) => token.image);
        const symbol: RepoMapSymbol = {
          name,
          kind,
          signature: render(headerTokens),
          exported: modifiers.includes("public") || Boolean(container && implicitlyPublic),
          line: tokenLine(declaration, kind === "annotation" ? "interface" : kind === "record" ? "record" : kind),
          ...(container ? { container } : {}),
          annotations: annotationNames(node),
          modifiers,
          typeParameters: typeParameters(declaration),
          relationships,
        };
        symbols.push(symbol);
        if (symbol.exported) exports.push({ name, typeOnly: kind === "interface" || kind === "annotation" });
        for (const relationship of [...relationships.extends, ...relationships.implements, ...relationships.permits]) {
          dependencies.add(relationship);
          dependencies.add(relationship.replace(/<.*$/u, ""));
        }
        for (const parameter of symbol.typeParameters ?? []) {
          const bound = parameter.match(/\bextends\s+(.+)$/u)?.[1];
          if (bound) dependencies.add(bound.replace(/<.*$/u, ""));
        }
        if (kind === "record") recordComponents(declaration, name, symbols);
        nextContainer = name;
        nextImplicitlyPublic = kind === "interface" || kind === "annotation";
      }
    } else if (
      node.name === "methodDeclaration" ||
      node.name === "interfaceMethodDeclaration" ||
      node.name === "annotationInterfaceElementDeclaration"
    ) {
      const name = memberName(node);
      if (name) {
        const modifiers = modifierNames(node);
        const header = firstDescendant(node, "methodHeader");
        const symbol: RepoMapSymbol = {
          name,
          kind: "method",
          signature: render(beforeBody(node).map((token) => token.image)),
          exported:
            modifiers.includes("public") ||
            implicitlyPublic ||
            Boolean(
              container && ["interfaceMethodDeclaration", "annotationInterfaceElementDeclaration"].includes(node.name),
            ),
          line: tokenLine(node, name),
          ...(container ? { container } : {}),
          annotations: annotationNames(node),
          modifiers,
          typeParameters: typeParameters(header ?? node),
        };
        symbols.push(symbol);
        for (const parameter of symbol.typeParameters ?? []) {
          const bound = parameter.match(/\bextends\s+(.+)$/u)?.[1];
          if (bound) dependencies.add(bound.replace(/<.*$/u, ""));
        }
      }
      nextImplicitlyPublic = false;
    } else if (node.name === "constructorDeclaration" || node.name === "compactConstructorDeclaration") {
      const name = memberName(node) ?? container;
      if (name) {
        const modifiers = modifierNames(node);
        symbols.push({
          name,
          kind: "constructor",
          signature: render(beforeBody(node).map((token) => token.image)),
          exported: modifiers.includes("public"),
          line: tokenLine(node, name),
          ...(container ? { container } : {}),
          annotations: annotationNames(node),
          modifiers,
          typeParameters: typeParameters(node),
        });
        nextImplicitlyPublic = false;
      }
    } else if (node.name === "fieldDeclaration" || node.name === "constantDeclaration") {
      const modifiers = modifierNames(node);
      for (const name of fieldNames(node)) {
        symbols.push({
          name,
          kind: "field",
          signature: fieldSignature(node, name),
          exported: modifiers.includes("public") || implicitlyPublic || node.name === "constantDeclaration",
          line: tokenLine(node, name),
          ...(container ? { container } : {}),
          annotations: annotationNames(node),
          modifiers,
        });
      }
      nextImplicitlyPublic = false;
    } else if (node.name === "enumConstant") {
      const name = allTokens(node).find((token) => token.tokenType.name === "Identifier")?.image;
      if (name) {
        symbols.push({
          name,
          kind: "enum-constant",
          signature: name,
          exported: true,
          line: tokenLine(node, name),
          ...(container ? { container } : {}),
          annotations: annotationNames(node),
          modifiers: [],
        });
      }
    }
    for (const child of childNodes(node)) walk(child, nextContainer, nextImplicitlyPublic);
  };
  walk(root);

  return {
    ...(packageName ? { packageName } : {}),
    imports,
    exports,
    symbols,
    dependencies: [...dependencies],
  };
}
