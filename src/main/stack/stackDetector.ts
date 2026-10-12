// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * StackDetector
 *
 * Detects the technology stack of each project the app already knows about, by
 * checking for well-known signal files (go.mod, buf.yaml, package.json, *.tf …).
 *
 * The set of projects to scan comes from one source: the session store's
 * resolved project roots (`SessionStore.listDetectedProjects`, injected via
 * `setProjectsProvider`), the same set that backs the Projects-view rows, so
 * every tag joins its row by the same path.
 */

import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir, stat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { mapWithConcurrency } from '../concurrency';
import { logger } from '../logging/logger';
// displayName is a user-facing label that reaches the renderer, so redact it at
// construction — the real username must never ride a home-level repo's label
// across IPC. `path` stays real internally (its only emitter,
// toStackProjects, redacts it there).
import { redactPath } from 'local-session-extractor';
import { isPathWithinBase } from '../permissions/pathWithin';
import { resolveProject } from '../permissions/resolveProject';

/** True when `absPath` is one of `roots` or inside one. */
function isWithinAny(absPath: string, roots: readonly string[]): boolean {
  return roots.some((root) => isPathWithinBase(absPath, root));
}


// ─── Public types ────────────────────────────────────────────────────────────

export interface Subproject {
  relativePath: string;  // e.g., "packages/api" or "." for root
  stackTags: string[];
}

export interface DetectedProject {
  path: string;
  displayName: string;
  stackTags: string[];  // union of subproject tags + deep-walk markers (which are not attributed to a subproject)
  lastSeenAt: Date;
  subprojects: Subproject[];  // per-subdirectory breakdown
}

/** One project root the extractor has already identified (absolute path + recency). */
export interface ResolvedProject {
  path: string;
  lastSeenAt: Date;
}

/**
 * Supplies the project roots StackDetector scans (see the file header for why
 * this is the single source). Returns `[]` before extraction has populated the
 * DB (cold start).
 */
export type ResolvedProjectsProvider = () => ResolvedProject[];

// ─── deriveDisplayName ───────────────────────────────────────────────────────

/**
 * Returns the last two path segments joined with `/`.
 * e.g. `/Users/alice/projs/shop` → `"projs/shop"`
 */
export function deriveDisplayName(projectPath: string): string {
  const parts = projectPath.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return parts[parts.length - 1] ?? projectPath;
}

// ─── Stack detection ──────────────────────────────────────────────────────────

/**
 * Looks at a file or folder below a project folder one part at a time, with lstat:
 * null when it is missing or any part of it is a symlink. No probe follows a link,
 * so a manifest linked into a protected folder is never read. The project folder
 * itself is already resolved (resolveProject), and subfolders come from directory
 * entries, which a symlink never is.
 */
async function probe(dir: string, ...parts: string[]): Promise<Stats | null> {
  let p = dir;
  let s: Stats | null = null;
  for (const part of parts.flatMap((x) => x.split('/'))) {
    p = join(p, part);
    try {
      s = await lstat(p);
    } catch {
      return null;
    }
    if (s.isSymbolicLink()) return null;
  }
  return s;
}

/**
 * Checks for GitHub Actions workflow files under `.github/workflows/`.
 * Returns true if at least one `*.yml` or `*.yaml` file exists there.
 */
async function hasGithubActionsWorkflows(projectDir: string): Promise<boolean> {
  const workflowsDir = join(projectDir, '.github', 'workflows');
  if (!(await probe(projectDir, '.github', 'workflows'))?.isDirectory()) return false;
  try {
    const entries = await readdir(workflowsDir, { withFileTypes: true });
    return entries.some(
      (e) => e.isFile() && (e.name.endsWith('.yml') || e.name.endsWith('.yaml')),
    );
  } catch {
    return false;
  }
}

/**
 * Checks for a `next.config.*` file (js, ts, or mjs) in the given directory.
 */
async function hasNextConfig(projectDir: string): Promise<boolean> {
  for (const name of ['next.config.js', 'next.config.ts', 'next.config.mjs']) {
    try {
      if (await probe(projectDir, name)) return true;
    } catch {
      // Not found — continue
    }
  }
  return false;
}

/** Whether a file, not a symlink, is at `parts` below `dir` (see probe). */
async function fileExists(dir: string, ...parts: string[]): Promise<boolean> {
  return (await probe(dir, ...parts))?.isFile() === true;
}

/** Whether a folder, not a symlink, is at `parts` below `dir` (see probe). */
async function directoryExists(dir: string, ...parts: string[]): Promise<boolean> {
  return (await probe(dir, ...parts))?.isDirectory() === true;
}

/**
 * Checks for `.csproj` or `.sln` files in the project root directory.
 * Returns true if at least one matching file is found.
 */
async function hasDotnetProjectFile(projectDir: string): Promise<boolean> {
  try {
    const entries = await readdir(projectDir, { withFileTypes: true });
    return entries.some(
      (e) => e.isFile() && (e.name.endsWith('.csproj') || e.name.endsWith('.sln')),
    );
  } catch {
    return false;
  }
}

/**
 * Reads the project root's directory entries once, so the several suffix/name
 * matchers below can scan a single listing instead of each issuing its own
 * `readdir` on the same directory (this runs per project root AND per first-level
 * subdir, and stack-detect concurrency is already bounded because of that fan-out
 * cost). Returns `[]` on any read failure — every matcher then reports absent.
 */
