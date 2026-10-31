#!/usr/bin/env bash
#
# sign-package.sh <zip>
#
# Signs a package built by build-update-package.sh with the CaeloWorks identity
# of the Certified PixInsight Developer program (CPD Program Rules, rule 5.1):
# the zip gains SkyIntruders.xsgn and is re-zipped reproducibly, and the
# update-package.json next to it gets the new sha1. The signed zip and sidecar
# are built and checked (check-package.sh --signed, verify-signature.sh) in a
# work directory, and replace the originals only once both checks pass.
#
#   XSSK_PATH=/path/to/caeloworks.xssk scripts/sign-package.sh dist/SkyIntruders-X.Y.Z.zip
#
# The key password is read from stdin: prompted on a terminal, one line when
# piped. It is passed only through the environment of the PixInsight process
# that signs, and never written anywhere.
#
# What gets signed, and why only that:
#   Only the entry script, into SkyIntruders.xsgn. Its signature covers every
#   file it #includes, recursively (PixInsight's CodeSigning documentation,
#   section 6; measured on 1.9.5: a line of code added to an included file
#   turns the entry signature invalid). The lib/ files are not signed: their
#   signatures would never be verified, and the core refuses to sign a file
#   without #feature-id. A comment added to any file does NOT invalidate the
#   signature: the signed code is canonicalized.
#
#   Entitlements: the signature declares none. The pjsr.*/pcl.* entitlements
#   verify-signature.sh prints belong to the CaeloWorks identity
#   (etc/security/certified-developers.xcdev), not to the script.
#
#   The file signed is the one in the zip, after the version stamp: the stamp
#   changes code, so a signature made on pjsr/ in the repository would not hold.
#
# A signed zip is not reproducible: the signature carries a timestamp, so each
# signing gives a new sha1. The sidecar is what carries the right one.
#
# The signing PixInsight must keep "Allow execution of unsigned scripts" ON:
# the PJSR runners this script and verify-signature.sh use are unsigned.
#
set -euo pipefail

ZIP="${1:?usage: sign-package.sh <zip>}"
[ -f "$ZIP" ] || { echo "error: no such file: $ZIP" >&2; exit 1; }
ZIP="$( cd "$( dirname "$ZIP" )" && pwd )/$( basename "$ZIP" )"
SIDECAR="$( dirname "$ZIP" )/update-package.json"
[ -f "$SIDECAR" ] || { echo "error: no update-package.json next to $ZIP" >&2; exit 1; }
: "${XSSK_PATH:?set XSSK_PATH to the CaeloWorks signing keys (.xssk)}"
[ -f "$XSSK_PATH" ] || { echo "error: XSSK_PATH not found: $XSSK_PATH" >&2; exit 1; }

NAME="SkyIntruders"
DEVELOPER="CaeloWorks"
VENDOR="src/scripts/CaeloWorks/$NAME"
REPO="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"

# shellcheck source=scripts/pi-run.sh
. "$REPO/scripts/pi-run.sh"
pi_setup
WORK="$( pi_tmpdir )"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/pkg" "$WORK/out"
( cd "$WORK/pkg" && unzip -q "$ZIP" )
[ -f "$WORK/pkg/$VENDOR/$NAME.js" ] || { echo "error: no $VENDOR/$NAME.js in $ZIP" >&2; exit 1; }
# Re-signing replaces, never stacks: start from no signature at all.
find "$WORK/pkg" -name '*.xsgn' -delete

# The files to sign, relative to the package directory, ';'-separated.
SIGN_LIST="$NAME.js"

if [ -t 0 ]; then
  printf 'PixInsight signing-key password for %s (not stored): ' "$DEVELOPER" >&2
fi
# IFS= keeps leading/trailing spaces: they are part of the password.
IFS= read -r -s __PW || true
[ -t 0 ] && echo >&2
[ -n "$__PW" ] || { echo "error: no password given" >&2; exit 1; }

