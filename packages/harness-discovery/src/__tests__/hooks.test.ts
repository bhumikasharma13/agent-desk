// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { boundAssetName, hookCommandLabel, hookFileAssetName, hookInlineAssetName } from "../hookAssetName";
import { commandNamesAScript, resolveHookScriptPath, tokenizeCommand } from "../hookResolution";
import { normalizeGitToplevelHookCommand } from "../codex";
import { scan } from "../scan";
import { Fixture, git, sha256, write } from "./fixtures";

let fx: Fixture;
beforeAll(() => {
  fx = new Fixture();
});
afterAll(() => fx.cleanup());
afterEach(() => fx.resetHome());

describe("tokenizeCommand", () => {
  it.each([
    ["bash hooks/x.sh --flag", ["bash", "hooks/x.sh", "--flag"]],
    ['bash "My Scripts/hook.sh"', ["bash", "My Scripts/hook.sh"]],
    ['"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh', ["$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"]],
    ["echo ''", ["echo", ""]],
    ['bash "unterminated x.sh', ["bash", "unterminated", "x.sh"]],
  ])("%s", (cmd, expected) => {
    expect(tokenizeCommand(cmd)).toEqual(expected);
  });
});

describe("hook names", () => {
  it("strips Claude Code's root variables and the .claude/ segment", () => {
    expect(hookCommandLabel('"$CLAUDE_PROJECT_DIR"/.claude/hooks/format.sh')).toBe("hooks/format.sh");
    expect(hookCommandLabel("${CLAUDE_PLUGIN_ROOT}/scripts/run.sh")).toBe("scripts/run.sh");
    expect(hookInlineAssetName("Stop", "  jq . ")).toBe("Stop: jq .");
    expect(hookFileAssetName("Stop", "/a/b/check.sh")).toBe("Stop: check.sh");
  });

  it("bounds a long name at 256 characters with a hash tail, keeping two long names distinct", () => {
    const a = boundAssetName(`Stop: ${"x".repeat(1000)}a`);
    const b = boundAssetName(`Stop: ${"x".repeat(1000)}b`);
    expect(a).toHaveLength(256);
    expect(a).toMatch(/…[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(boundAssetName("short")).toBe("short");
  });

  it("never cuts a surrogate pair in half at the bound", () => {
    const name = boundAssetName(`echo ${"a".repeat(235)}${"😀".repeat(20)}`);
    expect(name.length).toBeLessThanOrEqual(256);
    expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe("resolveHookScriptPath", () => {
  it("resolves a script inside the scope root and refuses one outside it", () => {
    const repo = join(fx.root, "scope");
    write(join(repo, "hooks", "ok.sh"), "#!/bin/sh\n");
    write(join(fx.home, ".ssh", "id_rsa"), "not a key\n");
    expect(resolveHookScriptPath("bash hooks/ok.sh", repo, repo)).toBe(join(repo, "hooks", "ok.sh"));
    expect(resolveHookScriptPath(`bash ${join(fx.home, ".ssh", "id_rsa")}`, repo, repo)).toBeNull();
    expect(resolveHookScriptPath("bash ../outside.sh", repo, repo)).toBeNull();
  });

  it("skips env assignments, flags and interpreters to find the script", () => {
    const repo = join(fx.root, "scope2");
    write(join(repo, "x.py"), "print()\n");
    expect(resolveHookScriptPath("FOO=1 /usr/bin/env python3 -u x.py", repo, repo)).toBe(join(repo, "x.py"));
  });

  it("accepts an in-scope directory whose name starts with two dots", () => {
    const repo = join(fx.root, "scope3");
    write(join(repo, "..tools", "x.sh"), "#!/bin/sh\n");
    expect(resolveHookScriptPath("bash ..tools/x.sh", repo, repo)).toBe(join(repo, "..tools", "x.sh"));
  });

  it("tells a command that names a script from an inline one", () => {
    expect(commandNamesAScript("bash hooks/gone.sh")).toBe(true);
    expect(commandNamesAScript("echo done")).toBe(false);
  });
});

describe("normalizeGitToplevelHookCommand", () => {
  it("rewrites $(git rev-parse --show-toplevel), quoted or bare, and inserts the root verbatim", () => {
    expect(normalizeGitToplevelHookCommand('"$(git rev-parse --show-toplevel)"/.codex/hooks/x.sh arg', "/r o/$1")).toBe('"/r o/$1/.codex/hooks/x.sh" arg');
    expect(normalizeGitToplevelHookCommand("$(git rev-parse --show-toplevel)/x.sh", "/r")).toBe("/r/x.sh");
    expect(normalizeGitToplevelHookCommand("echo hi", "/r")).toBe("echo hi");
  });
});

describe("hooks in a scan", () => {
  it("reports a settings.json command whose script is in the repo as file-backed, and one that is not as inline", async () => {
    const repo = fx.repo("claude-hooks");
    write(join(repo, ".claude", "hooks", "check.sh"), "#!/bin/sh\necho ok\n");
    write(join(repo, ".claude", "settings.json"), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh', timeout: 5 }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
      },
    }));
    fx.commitAll(repo);
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    const hooks = r.assets.filter((a) => a.type === "hook");
    const file = hooks.find((h) => h.payload.hook_command !== undefined)!;
    const inline = hooks.find((h) => h.payload.inline_body !== undefined)!;
    expect(file).toMatchObject({ name: "PreToolUse[Bash]: check.sh", scope: "repo-committed", sourcePath: ".claude/hooks/check.sh" });
    expect(file.payload.hook_config).toEqual({ event: "PreToolUse", matcher: "Bash", timeoutSeconds: 5 });
    expect(inline).toMatchObject({ name: "Stop: echo done", scope: "repo-committed", contentHash: sha256("echo done") });
    expect(inline.sourcePath).toMatch(/^\.claude\/settings\.json#Stop:[0-9a-f]{12}$/);
  });

  it("treats a committed inline command moved to another event locally as repo-local", async () => {
    const repo = fx.repo("moved");
    const settings = (event: string) => JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: "command", command: "echo x" }] }] } });
    write(join(repo, ".claude", "settings.json"), settings("PreToolUse"));
    fx.commitAll(repo);
    write(join(repo, ".claude", "settings.json"), settings("PostToolUse"));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets.find((a) => a.type === "hook")!.scope).toBe("repo-local");
  });

  it("reports a hook whatever directory its command points into", async () => {
    write(join(fx.home, ".claude", "settings.json"), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "~/.tools/hooks/notify.sh" }] }] },
    }));
    const r = await scan({ ides: ["claude-code"] });
    expect(r.assets.map((a) => a.name)).toEqual(["Stop: ~/.tools/hooks/notify.sh"]);
  });

  it("never reads a user hook script outside ~/.claude, even under HOME", async () => {
    write(join(fx.home, "notes.sh"), "#!/bin/sh\n");
    write(join(fx.home, ".claude", "settings.json"), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: `bash ${join(fx.home, "notes.sh")}` }] }] },
    }));
    const r = await scan({ ides: ["claude-code"] });
    expect(r.assets[0]!.payload.inline_body).toBe(`bash ${join(fx.home, "notes.sh")}`);
  });

  it("names a Cursor hook by its wiring and marks committed wiring repo-committed", async () => {
    const repo = fx.repo("cursor-hooks");
    write(join(repo, ".cursor", "hooks", "fmt.sh"), "#!/bin/sh\n");
    write(join(repo, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: ".cursor/hooks/fmt.sh" }, { command: "echo edited" }] } }));
    fx.commitAll(repo);
    const r = await scan({ repos: [repo], ides: ["cursor"] });
    const hooks = r.assets.filter((a) => a.type === "hook").map((h) => [h.name, h.scope, h.sourcePath.replace(/[0-9a-f]{12}$/, "<k>")]);
    expect(hooks).toEqual([
      ["afterFileEdit: fmt.sh", "repo-committed", ".cursor/hooks/fmt.sh"],
      ["afterFileEdit: echo edited", "repo-committed", ".cursor/hooks.json#afterFileEdit:<k>"],
    ]);
  });

  it("resolves a Codex $(git rev-parse --show-toplevel) hook to the script, from the root and from a package subdirectory", async () => {
    const repo = fx.repo("codex-hooks");
    write(join(repo, ".codex", "hooks", "root.sh"), "#!/bin/sh\n");
    write(join(repo, ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: '"$(git rev-parse --show-toplevel)"/.codex/hooks/root.sh' }] }] } }));
    write(join(repo, "pkg", ".codex", "hooks", "check.sh"), "#!/bin/sh\n");
    write(join(repo, "pkg", ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: '"$(git rev-parse --show-toplevel)"/pkg/.codex/hooks/check.sh' }] }] } }));
    fx.commitAll(repo);
    const r = await scan({ repos: [join(repo, "pkg")], ides: ["codex"] });
    const hooks = r.assets.filter((a) => a.type === "hook");
    expect(hooks.map((h) => [h.name, h.scope, h.payload.inline_body === undefined])).toEqual([
      ["Stop: root.sh", "repo-committed", true],
      ["Stop: check.sh", "repo-committed", true],
    ]);
  });

  // One script wired under two matchers on one event is two assets, told apart by the matcher
  // in the name: `event[matcher]: script`; a wiring with no matcher keeps `event: script`.
  // Inline commands are already distinct (their source path carries the matcher).
  const nested = (script: string) => ({
    hooks: {
      PreToolUse: ["Bash", "Edit"].map((matcher) => ({ matcher, hooks: [{ type: "command", command: `bash ${script}` }, { type: "command", command: "echo hi" }] })),
      Stop: [{ hooks: [{ type: "command", command: `bash ${script}` }] }],
    },
  });
  const hookNames = (assets: { type: string; name: string }[]) => assets.filter((a) => a.type === "hook").map((a) => a.name).sort();
  const BOTH_FORMS = ["PreToolUse: echo hi", "PreToolUse: echo hi", "PreToolUse[Bash]: guard.sh", "PreToolUse[Edit]: guard.sh", "Stop: guard.sh"];

  it("names Claude settings hooks with the matcher when there is one", async () => {
    const repo = fx.repo("names-claude");
    write(join(repo, ".claude", "hooks", "guard.sh"), "#!/bin/sh\n");
    write(join(repo, ".claude", "settings.json"), JSON.stringify(nested(".claude/hooks/guard.sh")));
    expect(hookNames((await scan({ repos: [repo], ides: ["claude-code"] })).assets)).toEqual(BOTH_FORMS);
  });

  it("names Claude plugin hooks with the matcher when there is one", async () => {
    const install = join(fx.home, ".claude", "plugins", "cache", "g");
    write(join(install, "hooks", "guard.sh"), "#!/bin/sh\n");
    write(join(install, "hooks", "hooks.json"), JSON.stringify(nested("hooks/guard.sh")));
    write(join(fx.home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "g@m": [{ installPath: install }] } }));
    expect(hookNames((await scan({ ides: ["claude-code"] })).assets)).toEqual(BOTH_FORMS);
  });

  it("names Codex hooks with the matcher when there is one", async () => {
    const repo = fx.repo("names-codex");
    write(join(repo, ".codex", "hooks", "guard.sh"), "#!/bin/sh\n");
    write(join(repo, ".codex", "hooks.json"), JSON.stringify(nested(".codex/hooks/guard.sh")));
    expect(hookNames((await scan({ repos: [repo], ides: ["codex"] })).assets)).toEqual(BOTH_FORMS);
  });

  it("names Cursor hooks with the matcher when there is one", async () => {
    const repo = fx.repo("names-cursor");
    write(join(repo, ".cursor", "hooks", "guard.sh"), "#!/bin/sh\n");
    write(join(repo, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: {
      beforeShellExecution: [
        { command: ".cursor/hooks/guard.sh", matcher: "rm" },
        { command: ".cursor/hooks/guard.sh", matcher: "curl" },
        { command: "echo hi", matcher: "rm" },
        { command: "echo hi", matcher: "curl" },
      ],
      stop: [{ command: ".cursor/hooks/guard.sh" }],
    } }));
    expect(hookNames((await scan({ repos: [repo], ides: ["cursor"] })).assets)).toEqual([
      "beforeShellExecution: echo hi",
      "beforeShellExecution: echo hi",
      "beforeShellExecution[curl]: guard.sh",
      "beforeShellExecution[rm]: guard.sh",
      "stop: guard.sh",
    ]);
  });

  it("keeps a committed Claude hook script repo-local when only settings.local.json wires it", async () => {
    const repo = fx.repo("claude-local-wiring");
    write(join(repo, ".claude", "hooks", "check.sh"), "#!/bin/sh\necho ok\n");
    fx.commitAll(repo);
    write(join(repo, ".claude", "settings.local.json"), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash .claude/hooks/check.sh" }] }] },
    }));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    const hook = r.assets.find((a) => a.type === "hook")!;
    expect([hook.sourcePath, hook.scope, hook.payload.baseline_content_hash]).toEqual([".claude/hooks/check.sh", "repo-local", undefined]);
  });

  it("gives a user hook script a home-relative path when HOME is a symlink", async () => {
    write(join(fx.home, ".claude", "hooks", "h.sh"), "#!/bin/sh\n");
    write(join(fx.home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bash ~/.claude/hooks/h.sh" }] }] } }));
    const link = join(fx.root, "home-link");
    symlinkSync(fx.home, link);
    process.env.HOME = link;
    try {
      const r = await scan({ ides: ["claude-code"] });
      expect(r.assets.map((a) => a.sourcePath)).toEqual([".claude/hooks/h.sh"]);
    } finally {
      process.env.HOME = fx.home;
      rmSync(link);
    }
  });

  it("keeps a committed Cursor script repo-local when only the working copy wires it", async () => {
    const repo = fx.repo("cursor-local-wiring");
    write(join(repo, ".cursor", "hooks", "check.sh"), "#!/bin/sh\n");
    write(join(repo, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: {} }));
    fx.commitAll(repo);
    write(join(repo, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [{ command: ".cursor/hooks/check.sh" }] } }));
    const r = await scan({ repos: [repo], ides: ["cursor"] });
    const hook = r.assets.find((a) => a.type === "hook")!;
    expect([hook.sourcePath, hook.scope, hook.payload.baseline_content_hash]).toEqual([".cursor/hooks/check.sh", "repo-local", undefined]);
  });

  it("keys committed Claude inline hooks on the matcher too", async () => {
    const repo = fx.repo("matcher");
    const settings = (matcher: string) => JSON.stringify({ hooks: { PreToolUse: [{ matcher, hooks: [{ type: "command", command: "echo x" }] }] } });
    write(join(repo, ".claude", "settings.json"), settings("Bash"));
    fx.commitAll(repo);
    write(join(repo, ".claude", "settings.json"), settings("Edit"));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets.find((a) => a.type === "hook")!.scope).toBe("repo-local");
  });

  it("keeps a committed Codex hook that names a missing script repo-local", async () => {
    const repo = fx.repo("codex-missing");
    write(join(repo, ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bash .codex/hooks/gone.sh" }] }] } }));
    fx.commitAll(repo);
    const r = await scan({ repos: [repo], ides: ["codex"] });
    const hook = r.assets.find((a) => a.type === "hook")!;
    expect([hook.payload.inline_body, hook.scope]).toEqual(["bash .codex/hooks/gone.sh", "repo-local"]);
  });

  it("reads a negative or missing hook timeout as 0", async () => {
    write(join(fx.home, ".claude", "settings.json"), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo a", timeout: -5 }, { type: "command", command: "echo b" }] }] },
    }));
    const r = await scan({ ides: ["claude-code"] });
    expect(r.assets.map((a) => a.payload.hook_config?.timeoutSeconds)).toEqual([0, 0]);
  });

  it("gives a plugin's inline hook a home-relative source path", async () => {
    const install = join(fx.home, ".claude", "plugins", "cache", "p");
    write(join(install, "hooks", "hooks.json"), JSON.stringify({ description: "d", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] } }));
    write(join(fx.home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "p@m": [{ installPath: install }] } }));
    const r = await scan({ ides: ["claude-code"] });
    const hook = r.assets.find((a) => a.type === "hook")!;
    expect(hook.sourcePath).toMatch(/^\.claude\/plugins\/cache\/p\/hooks\/hooks\.json#Stop:[0-9a-f]{12}$/);
  });
});

