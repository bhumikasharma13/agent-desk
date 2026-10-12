import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, readAll } from "local-session-extractor";

// A throwaway home holding one Claude Code session, so nothing of yours is read.
const home = mkdtempSync(join(tmpdir(), "lse-quickstart-"));
const projectDir = join(home, ".claude", "projects", "-Users-you-app");
mkdirSync(projectDir, { recursive: true });
const transcript = [
  {
    type: "user",
    uuid: "u1",
    timestamp: "2026-04-01T10:00:00.000Z",
    sessionId: "demo-1",
    cwd: "/Users/you/app",
    message: { role: "user", content: "Why does login.test.ts fail? Mail jane@example.com if stuck." },
  },
  {
    type: "assistant",
    uuid: "a1",
    timestamp: "2026-04-01T10:00:05.000Z",
    sessionId: "demo-1",
    message: { id: "m1", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "The mock returns a 500." }] },
  },
];
writeFileSync(join(projectDir, "demo-1.jsonl"), transcript.map((r) => JSON.stringify(r)).join("\n") + "\n");

const store = openStore(join(home, "sessions.db"));
try {
  const result = await readAll(store, { home, sources: ["claude-code"] });
  console.log(`read ${result.counts["claude-code"]} session(s), ${result.errors.length} error(s)`);
  for (const row of store.listConversations()) {
    const prompts = JSON.parse(row.conversation) as Array<{ role: string; content: string }>;
    console.log(`${row.ide_type} ${row.session_id} in ${row.project_path}`);
    for (const p of prompts) console.log(`  ${p.role}: ${p.content}`);
  }
} finally {
  store.close();
  rmSync(home, { recursive: true, force: true });
}
