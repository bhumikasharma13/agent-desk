# Get insights with Session Intelligence

The workflow is **browse → extract → analyze → improve**. [Session Intelligence](https://github.com/tetriz-ai/session-intelligence) analyzes a transcript to help you understand prompt clarity and context, exchanges that needed corrections, what went well, whether the goal was achieved, and where time or tokens were wasted. It also flags detected secrets and personal data.

Agent Desk collects and displays your sessions. Analysis runs separately in Session Intelligence; its results are not displayed inside Agent Desk.

1. **Find a session in the app.** Choose Projects → a project → a session to review the conversation you want to analyze.
2. **Extract it with the companion CLI.** After [building from source](../README.md#build-from-source), run these commands from this repo with Node 24 or newer:

   ```sh
   node packages/local-session-extractor/dist/cli.js scan
   node packages/local-session-extractor/dist/cli.js list
   ```

   The CLI uses its own store at `~/.local-session-extractor/sessions.db`, so this scans the same local sources independently of the app. Pick the source and session ID from `list`; the app does not show session IDs. For a Codex session, replace `YOUR_SESSION_ID` below:

   ```sh
   node packages/local-session-extractor/dist/cli.js show codex -- YOUR_SESSION_ID > session.json
   ```

   For Claude Code use `show claude-code -- YOUR_SESSION_ID`. Other source names are `cursor`, `copilot`, `kiro` and `antigravity`. The current CLI writes Session Intelligence's `Conversation` JSON by default, ready for analysis. `--raw` writes a store row and needs conversion. See the [extractor quick start](../packages/local-session-extractor/README.md#quick-start).

3. **Analyze and review.** Follow [Session Intelligence's setup](https://github.com/tetriz-ai/session-intelligence#quick-start) to start its reference LLM service with your own key, then run this from a clone of that repo:

   ```sh
   go run ./cmd/analyze-real --url http://localhost:8000 /absolute/path/to/session.json > analysis.json
   ```

   Use its [results guide](https://github.com/tetriz-ai/session-intelligence#understand-your-results) to choose a concrete improvement for your next session: supply missing context, clarify acceptance criteria, or split work that repeatedly stalled.

Agent Desk's browsing stays local. Analysis sends the transcript to the model provider you configure and can incur usage charges. Exports still contain login email and account/device metadata in `installationMetadata`, and masking can miss secrets; review the file before sending or sharing it. Analysis scores are model judgments, and usage metrics depend on what the source recorded. Session Intelligence also offers an [offline sample](https://github.com/tetriz-ai/session-intelligence#no-key-yet-try-it-offline) without a key or Docker.
