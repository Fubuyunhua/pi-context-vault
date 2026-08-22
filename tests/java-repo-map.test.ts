import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRepoMap, indexRepoMapFile, RepoMapSearch } from "../src/repo-map/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "context-vault-java-map-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

const service = [
  "package com.example.user;",
  "",
  "import java.util.List;",
  "import static java.util.Collections.emptyList;",
  "import com.example.shared.*;",
  "",
  "@Service",
  "public final class UserService<T extends User> implements UserOperations<T> {",
  "  private final UserRepository repository;",
  "",
  "  @Autowired",
  "  public UserService(UserRepository repository) { this.repository = repository; }",
  "",
  "  @Transactional(readOnly = true)",
  "  public List<T> findUsers(String name, int limit) throws UserLookupException { return emptyList(); }",
  "}",
].join("\n");

describe("Java semantic repository map", () => {
  it("extracts packages, imports, types, members, annotations, generics, relationships, and lines", async () => {
    const root = await fixture({ "src/main/java/com/example/user/UserService.java": service });
    const snapshot = await buildRepoMap({ projectRoot: root });
    const file = snapshot.files[0];

    expect(file).toMatchObject({
      kind: "semantic",
      language: "java",
      packageName: "com.example.user",
    });
    expect(file?.imports).toEqual([
      { source: "java.util.List", names: ["List"], typeOnly: false, static: false, wildcard: false },
      {
        source: "java.util.Collections.emptyList",
        names: ["emptyList"],
        typeOnly: false,
        static: true,
        wildcard: false,
      },
      { source: "com.example.shared", names: [], typeOnly: false, static: false, wildcard: true },
    ]);
    expect(file?.dependencies).toEqual(
      expect.arrayContaining([
        "java.util.List",
        "java.util.Collections.emptyList",
        "com.example.shared",
        "User",
        "UserOperations",
      ]),
    );
    expect(file?.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "UserService",
          kind: "class",
          signature: "public final class UserService<T extends User> implements UserOperations<T>",
          exported: true,
          line: 8,
          annotations: ["Service"],
          modifiers: ["public", "final"],
          typeParameters: ["T extends User"],
          relationships: { extends: [], implements: ["UserOperations<T>"], permits: [] },
        }),
        expect.objectContaining({
          name: "repository",
          kind: "field",
          signature: "private final UserRepository repository",
          container: "UserService",
          exported: false,
          line: 9,
        }),
        expect.objectContaining({
          name: "UserService",
          kind: "constructor",
          signature: "public UserService(UserRepository repository)",
          container: "UserService",
          annotations: ["Autowired"],
          line: 12,
        }),
        expect.objectContaining({
          name: "findUsers",
          kind: "method",
          signature: "public List<T> findUsers(String name, int limit) throws UserLookupException",
          container: "UserService",
          annotations: ["Transactional"],
          line: 15,
        }),
      ]),
    );
  });

  it("covers records, enums, annotations, sealed types, nested types, multiple top-level types, Unicode, and CRLF", async () => {
    const source = [
      "package demo.domain;",
      "public sealed interface Shape permits Circle, Box { int DIMENSIONS = 2; }",
      "record Circle(double radius) implements Shape {}",
      "public record Box<T>(T value) implements Shape { public static class Builder {} }",
      "enum 状态 { READY, 已停止; private int code; }",
      '@interface Audited { String value() default ""; }',
      "class Extra {}",
    ].join("\r\n");
    const root = await fixture({ "src/Domain.java": source });
    const file = (await buildRepoMap({ projectRoot: root })).files[0];

    expect(file?.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Shape",
          kind: "interface",
          line: 2,
          relationships: { extends: [], implements: [], permits: ["Circle", "Box"] },
        }),
        expect.objectContaining({
          name: "DIMENSIONS",
          kind: "field",
          container: "Shape",
          exported: true,
          line: 2,
        }),
        expect.objectContaining({ name: "Circle", kind: "record", line: 3 }),
        expect.objectContaining({ name: "radius", kind: "field", container: "Circle" }),
        expect.objectContaining({ name: "Box", kind: "record", exported: true, line: 4 }),
        expect.objectContaining({ name: "Builder", kind: "class", container: "Box" }),
        expect.objectContaining({ name: "状态", kind: "enum", line: 5 }),
        expect.objectContaining({ name: "READY", kind: "enum-constant", container: "状态" }),
        expect.objectContaining({ name: "已停止", kind: "enum-constant", container: "状态" }),
        expect.objectContaining({ name: "Audited", kind: "annotation", line: 6 }),
        expect.objectContaining({
          name: "value",
          kind: "method",
          container: "Audited",
          exported: true,
          signature: 'String value() default ""',
        }),
        expect.objectContaining({ name: "Extra", kind: "class", line: 7 }),
      ]),
    );
  });

  it("indexes overloads, checked exceptions, static imports, and dependency evidence", async () => {
    const root = await fixture({
      "src/Store.java": [
        "package demo;",
        "import static java.util.Objects.*;",
        "interface Store<K, V> { V get(K key) throws java.io.IOException; V get(K key, V fallback); }",
        "final class StoreImpl<K, V> implements Store<K, V> {",
        " public V get(K key) throws java.io.IOException { return null; }",
        " public V get(K key, V fallback) { return fallback; }",
        " public <R extends V> R transform(K key, R fallback) throws java.io.IOException { return fallback; }",
        "}",
      ].join("\n"),
    });
    const file = (await buildRepoMap({ projectRoot: root })).files[0];
    expect(file?.imports[0]).toEqual({
      source: "java.util.Objects",
      names: [],
      typeOnly: false,
      static: true,
      wildcard: true,
    });
    expect(file?.symbols.filter((symbol) => symbol.name === "get")).toHaveLength(4);
    expect(file?.symbols).toContainEqual(
      expect.objectContaining({
        name: "transform",
        kind: "method",
        signature: "public <R extends V> R transform(K key, R fallback) throws java.io.IOException",
        exported: true,
        typeParameters: ["R extends V"],
      }),
    );
    expect(file?.dependencies).toEqual(expect.arrayContaining(["java.util.Objects", "Store<K, V>"]));
  });

  it("does not treat comments or strings as declarations and degrades malformed Java honestly", async () => {
    const root = await fixture({
      "src/Safe.java": [
        "// class Phantom { void ghost() {} }",
        "/* interface Specter {} */",
        'public class Safe { String text = "record Mirage(int id) {}"; public void realMethod() {} }',
      ].join("\n"),
      "src/Broken.java": "package demo; public class Broken { void incomplete( ",
    });
    const snapshot = await buildRepoMap({ projectRoot: root });
    const safe = snapshot.files.find((file) => file.path === "src/Safe.java");
    const broken = snapshot.files.find((file) => file.path === "src/Broken.java");

    expect(safe?.symbols.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["Safe", "text", "realMethod"]));
    expect(safe?.symbols.map((symbol) => symbol.name)).not.toEqual(
      expect.arrayContaining(["Phantom", "ghost", "Specter", "Mirage"]),
    );
    expect(broken).toMatchObject({
      kind: "lexical",
      language: "java",
      degradedReason: expect.stringContaining("parse"),
    });
    expect(broken?.symbols).toEqual([]);
    expect(snapshot.warnings).toContainEqual(expect.objectContaining({ path: "src/Broken.java", code: "parse-error" }));
    expect(snapshot.warnings[0]?.message.length).toBeLessThanOrEqual(512);
  });

  it("bounds adversarial source diagnostics and rejects traversal", async () => {
    const root = await fixture({ "src/Deep.java": `${"class N { ".repeat(5_000)} broken` });
    const indexed = await indexRepoMapFile(root, "src/Deep.java");
    expect(indexed).toMatchObject({
      kind: "indexed",
      file: { kind: "lexical", language: "java" },
      warning: { message: expect.any(String) },
    });
    if (indexed.kind !== "indexed") throw new Error("expected indexed Java outcome");
    expect(indexed.warning?.message.length).toBeLessThanOrEqual(512);
    await expect(indexRepoMapFile(root, "../Outside.java")).rejects.toThrow("project-relative");
  });

  it("ranks Java declarations above comments and preserves deterministic bounded results", async () => {
    const root = await fixture({
      "src/main/java/demo/UserController.java":
        "package demo; public class UserController { public void createUser() {} }",
      "docs/notes.txt": "UserController createUser UserController createUser",
      "src/main/java/demo/Caller.java": "package demo; // UserController createUser\nclass Caller {}",
    });
    const snapshot = await buildRepoMap({ projectRoot: root });
    const search = new RepoMapSearch(snapshot);
    const first = search.query("UserController createUser", { limit: 2 });
    const second = search.query("UserController createUser", { limit: 2 });

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first[0]?.path).toBe("src/main/java/demo/UserController.java");
    expect(first[0]?.matchedSymbols).toEqual(expect.arrayContaining(["UserController", "createUser"]));
  });

  it("indexes a Spring-style multi-package backend and excludes Maven and Gradle output", async () => {
    const root = await fixture({
      "src/main/java/demo/api/UserController.java": [
        "package demo.api;",
        "import demo.service.UserService;",
        "@RestController public class UserController {",
        " private final UserService service;",
        " public UserController(UserService service) { this.service = service; }",
        ' @PostMapping("/users") public User createUser(CreateUserRequest request) { return service.createUser(request); }',
        "}",
      ].join("\n"),
      "src/main/java/demo/service/UserService.java":
        "package demo.service; import demo.data.UserRepository; @Service public class UserService { public User createUser(CreateUserRequest request) { return null; } }",
      "src/main/java/demo/data/UserRepository.java":
        "package demo.data; public interface UserRepository extends CrudRepository<User, Long> {}",
      "target/generated-sources/Ghost.java": "public class MavenGhost {}",
      ".gradle/cache/GradleGhost.java": "public class GradleGhost {}",
    });
    const snapshot = await buildRepoMap({ projectRoot: root });
    const paths = snapshot.files.map((file) => file.path);
    expect(paths).not.toEqual(
      expect.arrayContaining(["target/generated-sources/Ghost.java", ".gradle/cache/GradleGhost.java"]),
    );

    const search = new RepoMapSearch(snapshot);
    expect(search.query("PostMapping createUser")[0]?.path).toBe("src/main/java/demo/api/UserController.java");
    expect(search.query("UserService createUser")[0]?.path).toBe("src/main/java/demo/service/UserService.java");
    expect(search.query("UserRepository CrudRepository")[0]?.path).toBe("src/main/java/demo/data/UserRepository.java");
    expect(snapshot.files.find((file) => file.path.endsWith("UserController.java"))?.dependencies).toContain(
      "demo.service.UserService",
    );
  });
});
