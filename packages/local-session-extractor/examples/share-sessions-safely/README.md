This example exports stored sessions to a JSON-lines file with `exportSessions`, one Session Intelligence Conversation per line, then masks a note of your own with `redactText` so it can travel with the export. The file is written at mode 0600, and every session is redacted again on the way out. The last line shows `redactPath` hiding your user name and `unredactPath` restoring it on this machine only.

Use it before you hand an export to someone else, and read "Before you rely on it" in the top-level README first.

```sh
node examples/share-sessions-safely/index.mts
```

```text
exported 1 session(s), file mode 600
prompt: Connect with ████████ and tell ████████.
note: Staging login is ████████, password in ████████
own path hidden: true, restored here: true
```
