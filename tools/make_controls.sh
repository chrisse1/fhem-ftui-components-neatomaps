#!/bin/sh
# Regenerates controls_neatomaps.txt, the index FHEM's update mechanism reads.
#
# One line per file: <CMD> <timestamp> <bytes> <path>. The path is relative to
# the FHEM directory and, because this repository is laid out the same way,
# also relative to the repository root - which is what makes the raw URL of a
# file and its place in an installation line up.
#
#   UPD  install and keep up to date
#   CRE  create once, never overwrite - for the example page, which carries a
#        device name somebody is going to edit
#
# FHEM compares timestamp and size against what it has installed and refuses a
# file whose size does not match to the byte, so this has to be re-run whenever
# one of the files changes. test/controls.test.mjs fails if it was forgotten.
set -e
cd "$(dirname "$0")/.."

out=controls_neatomaps.txt
stamp=$(date -u '+%Y-%m-%d_%H:%M:%S')

# The current time, not the file's mtime: a fresh clone resets those, and the
# timestamp has to move whenever a file changes.
line() {
    printf '%s %s %s %s\n' "$1" "$stamp" "$(wc -c < "$2" | tr -d ' ')" "$2"
}

: > "$out"
for f in www/ftui/components/neato/*; do
    line UPD "$f" >> "$out"
done
line CRE www/ftui/examples/neato-map.html >> "$out"

cat "$out"
