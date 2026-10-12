# Examples

| You want | Example |
|---|---|
| The quick start: scan one repo from the command line | [scan-a-repo](scan-a-repo/) |
| A CI step that fails on agent config not committed yet | [fail-ci-on-local-config](fail-ci-on-local-config/) |
| Your own rule over the result: committed config edited locally | [report-drift](report-drift/) |
| One tool's assets for one repo, in a store of your own | [collect-into-your-own-store](collect-into-your-own-store/) |
| A home directory and a repo together, with a symlink the scan will not follow | [inventory-home-and-repo](inventory-home-and-repo/) |

Run them all with `scripts/run-examples.sh` after `pnpm build`. Each runs against a throwaway home directory and repos it creates in a temp directory, and nothing leaves the machine. The runner rewrites that temp directory to `/tmp/work` before it compares the output.
