import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { exportSessions, openStore, readAll, redactPath, redactText, unredactPath, type SessionIntelligenceConversation } from "local-session-extractor";

// One Claude Code session in a throwaway home, with a password and an email address in its prompt.
const home = mkdtempSync(join(tmpdir(), "lse-share-"));
const dir = join(home, ".claude", "projects", "-Users-you-app");
mkdirSync(dir, { recursive: true });
const prompt = "Connect with postgres://admin:hunter2@db.example.com/shop and tell jane@example.com.";
writeFileSync(join(dir, "s1.jsonl"), JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-04-01T10:00:00.000Z", sessionId: "s1", cwd: "/Users/you/app", message: { role: "user", content: prompt } }) + "\n");

const store = openStore(join(home, "sessions.db"));
await readAll(store, { home, sources: ["claude-code"] });
const file = join(home, "sessions.jsonl");
const { written } = await exportSessions(store, { format: "jsonl", out: file, filter: { ideType: "claude-code" } });
store.close();
const [session] = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as SessionIntelligenceConversation);
console.log(`exported ${written} session(s), file mode ${(statSync(file).mode & 0o777).toString(8)}`);
console.log(`prompt: ${session!.prompts[0]!.content}`);
console.log(`note: ${redactText("Staging login is jane@example.com, password in postgres://ops:s3cret@db.example.net/ops")}`);
const own = `/Users/${userInfo().username}/app/src/cart.ts`;
console.log(`own path hidden: ${redactPath(own) !== own}, restored here: ${unredactPath(redactPath(own)) === own}`);
rmSync(home, { recursive: true, force: true });