async function scanRootEntries(projectDir: string): Promise<Dirent[]> {
  try {
    return await readdir(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Terraform / OpenTofu signals among root entries: `*.tf` / `*.tofu` /
 * `*.tf.json` config files, a `terragrunt.hcl` wrapper, or the
 * `.terraform.lock.hcl` provider lockfile. The lockfile matters because an infra
 * repo that keeps its `.tf` in per-environment subdirectories can still carry the
 * lockfile at the root the scan sees.
 */
function hasTerraformEntry(entries: Dirent[]): boolean {
  return entries.some(
    (e) =>
      e.isFile() &&
      (e.name.endsWith('.tf') ||
        e.name.endsWith('.tofu') ||
        e.name.endsWith('.tf.json') ||
        e.name === 'terragrunt.hcl' ||
        e.name === '.terraform.lock.hcl'),
  );
}

/** HashiCorp Packer templates (`*.pkr.hcl` / `*.pkr.json`) among root entries. */
function hasPackerEntry(entries: Dirent[]): boolean {
  return entries.some(
    (e) => e.isFile() && (e.name.endsWith('.pkr.hcl') || e.name.endsWith('.pkr.json')),
  );
}

/**
 * Protobuf signals among root entries: a Buf config (`buf.yaml` / `buf.yml` /
 * `buf.work.yaml` / `buf.work.yml` / `buf.gen.yaml` / `buf.gen.yml`) or at least
 * one `.proto` file. Independent of `go.mod`, so a language-agnostic proto repo
 * is still tagged.
 */
function hasProtobufEntry(entries: Dirent[]): boolean {
  return entries.some(
    (e) =>
      e.isFile() &&
      (e.name.endsWith('.proto') ||
        e.name === 'buf.yaml' ||
        e.name === 'buf.yml' ||
        e.name === 'buf.work.yaml' ||
        e.name === 'buf.work.yml' ||
        e.name === 'buf.gen.yaml' ||
        e.name === 'buf.gen.yml'),
  );
}

/**
 * Checks for Ansible signals: an `ansible.cfg`, or a top-level playbook
 * (`playbook.yml` / `playbook.yaml`). Deliberately conservative — a bare
 * `site.yml` is too generic to treat as an Ansible signal on its own.
 */
async function hasAnsibleSignal(projectDir: string): Promise<boolean> {
  for (const name of ['ansible.cfg', 'playbook.yml', 'playbook.yaml']) {
    if (await fileExists(projectDir, name)) return true;
  }
  return false;
}

/**
 * Checks for a Pulumi project file (`Pulumi.yaml` / `Pulumi.yml`).
 */
async function hasPulumiConfig(projectDir: string): Promise<boolean> {
  for (const name of ['Pulumi.yaml', 'Pulumi.yml']) {
    if (await fileExists(projectDir, name)) return true;
  }
  return false;
}

/**
 * Checks for a Kustomize overlay (`kustomization.yaml` / `kustomization.yml`),
 * a Kubernetes signal distinct from the top-level `k8s/` directory probe.
 */
async function hasKustomizeConfig(projectDir: string): Promise<boolean> {
  for (const name of ['kustomization.yaml', 'kustomization.yml']) {
    if (await fileExists(projectDir, name)) return true;
  }
  return false;
}

/**
 * Checks for a Docker Compose file (`docker-compose.{yml,yaml}` or the newer
 * `compose.{yml,yaml}`) in the project root directory.
 */
async function hasDockerComposeFile(projectDir: string): Promise<boolean> {
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    if (await fileExists(projectDir, name)) return true;
  }
  return false;
}

// High-signal, unambiguous marker filenames for the deep rescue walk below.
// Kept to strong single-file signals a language/tool almost never shares, so a
// nested match is safe to attribute at the project level.
const DEEP_FILENAME_TAGS: Record<string, string> = {
  'go.mod': 'go',
  'package.json': 'typescript',
  'Cargo.toml': 'rust',
  'pyproject.toml': 'python',
  'requirements.txt': 'python',
  'pom.xml': 'java',
  'build.gradle': 'java',
  'build.gradle.kts': 'kotlin',
  Gemfile: 'ruby',
  'Package.swift': 'swift',
  'composer.json': 'php',
  'Pulumi.yaml': 'pulumi',
  'Pulumi.yml': 'pulumi',
  'kustomization.yaml': 'kubernetes',
  'kustomization.yml': 'kubernetes',
  'ansible.cfg': 'ansible',
  'playbook.yml': 'ansible',
  'playbook.yaml': 'ansible',
  'Chart.yaml': 'helm',
  Dockerfile: 'docker',
  Jenkinsfile: 'jenkins',
};

// Directories never descended into when attributing stack tags: dependency/build
// output and fixture/example/test/generated trees. Load-bearing because every
// deep-walk marker is attributed unconditionally, so a manifest inside a fixture
// (`testdata/x/package.json`, `examples/chart/Chart.yaml`) would otherwise tag the
// enclosing repo. Deliberately a bounded denylist of well-known conventions, not an
// exhaustive classifier — an oddly-named dir (`gen/`, `demo/`) can still contribute a
// marker, usually a real generated/secondary language, so erring toward tagging it
// is acceptable.
const DEEP_SCAN_SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'target', 'out',
  '.terraform', '.next', '.venv', '__pycache__', 'coverage',
  'testdata', 'fixtures', '__fixtures__', 'mocks', '__mocks__',
  'example', 'examples', 'samples', 'test', 'tests', '__tests__', 'spec', 'e2e',
  'generated', '__generated__', 'test-fixtures', 'test_fixtures', '__snapshots__',
]);

