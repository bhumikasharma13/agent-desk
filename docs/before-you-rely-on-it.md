# Before you rely on it

A test traces every file read, write, connection and command the app's Node code makes on a sample home folder, but not Chromium's own native code. Apart from the items below, reads stay in that folder, the app and its data folder, and writes stay in the data folder. Each item a test pins names that test, and [Tests](reference.md#tests) shows how to run them.

## What it reads and sends

**Reads or sends beyond those folders:**

- Reading sessions finds the repository of every folder a session ran in, inside a protected folder too, before you allow it. It looks for `.git` and `.git/config` and runs git there with that repository's own settings, its fsmonitor turned off and its index left alone. A filter driver the repository names still runs. Pinned by `acceptance.test.mjs` ("containment"), `extractionWorker.test.ts` and the session library's `gitRepoControl.test.ts`.
- The scan of your home folder follows symlinks in `~/.claude` and the other agents' home folders, into a protected folder too, before you allow it. The file viewer still refuses to open those files until you allow the folder. The refusal is pinned by `assetContent.test.ts` and `launch.test.ts`.
- The protected-folder skip covers a path spelled inside a protected folder and one that reaches it through symlinks, as `stackDetectorProtected.test.ts` pins. Some unusual paths still reach one, and macOS then asks before anything there is read. They are a home folder that is itself a symlink, a protected folder that is itself a symlink, and a `/System/Volumes/Data/...` path.
- The app reads about every five minutes, and each read runs `ps -ax -o pid=,command=`, which lists every running process with its command line, to find a running Antigravity. If one runs, the read sends it HTTPS requests on 127.0.0.1, with certificate checks off, carrying Antigravity's own CSRF token. Pinned by `acceptance.test.mjs` ("offline" and "only git and ps are started").
- Each read opens four login files for account details, and keeps no token from any of them. Pinned by `acceptance.test.mjs` ("first launch") and local-session-extractor's `credentialFiles.test.ts`.
  - Claude Code's `~/.claude.json`, its `oauthAccount` part only: the email, the account and organization ids, the seat tier, the organization type and role, the billing type, the rate-limit tiers, the subscription start and the extra-usage flag.
  - Codex's `auth.json` and Kiro's login database: the login email and plan.
  - Cursor's `~/.cursor/cli-config.json`: the login email.
- `sessions.db` keeps those details unmasked, with the device and account ids the tools record in their own logs and caches. It masks secrets, email addresses and your user name in the session text.
- `sessions.db` also keeps branch names and Claude Code session ids as written, your user name included. local-session-extractor's [Redaction](../packages/local-session-extractor/docs/limits.md#redaction) list names the tests that pin both.

**Reads less than it could:**

- A project in a protected folder you have not allowed gets no stack tags and no agent files, and neither does a subfolder in one or a project reached through a symlink into one. Its sessions still count. Pinned by `stackDetectorProtected.test.ts` and `extractionWorker.test.ts`.
- A session that ran in your home folder, or in a folder that holds it such as `/`, gets no stack tags and no repo agent files, since that would walk every folder below. The agent files in your home folder still show, as `User`. Pinned by `stackDetectorProtected.test.ts` and `extractionWorker.test.ts`.
- A manifest or other stack file that is a symlink counts as absent for stack tags. Pinned by `stackDetectorProtected.test.ts`.

## What it shows

**Shows more than it should:**

- A conversation on the Projects page shows what masking missed. Masking misses a secret written as a plain word in a shape no pattern knows, a token used as the user name in a URL on a dotless host, and another person's name inside a path. local-session-extractor's [Redaction](../packages/local-session-extractor/docs/limits.md#redaction) list names each case and the test that pins it.

**Shows less than is there:**

- A tool whose session files cannot be read shows as a problem, and the other tools still count. Pinned by `extractionWorker.test.ts`.
- Changes made between reads show at the next read, about five minutes after the last read finished, or at once with Refresh on the Harness page. Pinned by `extractionSchedulerWorker.test.ts` and `acceptance.test.mjs`.

**Shows more than is there:** None known.
