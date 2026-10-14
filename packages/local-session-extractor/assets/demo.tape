# Copyright 2026 The Agent Desk Authors
# SPDX-License-Identifier: MIT
# vhs tape for the demo GIF. Render with `vhs assets/demo.tape` from the package folder.
# It types the README's first Quick start commands verbatim. The hidden setup answers
# `npx` for the release URL with the packed package, offline, since a demo cannot wait for a
# release, and points HOME at a copy of the repo's demo home, so the scan reads only that
# folder, and nothing the tape runs reaches the network or a real home.
Output assets/demo.gif
Set Width 1560
Set Height 740
Set FontSize 15
Set TypingSpeed 40ms
Env PS1 "$ "
Hide
Type "source assets/demo-setup.sh && clear" Enter
Wait+Line@90s /^\$ ?$/
Show
Type@10ms `LSE=https://github.com/tetriz-ai/agent-desk/releases/download/local-session-extractor-v0.1.0/local-session-extractor-0.1.0.tgz` Sleep 300ms Enter
Sleep 500ms
Type `npx "$LSE" capabilities` Sleep 300ms Enter
Wait+Line@60s /^\$ ?$/
Sleep 2s
Type `npx "$LSE" scan` Sleep 300ms Enter
Wait+Line@60s /^\$ ?$/
Sleep 2s
Type `npx "$LSE" list` Sleep 300ms Enter
Wait+Line@60s /^\$ ?$/
Sleep 4s