/**
 * Whether a subdirectory should be skipped when attributing tags (see
 * DEEP_SCAN_SKIP_DIRS). Case-insensitive (`Examples/` matches on macOS) and shared
 * by both tag-attributing passes — the one-level monorepo scan and the deep walk —
 * so the guard is uniform at every depth.
 */
function isSkippedScanDir(name: string): boolean {
  return DEEP_SCAN_SKIP_DIRS.has(name.toLowerCase());
}

/**
 * Bounded breadth-first walk for strong stack markers a project keeps deeper than
 * the one-level monorepo scan reaches (e.g. `infra/environments/prod/main.tf`,
 * or a service whose `go.mod` sits two directories down). The caller unions the
 * result for every project. Hard-capped on depth and directory count; dot-dirs and
 * the dependency/build/fixture/example/test dirs in `DEEP_SCAN_SKIP_DIRS` are
 * skipped (case-insensitively) — that skip is both the perf bound (a pathological
 * tree stays bounded) and the false-positive guard (a manifest inside a fixture
 * tree is never reached, so it can't be mis-attributed to the enclosing repo).
 */
async function deepScanForSignals(rootDir: string, skipRoots: readonly string[] = []): Promise<string[]> {
  const MAX_DEPTH = 3; // levels below rootDir
  const MAX_DIRS = 250; // hard ceiling on directories visited
  const found = new Set<string>();
  const queue: { dir: string; depth: number }[] = [{ dir: rootDir, depth: 0 }];
  let visited = 0;

  while (queue.length > 0 && visited < MAX_DIRS) {
    const { dir, depth } = queue.shift()!;
    visited++;
    const entries = await scanRootEntries(dir);

    if (hasTerraformEntry(entries)) found.add('terraform');
    if (hasPackerEntry(entries)) found.add('packer');
    if (hasProtobufEntry(entries)) found.add('protobuf');
    for (const e of entries) {
      if (e.isFile()) {
        const tag = DEEP_FILENAME_TAGS[e.name];
        if (tag) found.add(tag);
      } else if (e.isDirectory() && e.name === 'k8s') {
        found.add('kubernetes');
      }
    }

    if (depth < MAX_DEPTH) {
      for (const e of entries) {
        // Bound the queue itself, not just dirs processed: a tag-less repo with a
        // huge flat fan-out (the data/assets case this path fires on) would else
        // enqueue every child of one directory even though only MAX_DIRS are ever
        // dequeued — a transient spike scaling with fan-out, not the cap.
        if (visited + queue.length >= MAX_DIRS) break;
        const child = join(dir, e.name);
        if (e.isDirectory() && !e.name.startsWith('.') && !isSkippedScanDir(e.name) && !isWithinAny(child, skipRoots)) {
          queue.push({ dir: child, depth: depth + 1 });
        }
      }
    }
  }
  return Array.from(found);
}

/**
 * Checks for a `tailwind.config.*` file (js, ts, mjs, cjs) in the given directory.
 */
async function hasTailwindConfig(projectDir: string): Promise<boolean> {
  for (const name of ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.mjs', 'tailwind.config.cjs']) {
    try {
      if (await probe(projectDir, name)) return true;
    } catch {
      // Not found — continue
    }
  }
  return false;
}

/**
 * Checks for ESLint configuration files in the given directory.
 * Covers both legacy (`.eslintrc.*`) and modern flat config (`eslint.config.*`).
 */
async function hasEslintConfig(projectDir: string): Promise<boolean> {
  try {
    const entries = await readdir(projectDir, { withFileTypes: true });
    return entries.some(
      (e) =>
        e.isFile() &&
        (e.name.startsWith('.eslintrc') || e.name.startsWith('eslint.config')),
    );
  } catch {
    return false;
  }
}

/**
 * Checks for a `vite.config.*` file (js, ts, mjs, cjs) in the given directory.
 */
async function hasViteConfig(projectDir: string): Promise<boolean> {
  for (const name of ['vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.cjs']) {
    try {
      if (await probe(projectDir, name)) return true;
    } catch {
      // Not found — continue
    }
  }
  return false;
}

/**
 * Checks for a `vue.config.js` or `nuxt.config.ts` file in the given directory.
 */
async function hasVueConfig(projectDir: string): Promise<boolean> {
  for (const name of ['vue.config.js', 'nuxt.config.ts']) {
    try {
      if (await probe(projectDir, name)) return true;
    } catch {
      // Not found — continue
    }
  }
  return false;
}

/**
 * Checks for Android project signals:
 * 1. AndroidManifest.xml in known locations.
 * 2. build.gradle / build.gradle.kts containing `com.android.application`.
 */
async function hasAndroidSignal(projectDir: string): Promise<boolean> {
  for (const p of ['AndroidManifest.xml', 'app/src/main/AndroidManifest.xml', 'src/main/AndroidManifest.xml']) {
    if (await fileExists(projectDir, p)) return true;
  }
  for (const name of ['build.gradle', 'build.gradle.kts', 'app/build.gradle', 'app/build.gradle.kts']) {
    const buf = await safeReadFile(projectDir, name);
    if (buf?.includes('com.android.application')) return true;
  }
  return false;
}

