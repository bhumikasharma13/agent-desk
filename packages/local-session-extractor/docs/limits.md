# Before you rely on it

What to know before you run local-session-extractor on sessions that matter. The [README](https://github.com/tetriz-ai/agent-desk/blob/main/packages/local-session-extractor/README.md) shows how to install and use it.

Each item below is pinned by the named test.

## Redaction

- **Passes through unmasked (can leak).**
  - An export carries the installation metadata as stored (`installationMetadata`, or `installation_metadata` in a row export), with each tool's login email, account ids and device ids. This is by design, so treat an export as personal data before you share it. Pinned by `src/store/__tests__/outboxContract.test.ts` ("is exported as stored").
  - A secret in a shape no pattern knows, written as a plain word, stays in the text. Pinned by `src/redaction/__tests__/limits.test.ts`.
  - Another person's name inside a path is kept unless it is your user name or the owner of a scanned home. Pinned by `src/redaction/__tests__/anonymizer.test.ts` ("does not anonymize other users' paths").
  - A token used as the user name with no `:`, as in `https://<token>@host`, is masked only when it reads as an email address, so on a dotless host it stays. Pinned by `src/redaction/__tests__/secretShapes.test.ts` ("masks a colon-less token user only when it reads as an email address").
  - The store keeps branch names as the readers wrote them, even one holding your user name. An export redacts every string but the installation metadata, so a user name inside a branch, model or agent name is hashed there. Pinned by `src/redaction/__tests__/limits.test.ts` ("keeps branch names in the stored row") and `src/__tests__/exportFullRedaction.test.ts` ("hashes the running user's name in a branch name").
  - The store keeps Claude Code session ids raw, such as `-Users-alice-app::<id>`, and records scanned home owners' names, so a copied `.db` file carries them. Only `export`, `list` and `show` hash them. Pinned by `src/__tests__/contractPins.test.ts` ("the store at rest").
- **Masks more than it should (harmless).**
  - A quoted string that looks random, such as an id, is masked as a secret. Pinned by `src/redaction/__tests__/secrets.test.ts` ("redacts high-entropy quoted strings").
  - A quoted home path can be masked whole once the name in it is hashed. Pinned by `src/redaction/__tests__/limits.test.ts` ("can mask a quoted home path whole").
- **Restores less than it hid.** `unredactPath`, the SDK function that puts your home path back into a redacted path, restores a dash-encoded home only in Claude Code's encoding, where every character other than a letter or digit is a dash. Pinned by `src/redaction/__tests__/limits.test.ts` ("restores a dash-encoded home").

## What a scan starts and reads

- **Starts `ps` and calls a local server.** A scan without `home` runs `ps` once to find a running Antigravity server, then sends HTTPS requests to it on 127.0.0.1 and nowhere else. With `home`, it runs no `ps` and makes no request. Pinned by `src/__tests__/networkDisclosure.test.ts`.
- **Runs git in your projects.** A scan without `home` runs git in every project folder a session names, and that git reads the repository's own settings. It ignores the `GIT_*` variables in your environment except `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and `GIT_CONFIG_NOSYSTEM`, which only choose the config files it reads. It does not rewrite the index, and runs no fsmonitor, `post-index-change` hook, external diff, textconv or `log.showSignature` signature check. It still runs a filter driver the repository's `.gitattributes` names (`filter.<name>.clean` or `.process`) when it diffs a changed file. Scan only projects you trust, or pass `home`, which runs no git. Pinned by `src/extractors/__tests__/gitRepoControl.test.ts`, and the `home` case by `src/__tests__/readAll.test.ts` ("spawns no git process in a scanned repository").
- **Reads login files.** A scan reads four login files for account details, and keeps no token from any of them. Pinned by `src/__tests__/credentialFiles.test.ts` for the first two.
  - Claude Code's `~/.claude.json`, its `oauthAccount` part only: the email, the account and organization ids, the seat tier, the organization type and role, the billing type, the rate-limit tiers, the subscription start and the extra-usage flag.
  - Codex's `auth.json`: the login email and plan.
  - Kiro's login database: the login email and plan.
  - Cursor's CLI config, `~/.cursor/cli-config.json`: the login email.
- **Hands a Cursor token to your code only if you ask.** With `cursor.lookup` set, a scan reads the Cursor access token from Cursor's local database and passes it to your callback. Without it, no callback runs and nothing is fetched. Pinned by `src/__tests__/readAll.test.ts` ("the Cursor seat-tier gate").

## Coverage

- **Misses.** Vendors change their file formats without notice. A record kind the reader does not know is counted in `unknownRecordKinds`, not read. Pinned by `src/__tests__/readAll.test.ts` ("counts unrecognized record kinds").
  - Codex 0.118 and later record a command's result in a form the reader does not take counts from. For those sessions, the files read, failed commands, and the commits, pushes and pull requests that the reader would otherwise count from command output are missing. Their prompts, replies and tool timeline are read.
- **Reads too much.** None known.
