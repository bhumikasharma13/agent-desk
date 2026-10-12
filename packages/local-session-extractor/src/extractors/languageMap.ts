// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
// Shared file-path → programming-language derivation, used by every extractor
// that reports session languages (Claude Code, Cursor, Kiro CLI/Desktop).
//
// Keeping a single map here (rather than one per extractor) is what makes
// per-language counts comparable across IDEs: a per-extractor map drifts, and
// TOML/HCL/Groovy and extensionless files (Makefile/Dockerfile) under-appear.

// Bare, lowercased extension (no leading dot) → language label.
const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", kts: "Kotlin",
  swift: "Swift", cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++",
  c: "C", h: "C", cs: "C#", rb: "Ruby", php: "PHP", scala: "Scala",
  sh: "Shell", bash: "Shell", zsh: "Shell", fish: "Shell",
  sql: "SQL", html: "HTML", css: "CSS", scss: "CSS", sass: "CSS", less: "CSS",
  json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", md: "Markdown", mdx: "Markdown",
  tf: "Terraform", tfvars: "Terraform", hcl: "HCL",
  proto: "Protobuf", graphql: "GraphQL", gql: "GraphQL",
  groovy: "Groovy", gradle: "Groovy",
};

// Extensionless (or convention-named) files keyed by exact basename. Basename
// wins over extension so a "Dockerfile" is not lost for having no extension.
const BASENAME_TO_LANGUAGE: Record<string, string> = {
  Makefile: "Makefile", GNUmakefile: "Makefile", makefile: "Makefile",
  Dockerfile: "Dockerfile", Containerfile: "Dockerfile",
  Jenkinsfile: "Groovy",
  Rakefile: "Ruby", Gemfile: "Ruby", Guardfile: "Ruby",
  Vagrantfile: "Ruby", Brewfile: "Ruby",
  Justfile: "Just", justfile: "Just",
};

// languageForPath returns the language for a single file path, or undefined when
// the extension/basename is unmapped. Basename match is tried before extension;
// a leading-dot file (".gitignore") has no extension by this rule.
export function languageForPath(filePath: string): string | undefined {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  // Object.hasOwn, not a bare bracket lookup: a basename/extension that collides
  // with an Object.prototype key ("constructor", "__proto__", "toString", …)
  // would otherwise resolve up the prototype chain to a truthy non-string.
  if (Object.hasOwn(BASENAME_TO_LANGUAGE, base)) return BASENAME_TO_LANGUAGE[base];
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return Object.hasOwn(EXT_TO_LANGUAGE, ext) ? EXT_TO_LANGUAGE[ext] : undefined;
}

// deriveLanguages counts language occurrences across file paths, returning a
// language → file-count map (empty when nothing maps). Shape matches the
// SessionMeta.languages (a map of language to count).
export function deriveLanguages(filePaths: Iterable<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const fp of filePaths) {
    const lang = languageForPath(fp);
    if (lang) counts[lang] = (counts[lang] ?? 0) + 1;
  }
  return counts;
}