/**
 * Checks for Spring Boot configuration files under `src/main/resources/`.
 * Looks for `application.properties` or `application.yml`.
 */
async function hasSpringBootConfig(projectDir: string): Promise<boolean> {
  for (const name of ['application.properties', 'application.yml']) {
    try {
      if (await probe(projectDir, 'src', 'main', 'resources', name)) return true;
    } catch {
      // Not found — continue
    }
  }
  return false;
}

// ─── Manifest parsing maps ───────────────────────────────────────────────────

const PACKAGE_JSON_FRAMEWORK_MAP: Record<string, string> = {
  'react': 'react',
  'vue': 'vue',
  'angular': 'angular',
  'svelte': 'svelte',
  'express': 'express',
  'fastify': 'fastify',
  'tailwindcss': 'tailwind',
  'prisma': 'prisma',
  '@prisma/client': 'prisma',
  'jest': 'jest',
  'vitest': 'vitest',
  'eslint': 'eslint',
  'vite': 'vite',
  'webpack': 'webpack',
  '@nestjs/core': 'nestjs',
  'electron': 'electron',
  'three': 'threejs',
};

const PYTHON_FRAMEWORK_MAP: Record<string, string> = {
  'django': 'django',
  'flask': 'flask',
  'fastapi': 'fastapi',
  'celery': 'celery',
  'sqlalchemy': 'sqlalchemy',
  'pytest': 'pytest',
  'numpy': 'numpy',
  'pandas': 'pandas',
  'torch': 'pytorch',
  'tensorflow': 'tensorflow',
};

const GO_MODULE_MAP: Record<string, string> = {
  'github.com/gin-gonic/gin': 'gin',
  'github.com/labstack/echo': 'echo',
  'google.golang.org/grpc': 'grpc',
  'github.com/gofiber/fiber': 'fiber',
  'gorm.io/gorm': 'gorm',
  'github.com/jmoiron/sqlx': 'sqlx',
  'github.com/gorilla/mux': 'gorilla',
};

/** Maximum file size (1 MB) for manifest reads — skip larger files. */
const MAX_MANIFEST_SIZE = 1_000_000;

/**
 * Reads a file below `dir` if it exists, is not a symlink (see probe) and is under
 * the size cap. Returns the file contents as a string, or null on any failure.
 */
async function safeReadFile(dir: string, ...parts: string[]): Promise<string | null> {
  try {
    const s = await probe(dir, ...parts);
    if (!s?.isFile() || s.size > MAX_MANIFEST_SIZE) return null;
    return await readFile(join(dir, ...parts), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Parses package.json to detect framework tags from dependencies and devDependencies.
 */
async function parsePackageJsonTags(projectDir: string): Promise<string[]> {
  const tags: string[] = [];
  try {
    const raw = await safeReadFile(projectDir, 'package.json');
    if (!raw) return tags;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return tags;

    const obj = parsed as Record<string, unknown>;
    const deps = typeof obj['dependencies'] === 'object' && obj['dependencies'] !== null
      ? Object.keys(obj['dependencies'] as Record<string, unknown>)
      : [];
    const devDeps = typeof obj['devDependencies'] === 'object' && obj['devDependencies'] !== null
      ? Object.keys(obj['devDependencies'] as Record<string, unknown>)
      : [];

    const allDeps = [...deps, ...devDeps];

    for (const dep of allDeps) {
      const mapped = PACKAGE_JSON_FRAMEWORK_MAP[dep];
      if (mapped) {
        tags.push(mapped);
      }
      // Special case: any @angular/* dependency adds angular tag
      if (dep.startsWith('@angular/')) {
        tags.push('angular');
      }
    }
  } catch {
    // Parse failure — return whatever we have
  }
  return tags;
}

/**
 * Parses pyproject.toml and/or requirements.txt to detect Python framework tags.
 */
async function parsePythonManifestTags(projectDir: string): Promise<string[]> {
  const tags: string[] = [];

  // Parse pyproject.toml — use regex to extract dependency names
  try {
    const raw = await safeReadFile(projectDir, 'pyproject.toml');
    if (raw) {
      // Match quoted package names that look like dependencies.
      // Covers formats like: "django>=4.0", 'flask', django = "^4.0"
      // We extract the bare package name before any version specifier.
      const depNameRegex = /["']([a-zA-Z0-9_-]+)(?:\[.*?\])?(?:\s*[>=<~!^].*?)?["']/g;
      let match: RegExpExecArray | null;
      while ((match = depNameRegex.exec(raw)) !== null) {
        const pkgName = match[1]!.toLowerCase();
        const mapped = PYTHON_FRAMEWORK_MAP[pkgName];
        if (mapped) {
          tags.push(mapped);
        }
      }
    }
  } catch {
    // Ignore parse errors
  }

  // Parse requirements.txt — one package per line, name before ==, >=, etc.
  try {
    const raw = await safeReadFile(projectDir, 'requirements.txt');
    if (raw) {
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
        // Extract package name: everything before ==, >=, <=, ~=, !=, <, >, [, ;, @
        const nameMatch = trimmed.match(/^([a-zA-Z0-9_-]+)/);
        if (nameMatch) {
          const pkgName = nameMatch[1]!.toLowerCase();
          const mapped = PYTHON_FRAMEWORK_MAP[pkgName];
          if (mapped) {
            tags.push(mapped);
          }
        }
      }
    }
  } catch {
    // Ignore parse errors
  }

  return tags;
}

/**
 * Parses go.mod to detect Go framework/library tags from the require block.
 */
async function parseGoModTags(projectDir: string): Promise<string[]> {
  const tags: string[] = [];
  try {
    const raw = await safeReadFile(projectDir, 'go.mod');
    if (!raw) return tags;

    // Extract module paths from require blocks and single-line requires.
    // Multi-line: require (\n  module/path v1.2.3\n)
    // Single-line: require module/path v1.2.3
    const requireBlockRegex = /require\s*\(\s*([\s\S]*?)\)/g;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = requireBlockRegex.exec(raw)) !== null) {
      const block = blockMatch[1]!;
      for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//')) continue;
        // Module path is the first token on the line
        const modulePath = trimmed.split(/\s+/)[0];
        if (modulePath) {
          for (const [prefix, tag] of Object.entries(GO_MODULE_MAP)) {
            if (modulePath === prefix || modulePath.startsWith(prefix + '/')) {
              tags.push(tag);
            }
          }
        }
      }
    }

    // Also check single-line requires: require github.com/gin-gonic/gin v1.9.0
    const singleRequireRegex = /^require\s+(\S+)\s+\S+/gm;
    let singleMatch: RegExpExecArray | null;
    while ((singleMatch = singleRequireRegex.exec(raw)) !== null) {
      const modulePath = singleMatch[1]!;
      for (const [prefix, tag] of Object.entries(GO_MODULE_MAP)) {
        if (modulePath === prefix || modulePath.startsWith(prefix + '/')) {
          tags.push(tag);
        }
      }
    }
  } catch {
    // Parse failure — return whatever we have
  }
  return tags;
}