describe("hook identity: arguments, escaped names, bounds", () => {
  const settings = (entries: Array<[string, string, number?]>) => ({
    hooks: { PreToolUse: entries.map(([matcher, command, timeout]) => ({ matcher, hooks: [{ type: "command", command, ...(timeout ? { timeout } : {}) }] })) },
  });
  // A file-backed hook name ends in the first 6 hex of the SHA-256 of the text after the script.
  const argsHash = (text: string) => sha256(text).slice(0, 6);
  const hookNames = (assets: { type: string; name: string }[]) => assets.filter((a) => a.type === "hook").map((a) => a.name).sort();

  it("names one script wired twice under one matcher with different arguments as two assets (Claude settings)", async () => {
    const repo = fx.repo("args-claude");
    write(join(repo, ".claude", "hooks", "g.sh"), "#!/bin/sh\n");
    write(join(repo, ".claude", "settings.json"), JSON.stringify(settings([["Bash", "bash .claude/hooks/g.sh --a", 5], ["Bash", "bash .claude/hooks/g.sh --b", 9]])));
    expect(hookNames((await scan({ repos: [repo], ides: ["claude-code"] })).assets)).toEqual([`PreToolUse[Bash]: g.sh #${argsHash("--a")}`, `PreToolUse[Bash]: g.sh #${argsHash("--b")}`].sort());
  });

  it("names one script wired twice under one matcher with different arguments as two assets (Claude plugin)", async () => {
    const install = join(fx.home, ".claude", "plugins", "cache", "a");
    write(join(install, "hooks", "g.sh"), "#!/bin/sh\n");
    write(join(install, "hooks", "hooks.json"), JSON.stringify(settings([["Bash", "bash hooks/g.sh --a"], ["Bash", "bash hooks/g.sh --b"]])));
    write(join(fx.home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "a@m": [{ installPath: install }] } }));
    expect(hookNames((await scan({ ides: ["claude-code"] })).assets)).toEqual([`PreToolUse[Bash]: g.sh #${argsHash("--a")}`, `PreToolUse[Bash]: g.sh #${argsHash("--b")}`].sort());
  });

  it("names one script wired twice under one matcher with different arguments as two assets (Codex)", async () => {
    const repo = fx.repo("args-codex");
    write(join(repo, ".codex", "hooks", "g.sh"), "#!/bin/sh\n");
    write(join(repo, ".codex", "hooks.json"), JSON.stringify(settings([["Bash", "bash .codex/hooks/g.sh --a"], ["Bash", "bash .codex/hooks/g.sh --b"]])));
    expect(hookNames((await scan({ repos: [repo], ides: ["codex"] })).assets)).toEqual([`PreToolUse[Bash]: g.sh #${argsHash("--a")}`, `PreToolUse[Bash]: g.sh #${argsHash("--b")}`].sort());
  });

  it("names one script wired twice under one matcher with different arguments as two assets (Cursor)", async () => {
    const repo = fx.repo("args-cursor");
    write(join(repo, ".cursor", "hooks", "g.sh"), "#!/bin/sh\n");
    write(join(repo, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { beforeShellExecution: [
      { command: ".cursor/hooks/g.sh --a", matcher: "rm" },
      { command: ".cursor/hooks/g.sh --b", matcher: "rm" },
    ] } }));
    expect(hookNames((await scan({ repos: [repo], ides: ["cursor"] })).assets)).toEqual([`beforeShellExecution[rm]: g.sh #${argsHash("--a")}`, `beforeShellExecution[rm]: g.sh #${argsHash("--b")}`].sort());
  });

  it("warns when it drops a wiring whose config differs from the one it kept", async () => {
    const repo = fx.repo("same-wiring");
    write(join(repo, ".claude", "hooks", "g.sh"), "#!/bin/sh\n");
    write(join(repo, ".claude", "settings.json"), JSON.stringify(settings([["Bash", "bash .claude/hooks/g.sh", 5], ["Bash", "bash .claude/hooks/g.sh", 9]])));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(hookNames(r.assets)).toEqual(["PreToolUse[Bash]: g.sh"]);
    expect(r.warnings).toEqual([{ ide: "claude-code", path: join(repo, ".claude", "hooks", "g.sh"), message: expect.stringMatching(/wired again with a different command or config/) }]);
  });

  it("keeps matchers that differ only in a bidi or control character apart, escaped", async () => {
    const repo = fx.repo("escaped-matchers");
    write(join(repo, ".claude", "hooks", "g.sh"), "#!/bin/sh\n");
    write(join(repo, ".claude", "settings.json"), JSON.stringify(settings([["Bash", "bash .claude/hooks/g.sh"], ["Bash\u202e", "bash .claude/hooks/g.sh"], ["Bash\nEdit", "bash .claude/hooks/g.sh"]])));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(hookNames(r.assets)).toEqual(["PreToolUse[Bash\\u202e]: g.sh", "PreToolUse[Bash\\x0aEdit]: g.sh", "PreToolUse[Bash]: g.sh"]);
    expect(r.assets.map((a) => a.payload.hook_config?.matcher).sort()).toEqual(["Bash", "Bash\nEdit", "Bash\u202e"]);
  });

  it("bounds every asset name at 256 characters, a skill's too", async () => {
    const repo = fx.repo("long-name");
    write(join(repo, ".claude", "skills", "l", "SKILL.md"), `---\nname: ${"n".repeat(1000)}\n---\nBody.\n`);
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets[0]!.name).toHaveLength(256);
    expect(r.assets[0]!.name).toMatch(/…[0-9a-f]{8}$/);
  });

  it("keeps the script in the name when the matcher is very long", async () => {
    const repo = fx.repo("long-matcher");
    write(join(repo, ".claude", "hooks", "g.sh"), "#!/bin/sh\n");
    write(join(repo, ".claude", "settings.json"), JSON.stringify(settings([["A".repeat(301), "bash .claude/hooks/g.sh"]])));
    const name = (await scan({ repos: [repo], ides: ["claude-code"] })).assets[0]!.name;
    expect(name).toMatch(/^PreToolUse\[A+…[0-9a-f]{8}\]: g\.sh$/);
    expect(name.length).toBeLessThanOrEqual(256);
  });

  it("splits a script's basename on / only, as POSIX does", () => {
    expect(hookFileAssetName("Stop", "/r/.claude/hooks/x\\y.sh")).toBe("Stop: x\\y.sh");
  });
});

