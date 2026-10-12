// Fails when a repo holds agent config that is not on its default branch yet.
import { scan } from "harness-discovery";

const { assets, errors } = await scan({ repos: [process.argv[2] ?? "."] });
const local = new Set(assets.filter((a) => a.scope === "repo-local").map((a) => a.sourcePath));
for (const path of local) console.log(`not on the default branch: ${path}`);
console.log(local.size === 0 ? "ok" : `${local.size} file(s) to commit`);
if (local.size > 0 || errors.length > 0) process.exitCode = 1;
