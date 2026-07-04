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
# The zip is REPRODUCIBLE (sorted entries, fixed mtimes/permissions) so identical content
# always yields the same SHA-1 — the site authenticates the package by that SHA-1.
#
set -euo pipefail

# ----- script identity (bootstrap.sh rewrites these) -------------------------
NAME="SkyIntruders"                          # class-case: entry file, package dir, icon
SLUG="sky-intruders"                         # kebab-case: site slug
TITLE="Sky Intruders"                        # human name
DESCRIPTION_HTML="<p>Who crossed your photo last night? Sky Intruders scans your light frames for trails and identifies them: satellites by TLE cross-match (CelesTrak + SGP4), probable meteors by active-shower radiant alignment, plus slow movers as asteroid candidates. Renders a chronological night log with fun stats, persistent personal records and a Reddit-ready post.</p>"
PI_VERSION_RANGE="1.9.4:1.9.99"
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

# 2) optional lib/ and bin/ (per-OS helper binaries, kept 0755 by the zip step)
[ -d "$REPO/pjsr/lib" ] && { mkdir -p "$DST/lib"; cp -R "$REPO"/pjsr/lib/. "$DST/lib/"; }
[ -d "$REPO/bin" ]      && { mkdir -p "$DST/bin"; cp "$REPO"/bin/*        "$DST/bin/"; }

# 3) menu icon (#feature-icon @script_icons_dir/<NAME>.svg)
cp "$REPO/pjsr/assets/$NAME.svg" "$STAGE/rsc/icons/script/$NAME/$NAME.svg"

# 3b) OPTIONAL code signature — DISABLED by default. Enabled only when XSSK_PATH points
#     to the CaeloWorks signing keys (.xssk) and PI_EXE to a PixInsight executable.
#     Signs ONLY the entry script into <NAME>.xsgn. Entitlements [].
#     PASSWORD RULE: prompted at runtime (read -s), passed only through the signing
#     process's transient environment, NEVER written anywhere.
#     Leave OFF until the CaeloWorks CPD identity is distributed by Pleiades: an
#     unverifiable signature is WORSE than none.
SIGNED=0
if [ -n "${XSSK_PATH:-}" ]; then
  [ -f "$XSSK_PATH" ] || { echo "error: XSSK_PATH not found: $XSSK_PATH" >&2; exit 1; }
  : "${PI_EXE:?set PI_EXE to your PixInsight executable to code-sign}"
  printf 'PixInsight signing-key password (not stored): ' >&2
  read -r -s __PW; echo >&2
  SIGN_TMP="$( mktemp -d )"; SIGN_JS="$SIGN_TMP/sign.js"
  cat > "$SIGN_JS" <<'PJSR'
var xsgn = getEnvironmentVariable( "SIGN_XSGN" );
var js   = getEnvironmentVariable( "SIGN_JS" );
var xssk = getEnvironmentVariable( "SIGN_XSSK" );
var pw   = getEnvironmentVariable( "SIGN_PW" );
Security.generateScriptSignatureFile( xsgn, js, [], xssk, pw );
PJSR
  rm -f "$DST/$NAME.xsgn"
  SIGN_XSGN="$DST/$NAME.xsgn" SIGN_JS="$DST/$NAME.js" SIGN_XSSK="$XSSK_PATH" SIGN_PW="$__PW" \
    "$PI_EXE" -n --automation-mode --force-exit -r="$SIGN_JS" || true
  unset __PW
  rm -rf "$SIGN_TMP"
  [ -f "$DST/$NAME.xsgn" ] || { echo "error: no .xsgn produced" >&2; exit 1; }
  SIGNED=1
fi

# 4) reproducible zip: sorted entries, fixed mtime (1980-01-01), fixed perms
#    (0755 for bin/, 0644 otherwise). No OS/timestamp entropy -> stable SHA-1.
python3 - "$STAGE" "$OUT/$ZIPNAME" <<'PY'
import os, sys, zipfile
stage, out = sys.argv[1], sys.argv[2]
files = []
for root, _, names in os.walk(stage):
    for n in names:
        full = os.path.join(root, n)
        arc = os.path.relpath(full, stage).replace(os.sep, "/")
        files.append((arc, full))
files.sort(key=lambda x: x[0])
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for arc, full in files:
        zi = zipfile.ZipInfo(arc, date_time=(1980, 1, 1, 0, 0, 0))
        perm = 0o755 if "/bin/" in ("/" + arc) else 0o644
        zi.external_attr = (perm & 0xFFFF) << 16
        zi.compress_type = zipfile.ZIP_DEFLATED
        with open(full, "rb") as f:
            z.writestr(zi, f.read())
PY

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
if [ "$SIGNED" = 1 ]; then
  echo "  code signature: $NAME.xsgn INCLUDED (signed; zip not reproducible — sha1 is per-signing)"
else
  echo "  code signature: package NOT SIGNED (CPD identity pending validation)"
fi
