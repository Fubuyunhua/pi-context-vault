import { describe, expect, it } from "vitest";
import {
  canonicalGraphPath,
  canonicalizeGraphPaths,
  canonicalizeJcs,
  compareUtf8,
  createDomainSeparatedId,
  GraphCanonicalizationError,
  sha256HexUtf8,
  sha256Jcs,
  writeJcs,
} from "../src/repo-map/canonical.js";

describe("repository graph canonical foundation", () => {
  it("canonicalizes accepted graph paths without changing case or Unicode", () => {
    expect(canonicalGraphPath("./src//./Å.ts")).toBe("src/Å.ts");
    expect(canonicalGraphPath("Case/A.ts")).toBe("Case/A.ts");
    expect(canonicalizeGraphPaths(["z.ts", "é.ts", "a.ts"])).toEqual(["a.ts", "z.ts", "é.ts"]);
  });

  it.each([
    "",
    ".",
    "..",
    "a/../b.ts",
    "/root.ts",
    "C:/root.ts",
    "C:root.ts",
    "\\\\server\\share",
    "a\\b.ts",
    "a\0b.ts",
    "a\u0085b.ts",
  ])("rejects invalid or escaping path %j", (path) => {
    expect(() => canonicalGraphPath(path)).toThrow(GraphCanonicalizationError);
  });

  it("rejects invalid Unicode, path bounds, and canonical collisions", () => {
    try {
      canonicalGraphPath("bad\ud800.ts");
      throw new Error("expected invalid Unicode");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid-unicode" });
    }
    expect(() => canonicalGraphPath(`${"a".repeat(4_097)}.ts`)).toThrow(
      expect.objectContaining({ code: "path-bound-exceeded" }),
    );
    expect(() => canonicalizeGraphPaths(["a//b.ts", "a/./b.ts"])).toThrow(
      expect.objectContaining({ code: "path-collision" }),
    );
  });

  it("orders strings by unsigned UTF-8 bytes, independently of JCS key ordering", () => {
    expect(compareUtf8("a", "é")).toBeLessThan(0);
    expect(compareUtf8("\ue000", "😀")).toBeLessThan(0);
    expect(canonicalizeJcs({ "\ue000": 1, "😀": 2 })).toBe('{"😀":2,"":1}');
    expect(() => compareUtf8("\ud800", "a")).toThrow("invalid Unicode string");
  });

  it("implements RFC 8785 JSON primitives and rejects values outside the JSON domain", () => {
    expect(
      canonicalizeJcs({
        numbers: [Number("333333333.33333329"), 1e30, 4.5, 0.002, 1e-27, -0],
        string: '€$\u000f\nA\'B"\\"/',
      }),
    ).toBe('{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27,0],"string":"€$\\u000f\\nA\'B\\"\\\\\\"/"}');
    expect(canonicalizeJcs([5e-324, 1.7976931348623157e308, 9007199254740992, 1e-7, 0.000001])).toBe(
      "[5e-324,1.7976931348623157e+308,9007199254740992,1e-7,0.000001]",
    );
    expect(canonicalizeJcs('\b\t\n\f\r"\\/\u001f')).toBe('"\\b\\t\\n\\f\\r\\"\\\\/\\u001f"');
    expect(() => canonicalizeJcs(Number.NaN)).toThrow();
    expect(() => canonicalizeJcs({ value: undefined })).toThrow();
    const sparse = new Array<unknown>(2);
    sparse[1] = 1;
    expect(() => canonicalizeJcs(sparse)).toThrow();
    expect(() => canonicalizeJcs("\udc00")).toThrow();
    const invalidKey = Object.fromEntries([["bad\ud800", 1]]);
    expect(() => canonicalizeJcs(invalidKey)).toThrow("invalid Unicode string");
    const symbolProperty = { value: 1, [Symbol("hidden")]: 2 };
    expect(() => canonicalizeJcs(symbolProperty)).toThrow("symbol properties");
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
    expect(() => canonicalizeJcs(accessor)).toThrow("non-data properties");
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => canonicalizeJcs(cycle)).toThrow("cyclic value");
    expect(() => canonicalizeJcs(new Date(0))).toThrow("non-plain objects");
  });

  it("streams exact UTF-8 counts and produces compact domain-separated hashes", () => {
    let output = "";
    expect(writeJcs({ b: "é", a: true }, { write: (chunk) => (output += chunk) })).toBe(
      Buffer.byteLength('{"a":true,"b":"é"}'),
    );
    expect(output).toBe('{"a":true,"b":"é"}');
    expect(sha256HexUtf8("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Jcs({ b: 2, a: 1 })).toBe("sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
    const first = createDomainSeparatedId("file:sha256:", "repository-graph/file", { canonicalPath: "a.ts" });
    const otherDomain = createDomainSeparatedId("file:sha256:", "repository-graph/other", {
      canonicalPath: "a.ts",
    });
    expect(first).toBe("file:sha256:3_07vO4Mf-bQCelyIcW2QQ4dpKy1J-Exlj-wW-c28DM");
    expect(first).not.toContain("a.ts");
    expect(otherDomain).not.toBe(first);
  });
});
