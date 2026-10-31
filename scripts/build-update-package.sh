#!/usr/bin/env bash
#
# build-update-package.sh <version> [releaseDate YYYYMMDD]
#
# Produces the standardized DISTRIBUTION ARTIFACT that the CaeloWorks showcase site
# (caelo-works/pixinsight-scripts, served at https://pixinsight-scripts.caelo.works/update/)
# ingests to build the shared, signed updates.xri. This repo does NOT generate or host the
# final updates.xri — it only emits, per release, two files under dist/:
#
#   dist/<NAME>-<version>.zip     the package, tree RELATIVE TO PixInsight's install dir
#   dist/update-package.json      metadata the site needs to emit the <package> element
#
# The UNSIGNED zip is REPRODUCIBLE (sorted entries, fixed mtimes/permissions) so identical
# content always yields the same SHA-1 — the site authenticates the package by that SHA-1.
# A release is then signed by scripts/sign-package.sh, which re-zips and rewrites the sha1
# (a signed zip is not reproducible: the signature carries a timestamp).
#
set -euo pipefail

# ----- script identity (bootstrap.sh rewrites these) -------------------------
NAME="SkyIntruders"                          # class-case: entry file, package dir, icon
SLUG="sky-intruders"                         # kebab-case: site slug
TITLE="Sky Intruders"                        # human name
DESCRIPTION_HTML="<p>The hidden life of your astrophotos, in two modes. <b>Night trails</b>: scans your light frames for trails and identifies them &mdash; satellites by TLE cross-match (CelesTrak + SGP4), probable meteors by active-shower radiant alignment, slow movers as asteroid candidates &mdash; then writes a night log with fun stats and a ready-to-post report. <b>Treasure Hunt</b>: on a plate-solved image, finds the galaxies, quasars (with redshift), planetary nebulae and passing asteroids hiding in your field and tells their story, as a star-chart overlay and an illustrated HTML post. All computation runs inside PixInsight.</p>"
PI_VERSION_RANGE="1.9.4:1.9.99"
DOC_PAGES="SkyIntruders SkyIntruders-fr"   # doc/scripts/<page>/<page>.html
# -----------------------------------------------------------------------------

VERSION="${1:?usage: build-update-package.sh <version> [releaseDate YYYYMMDD]}"
RELEASE_DATE="${2:-$(date +%Y%m%d)}"

REPO="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
VENDORDIR="CaeloWorks/$NAME"
ZIPNAME="$NAME-${VERSION}.zip"
OUT="$REPO/dist"
STAGE="$( mktemp -d )"
trap 'rm -rf "$STAGE"' EXIT

DST="$STAGE/src/scripts/$VENDORDIR"
mkdir -p "$DST" "$STAGE/rsc/icons/script/$NAME"
rm -rf "$OUT"; mkdir -p "$OUT"

# 1) entry script — stamp the build
sed -e "s/__BUILD__/${VERSION}/g" "$REPO/pjsr/$NAME.js" > "$DST/$NAME.js"

# 1b) licence text ships next to the entry script (GPL-3.0 — sources carry SPDX headers)
cp "$REPO/LICENSE" "$DST/LICENSE"

# 2) optional lib/ and assets/ (flags etc.)
[ -d "$REPO/pjsr/lib" ] && { mkdir -p "$DST/lib"; cp -R "$REPO"/pjsr/lib/. "$DST/lib/"; }
[ -d "$REPO/pjsr/assets" ] && { mkdir -p "$DST/assets"; cp -R "$REPO"/pjsr/assets/. "$DST/assets/"; }

# 3) menu icon (#feature-icon @script_icons_dir/<NAME>.svg)
cp "$REPO/pjsr/assets/$NAME.svg" "$STAGE/rsc/icons/script/$NAME/$NAME.svg"

# 3b) documentation pages (CPD rule 6.1), compiled from docs/pidoc/ by
#     scripts/build-script-doc.sh and VERSIONED under doc/scripts/: they ship as
#     they are, so this build never needs PixInsight. PixInsight integrates the
#     page named after the #feature-id; the French page sits next to it and both
#     link to each other.
for page in $DOC_PAGES; do
  src="$REPO/doc/scripts/$page/$page.html"
  [ -f "$src" ] || { echo "error: no doc/scripts/$page/$page.html (run scripts/build-script-doc.sh and commit its output)" >&2; exit 1; }
  mkdir -p "$STAGE/doc/scripts/$page"
  cp "$src" "$STAGE/doc/scripts/$page/$page.html"
  if [ -d "$REPO/doc/scripts/$page/images" ]; then
    cp -R "$REPO/doc/scripts/$page/images" "$STAGE/doc/scripts/$page/"
  fi
done

# 3c) No code signature here. A release is signed afterwards, on the zip this
#     script emits, by scripts/sign-package.sh: the version stamp above changes
#     code, so the signature can only be made on the stamped file.

# 4) reproducible zip: sorted entries, fixed mtime (1980-01-01), fixed perms
#    (0644). No OS/timestamp entropy -> stable SHA-1.
python3 "$REPO/scripts/repro-zip.py" "$STAGE" "$OUT/$ZIPNAME"

SHA1=$( sha1sum "$OUT/$ZIPNAME" | cut -d' ' -f1 )

# 5) metadata sidecar — exactly the contract the site ingests
cat > "$OUT/update-package.json" <<JSON
{
  "name": "${TITLE}",
  "slug": "${SLUG}",
  "version": "${VERSION}",
  "fileName": "${ZIPNAME}",
  "sha1": "${SHA1}",
  "type": "script",
  "releaseDate": "${RELEASE_DATE}",
  "piVersionRange": "${PI_VERSION_RANGE}",
  "title": "${TITLE} v${VERSION}",
  "descriptionHtml": "${DESCRIPTION_HTML}"
}
JSON

echo "dist/$ZIPNAME  ($(du -h "$OUT/$ZIPNAME" | cut -f1), sha1 $SHA1)"
echo "dist/update-package.json"
echo "  code signature: none yet - a release is signed with scripts/sign-package.sh"
