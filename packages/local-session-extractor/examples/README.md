# Examples

| You want | Example |
|---|---|
| Scan a home folder into the default store and list what it wrote | [read-sessions-into-a-store](read-sessions-into-a-store/) |
| Read one session into a store and print it | [read-one-session](read-one-session/) |
| Send stored sessions to your own server and track which ones arrived | [sync-to-your-server](sync-to-your-server/) |
| Export sessions to a file and mask your own text the same way | [share-sessions-safely](share-sessions-safely/) |
| Send the scan's logs and counters to your logger, and read transcripts from another folder | [wire-a-logger-and-metrics](wire-a-logger-and-metrics/) |
| Report scan progress and keep going when one source cannot be read | [keep-scanning-past-a-broken-source](keep-scanning-past-a-broken-source/) |
| Capture sub-agent runs and add their usage into the session that spawned them | [fold-sub-agents-onto-their-session](fold-sub-agents-onto-their-session/) |
| Scan a home folder and inspect the store from the terminal | [scan-from-the-command-line](scan-from-the-command-line/) |

Run them all with `scripts/run-examples.sh`. It builds the package, runs each example's command from the repo root with an empty home folder, and compares standard output with the example's README. Every example reads only sessions it writes itself or keeps in its `testdata/` folder, and no call leaves the machine.

The runner rewrites each temp directory to `/tmp/example`, a scan's duration to `0.0s`, and store write times to `2026-01-01 00:00:00`.
