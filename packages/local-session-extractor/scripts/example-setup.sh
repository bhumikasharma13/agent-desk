# Copyright 2026 The Agent Desk Authors
# SPDX-License-Identifier: MIT
# shellcheck shell=bash
# Sourced by each examples/*/run.sh. It puts the repo's built `local-session-extractor`
# first on PATH, points HOME at an empty directory so nothing of yours is read, and sends
# any proxied request to a closed loopback port.
set -euo pipefail

example_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$example_root/dist/cli.js" ] || (cd "$example_root" && pnpm -s build >/dev/null)

example_work="$(mktemp -d)"
trap 'rm -rf "$example_work"' EXIT
mkdir "$example_work/bin" "$example_work/home"
printf '#!/bin/sh\nexec node "%s/dist/cli.js" "$@"\n' "$example_root" >"$example_work/bin/local-session-extractor"
chmod +x "$example_work/bin/local-session-extractor"

export PATH="$example_work/bin:$PATH"
export HOME="$example_work/home"
unset NO_PROXY no_proxy
export HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9
export NO_PROXY=127.0.0.1,localhost
