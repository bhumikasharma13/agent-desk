import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, readAll } from "local-session-extractor";

// Two Claude Code sessions in a throwaway home, and your server: here a local one that rejects session-b.
const home = mkdtempSync(join(tmpdir(), "lse-sync-"));
const dir = join(home, ".claude", "projects", "-Users-you-app");
mkdirSync(dir, { recursive: true });
for (const id of ["session-a", "session-b"]) {
  const line = { type: "user", uuid: id, timestamp: "2026-04-01T10:00:00.000Z", sessionId: id, cwd: "/Users/you/app", message: { role: "user", content: `Prompt from ${id}` } };
  writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify(line) + "\n");
}
const server = createServer((req, res) => res.writeHead(req.url!.endsWith("session-b") ? 422 : 200).end());
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as { port: number };

const store = openStore(join(home, "sessions.db"));
await readAll(store, { home, sources: ["claude-code"] });
const rows = store.getPendingConversations(100);
store.markSyncing(rows.map((r) => r.id)); // claim before sending, so a changed row is sent again
for (const row of rows) {
  const res = await fetch(`http://127.0.0.1:${port}/sessions/${row.session_id}`, { method: "PUT", body: row.conversation });
  if (res.ok) store.markSynced(row.id);
  else store.markFailed(row.id);
}
for (const r of store.listConversations().sort((a, b) => a.session_id.localeCompare(b.session_id))) console.log(`${r.session_id}: ${r.sync_status}`);
store.resetToPending(store.listConversations({ syncStatus: "failed" }).map((r) => r.id)); // failed stays failed until you retry it
console.log(`queued again: ${store.getPendingConversations(100).length}`);
store.close();
server.close();
rmSync(home, { recursive: true, force: true });
