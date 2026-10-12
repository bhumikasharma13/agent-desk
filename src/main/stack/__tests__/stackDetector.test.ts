// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { StackDetector, detectStackTags, detectStackTagsWithMonorepo, deriveDisplayName } from "../stackDetector";

// Builds a throwaway project directory and returns its absolute path. `files`
// are created empty (parent dirs made on the way); `dirs` are created as
// directories — used to prove a matcher keys off a real file, not a directory
// that merely shares the name.
function makeProject(files: string[], dirs: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "stack-detector-"));
  createdDirs.push(dir);
  for (const rel of files) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "");
  }
  for (const rel of dirs) {
    mkdirSync(join(dir, rel), { recursive: true });
  }
  return dir;
}

const createdDirs: string[] = [];

describe("detectStackTags", () => {
  after(() => {
    for (const d of createdDirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // Each case seeds a project with signal files and asserts which tags the
  // detector must emit (`expect`) and, where a past mislabel is being guarded,
  // which it must NOT emit (`reject`).
  const cases: {
    name: string;
    files: string[];
    dirs?: string[];
    expect: string[];
    reject?: string[];
  }[] = [
    // ── Infra coverage ──
    {
      name: "root *.tf → terraform",
      files: ["main.tf", "variables.tf"],
      expect: ["terraform"],
    },
    {
      name: "OpenTofu *.tofu → terraform",
      files: ["main.tofu"],
      expect: ["terraform"],
    },
    {
      name: "terragrunt.hcl → terraform",
      files: ["terragrunt.hcl"],
      expect: ["terraform"],
    },
    {
      name: ".terraform.lock.hcl (env-nested repo) → terraform",
      files: [".terraform.lock.hcl"],
      expect: ["terraform"],
    },
    {
      name: "*.pkr.hcl → packer",
      files: ["ubuntu.pkr.hcl"],
      expect: ["packer"],
    },
    {
      name: "ansible.cfg → ansible",
      files: ["ansible.cfg"],
      expect: ["ansible"],
    },
    {
      name: "playbook.yml → ansible",
      files: ["playbook.yml"],
      expect: ["ansible"],
    },
    {
      name: "Pulumi.yaml → pulumi",
      files: ["Pulumi.yaml"],
      expect: ["pulumi"],
    },
    {
      name: "kustomization.yaml → kubernetes",
      files: ["kustomization.yaml"],
      expect: ["kubernetes"],
    },
    {
      name: "docker-compose.yml → docker",
      files: ["docker-compose.yml"],
      expect: ["docker"],
    },
    {
      name: "compose.yaml → docker",
      files: ["compose.yaml"],
      expect: ["docker"],
    },
    {
      name: "Jenkinsfile → jenkins",
      files: ["Jenkinsfile"],
      expect: ["jenkins"],
    },
    // ── isFile guard: a directory sharing a config-file's name must not tag ──
    {
      name: "directory named Pulumi.yaml → no pulumi",
      files: [],
      dirs: ["Pulumi.yaml"],
      expect: [],
      reject: ["pulumi"],
    },
    {
      name: "directory named compose.yml → no docker",
      files: [],
      dirs: ["compose.yml"],
      expect: [],
      reject: ["docker"],
    },
    // ── Protobuf without go.mod ──
    {
      name: "buf.yaml without go.mod → protobuf (no go, no grpc)",
      files: ["buf.yaml", "greeter.proto"],
      expect: ["protobuf"],
      reject: ["go", "grpc"],
    },
    {
      name: "buf.gen.yaml → protobuf",
      files: ["buf.gen.yaml"],
      expect: ["protobuf"],
    },
    {
      name: "go.mod + buf.yaml → go, grpc, protobuf",
      files: ["go.mod", "buf.yaml"],
      expect: ["go", "grpc", "protobuf"],
    },
    // ── Mislabel guard: a bare Makefile must NOT read as C++ ──
    {
      name: "Makefile alone → no cpp (was mislabeled)",
      files: ["Makefile"],
      expect: [],
      reject: ["cpp"],
    },
    {
      name: "CMakeLists.txt → cpp (kept)",
      files: ["CMakeLists.txt"],
      expect: ["cpp"],
    },
    {
      name: "Go monorepo root with Makefile → go, not cpp",
      files: ["go.mod", "Makefile"],
      expect: ["go"],
      reject: ["cpp"],
    },
    // ── Regression anchor for existing detection ──
    {
      name: "package.json → typescript",
      files: ["package.json"],
      expect: ["typescript"],
    },
  ];

  for (const tc of cases) {
    it(tc.name, async () => {
      const dir = makeProject(tc.files, tc.dirs);
      const tags = await detectStackTags(dir);
      for (const t of tc.expect) {
        assert.ok(tags.includes(t), `expected tag "${t}" in [${tags.join(", ")}]`);
      }
      for (const t of tc.reject ?? []) {
        assert.ok(!tags.includes(t), `did not expect tag "${t}" in [${tags.join(", ")}]`);
      }
    });
  }
});

describe("detectStackTagsWithMonorepo — deep rescue scan", () => {
  after(() => {
    for (const d of createdDirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("rescues a Terraform repo nesting .tf below the one-level scan", async () => {
    // environments/prod/main.tf is 2 levels down — the root + one-level scan
    // never reaches it, so without the deep scan this repo shows nothing.
    const dir = makeProject(["environments/prod/main.tf", "README.md"]);
    const { tags } = await detectStackTagsWithMonorepo(dir);
    assert.ok(tags.includes("terraform"), `expected terraform in [${tags.join(", ")}]`);
  });

  it("rescues a service whose go.mod sits two levels down", async () => {
    const dir = makeProject(["services/api/go.mod"]);
    const { tags } = await detectStackTagsWithMonorepo(dir);
    assert.ok(tags.includes("go"), `expected go in [${tags.join(", ")}]`);
  });

  it("augments an already-tagged repo with deeper markers the shallow scan missed", async () => {
    // Root package.json tags `typescript` at the shallow layer; the deep walk
    // still runs and unions the two-levels-down infra/env/main.tf (a
    // one-level-down .tf is already caught by the ordinary monorepo scan, so it
    // is nested past that to isolate the deep-scan path). Both tags must appear:
    // the deep scan augments, it does not replace.
    const dir = makeProject(["package.json", "infra/env/main.tf"]);
    const { tags } = await detectStackTagsWithMonorepo(dir);
    assert.ok(tags.includes("typescript"), `expected typescript in [${tags.join(", ")}]`);
    assert.ok(tags.includes("terraform"), `expected deep-scanned terraform in [${tags.join(", ")}]`);
  });

  it("tags an infra repo's deeply-nested Terraform/Ansible/Docker alongside its shallow hits", async () => {
    // An infra repo's shape: GitHub Actions at root and Packer one level down
    // are found shallowly, but Terraform, Ansible and Docker all sit two levels
    // down and were invisible while the deep scan was gated on an empty result.
    const dir = makeProject([
      ".github/workflows/ci.yml",       // github-actions (root)
      "packer/image.pkr.hcl",           // packer (one level)
      "terraform/env/main.tf",          // terraform (two levels)
      "ansible/monitoring/ansible.cfg", // ansible (two levels)
      "docker/exporter/Dockerfile",     // docker (two levels)
    ]);
    const { tags } = await detectStackTagsWithMonorepo(dir);
    for (const expected of ["github-actions", "packer", "terraform", "ansible", "docker"]) {
      assert.ok(tags.includes(expected), `expected ${expected} in [${tags.join(", ")}]`);
    }
  });

  it("keeps a real nested language in a polyglot monorepo (not a fixture dir)", async () => {
    // The common polyglot shape: a shallow language at root plus a real service in
    // another language a couple levels down (here TS at root + a Go service under
    // `services/`, which is NOT a fixture dir). Both must appear — the guard is the
    // fixture-dir skip-list, not "a shallow language already exists", so a genuine
    // second language is never dropped.
    const dir = makeProject(["package.json", "services/api/go.mod"]);
    const { tags } = await detectStackTagsWithMonorepo(dir);
    assert.ok(tags.includes("typescript"), `expected typescript in [${tags.join(", ")}]`);
    assert.ok(tags.includes("go"), `expected the real nested go service in [${tags.join(", ")}]`);
  });

  it("does NOT attribute a language manifest sitting in a fixture tree", async () => {
    // A Go repo with a JS manifest under `testdata/` must not gain `typescript` — the
    // fixture dir is skip-listed, so the walk never reaches the manifest. This is the
    // false-positive guard: it keys on the fixture directory, the honest signal.
    const dir = makeProject(["go.mod", "testdata/case/package.json"]);
    const { tags } = await detectStackTagsWithMonorepo(dir);
    assert.ok(tags.includes("go"), `expected go in [${tags.join(", ")}]`);
    assert.ok(!tags.includes("typescript"), `fixture-tree package.json must not tag typescript; got [${tags.join(", ")}]`);
  });

  it("skips fixture dirs case-insensitively (Examples/ on macOS)", async () => {
    // The skip lookup lower-cases the dir name, so a capitalized `Examples/` tree —
    // the same tree on the case-insensitive macOS filesystem — is guarded too.
    const dir = makeProject(["package.json", "Examples/infra/main.tf"]);
    const { tags } = await detectStackTagsWithMonorepo(dir);
    assert.ok(tags.includes("typescript"), `expected typescript in [${tags.join(", ")}]`);
    assert.ok(!tags.includes("terraform"), `Examples/ tree must be skipped case-insensitively; got [${tags.join(", ")}]`);
  });

  it("applies the skip-list to fixture/build dirs DIRECTLY below root (one-level pass)", async () => {
    // The guard must be uniform: the one-level monorepo pass, not only the deep
    // walk, has to honour the skip-list — else a fixture manifest a single level
    // down (the shape the deeper tests miss) leaks. A Go repo with a JS fixture
    // package and an example .tf both directly under root must gain neither
    // `typescript` nor `terraform`, and a marker under `build/` stays excluded.
    // Deliberate trade-off: a genuine top-level subproject that happens to be named
    // like a fixture dir (a real `examples/` demo app) is likewise not tagged — the
    // convention that those names denote non-primary trees is worth the rare miss.
    const dir = makeProject([
      "go.mod",                     // go (root)
      "testdata/package.json",      // fixture language, one level
      "examples/main.tf",           // example infra, one level
      "build/service/Dockerfile",   // build-output, one level
    ]);
    const { tags } = await detectStackTagsWithMonorepo(dir);
    assert.ok(tags.includes("go"), `expected go in [${tags.join(", ")}]`);
    for (const forbidden of ["typescript", "terraform", "docker"]) {
      assert.ok(!tags.includes(forbidden), `direct-child fixture/build must not tag ${forbidden}; got [${tags.join(", ")}]`);
    }
  });

  it("still rescues a fully tag-less repo with a deep language manifest", async () => {
    // The deep walk always runs, so a repo with no shallow tag at all is still
    // rescued — its only signal, a go.mod two levels down, must still tag `go`.
    const dir = makeProject(["services/api/go.mod", "README.md"]);
    const { tags } = await detectStackTagsWithMonorepo(dir);
    assert.ok(tags.includes("go"), `expected go in [${tags.join(", ")}]`);
  });

  it("skips node_modules during the deep scan", async () => {
    // A go.mod that exists only inside node_modules must not tag the project.
    const dir = makeProject(["node_modules/somepkg/go.mod"]);
    const { tags } = await detectStackTagsWithMonorepo(dir);
    assert.ok(!tags.includes("go"), `node_modules should be skipped; got [${tags.join(", ")}]`);
  });

  it("tags a subproject however many subdirectories come before it", async () => {
    // manage.py tags "django" only through the per-directory pass (the deep walk has no rule for
    // it), so this checks that every subdirectory is looked at, not the first few.
    const dirs = Array.from({ length: 25 }, (_, i) => `pkg${String(i).padStart(2, "0")}`);
    const dir = makeProject(["pkg24/manage.py"], dirs);
    const { tags, subprojects } = await detectStackTagsWithMonorepo(dir);
    assert.ok(tags.includes("django"), `expected django; got [${tags.join(", ")}]`);
    assert.deepEqual(subprojects.map((s) => s.relativePath), ["pkg24"]);
  });
});

describe("deriveDisplayName", () => {
  // toStackProjects derives the renderer label from the REDACTED path; since
  // this returns path segments verbatim, a redacted home segment (user_<hash>)
  // stays redacted — the real username never reaches the renderer.
  it("returns the last two path segments verbatim", () => {
    assert.equal(deriveDisplayName("/Users/user_abc12345/myrepo"), "user_abc12345/myrepo");
    assert.equal(deriveDisplayName("/a/b/c/d"), "c/d");
    assert.equal(deriveDisplayName("/only"), "only");
  });
});

describe("StackDetector.rescan", () => {
  it("a rescan asked for while one runs scans again and sees the new projects", async () => {
    const dir = makeProject(["go.mod"]);
    const detector = StackDetector.getInstance();
    let projects: { path: string; lastSeenAt: Date }[] = [];
    detector.setProjectsProvider(() => projects);
    const first = detector.rescan(); // reads the empty list, like the page's scan before the first read
    projects = [{ path: dir, lastSeenAt: new Date() }]; // the read has now stored a project
    const second = await detector.rescan();
    await first;
    assert.deepEqual(
      second.map((p) => [p.path, p.stackTags]),
      [[dir, ["go"]]],
    );
  });
});

describe("the deep scan's depth", () => {
  it("reaches a marker three folders down, not four", async () => {
    const three = makeProject(["a/b/c/main.tf"]);
    const four = makeProject(["a/b/c/d/main.tf"]);
    assert.ok((await detectStackTagsWithMonorepo(three)).tags.includes("terraform"));
    assert.ok(!(await detectStackTagsWithMonorepo(four)).tags.includes("terraform"));
  });
});
