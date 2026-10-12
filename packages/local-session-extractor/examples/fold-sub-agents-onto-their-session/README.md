This example scans a Claude Code session that handed work to two sub-agents, a built-in `Explore` and a plugin's `feature-dev:code-reviewer`, plus a sub-agent whose parent transcript no longer exists. Without `captureLineage`, a scan stores only the top-level session. With `captureLineage: true`, each sub-agent run is its own row, and its `session_meta.lineage` says whether it is a `SUBAGENT` or a `PLUGIN` run, which row is its parent (`parent_record_key` is the parent's row `id`), how sure that link is, and how many tokens the run used.

Use this shape when a host adds sub-agent usage into the session that spawned it. Fold only `STRONG` links, and keep the others out of any per-session total.

```sh
node examples/fold-sub-agents-onto-their-session/index.mts
```

```text
without captureLineage: 1 row(s)
with captureLineage: 4 row(s)
-Users-you-app::main: 2 child run(s), 250 child token(s)
  SUBAGENT Explore: 120 token(s), spawned by toolu-agent-explore
  PLUGIN feature-dev:code-reviewer (plugin feature-dev): 130 token(s), spawned by toolu-agent-review
unlinked: -Users-you-app::gone::agent-orphan (SUBAGENT, confidence NONE)
```
