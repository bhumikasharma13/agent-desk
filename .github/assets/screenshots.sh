#!/bin/sh
# Copyright 2026 The Agent Desk Authors
# SPDX-License-Identifier: MIT

# Renders the README screenshots, projects.png, sessions.png, conversation.png and harness.png, from the sample home in
# .github/assets/testdata/home, through the same setup the examples use. Run `pnpm build` first.
EXAMPLE=$(cd "$(dirname "$0")" && pwd)
. "$(dirname "$0")/../../scripts/example-setup.sh"
node .github/assets/screenshots.mjs "$EXAMPLE"