/**
 * Detects the technology stack in a single project directory.
 * Returns an array of stack tag strings (e.g. `["go", "grpc", "docker"]`).
 *
 * Detection rules (all applied, results unioned):
 *  - `go.mod`                            → `"go"`
 *  - `go.mod` + `buf.yaml`              → additionally `"grpc"`
 *  - `package.json`                      → `"typescript"`
 *  - `next.config.{js,ts,mjs}`          → additionally `"next"`
 *  - `Cargo.toml`                        → `"rust"`
 *  - `pyproject.toml` or `requirements.txt` → `"python"`
 *  - `prisma/schema.prisma`             → additionally `"prisma"`
 *  - `Dockerfile`                                    → `"docker"`
 *  - `.github/workflows/*.yml`                       → `"github-actions"`
 *  - `pom.xml` or `build.gradle`                     → `"java"`
 *  - `build.gradle.kts`                              → `"kotlin"`
 *  - `Package.swift`                                 → `"swift"`
 *  - `Gemfile`                                       → `"ruby"`
 *  - `composer.json`                                 → `"php"`
 *  - `*.csproj` or `*.sln`                           → `"dotnet"`
 *  - `pubspec.yaml`                                  → `"flutter"`
 *  - `mix.exs`                                       → `"elixir"`
 *  - `CMakeLists.txt`                                → `"cpp"`
 *  - `build.sbt`                                     → `"scala"`
 *  - `manage.py`                                     → `"django"`
 *  - `app.py` + `requirements.txt`                   → `"flask"`
 *  - `config/routes.rb`                              → `"rails"`
 *  - `artisan`                                       → `"laravel"`
 *  - `src/main/resources/application.{properties,yml}` → `"spring-boot"`
 *  - `vue.config.js` or `nuxt.config.ts`            → `"vue"`
 *  - `angular.json`                                  → `"angular"`
 *  - `svelte.config.js`                              → `"svelte"`
 *  - `buf.*` or `*.proto`                            → `"protobuf"`
 *  - `*.tf`/`*.tofu` or `terragrunt.hcl`             → `"terraform"`
 *  - `*.pkr.hcl`/`*.pkr.json`                        → `"packer"`
 *  - `ansible.cfg` or `playbook.{yml,yaml}`          → `"ansible"`
 *  - `Pulumi.{yaml,yml}`                             → `"pulumi"`
 *  - `k8s/` directory or `kustomization.{yml,yaml}`  → `"kubernetes"`
 *  - `Chart.yaml`                                    → `"helm"`
 *  - `docker-compose.*` / `compose.*`                → `"docker"`
 *  - `Jenkinsfile`                                   → `"jenkins"`
 *  - `.gitlab-ci.yml`                                → `"gitlab-ci"`
 *  - `.circleci/config.yml`                          → `"circleci"`
 *  - `tailwind.config.*`                             → `"tailwind"`
 *  - `.eslintrc.*` or `eslint.config.*`              → `"eslint"`
 *  - `vite.config.*`                                 → `"vite"`
 */
