#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR source=../../scripts/example-setup.sh
source "$(dirname "$0")/../../scripts/example-setup.sh"

db="$(mktemp -d)/sessions.db"
local-session-extractor scan --home examples/scan-from-the-command-line/testdata/home --db "$db"
local-session-extractor list --db "$db"
local-session-extractor status --db "$db"
