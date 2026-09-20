#!/bin/sh
# Fetches the FTUI framework the browser test runs the component in.
#
# The test needs a real FTUI page, not a mock of one: how the component fills
# an <ftui-grid-tile> is decided by FTUI's own CSS. The checkout is not part of
# this repository - it goes to ./.ftui, which git ignores.
set -e

dir="${FTUI_DIR:-$(dirname "$0")/../.ftui}"

if [ -f "$dir/www/ftui/ftui.js" ]; then
  echo "FTUI already in $dir"
  exit 0
fi

git clone --depth 1 https://github.com/knowthelist/ftui "$dir"
echo "FTUI in $dir"