export async function detectStackTags(projectDir: string): Promise<string[]> {
  const tags = new Set<string>();

  // One listing of the root, shared by the suffix/name matchers below (terraform,
  // packer, protobuf) instead of a readdir each.
  const rootEntries = await scanRootEntries(projectDir);

  const [
    // ── Languages and common tools ──
    hasGoMod,
    hasBufYaml,
    hasPackageJson,
    hasCargoToml,
    hasPyproject,
    hasRequirements,
    hasPrismaSchema,
    hasDockerfile,
    hasNextConf,
    hasGhActions,
    hasPomXml,
    hasBuildGradle,
    hasBuildGradleKts,
    hasPackageSwift,
    hasGemfile,
    hasComposerJson,
    hasDotnetProj,
    hasPubspecYaml,
    hasMixExs,
    hasCMakeLists,
    hasBuildSbt,
    // ── Frameworks ──
    hasManagePy,
    hasAppPy,
    hasRoutesRb,
    hasArtisan,
    hasSpringBoot,
    hasVueConf,
    hasAngularJson,
    hasSvelteConfig,
    hasAndroid,
    // ── Infrastructure ──
    hasProtobuf,
    hasTerraform,
    hasPacker,
    hasAnsible,
    hasPulumi,
    hasK8sDir,
    hasKustomize,
    hasChartYaml,
    hasDockerCompose,
    hasJenkinsfile,
    hasGitlabCi,
    hasCircleCi,
    hasTailwind,
    hasEslint,
    hasVite,
  ] = await Promise.all([
    // ── Languages and common tools ──
    fileExists(projectDir, 'go.mod'),
    fileExists(projectDir, 'buf.yaml'),
    fileExists(projectDir, 'package.json'),
    fileExists(projectDir, 'Cargo.toml'),
    fileExists(projectDir, 'pyproject.toml'),
    fileExists(projectDir, 'requirements.txt'),
    fileExists(projectDir, 'prisma', 'schema.prisma'),
    fileExists(projectDir, 'Dockerfile'),
    hasNextConfig(projectDir),
    hasGithubActionsWorkflows(projectDir),
    fileExists(projectDir, 'pom.xml'),
    fileExists(projectDir, 'build.gradle'),
    fileExists(projectDir, 'build.gradle.kts'),
    fileExists(projectDir, 'Package.swift'),
    fileExists(projectDir, 'Gemfile'),
    fileExists(projectDir, 'composer.json'),
    hasDotnetProjectFile(projectDir),
    fileExists(projectDir, 'pubspec.yaml'),
    fileExists(projectDir, 'mix.exs'),
    fileExists(projectDir, 'CMakeLists.txt'),
    fileExists(projectDir, 'build.sbt'),
    // ── Frameworks ──
    fileExists(projectDir, 'manage.py'),
    fileExists(projectDir, 'app.py'),
    fileExists(projectDir, 'config', 'routes.rb'),
    fileExists(projectDir, 'artisan'),
    hasSpringBootConfig(projectDir),
    hasVueConfig(projectDir),
    fileExists(projectDir, 'angular.json'),
    fileExists(projectDir, 'svelte.config.js'),
    hasAndroidSignal(projectDir),
    // ── Infrastructure ──
    hasProtobufEntry(rootEntries),
    hasTerraformEntry(rootEntries),
    hasPackerEntry(rootEntries),
    hasAnsibleSignal(projectDir),
    hasPulumiConfig(projectDir),
    directoryExists(projectDir, 'k8s'),
    hasKustomizeConfig(projectDir),
    fileExists(projectDir, 'Chart.yaml'),
    hasDockerComposeFile(projectDir),
    fileExists(projectDir, 'Jenkinsfile'),
    fileExists(projectDir, '.gitlab-ci.yml'),
    fileExists(projectDir, '.circleci', 'config.yml'),
    hasTailwindConfig(projectDir),
    hasEslintConfig(projectDir),
    hasViteConfig(projectDir),
  ]);

  // ── Languages and common tools ──
  if (hasGoMod) {
    tags.add('go');
    if (hasBufYaml) {
      tags.add('grpc');
    }
  }

  if (hasPackageJson) {
    tags.add('typescript');
    if (hasNextConf) {
      tags.add('next');
    }
  }

  if (hasCargoToml) tags.add('rust');
  if (hasPyproject || hasRequirements) tags.add('python');
  if (hasPrismaSchema) tags.add('prisma');
  if (hasDockerfile) tags.add('docker');
  if (hasGhActions) tags.add('github-actions');

  if (hasPomXml || hasBuildGradle) tags.add('java');
  if (hasBuildGradleKts) tags.add('kotlin');
  if (hasPackageSwift) tags.add('swift');
  if (hasGemfile) tags.add('ruby');
  if (hasComposerJson) tags.add('php');
  if (hasDotnetProj) tags.add('dotnet');
  if (hasPubspecYaml) tags.add('flutter');
  if (hasMixExs) tags.add('elixir');
  if (hasCMakeLists) tags.add('cpp');
  if (hasBuildSbt) tags.add('scala');

  // ── Frameworks ──
  if (hasManagePy) tags.add('django');
  if (hasAppPy && (hasRequirements || hasPyproject)) tags.add('flask');
  if (hasRoutesRb) tags.add('rails');
  if (hasArtisan) tags.add('laravel');
  if (hasSpringBoot) tags.add('spring-boot');
  if (hasVueConf) tags.add('vue');
  if (hasAngularJson) tags.add('angular');
  if (hasSvelteConfig) tags.add('svelte');
  if (hasAndroid) tags.add('android');

  // ── Infrastructure ──
  if (hasProtobuf) tags.add('protobuf');
  if (hasTerraform) tags.add('terraform');
  if (hasPacker) tags.add('packer');
  if (hasAnsible) tags.add('ansible');
  if (hasPulumi) tags.add('pulumi');
  if (hasK8sDir || hasKustomize) tags.add('kubernetes');
  if (hasChartYaml) tags.add('helm');
  if (hasDockerCompose) tags.add('docker');
  if (hasJenkinsfile) tags.add('jenkins');
  if (hasGitlabCi) tags.add('gitlab-ci');
  if (hasCircleCi) tags.add('circleci');
  if (hasTailwind) tags.add('tailwind');
  if (hasEslint) tags.add('eslint');
  if (hasVite) tags.add('vite');

  // ── Deep manifest parsing (only for files confirmed to exist) ──
  const manifestParsePromises: Promise<string[]>[] = [];

  if (hasPackageJson) {
    manifestParsePromises.push(parsePackageJsonTags(projectDir));
  }
  if (hasPyproject || hasRequirements) {
    manifestParsePromises.push(parsePythonManifestTags(projectDir));
  }
  if (hasGoMod) {
    manifestParsePromises.push(parseGoModTags(projectDir));
  }

  if (manifestParsePromises.length > 0) {
    const manifestResults = await Promise.all(manifestParsePromises);
    for (const manifestTags of manifestResults) {
      for (const tag of manifestTags) {
        tags.add(tag);
      }
    }
  }

  return Array.from(tags);
}

