#!/usr/bin/env bash
#
# stage-dev.sh [dest]
#
# Stage the script tree into a folder for hand-testing in PixInsight WITHOUT a
# release: the #include paths in SkyIntruders.js are relative, so staging pjsr/
# intact lets you run it straight from Script > Execute Script File.
#
# Default dest is a Windows-accessible dev folder on this WSL host.
#
#   ./scripts/stage-dev.sh
#   -> then in PixInsight: Script > Execute Script File... ->
#      <dest>/SkyIntruders.js
#
# To make it appear in the Scripts menu instead: Script > Feature Scripts... ,
# Add the <dest> directory, and it registers under Batch Processing.
set -euo pipefail

REPO="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
DEST="${1:-$HOME/SkyIntruders-dev}"

rm -rf "$DEST"
mkdir -p "$DEST/lib"
cp "$REPO/pjsr/SkyIntruders.js" "$DEST/"
cp -R "$REPO/pjsr/lib/." "$DEST/lib/"
mkdir -p "$DEST/assets"
cp -R "$REPO"/pjsr/assets/. "$DEST/assets/" 2>/dev/null || true

# The build stamp is only substituted at packaging time; make it readable in dev.
sed -i 's/__BUILD__/dev/g' "$DEST/SkyIntruders.js"

# Report the Windows-style path when staged under /mnt/c.
WINPATH="$DEST"
case "$DEST" in
  /mnt/c/*) WINPATH="C:${DEST#/mnt/c}"; WINPATH="${WINPATH//\//\\}" ;;
esac

echo "Staged to: $DEST"
echo
echo "In PixInsight:  Script > Execute Script File...  ->"
echo "    ${WINPATH}\\SkyIntruders.js"
echo
echo "Or register it in the menu:  Script > Feature Scripts... > Add"
echo "    ${WINPATH}"
