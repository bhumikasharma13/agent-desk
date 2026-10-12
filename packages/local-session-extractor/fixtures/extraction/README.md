# Cursor extraction test fixtures

## `cursor-cli-latest-root.bin` / `cursor-cli-summarized-*.bin`

Scrubbed live `~/.cursor/chats/**/store.db` protobuf roots used by
`cursorCliConversationOrder.test.ts`. Each file is the original field-1 and
field-13 records (32-byte SHA-256 child / prior-root ids) copied as-is from a
real Cursor CLI root. Field 5 and JSON message blobs are dropped — those carry
prompt text and paths — so the fixtures are safe to commit. `cursor-cli-root-ids.json`
lists the child ids the decoder must recover; tests attach synthetic JSON at
those ids and never load real conversation text. The summarized latest root
points at two field-13 priors (`cursor-cli-summarized-prior.bin` and
`cursor-cli-summarized-other-prior.bin`); both must be present for the walk to
count as complete.

If Cursor changes the on-disk field numbers or id width, these tests fail even
when the in-memory synthetic encoder still agrees with itself.
