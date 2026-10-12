import { openStore, readAll } from "local-session-extractor";

// Opens ~/.local-session-extractor/sessions.db, creating it on first use.
const store = openStore();
// Reads every tool's sessions under your home, or under a copied home folder you pass.
const home = process.argv[2];
const result = await readAll(store, home === undefined ? {} : { home });
console.log(`written: ${JSON.stringify(result.counts)}`);
const failed = Object.entries(result.partial).filter(([, partial]) => partial).map(([source]) => source);
console.log(`errors: ${result.errors.length}, failed as a whole: ${failed.join(", ") || "none"}`);
for (const row of store.listConversations({ limit: 5 })) console.log(`${row.ide_type} ${row.session_id}`);
store.close();
