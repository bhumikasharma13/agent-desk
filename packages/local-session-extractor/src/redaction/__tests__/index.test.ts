// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { redactErrorMessage, redactText, redactPath, redactPrompts, sanitizeSessionMeta } from "../index";
import { hashUsername, setRunningUsernameForTests } from "../anonymizer";
import type { ConversationPrompt, SessionMetaPayload } from "../../types/session";

describe("redactText", () => {
  it("redacts secrets in text", () => {
    const text = "Use API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
    const result = redactText(text);
    assert.ok(!result.includes("sk-ant"));
  });

  it("anonymizes paths in text", () => {
    const username = userInfo().username as string;
    if (!username) return;

    const text = `cwd: /Users/${username}/projects/foo`;
    const result = redactText(text);
    assert.ok(!result.includes(`/Users/${username}/`));
  });

  it("applies both anonymization and secret redaction", () => {
    const username = userInfo().username as string;
    if (!username) return;

    const text = `File /Users/${username}/app/.env contains SECRET=abc123456789xyz`; // fake credential, test fixture. gitleaks:allow
    const result = redactText(text);
    assert.ok(!result.includes(username));
    assert.ok(!result.includes("abc123456789xyz"));
  });

  // The fixture capture tool (fixtures/extraction/capture-fixture-scrub.mts)
  // scrubs a session by running redactText over the RAW file text, so a home
  // path or secret that appears in a JSON KEY (edit/diff maps keyed by an
  // absolute path) is scrubbed like any value — a parsed-tree scrub that only
  // walked values would leak it. Pin that contract here.
  it("redacts a home path in a JSON key and a secret in a value (capture-scrub contract)", () => {
    const username = userInfo().username as string;
    if (!username) return;

    const jsonl =
      `{"edits":{"/Users/${username}/repo/main.ts":{"added":3}},` +
      `"env":"TOKEN=sk-ant-api03-abcdefghijklmnopqrstuvwxyz"}`;
    const result = redactText(jsonl);
    assert.ok(!result.includes(username), "username in a JSON key must be scrubbed");
    assert.ok(!result.includes("sk-ant"), "secret in a value must be scrubbed");
  });
});

describe("redactPath", () => {
  it("anonymizes home directory paths", () => {
    const username = userInfo().username as string;
    if (!username) return;

    const result = redactPath(`/Users/${username}/dev/myapp`);
    assert.ok(!result.includes(username));
    assert.ok(result.endsWith("/dev/myapp"));
  });

  it("passes non-home paths through", () => {
    assert.equal(redactPath("/tmp/build"), "/tmp/build");
  });
});

describe("redactErrorMessage", () => {
  /** An error shaped like Node's fs errors: the message ends with the quoted path, then dest. */
  const fsError = (message: string, fields: { path: string; dest?: string }): Error => Object.assign(new Error(message), fields);

  it("shows an fs error's path and dest as redacted paths, a token in them masked", () => {
    const restore = setRunningUsernameForTests("jdoe");
    try {
      const path = "/Users/jdoe/src/app";
      const dest = "/Users/jdoe/ghp_0123456789abcdefghij0123456789abcdef"; // fake credential, test fixture. gitleaks:allow
      const err = fsError(`EXDEV: cross-device link not permitted, rename '${path}' -> '${dest}'`, { path, dest });
      const h = hashUsername("jdoe");
      assert.equal(redactErrorMessage(err), `EXDEV: cross-device link not permitted, rename '/Users/${h}/src/app' -> '/Users/${h}/████████'`);
    } finally {
      restore();
    }
  });

  it("redacts the whole message as text when it does not end with the error's path", () => {
    const err = fsError("could not read 'Xk9mP2vL5nQ8wR3tY7' here", { path: "Xk9mP2vL5nQ8wR3tY7" });
    assert.equal(redactErrorMessage(err), redactText(err.message));
    assert.equal(redactErrorMessage("plain 'Xk9mP2vL5nQ8wR3tY7'"), redactText("plain 'Xk9mP2vL5nQ8wR3tY7'"));
  });
});

