// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveLanguages, languageForPath } from "../../internal";

describe("languageForPath", () => {
  const cases: Array<[string, string | undefined]> = [
    ["src/handler.go", "Go"],
    ["/Users/x/proj/pkg/util.go", "Go"],
    ["SRC/Main.GO", "Go"], // uppercase extension
    ["deploy/Dockerfile", "Dockerfile"], // basename, no extension
    ["Makefile", "Makefile"],
    ["ci/Jenkinsfile", "Groovy"],
    ["infra/main.hcl", "HCL"],
    ["infra/main.tf", "Terraform"],
    [".gitignore", undefined], // leading dot is not an extension
    ["notes.xyz", undefined], // unmapped extension
    ["README", undefined], // extensionless, unmapped basename
    ["src/constructor", undefined], // Object.prototype key must not resolve via prototype chain
    ["__proto__", undefined],
    ["foo.constructor", undefined], // same, as an extension
    ["C:\\repo\\app\\main.rs", "Rust"], // windows separator
  ];
  for (const [path, want] of cases) {
    it(`${path} -> ${want ?? "undefined"}`, () => {
      assert.equal(languageForPath(path), want);
    });
  }
});

describe("deriveLanguages", () => {
  it("counts occurrences and skips unmapped paths", () => {
    const got = deriveLanguages(["a.go", "b.go", "c.ts", "deploy/Dockerfile", "x.unknown"]);
    assert.deepEqual(got, { Go: 2, TypeScript: 1, Dockerfile: 1 });
  });

  it("accepts a Set input (kiro/CC path); the Set dedupes repeated paths", () => {
    const got = deriveLanguages(new Set(["a.go", "a.go"]));
    assert.deepEqual(got, { Go: 1 });
  });

  it("returns an empty map when nothing maps", () => {
    assert.deepEqual(deriveLanguages(["x.unknown", "README"]), {});
    assert.deepEqual(deriveLanguages([]), {});
  });
});