describe("hook names carry a hash of the arguments as written", () => {
  const settings = (entries: Array<[string, string, number?]>) => ({
    hooks: { PreToolUse: entries.map(([matcher, command, timeout]) => ({ matcher, hooks: [{ type: "command", command, ...(timeout ? { timeout } : {}) }] })) },
  });
  const argsHash = (text: string) => sha256(text).slice(0, 6);
  const hooks = (assets: { type: string; name: string; scope: string }[]) =>
    assets.filter((a) => a.type === "hook").map((a) => `${a.scope} ${a.name}`).sort();

  it("gives two checkouts one Codex asset when the arguments hold $(git rev-parse --show-toplevel)", async () => {
    const cmd = 'bash .codex/hooks/g.sh --root "$(git rev-parse --show-toplevel)"';
    const repos = ["a", "b"].map((n) => {
      const repo = fx.repo(`toplevel-args-${n}`);
      write(join(repo, ".codex", "hooks", "g.sh"), "#!/bin/sh\n");
      write(join(repo, ".codex", "hooks.json"), JSON.stringify(settings([["Bash", cmd]])));
      git(repo, "remote", "add", "origin", "https://example.com/o/r.git");
      fx.commitAll(repo);
      git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      return repo;
    });
    const r = await scan({ repos, ides: ["codex"] });
    expect(hooks(r.assets)).toEqual([`repo-committed PreToolUse[Bash]: g.sh #${argsHash('--root "$(git rev-parse --show-toplevel)"')}`]);
    expect(JSON.stringify(r)).not.toContain(`--root ${repos[0]}`);
  });

  it("keeps quoting: \"a b\" and a b are two assets", async () => {
    const repo = fx.repo("quoted-args");
    write(join(repo, ".claude", "hooks", "g.sh"), "#!/bin/sh\n");
    write(join(repo, ".claude", "settings.json"), JSON.stringify(settings([["Bash", 'bash .claude/hooks/g.sh "a b"'], ["Bash", "bash .claude/hooks/g.sh a b"]])));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(hooks(r.assets)).toEqual([`repo-local PreToolUse[Bash]: g.sh #${argsHash('"a b"')}`, `repo-local PreToolUse[Bash]: g.sh #${argsHash("a b")}`].sort());
    expect(r.warnings).toEqual([]);
  });

  it("puts no argument in a name or the wired-again warning", async () => {
    const repo = fx.repo("secret-args");
    write(join(repo, ".claude", "hooks", "g.sh"), "#!/bin/sh\n");
    write(join(repo, ".claude", "settings.json"), JSON.stringify(settings([["Bash", "bash .claude/hooks/g.sh --token=abc", 5], ["Bash", "bash .claude/hooks/g.sh --token=abc", 9]])));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(hooks(r.assets)).toEqual([`repo-local PreToolUse[Bash]: g.sh #${argsHash("--token=abc")}`]);
    expect(r.warnings).toEqual([{ ide: "claude-code", path: join(repo, ".claude", "hooks", "g.sh"), message: "is wired again with a different command or config; only the first wiring is reported" }]);
    expect(r.assets[0]!.payload.hook_command).toBe("bash .claude/hooks/g.sh --token=abc");
  });

  it("names one asset, with a warning, when only the interpreter differs", async () => {
    const repo = fx.repo("interpreter-only");
    write(join(repo, ".claude", "hooks", "g.sh"), "#!/bin/sh\n");
    write(join(repo, ".claude", "settings.json"), JSON.stringify(settings([["Bash", "sh .claude/hooks/g.sh"], ["Bash", "bash .claude/hooks/g.sh"]])));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(hooks(r.assets)).toEqual(["repo-local PreToolUse[Bash]: g.sh"]);
    expect(r.warnings.map((w) => w.message)).toEqual([expect.stringMatching(/wired again/)]);
  });

  it("bounds a matcher at 80 characters, after escaping it, and keeps the script in the name", async () => {
    const repo = fx.repo("matcher-bound");
    write(join(repo, ".claude", "hooks", "g.sh"), "#!/bin/sh\n");
    write(join(repo, ".claude", "settings.json"), JSON.stringify(settings([["m".repeat(80), "bash .claude/hooks/g.sh"], ["n".repeat(81), "bash .claude/hooks/g.sh"], ["\u0001".repeat(80), "bash .claude/hooks/g.sh"]])));
    const names = (await scan({ repos: [repo], ides: ["claude-code"] })).assets.map((a) => a.name);
    expect(names).toContain(`PreToolUse[${"m".repeat(80)}]: g.sh`);
    expect(names).toContainEqual(expect.stringMatching(new RegExp(`^PreToolUse\\[${"n".repeat(71)}…[0-9a-f]{8}\\]: g\\.sh$`)));
    // 80 escapes are 320 characters: cut at a whole escape, and the script still shows.
    expect(names).toContainEqual(expect.stringMatching(/^PreToolUse\[(?:\\x01){17}…[0-9a-f]{8}\]: g\.sh$/));
  });

  it.each([
    ["\\x01", "\u0001"],
    ["\\u202e", "‮"],
  ])("never cuts a name inside an escape (%s)", async (_label, ch) => {
    const repo = fx.repo(`escape-cut-${ch.charCodeAt(0)}`);
    // "PreToolUse: " is 12 characters, so the escape starts at 245 and the cut is at 247.
    write(join(repo, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `${"E".repeat(233)}${ch}${"z".repeat(40)}` }] }] } }));
    const [asset] = (await scan({ repos: [repo], ides: ["claude-code"] })).assets;
    expect(asset!.name).toMatch(new RegExp(`^PreToolUse: E{233}…[0-9a-f]{8}$`));
  });

  it("escapes lone surrogates, so two matchers that differ only in one are two assets", async () => {
    const repo = fx.repo("lone-surrogates");
    write(join(repo, ".claude", "hooks", "g.sh"), "#!/bin/sh\n");
    write(join(repo, ".claude", "settings.json"), JSON.stringify(settings([["\ud800", "bash .claude/hooks/g.sh"], ["\udc00", "bash .claude/hooks/g.sh"]])));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(hooks(r.assets)).toEqual(["repo-local PreToolUse[\\ud800]: g.sh", "repo-local PreToolUse[\\udc00]: g.sh"]);
    expect(r.warnings).toEqual([]);
  });

  it("keeps a description's tabs and line breaks", async () => {
    const repo = fx.repo("description-lines");
    write(join(repo, ".claude", "skills", "d", "SKILL.md"), "---\nname: d\ndescription: |\n  the first\tline\n  the second line\n---\nBody.\n");
    const [asset] = (await scan({ repos: [repo], ides: ["claude-code"] })).assets;
    expect(asset!.payload.description).toBe("the first\tline\nthe second line");
  });

  it("gives the same wiring in settings.json and settings.local.json two assets, one per scope", async () => {
    const repo = fx.repo("committed-and-local");
    write(join(repo, ".claude", "hooks", "g.sh"), "#!/bin/sh\n");
    write(join(repo, ".claude", "settings.json"), JSON.stringify(settings([["Bash", "bash .claude/hooks/g.sh"]])));
    fx.commitAll(repo);
    write(join(repo, ".claude", "settings.local.json"), JSON.stringify(settings([["Bash", "bash .claude/hooks/g.sh"]])));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(hooks(r.assets)).toEqual(["repo-committed PreToolUse[Bash]: g.sh", "repo-local PreToolUse[Bash]: g.sh"]);
  });
});