/**
 * Detects the stack for a directory, also checking every immediate
 * subdirectory for monorepo support. Returns both the union of all tags and a
 * per-subdirectory breakdown. Nothing inside `skipRoots` (protected folders the
 * user has not granted) is read, at any depth.
 */
export async function detectStackTagsWithMonorepo(
  projectDir: string,
  skipRoots: readonly string[] = [],
): Promise<{ tags: string[]; subprojects: Subproject[] }> {
  const rootTags = await detectStackTags(projectDir);
  const allTags = new Set<string>(rootTags);
  const subprojects: Subproject[] = [];

  // Root is always a subproject if it has tags
  if (rootTags.length > 0) {
    subprojects.push({
      relativePath: '.',
      stackTags: rootTags,
    });
  }

  // Recurse one level for monorepos
  try {
    const entries = await readdir(projectDir, { withFileTypes: true });
    const subDirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !isSkippedScanDir(e.name))
      .map((e) => ({ name: e.name, absPath: join(projectDir, e.name) }))
      .filter((sd) => !isWithinAny(sd.absPath, skipRoots));

    // Subfolders come from directory entries, so a symlinked subfolder is never one
    // of them and is not probed; realpath below so returns each subfolder's own path.
    // A repo can have hundreds of immediate subdirectories, so a bounded number at a time.
    const realpaths = await mapWithConcurrency(subDirs, SUBDIR_CONCURRENCY, (sd) =>
      realpath(sd.absPath).catch(() => sd.absPath),
    );
    const seenReal = new Set<string>();
    const dedupedSubDirs: typeof subDirs = [];
    for (let i = 0; i < subDirs.length; i++) {
      const real = realpaths[i]!;
      // A second guard: the folder is not inside a skipped one.
      if (seenReal.has(real) || isWithinAny(real, skipRoots)) continue;
      seenReal.add(real);
      dedupedSubDirs.push(subDirs[i]!);
    }

    const subResults = await mapWithConcurrency(dedupedSubDirs, SUBDIR_CONCURRENCY, async ({ name, absPath }) => {
      try {
        const subTags = await detectStackTags(absPath);
        return { name, subTags };
      } catch {
        return { name, subTags: [] as string[] };
      }
    });

    for (const { name, subTags } of subResults) {
      if (subTags.length > 0) {
        subprojects.push({
          relativePath: name,
          stackTags: subTags,
        });
        for (const tag of subTags) {
          allTags.add(tag);
        }
      }
    }
  } catch {
    // Ignore readdir errors for root — we already have rootTags
  }

  // Union the deep walk, which reaches the strong markers the root + one-level scan
  // structurally cannot — an infra repo's `.tf` under `terraform/env/`, a polyglot
  // monorepo's service `go.mod` a couple levels in. It runs for every project (not
  // only tag-less ones); its cost is bounded by deepScanForSignals' own depth/dir
  // caps, and its fixture false-positives by DEEP_SCAN_SKIP_DIRS (documented there).
  for (const tag of await deepScanForSignals(projectDir, skipRoots)) {
    allTags.add(tag);
  }

  return { tags: Array.from(allTags), subprojects };
}

// ─── StackDetector singleton ──────────────────────────────────────────────────

// How many projects run stack detection concurrently during a rescan. See the
// call site in runRescan for why the fan-out must be bounded.
const DETECT_CONCURRENCY = 4;

// How many immediate subdirectories of one project are probed at a time (each
// runs ~40 fs probes); bounds the fan-out of a wide monorepo root.
const SUBDIR_CONCURRENCY = 8;

export class StackDetector {
  private static instance: StackDetector;

  private projects: DetectedProject[] = [];
  private onRescanCallback: ((projects: DetectedProject[]) => void) | null = null;
  private rescanInFlight: Promise<DetectedProject[]> | null = null;
  private rescanQueued: Promise<DetectedProject[]> | null = null;
  private lastRescanSettledAt = 0;
  // Supplies the project roots to scan (the session store's resolved set).
  // Injected from main/index.ts once the store is open; until then a rescan
  // finds nothing, which is correct for a cold start.
  private projectsProvider: ResolvedProjectsProvider | null = null;
  private skipRootsProvider: (() => Promise<string[]>) | null = null;
  private constructor() {}

  /**
   * Registers a callback invoked at the end of every successful rescan.
   */
  setOnRescanComplete(cb: (projects: DetectedProject[]) => void): void {
    this.onRescanCallback = cb;
  }

