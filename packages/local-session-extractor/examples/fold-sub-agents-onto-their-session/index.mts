import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, readAll, type ConversationRow, type SessionMetaPayload } from "local-session-extractor";

// One Claude Code session that delegated twice, plus a sub-agent whose parent transcript is gone.
const home = mkdtempSync(join(tmpdir(), "lse-lineage-"));
const projectDir = join(home, ".claude", "projects", "-Users-you-app");
const writeJsonl = (file: string, records: object[]) => {
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
};
const turn = (sessionId: string, prompt: string, answer: string, outputTokens: number) => [
  { type: "user", uuid: `${sessionId}-u`, timestamp: "2026-04-01T10:00:00.000Z", sessionId, cwd: "/Users/you/app", message: { role: "user", content: prompt } },
  {
    type: "assistant",
    uuid: `${sessionId}-a`,
    timestamp: "2026-04-01T10:00:05.000Z",
    sessionId,
    message: { id: `${sessionId}-m`, role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: answer }], usage: { input_tokens: 100, output_tokens: outputTokens } },
  },
];
/** A sub-agent transcript and its .meta.json, where Claude Code keeps them: <project>/<parent>/subagents/. */
const subagent = (parent: string, agent: string, agentType: string, outputTokens: number) => {
  const dir = join(projectDir, parent, "subagents");
  mkdirSync(dir, { recursive: true });
  writeJsonl(join(dir, `${agent}.jsonl`), turn(parent, `Task for ${agentType}`, "Done.", outputTokens));
  writeFileSync(join(dir, `${agent}.meta.json`), JSON.stringify({ agentType, toolUseId: `toolu-${agent}` }));
};
mkdirSync(projectDir, { recursive: true });
writeJsonl(join(projectDir, "main.jsonl"), turn("main", "Find and review the retry logic.", "Delegating.", 50));
subagent("main", "agent-explore", "Explore", 20);
subagent("main", "agent-review", "feature-dev:code-reviewer", 30);
subagent("gone", "agent-orphan", "Explore", 10);

const lineageOf = (row: ConversationRow) => (JSON.parse(row.session_meta ?? "{}") as SessionMetaPayload).lineage;

const store = openStore(join(home, "sessions.db"));
try {
  // Off by default: sub-agent transcripts are not captured at all.
  await readAll(store, { home, sources: ["claude-code"] });
  console.log(`without captureLineage: ${store.listConversations().length} row(s)`);

  // On: each sub-agent is its own row, tagged with how it relates to its parent.
  await readAll(store, { home, sources: ["claude-code"], captureLineage: true });
  const rows = store.listConversations().sort((a, b) => a.session_id.localeCompare(b.session_id));
  console.log(`with captureLineage: ${rows.length} row(s)`);

  const primaries = rows.filter((r) => lineageOf(r) === undefined);
  for (const parent of primaries) {
    // A child points at its parent by the parent's row id. Fold only STRONG links.
    const children = rows.filter((r) => lineageOf(r)?.parent_record_key === parent.id && lineageOf(r)?.linkage_confidence === "STRONG");
    const childTokens = children.reduce((sum, r) => sum + (lineageOf(r)?.tokens ?? 0), 0);
    console.log(`${parent.session_id}: ${children.length} child run(s), ${childTokens} child token(s)`);
    for (const child of children) {
      const l = lineageOf(child)!;
      console.log(`  ${l.relation_type} ${l.origin_agent_type}${l.plugin_name ? ` (plugin ${l.plugin_name})` : ""}: ${l.tokens} token(s), spawned by ${l.tool_use_id}`);
    }
  }

  // A child whose parent transcript is missing is kept, but marked so it is not attributed.
  for (const row of rows) {
    const l = lineageOf(row);
    if (l && l.linkage_confidence !== "STRONG") console.log(`unlinked: ${row.session_id} (${l.relation_type}, confidence ${l.linkage_confidence})`);
  }
} finally {
  store.close();
  rmSync(home, { recursive: true, force: true });
}