describe("hook shapes the re-check pinned", () => {
  it.each([255, 256, 257])("bounds a %i-character name at 256 at most", (n) => {
    const name = boundAssetName("x".repeat(n));
    expect(name.length).toBe(Math.min(n, 256));
    if (n <= 256) expect(name).toBe("x".repeat(n));
    if (n > 256) expect(name).toMatch(/…[0-9a-f]{8}$/);
  });

  it.each([244, 245, 246, 247, 248])("never leaves half a surrogate pair with %i characters before the emoji", (pad) => {
    const name = boundAssetName(`${"a".repeat(pad)}${"😀".repeat(20)}`);
    expect(name.length).toBeLessThanOrEqual(256);
    expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it("escapes a control character in a description that does not come from frontmatter", async () => {
    write(join(fx.home, ".claude", "settings.json"), JSON.stringify({ hooks: { "Stop\u0007": [{ hooks: [{ type: "command", command: "echo x" }] }] } }));
    const r = await scan({ ides: ["claude-code"] });
    expect(r.assets[0]!.payload.description).toBe("Hook for Stop\\x07 event");
  });

  it("keeps matchers `*`, a space, and ones with brackets or a colon apart", async () => {
    const repo = fx.repo("odd-matchers");
    write(join(repo, ".claude", "hooks", "g.sh"), "#!/bin/sh\n");
    const matchers = ["*", " ", "a[b]", "x]: y", ""];
    write(join(repo, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: matchers.map((matcher) => ({ matcher, hooks: [{ type: "command", command: "bash .claude/hooks/g.sh" }] })) } }));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets.map((a) => a.name).sort()).toEqual(["PreToolUse: g.sh", "PreToolUse[ ]: g.sh", "PreToolUse[*]: g.sh", "PreToolUse[a[b]]: g.sh", "PreToolUse[x]: y]: g.sh"]);
  });

  it.each([
    ["Claude Code", ".claude/settings.json", ".claude/hooks/g.sh", "claude-code"],
    ["Codex", ".codex/hooks.json", ".codex/hooks/g.sh", "codex"],
  ] as const)("judges committed-ness per matcher for a file-backed hook (%s)", async (_label, file, script, ide) => {
    const repo = fx.repo(`per-matcher-${ide}`);
    write(join(repo, script), "#!/bin/sh\n");
    const wire = (matchers: string[]) => JSON.stringify({ hooks: { PreToolUse: matchers.map((matcher) => ({ matcher, hooks: [{ type: "command", command: `bash ${script}` }] })) } });
    write(join(repo, file), wire(["Bash"]));
    fx.commitAll(repo);
    write(join(repo, file), wire(["Bash", "Edit"]));
    const r = await scan({ repos: [repo], ides: [ide] });
    expect(r.assets.map((a) => [a.name, a.scope]).sort()).toEqual([["PreToolUse[Bash]: g.sh", "repo-committed"], ["PreToolUse[Edit]: g.sh", "repo-local"]]);
  });

  it("judges committed-ness per matcher for a file-backed Cursor hook", async () => {
    const repo = fx.repo("per-matcher-cursor");
    write(join(repo, ".cursor", "hooks", "g.sh"), "#!/bin/sh\n");
    const wire = (matchers: string[]) => JSON.stringify({ version: 1, hooks: { beforeShellExecution: matchers.map((matcher) => ({ command: ".cursor/hooks/g.sh", matcher })) } });
    write(join(repo, ".cursor", "hooks.json"), wire(["rm"]));
    fx.commitAll(repo);
    write(join(repo, ".cursor", "hooks.json"), wire(["curl"]));
    const r = await scan({ repos: [repo], ides: ["cursor"] });
    expect(r.assets.map((a) => [a.name, a.scope])).toEqual([["beforeShellExecution[curl]: g.sh", "repo-local"]]);
  });
});