describe("redactPrompts", () => {
  it("returns a new array (does not mutate input)", () => {
    const prompts: ConversationPrompt[] = [
      { role: "user", content: "hello" },
    ];
    const result = redactPrompts(prompts);
    assert.notEqual(result, prompts);
    assert.equal(result.length, 1);
  });

  it("redacts secrets in prompt content", () => {
    const prompts: ConversationPrompt[] = [
      {
        role: "user",
        content: "My key is ghp_" + "a".repeat(36),
      },
    ];
    const result = redactPrompts(prompts);
    assert.ok(!result[0]!.content.includes("ghp_"));
  });

  it("anonymizes paths in metadata.relevantFiles", () => {
    const username = userInfo().username as string;
    if (!username) return;

    const prompts: ConversationPrompt[] = [
      {
        role: "assistant",
        content: "Here is the file",
        metadata: {
          relevantFiles: [`/Users/${username}/app/src/main.ts`],
        },
      },
    ];
    const result = redactPrompts(prompts);
    const files = result[0]!.metadata!.relevantFiles!;
    assert.equal(files.length, 1);
    assert.ok(!files[0]!.includes(username));
  });

  it("anonymizes paths in metadata.filesEdited", () => {
    const username = userInfo().username as string;
    if (!username) return;

    const prompts: ConversationPrompt[] = [
      {
        role: "assistant",
        content: "Edited the file",
        metadata: {
          // The per-message edited-files field carries absolute paths just as
          // relevantFiles does; both must be anonymized before store.
          filesEdited: [`/Users/${username}/app/src/main.ts`],
        },
      },
    ];
    const result = redactPrompts(prompts);
    const files = result[0]!.metadata!.filesEdited!;
    assert.equal(files.length, 1);
    assert.ok(!files[0]!.includes(username));
  });

  it("anonymizes relevantFiles and filesEdited together", () => {
    const username = userInfo().username as string;
    if (!username) return;

    const prompts: ConversationPrompt[] = [
      {
        role: "assistant",
        content: "Referenced and edited",
        metadata: {
          relevantFiles: [`/Users/${username}/app/a.ts`],
          filesEdited: [`/Users/${username}/app/b.ts`],
        },
      },
    ];
    const result = redactPrompts(prompts);
    assert.ok(!result[0]!.metadata!.relevantFiles![0]!.includes(username));
    assert.ok(!result[0]!.metadata!.filesEdited![0]!.includes(username));
  });

  it("preserves metadata without relevantFiles", () => {
    const prompts: ConversationPrompt[] = [
      {
        role: "assistant",
        content: "done",
        metadata: { model: "claude-3-5-sonnet", inputTokens: 100 },
      },
    ];
    const result = redactPrompts(prompts);
    assert.equal(result[0]!.metadata!.model, "claude-3-5-sonnet");
    assert.equal(result[0]!.metadata!.inputTokens, 100);
  });
});

