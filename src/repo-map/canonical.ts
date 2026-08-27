import { createHash } from "node:crypto";

const MAX_GRAPH_PATH_BYTES = 4_096;

export type GraphCanonicalizationErrorCode =
  | "invalid-path"
  | "invalid-unicode"
  | "path-bound-exceeded"
  | "path-collision";

export class GraphCanonicalizationError extends Error {
  readonly code: GraphCanonicalizationErrorCode;

  constructor(code: GraphCanonicalizationErrorCode) {
    super(code);
    this.name = "GraphCanonicalizationError";
    this.code = code;
  }
}

export interface JcsSink {
  write(chunk: string): void;
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) throw new TypeError("invalid Unicode string");
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError("invalid Unicode string");
    }
  }
}

/** Unsigned lexicographic comparison of valid Unicode strings encoded as UTF-8. */
export function compareUtf8(left: string, right: string): number {
  assertValidUnicode(left);
  assertValidUnicode(right);
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** Canonicalize a current repository-map path for graph/snapshot identity use only. */
export function canonicalGraphPath(path: string): string {
  try {
    assertValidUnicode(path);
  } catch {
    throw new GraphCanonicalizationError("invalid-unicode");
  }
  if (Buffer.byteLength(path, "utf8") > MAX_GRAPH_PATH_BYTES) {
    throw new GraphCanonicalizationError("path-bound-exceeded");
  }
  const containsControl = [...path].some((character) => {
    const codePoint = character.codePointAt(0) as number;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
  if (path.length === 0 || path.startsWith("/") || /^[A-Za-z]:/u.test(path) || path.includes("\\") || containsControl) {
    throw new GraphCanonicalizationError("invalid-path");
  }
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw new GraphCanonicalizationError("invalid-path");
    segments.push(segment);
  }
  if (segments.length === 0) throw new GraphCanonicalizationError("invalid-path");
  return segments.join("/");
}

/** Canonicalize, collision-check, deduplicate exact inputs, and UTF-8 byte-sort paths. */
export function canonicalizeGraphPaths(paths: readonly string[]): string[] {
  const canonicalByInput = new Map<string, string>();
  const inputByCanonical = new Map<string, string>();
  for (const path of paths) {
    if (canonicalByInput.has(path)) continue;
    const canonical = canonicalGraphPath(path);
    const prior = inputByCanonical.get(canonical);
    if (prior !== undefined && prior !== path) throw new GraphCanonicalizationError("path-collision");
    canonicalByInput.set(path, canonical);
    inputByCanonical.set(canonical, path);
  }
  return [...inputByCanonical.keys()].sort(compareUtf8);
}

function compareJcsPropertyNames(left: string, right: string): number {
  // RFC 8785 delegates property ordering to ECMAScript/UTF-16 code-unit order.
  return left < right ? -1 : left > right ? 1 : 0;
}

function writeString(value: string, emit: (chunk: string) => void): void {
  assertValidUnicode(value);
  emit(JSON.stringify(value));
}

function writeValue(value: unknown, emit: (chunk: string) => void, ancestors: Set<object>): void {
  if (value === null) {
    emit("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      emit(value ? "true" : "false");
      return;
    case "string":
      writeString(value, emit);
      return;
    case "number": {
      if (!Number.isFinite(value)) throw new TypeError("JCS numbers must be finite");
      emit(JSON.stringify(value));
      return;
    }
    case "object":
      break;
    default:
      throw new TypeError("value is outside the supported JCS JSON domain");
  }

  const object = value as object;
  if (ancestors.has(object)) throw new TypeError("cyclic value is outside the JCS JSON domain");
  ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (
        Object.getOwnPropertySymbols(value).length > 0 ||
        keys.length !== value.length ||
        Object.getOwnPropertyNames(value).length !== value.length + 1 ||
        keys.some((key) => {
          const descriptor = descriptors[key];
          return !descriptor?.enumerable || descriptor.get !== undefined || descriptor.set !== undefined;
        })
      ) {
        throw new TypeError("array properties are outside the JCS JSON domain");
      }
      emit("[");
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) emit(",");
        if (!(index in value)) throw new TypeError("sparse arrays are outside the JCS JSON domain");
        writeValue(value[index], emit, ancestors);
      }
      emit("]");
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("non-plain objects are outside the JCS JSON domain");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("symbol properties are outside the JCS JSON domain");
    }
    const record = value as Record<string, unknown>;
    const descriptors = Object.getOwnPropertyDescriptors(record);
    const keys = Object.keys(record).sort(compareJcsPropertyNames);
    if (Object.getOwnPropertyNames(record).length !== keys.length) {
      throw new TypeError("non-enumerable properties are outside the JCS JSON domain");
    }
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new TypeError("non-data properties are outside the JCS JSON domain");
      }
    }
    emit("{");
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index] as string;
      if (index > 0) emit(",");
      writeString(key, emit);
      emit(":");
      writeValue(record[key], emit, ancestors);
    }
    emit("}");
  } finally {
    ancestors.delete(object);
  }
}

/** Stream RFC 8785/JCS text to a sink and return its UTF-8 byte length. */
export function writeJcs(value: unknown, sink: JcsSink): number {
  let bytes = 0;
  writeValue(
    value,
    (chunk) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (!Number.isSafeInteger(bytes)) throw new RangeError("JCS byte count exceeded safe integer range");
      sink.write(chunk);
    },
    new Set(),
  );
  return bytes;
}

export function canonicalizeJcs(value: unknown): string {
  const chunks: string[] = [];
  writeJcs(value, { write: (chunk) => chunks.push(chunk) });
  return chunks.join("");
}

export function sha256HexUtf8(value: string): string {
  assertValidUnicode(value);
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Jcs(value: unknown): `sha256:${string}` {
  const digest = createHash("sha256");
  writeJcs(value, { write: (chunk) => digest.update(chunk, "utf8") });
  return `sha256:${digest.digest("hex")}`;
}

export function createDomainSeparatedId(prefix: string, domain: string, payload: unknown): string {
  assertValidUnicode(prefix);
  assertValidUnicode(domain);
  const digest = createHash("sha256");
  writeJcs({ domain, payload, version: 1 }, { write: (chunk) => digest.update(chunk, "utf8") });
  return `${prefix}${digest.digest("base64url")}`;
}
