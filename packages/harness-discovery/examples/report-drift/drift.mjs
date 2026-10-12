// Lists committed agent config whose working copy differs from the default branch.
// The scan has no plug-in point: this is a rule of your own, run over its result.
import { scan } from "harness-discovery";

const { assets } = await scan({ repos: [process.argv[2] ?? "."] });
const drifted = new Set();
for (const a of assets) {
  if (a.scope === "repo-committed" && a.contentHash !== a.payload.baseline_content_hash) drifted.add(a.sourcePath);
}
for (const path of drifted) console.log(`edited since the default branch: ${path}`);
console.log(`${drifted.size} drifted`);
