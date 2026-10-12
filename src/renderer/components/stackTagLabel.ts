// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// ─────────────────────────────────────────────────────────────────────────────
// Display labels for the StackDetector's canonical stack tags.
//
// The stack detector emits lowercase, kebab-case tokens ("grpc",
// "github-actions", "cpp"). For the Projects chips we want the polished,
// human-readable form ("gRPC", "GitHub Actions", "C++"). Known tokens map explicitly; anything unmapped falls back to a
// Title-Case-with-spaces rendering so a new detector tag still reads sensibly.
//
// NB: the detector does not extract versions, so labels carry none. We never
// fabricate a version we didn't detect.
// ─────────────────────────────────────────────────────────────────────────────

const LABELS: Record<string, string> = {
  // Languages
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  go: "Go",
  rust: "Rust",
  java: "Java",
  kotlin: "Kotlin",
  swift: "Swift",
  ruby: "Ruby",
  php: "PHP",
  csharp: "C#",
  cpp: "C++",
  dotnet: ".NET",
  scala: "Scala",
  elixir: "Elixir",
  // Frameworks / libraries
  react: "React",
  vue: "Vue",
  angular: "Angular",
  svelte: "Svelte",
  next: "Next.js",
  nuxt: "Nuxt",
  express: "Express",
  fastify: "Fastify",
  nestjs: "NestJS",
  tailwind: "Tailwind",
  prisma: "Prisma",
  django: "Django",
  flask: "Flask",
  fastapi: "FastAPI",
  rails: "Rails",
  laravel: "Laravel",
  "spring-boot": "Spring Boot",
  flutter: "Flutter",
  electron: "Electron",
  three: "Three.js",
  threejs: "Three.js",
  // Go ecosystem
  gin: "Gin",
  fiber: "Fiber",
  gorilla: "Gorilla",
  gorm: "GORM",
  sqlx: "sqlx",
  // Python ecosystem
  numpy: "NumPy",
  pandas: "pandas",
  pytorch: "PyTorch",
  torch: "PyTorch",
  tensorflow: "TensorFlow",
  sqlalchemy: "SQLAlchemy",
  celery: "Celery",
  // Build / tooling
  vite: "Vite",
  webpack: "Webpack",
  jest: "Jest",
  vitest: "Vitest",
  pytest: "pytest",
  // Infra / data / protocols
  docker: "Docker",
  kubernetes: "Kubernetes",
  k8s: "Kubernetes",
  terraform: "Terraform",
  packer: "Packer",
  ansible: "Ansible",
  pulumi: "Pulumi",
  helm: "Helm",
  aws: "AWS",
  gcp: "GCP",
  azure: "Azure",
  grpc: "gRPC",
  buf: "Protobuf",
  protobuf: "Protobuf",
  postgresql: "PostgreSQL",
  mongodb: "MongoDB",
  redis: "Redis",
  android: "Android",
  // CI
  "github-actions": "GitHub Actions",
  "gitlab-ci": "GitLab CI",
  circleci: "CircleCI",
  jenkins: "Jenkins",
};

export function stackTagLabel(tag: string): string {
  const key = tag.toLowerCase();
  const known = LABELS[key];
  if (known) return known;
  // Fallback: kebab/underscore → spaced Title Case ("design-system" → "Design System").
  return key
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
