This is the Quick start program from the top-level README. It writes one Claude Code transcript into a throwaway home folder, reads it into a new store with `readAll`, and prints each stored prompt with its email address masked. Start here to see the shape of a stored session.

```sh
node examples/read-one-session/index.mts
```

```text
read 1 session(s), 0 error(s)
claude-code -Users-you-app::demo-1 in /Users/you/app
  user: Why does login.test.ts fail? Mail ████████ if stuck.
  assistant: The mock returns a 500.
```