describe("sanitizeSessionMeta", () => {
  const username = userInfo().username as string;

  it("scrubs secrets from every free-text field", () => {
    const secret = "sk-ant-api03-" + "a".repeat(40);
    const meta: SessionMetaPayload = {
      session_title: `fixing ${secret}`,
      first_prompt: `help with ${secret}`,
      last_prompt: `still ${secret}`,
    };
    const out = sanitizeSessionMeta(meta);
    assert.ok(!out.session_title!.includes("sk-ant"));
    assert.ok(!out.first_prompt!.includes("sk-ant"));
    assert.ok(!out.last_prompt!.includes("sk-ant"));
  });

  // Fail loud rather than green-no-op: a security regression guard whose only
  // assertions sit behind `if (!username) return` would report PASS while checking
  // nothing. userInfo().username is populated in practice (it throws rather than
  // returning empty when there is no passwd entry), so asserting it is safe.
  const HOMES = ["/Users", "/home"]; // anonymizePath handles both macOS and Linux.
  for (const home of HOMES) {
    it(`anonymizes the home segment of every path field under ${home} (username → hash, basename kept)`, () => {
      assert.ok(username, "need an OS username to exercise redactPath");
      const p = (rel: string) => `${home}/${username}/${rel}`;
      const meta: SessionMetaPayload = {
        project_path: p("dev/app"),
        tracked_file_paths: [p("dev/app/src/a.ts")],
        files_edited: [p("dev/app/src/b.go")],
        sandbox_allowed_read_paths: [p("dev/app/read")],
        sandbox_allowed_write_paths: [p("dev/app/write")],
      };
      const out = sanitizeSessionMeta(meta);
      const all = [
        out.project_path!,
        ...out.tracked_file_paths!,
        ...out.files_edited!,
        ...out.sandbox_allowed_read_paths!,
        ...out.sandbox_allowed_write_paths!,
      ];
      for (const path of all) {
        assert.ok(!path.includes(`/${username}/`), `leaked username in ${path}`);
      }
      // The mapping preserves everything past the home segment — the basename +
      // extension a consumer keys languages off, and the prefix it strips.
      assert.ok(out.tracked_file_paths![0]!.endsWith("/dev/app/src/a.ts"));
      assert.ok(out.files_edited![0]!.endsWith("/dev/app/src/b.go"));
    });
  }

  it("leaves a non-string field untouched instead of throwing (untyped vendor/sidecar data)", () => {
    // A field that arrives as a non-string at runtime must not blow up serialization
    // and drop the whole session — it is left as-is (fail-open on shape, not on secrets).
    const meta = {
      first_prompt: 5,
      tracked_file_paths: [123, "/x/y.ts"],
      files_edited: {},
    } as unknown as SessionMetaPayload;
    let out: SessionMetaPayload | undefined;
    assert.doesNotThrow(() => {
      out = sanitizeSessionMeta(meta);
    });
    assert.equal((out as Record<string, unknown>).first_prompt, 5);
    // String elements of a path array are still redacted; the non-string is kept.
    assert.deepEqual(out!.tracked_file_paths, [123 as unknown as string, "/x/y.ts"]);
  });

  it("leaves structured fields untouched", () => {
    const meta: SessionMetaPayload = {
      languages: { TypeScript: 3 },
      git_branches: ["master", "feature/x"],
      mcp_server_names: ["github"],
      compaction_count: 2,
      source: "cli",
    };
    const out = sanitizeSessionMeta(meta);
    assert.deepEqual(out.languages, { TypeScript: 3 });
    assert.deepEqual(out.git_branches, ["master", "feature/x"]);
    assert.deepEqual(out.mcp_server_names, ["github"]);
    assert.equal(out.compaction_count, 2);
    assert.equal(out.source, "cli");
  });

  it("redacts the home paths inside sandbox_policy and keeps its shape", () => {
    assert.ok(username, "need an OS username to exercise sanitizeSessionMeta");
    const policy = {
      type: "managed",
      file_system: {
        entries: [
          { path: { type: "path", path: `/Users/${username}/dev/app` }, access: "write" },
          { path: { type: "special", value: { kind: "root" } }, access: "read" },
        ],
      },
      writable_roots: [`/Users/${username}`],
    };
    const redact = (v: unknown) =>
      sanitizeSessionMeta({ sandbox_policy: v } as unknown as SessionMetaPayload).sandbox_policy as unknown;
    const hashed = `/Users/${hashUsername(username)}`;
    const want = {
      ...policy,
      file_system: {
        entries: [
          { path: { type: "path", path: `${hashed}/dev/app` }, access: "write" },
          policy.file_system.entries[1],
        ],
      },
      writable_roots: [hashed],
    };
    // Codex stores it as JSON text; a sidecar may carry the object itself.
    assert.deepEqual(JSON.parse(redact(JSON.stringify(policy)) as string), want);
    assert.deepEqual(redact(policy), want);
    assert.equal(redact("workspace-write"), "workspace-write");
    assert.equal("sandbox_policy" in sanitizeSessionMeta({ source: "cli" } as unknown as SessionMetaPayload), false, "absent stays absent");
  });

  it("is idempotent and does not mutate its input", () => {
    assert.ok(username, "need an OS username to exercise redactPath");
    const meta: SessionMetaPayload = {
      session_title: `sk-ant-api03-${"a".repeat(40)} at /Users/${username}/x`,
      tracked_file_paths: [`/Users/${username}/dev/a.ts`],
    };
    const once = sanitizeSessionMeta(meta);
    // Confirm the first pass actually redacted — else two passes over unredacted
    // input would be trivially equal and the idempotency check would be vacuous.
    assert.ok(!once.session_title!.includes("sk-ant"));
    assert.ok(!once.tracked_file_paths![0]!.includes(`/${username}/`));
    const twice = sanitizeSessionMeta(once);
    assert.deepEqual(twice, once, "second pass changed an already-redacted blob");
    // Input untouched (choke point returns a fresh object).
    assert.ok(meta.tracked_file_paths![0]!.includes(`/${username}/`));
  });
});
