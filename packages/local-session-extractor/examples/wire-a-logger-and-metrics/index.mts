import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, readAll } from "local-session-extractor";
import { setLogger, setMetricsSink } from "local-session-extractor/host";

// Claude Code transcripts kept outside ~/.claude/projects, one holding a record kind this version does not know.
const root = mkdtempSync(join(tmpdir(), "lse-host-"));
const dir = join(root, "claude-transcripts", "-Users-you-app");
mkdirSync(dir, { recursive: true });
const lines = [
  { type: "user", uuid: "u1", timestamp: "2026-04-01T10:00:00.000Z", sessionId: "s1", cwd: "/Users/you/app", message: { role: "user", content: "hello" } },
  { type: "hologram", uuid: "h1", timestamp: "2026-04-01T10:00:01.000Z", sessionId: "s1" },
];
writeFileSync(join(dir, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

// Process-wide wiring. A scan's own logger and metrics options win over these.
const log = (level: string) => (component: string, event: string) => console.log(`log ${level} ${component} ${event}`);
setLogger({ info: log("info"), warn: log("warn"), error: log("error"), debug: () => {} });
setMetricsSink({ inc: (name, tags, by = 1) => console.log(`metric ${name} ${JSON.stringify(tags)} +${by}`), observe: () => {} });

const store = openStore(join(root, "sessions.db"));
// `home` keeps every other location inside the temp folder; `paths` points one tool elsewhere.
const paths = { CLAUDE_CODE_PROJECTS_PATH: join(root, "claude-transcripts") };
const result = await readAll(store, { home: root, paths, sources: ["claude-code"] });
console.log(`sessions: ${JSON.stringify(result.counts)}, unknown record kinds: ${JSON.stringify(result.unknownRecordKinds)}`);
store.close();
rmSync(root, { recursive: true, force: true });
