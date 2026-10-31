#!/usr/bin/env bash
#
# verify-signature.sh <zip>
#
# Asks PixInsight whether the package's code signature is valid, on the files
# exactly as the zip carries them. Needs PixInsight (PI_EXE, or the standard
# Windows install when run from WSL) but neither the keys nor their password:
# verification uses the public key PixInsight distributes for every certified
# developer.
#
# check-package.sh --signed checks the shape; this checks the cryptography. A
# release passes both before it is published.
#
# The entitlements it prints are the developer identity's, as listed in
# PixInsight's etc/security/certified-developers.xcdev, not something the
# signature declares: ours declares none (see sign-package.sh).
#
set -euo pipefail

ZIP="${1:?usage: verify-signature.sh <zip>}"
[ -f "$ZIP" ] || { echo "error: no such file: $ZIP" >&2; exit 1; }
ZIP="$( cd "$( dirname "$ZIP" )" && pwd )/$( basename "$ZIP" )"
NAME="SkyIntruders"
DEVELOPER="CaeloWorks"
REPO="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"

# shellcheck source=scripts/pi-run.sh
. "$REPO/scripts/pi-run.sh"
pi_setup
WORK="$( pi_tmpdir )"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/pkg"
( cd "$WORK/pkg" && unzip -q "$ZIP" )
ENTRY="$WORK/pkg/src/scripts/CaeloWorks/$NAME/$NAME.js"
[ -f "$ENTRY" ] || { echo "error: no entry script in $ZIP" >&2; exit 1; }

cat > "$WORK/verify.js" <<'PJSR'
var js     = getEnvironmentVariable( "SIVERIFY_JS" ).replace( /\\/g, "/" );
var report = getEnvironmentVariable( "SIVERIFY_REPORT" ).replace( /\\/g, "/" );
var line;
try
{
   var sig = Security.getScriptSignature( js );
   line = ( sig.valid ? "valid" : "invalid" ) + " " + sig.developerId + " " + sig.scriptId
        + " " + sig.timestamp + " identity entitlements [" + sig.entitlements + "]";
}
catch ( e )
{
   line = "error " + e;
}
File.writeTextFile( report, line + "\n" );
PJSR

REPORT="$WORK/report.txt"
SIVERIFY_JS="$( pi_native "$ENTRY" )" SIVERIFY_REPORT="$( pi_native "$REPORT" )" \
  pi_run "$WORK/verify.js" SIVERIFY_JS SIVERIFY_REPORT

[ -f "$REPORT" ] || {
  echo "error: PixInsight did not run the verification script" >&2
  echo "       (the runner is an unsigned script: is Preferences > Security >" >&2
  echo "       Allow execution of unsigned scripts turned on for this PixInsight?)" >&2
  exit 1
}
verdict="$( tr -d '\r' < "$REPORT" )"
echo "Code signature: $( basename "$ZIP" )"
echo "  $verdict"
case "$verdict" in
  "valid $DEVELOPER $NAME "*) echo "PASS"; exit 0 ;;
  *) echo "FAILED: expected a valid $DEVELOPER signature of $NAME"; exit 1 ;;
esac
