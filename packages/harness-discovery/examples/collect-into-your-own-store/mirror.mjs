// Collects one tool's assets for one repo into a store of your own, keyed by stable id.
import { assetSourcePath, collectCursorRepoAssets, createCollectSession, harnessAssetId, setLogger } from "harness-discovery";

setLogger({ debug() {}, info() {}, warn: (msg, meta) => console.error(msg, meta), error() {} });

const store = new Map();
const session = createCollectSession((asset) => store.set(harnessAssetId(asset), asset));
await collectCursorRepoAssets(session, process.argv[2] ?? ".");

for (const [id, asset] of store) console.log(id.slice(0, 12), asset.scope, asset.type, assetSourcePath(asset));