  /**
   * Injects the source of project roots to scan (the extractor's resolved set).
   * Set once at startup; a rescan before this is set finds nothing.
   */
  setProjectsProvider(provider: ResolvedProjectsProvider): void {
    this.projectsProvider = provider;
  }

  /**
   * Injects the protected folders a rescan must not read (`ungrantedProtectedRoots`
   * in production): a project inside one is skipped, and so is any subfolder in one.
   */
  setSkipRootsProvider(provider: () => Promise<string[]>): void {
    this.skipRootsProvider = provider;
  }

  static getInstance(): StackDetector {
    if (!StackDetector.instance) {
      StackDetector.instance = new StackDetector();
    }
    return StackDetector.instance;
  }

  /**
   * Returns the cached list of detected projects. No I/O is performed.
   */
  getProjects(): DetectedProject[] {
    return this.projects;
  }

  /**
   * Scans the injected `projectsProvider` roots (the session store's resolved
   * set), detects each project's stack, and updates the internal cache. The
   * provider call is wrapped in try/catch — a failing or cold store degrades
   * to an empty scan, never a thrown rescan.
   *
   * Only one scan runs at a time. A call made while one runs gets a fresh scan
   * after it, shared with any other such call: the running scan may have read
   * the project list before the change the caller is reacting to.
   */
  async rescan(): Promise<DetectedProject[]> {
    if (this.rescanInFlight) {
      this.rescanQueued ??= this.rescanInFlight
        .catch(() => undefined)
        .then(() => {
          this.rescanQueued = null;
          return this.rescan();
        });
      return this.rescanQueued;
    }
    this.rescanInFlight = (async () => {
      try {
        return await this.runRescan();
      } finally {
        this.rescanInFlight = null;
        this.lastRescanSettledAt = Date.now();
      }
    })();
    return this.rescanInFlight;
  }

  /**
   * Kicks a background rescan unless one settled within `cooldownMs`.
   * For opportunistic triggers (the cold-cache IPC path): an empty cache is
   * indistinguishable from "scanned and found nothing" (e.g. permissions still
   * pending), so without this latch every Projects-page remount in that state
   * re-armed a full multi-source scan. Event-driven triggers that must always
   * run (permission grant, a finished read) call rescan() directly.
   */
  rescanIfStale(cooldownMs: number): void {
    if (this.rescanInFlight) return;
    if (Date.now() - this.lastRescanSettledAt < cooldownMs) return;
    void this.rescan().catch(() => {});
  }

  private async runRescan(): Promise<DetectedProject[]> {
    // The session store's resolved roots (git-root, AI-session-gated) — the same
    // set backing the Projects-view rows, so detected tags join by path.
    let resolved: ResolvedProject[] = [];
    try {
      resolved = this.projectsProvider?.() ?? [];
    } catch (err: unknown) {
      logger.warn('stack', 'projects_provider_failed', { error: err instanceof Error ? err.message : String(err) });
    }
    // Protected folders the user has not granted. If they cannot be worked out,
    // read nothing this time and keep the last result.
    let skipRoots: string[];
    try {
      skipRoots = (await this.skipRootsProvider?.()) ?? [];
    } catch (err: unknown) {
      logger.warn('stack', 'skip_roots_failed', { error: err instanceof Error ? err.message : String(err) });
      return this.projects;
    }
    // One entry per path, keeping its most recent session time.
    const merged = new Map<string, { date: Date }>();
    for (const r of resolved) {
      const existing = merged.get(r.path);
      if (!existing || r.lastSeenAt > existing.date) merged.set(r.path, { date: r.lastSeenAt });
    }

    // Detect stacks for each unique project path, a bounded number at a time.
    // Each project fans out ~40 fs probes at its root plus ~40 per immediate
    // subdirectory; unbounded Promise.all over every project saturates libuv's
    // default 4-thread pool and starves the rest of the app's async I/O (IPC
    // included) for the whole scan.
    const projectEntries = Array.from(merged.entries());
    const results = await mapWithConcurrency(
      projectEntries,
      DETECT_CONCURRENCY,
      async ([projectPath, entry]): Promise<DetectedProject | null> => {
        const lastSeenAt = entry.date;
        // Where the project really is, symlinks followed one at a time: null when it
        // resolves into a folder not granted, or onto the home folder or a folder that
        // holds it (a session run in ~), whose walk would reach iCloud Drive, Photos
        // and every other project. Nothing is read before this says yes.
        const resolved = await resolveProject(projectPath, skipRoots);
        if (resolved === null) return null;
        const s = await stat(resolved).catch(() => null);
        if (!s || !s.isDirectory()) return null;

        try {
          const { tags: stackTags, subprojects } = await detectStackTagsWithMonorepo(resolved, skipRoots);
          return {
            path: projectPath,
            displayName: deriveDisplayName(redactPath(projectPath)),
            stackTags,
            lastSeenAt,
            subprojects,
          };
        } catch (err: unknown) {
          logger.warn('stack', 'detect_failed', {
            path: projectPath,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      },
    );

    // Filter nulls and sort by most recently seen (descending)
    const detected = (results.filter((r): r is DetectedProject => r !== null)).sort(
      (a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
    );

    this.projects = detected;
    logger.info('stack', 'rescan_complete', { projects: detected.length, paths: merged.size });
    this.onRescanCallback?.(detected);
    return detected;
  }
}
