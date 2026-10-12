# Examples

| You want | Example |
|---|---|
| The quick look: sessions per tool and per project | [count-sessions-per-tool](count-sessions-per-tool/) |
| Every agent file in a repo, and the agents that load it | [list-agent-files-in-a-repo](list-agent-files-in-a-repo/) |
| What a clone gives everyone, and what only your machine has | [tell-committed-from-local-files](tell-committed-from-local-files/) |
| An agent file the scan could not read, and where the page says so | [see-what-the-scan-skipped](see-what-the-scan-skipped/) |
| One session's conversation, masked, with its tool calls | [read-a-session](read-a-session/) |

Run them all with `scripts/run-examples.sh` after `pnpm build`. Each opens the built app on a throwaway home folder made from its `testdata/home`, with a throwaway profile, and prints what one page shows. The runner rewrites that temp folder to `/tmp/work` before it compares the output, and nothing leaves the machine.
