# Copyright 2026 The Agent Desk Authors
# SPDX-License-Identifier: MIT
# shellcheck shell=bash
# Sourced by the hidden first step of demo.tape, from the package folder. It packs the package and
# makes a home folder from the repo's demo home, so the recorded `scan` reads only that. It puts
# two stand-ins first on PATH: an `npx` that runs the README's `npx "$LSE" <command>` from the
# packed .tgz, offline, and passes every other call to the real npx; and a `ps` that lists
# nothing, so no scan can find and call a real Antigravity server.
set -eu
demo_src="$PWD"
demo_work="$(mktemp -d /tmp/lse-demo.XXXX)"
pnpm -s build >/dev/null
# prepack builds first and prints to stdout; pnpm pack prints the tarball's path last.
demo_tarball="$(pnpm pack --pack-destination "$demo_work" | tail -n 1)"
cp -R "$demo_src/examples/scan-from-the-command-line/testdata/home" "$demo_work/you"
export HOME="$demo_work/you"
mkdir "$demo_work/bin"
real_npx="$(command -v npx)"
demo_force=""
[ "$(uname -s)" = Darwin ] || demo_force="--force"
demo_version="$(node -p 'require("./package.json").version')"
demo_url="https://github.com/tetriz-ai/agent-desk/releases/download/local-session-extractor-v$demo_version/local-session-extractor-$demo_version.tgz"
cat >"$demo_work/bin/npx" <<STUB
#!/bin/sh
if [ "\$1" = "$demo_url" ]; then
  shift
  # On Linux, where CI renders the GIF, --force runs past the package's "os": ["darwin"].
  # A bare absolute path would run as a command, so the spec is file:<path>.
  exec env npm_config_cache="$demo_work/npm-cache" npm_config_update_notifier=false npm_config_loglevel=error \\
    "$real_npx" --yes --offline $demo_force "file:$demo_tarball" "\$@"
fi
exec "$real_npx" "\$@"
STUB
printf '#!/bin/sh\nexit 0\n' >"$demo_work/bin/ps"
chmod +x "$demo_work/bin/npx" "$demo_work/bin/ps"
export PATH="$demo_work/bin:$PATH"
cd "$HOME"
set +eu