# The runner signs, then checks each signature back through the core rather than
# trusting that a .xsgn appeared: a wrong password or a foreign key must fail here.
cat > "$WORK/sign.js" <<'PJSR'
var dir    = getEnvironmentVariable( "SISIGN_DIR" ).replace( /\\/g, "/" );
var files  = getEnvironmentVariable( "SISIGN_FILES" ).split( ";" );
var xssk   = getEnvironmentVariable( "SISIGN_XSSK" ).replace( /\\/g, "/" );
var pw     = getEnvironmentVariable( "SISIGN_PW" );
var report = getEnvironmentVariable( "SISIGN_REPORT" ).replace( /\\/g, "/" );
var lines  = [];
for ( var i = 0; i < files.length; ++i )
{
   var js = dir + "/" + files[i];
   var xsgn = js.replace( /\.js$/, ".xsgn" );
   try
   {
      Security.generateScriptSignatureFile( xsgn, js, [], xssk, pw );
      var sig = Security.getScriptSignature( js );
      lines.push( ( sig.valid ? "valid " : "invalid " ) + sig.developerId + " " + files[i] );
   }
   catch ( e )
   {
      lines.push( "error - " + files[i] + " : " + e );
   }
}
lines.push( "done" );
File.writeTextFile( report, lines.join( "\n" ) + "\n" );
PJSR

REPORT="$WORK/report.txt"
SISIGN_DIR="$( pi_native "$WORK/pkg/$VENDOR" )" SISIGN_FILES="$SIGN_LIST" \
SISIGN_XSSK="$( pi_native "$XSSK_PATH" )" SISIGN_PW="$__PW" \
SISIGN_REPORT="$( pi_native "$REPORT" )" \
  pi_run "$WORK/sign.js" SISIGN_DIR SISIGN_FILES SISIGN_XSSK SISIGN_PW SISIGN_REPORT
unset __PW

[ -f "$REPORT" ] || {
  echo "error: PixInsight did not run the signing script" >&2
  echo "       (the runner is an unsigned script: is Preferences > Security >" >&2
  echo "       Allow execution of unsigned scripts turned on for this PixInsight?)" >&2
  exit 1
}
report="$( tr -d '\r' < "$REPORT" )"
sed 's/^/  sign: /' <<<"$report" >&2
fail=0
IFS=';' read -r -a sign_files <<< "$SIGN_LIST"
for f in "${sign_files[@]}"; do
  grep -qxF "valid $DEVELOPER $f" <<<"$report" \
    || { echo "error: $f is not validly signed by $DEVELOPER" >&2; fail=1; }
  [ -f "$WORK/pkg/$VENDOR/${f%.js}.xsgn" ] || { echo "error: no ${f%.js}.xsgn produced" >&2; fail=1; }
done
[ "$fail" = 0 ] || exit 1
rm -f "$WORK/sign.js" "$REPORT"

# Re-zip exactly as the build does, with the sidecar next to it, in the work
# directory: nothing in dist/ changes until both checks below pass.
OUT_ZIP="$WORK/out/$( basename "$ZIP" )"
OUT_SIDECAR="$WORK/out/update-package.json"
python3 "$REPO/scripts/repro-zip.py" "$WORK/pkg" "$OUT_ZIP"
SHA1="$( sha1sum "$OUT_ZIP" | cut -d' ' -f1 )"
python3 - "$SIDECAR" "$OUT_SIDECAR" "$SHA1" <<'PY'
import json, sys
src, dst, sha1 = sys.argv[1], sys.argv[2], sys.argv[3]
with open(src) as f:
    meta = json.load(f)
meta["sha1"] = sha1
with open(dst, "w") as f:
    json.dump(meta, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY

bash "$REPO/scripts/check-package.sh" --signed "$OUT_ZIP" \
  || { echo "error: the signed package fails its contract - $ZIP left unchanged" >&2; exit 1; }
bash "$REPO/scripts/verify-signature.sh" "$OUT_ZIP" \
  || { echo "error: PixInsight does not accept the signature - $ZIP left unchanged" >&2; exit 1; }

# Both checks passed: swap the signed pair into place.
mv "$OUT_ZIP" "$ZIP"
mv "$OUT_SIDECAR" "$SIDECAR"
echo "$( basename "$ZIP" ) signed by $DEVELOPER - sha1 $SHA1 (update-package.json updated)"
