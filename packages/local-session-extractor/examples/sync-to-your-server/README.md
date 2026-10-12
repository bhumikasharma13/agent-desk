This example sends stored sessions to a server and records the result on each row, using the store's outbox methods: `getPendingConversations`, `markSyncing`, `markSynced`, `markFailed` and `resetToPending`. The server is a local one the example starts on 127.0.0.1, which accepts one session and rejects the other, so no call leaves the machine. Use this shape when a host copies sessions somewhere else and must not send a row twice.

```sh
node examples/sync-to-your-server/index.mts
```

```text
-Users-you-app::session-a: synced
-Users-you-app::session-b: failed
queued again: 1
```
