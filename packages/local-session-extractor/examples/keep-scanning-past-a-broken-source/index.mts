import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnsupportedSourceError, capabilities, openStore, readAll, type IdeType } from "local-session-extractor";

// A throwaway home: one readable Claude Code session and a Codex database that is not SQLite.
const home = mkdtempSync(join(tmpdir(), "lse-partial-"));
const projectDir = join(home, ".claude", "projects", "-Users-you-app");
mkdirSync(projectDir, { recursive: true });
const line = {
  type: "user",
  uuid: "u1",
  timestamp: "2026-04-01T10:00:00.000Z",
  sessionId: "s1",
  cwd: "/Users/you/app",
  message: { role: "user", content: "Add a retry to the HTTP client." },
};
writeFileSync(join(projectDir, "s1.jsonl"), JSON.stringify(line) + "\n");
mkdirSync(join(home, ".codex"));
writeFileSync(join(home, ".codex", "state_5.sqlite"), "this is not a database");

const store = openStore(join(home, "sessions.db"));
try {
  const supported = capabilities().sources;
  console.log(`this build reads: ${supported.join(", ")}`);

  // A source this build lacks is refused before anything runs, so nothing is half-written.
  try {
    await readAll(store, { home, sources: ["claude-code", "windsurf" as IdeType] });
  } catch (err) {
    if (!(err instanceof UnsupportedSourceError)) throw err;
    console.log(`refused before scanning: ${err.source}, stored rows: ${store.listConversations().length}`);
  }

  // Ask only for what the build supports. The broken Codex database fails its own source, not the scan.
  const wanted = (["claude-code", "codex", "windsurf"] as IdeType[]).filter((s) => supported.includes(s));
  const result = await readAll(store, {
    home,
    sources: wanted,
    onProgress: (e) => console.log(e.state === "start" ? `start ${e.source}` : `done  ${e.source}: ${e.count} session(s)`),
  });
  for (const source of wanted) {
    console.log(`${source}: ${result.counts[source]} written, ${result.partial[source] ? "failed as a whole" : "complete"}`);
  }
  for (const e of result.errors) console.log(`error ${e.source} (${e.scope}): ${e.message}`);
  console.log(`stored rows: ${store.listConversations().length}`);
} finally {
  store.close();
  rmSync(home, { recursive: true, force: true });
}
