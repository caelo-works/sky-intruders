#!/usr/bin/env bash
#
# check-package.sh [--signed] <zip>
#
#   --signed   the package is a release: it must carry the CaeloWorks code
#              signature. Without it the package is checked as a development
#              build (CI has neither PixInsight nor the keys, so cannot sign).
#
# Verifies a built package against the contract the CaeloWorks update site
# enforces on ingest (scripts/build-update-repo.sh in caelo-works/pixinsight-scripts),
# plus the things only this repo can know. Catching a violation here costs a red
# CI run; catching it there costs a published release that has to be pulled.
#
# When an update-package.json sits next to the zip, its fileName and sha1 must
# describe that zip.
#
set -euo pipefail

SIGNED=0
if [ "${1:-}" = "--signed" ]; then SIGNED=1; shift; fi
ZIP="${1:?usage: check-package.sh [--signed] <zip>}"
NAME="SkyIntruders"
VENDOR="src/scripts/CaeloWorks/$NAME"
DOC_PAGES="SkyIntruders SkyIntruders-fr"
REPO="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"

fail=0
note() { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fail=1; }

# Capture every listing and file before grepping it: under pipefail, `unzip | grep
# -q` fails at random (grep exits on the first match, unzip dies of SIGPIPE).
tree="$( unzip -Z1 "$ZIP" )"
has() { grep -qxF "$1" <<<"$tree"; }

echo "Package contract: $(basename "$ZIP")"

# The site refuses a package whose tree does not extract relative to the
# PixInsight install directory.
if grep -q '^src/' <<<"$tree"; then
   note "extracts relative to the PixInsight install directory"
else
   bad "no src/... tree: the site's ingest would reject this"
fi

# Code signature (CPD Program Rules, rule 5.1). Exactly one, for the entry
# script: its signature covers every file the entry #includes, and a signature
# on any other file is never verified. Validity can only be checked by
# PixInsight itself (verify-signature.sh); this checks the shape and the
# identity the signature claims.
sigs="$( grep -i '\.xsgn$' <<<"$tree" || true )"
if [ -z "$sigs" ]; then
   if [ "$SIGNED" -eq 1 ]; then
      bad "no code signature: a release must ship $VENDOR/$NAME.xsgn"
   else
      note "unsigned: a development build, not a release"
   fi
elif [ "$sigs" != "$VENDOR/$NAME.xsgn" ]; then
   bad "the only signature must be $VENDOR/$NAME.xsgn, found:"
   printf '%s\n' "$sigs" | sed 's/^/          /'
else
   xsgn="$( unzip -p "$ZIP" "$VENDOR/$NAME.xsgn" )"
   if grep -q "<Signature [^>]*scriptId=\"$NAME\"[^>]*developerId=\"CaeloWorks\"" <<<"$xsgn" \
      || grep -q "<Signature [^>]*developerId=\"CaeloWorks\"[^>]*scriptId=\"$NAME\"" <<<"$xsgn"; then
      note "signed by CaeloWorks ($NAME.xsgn)"
   else
      bad "$NAME.xsgn is not a CaeloWorks signature of script $NAME"
   fi
fi

# The entry script, with its #feature-id, and every file it needs at runtime.
entry=""
if has "$VENDOR/$NAME.js"; then
   note "entry script is in place"
   entry="$( unzip -p "$ZIP" "$VENDOR/$NAME.js" )"
   if grep -q '^#feature-id' <<<"$entry"; then note "entry script declares #feature-id"; else bad "no #feature-id in $NAME.js"; fi
else
   bad "no $VENDOR/$NAME.js"
fi
for lib in $( cd "$REPO" && find pjsr/lib -type f -name '*.js' | sed 's#^pjsr/##' | sort ); do
   if has "$VENDOR/$lib"; then note "$lib is packaged"; else bad "$lib is missing from the package"; fi
done
for asset in $( cd "$REPO" && find pjsr/assets -type f | sed 's#^pjsr/##' | sort ); do
   has "$VENDOR/$asset" || bad "$asset is missing from the package"
done
note "assets/ checked against pjsr/assets"

# The menu icon, installed where #feature-icon looks for it.
if has "rsc/icons/script/$NAME/$NAME.svg"; then
   note "menu icon is installed under rsc/icons/script/"
else
   bad "no menu icon at rsc/icons/script/$NAME/$NAME.svg"
fi

# The documentation (CPD rule 6.1): the page named after the #feature-id and
# its French twin, compiled PIDoc output.
for page in $DOC_PAGES; do
   f="doc/scripts/$page/$page.html"
   if has "$f"; then
      html="$( unzip -p "$ZIP" "$f" )"
      if grep -q 'pidoc-document-class" content="PIScriptDoc"' <<<"$html"; then
         note "$f ships (PIDoc script document)"
      else
         bad "$f is not a compiled PIDoc script document"
      fi
   else
      bad "no documentation page $f"
   fi
done

if has "$VENDOR/LICENSE"; then note "LICENSE ships with the script"; else bad "LICENSE is missing"; fi

# The version stamp has to have been substituted, or the dialog shows the
# literal placeholder and no user can report which build they are on.
if grep -q '__BUILD__' <<<"$entry"; then
   bad "the __BUILD__ placeholder was not stamped"
else
   note "the version stamp was substituted"
fi

# Nothing from the development tree belongs in a user's PixInsight install. A
# whitelist: the package unpacks over someone's PixInsight directory.
allowed="^(${VENDOR}|rsc/icons/script/${NAME}"
for page in $DOC_PAGES; do allowed="$allowed|doc/scripts/$page"; done
allowed="$allowed)/"
stray="$( grep -v '/$' <<<"$tree" | grep -vE "$allowed" || true )"
if [ -n "$stray" ]; then
   bad "the package writes outside its allowed directories:"
   printf '%s\n' "$stray" | sed 's/^/          /'
else
   note "every file lands under $VENDOR/, rsc/icons/script/$NAME/ or doc/scripts/$NAME{,-fr}/"
fi

# The sidecar, when present, must describe this very zip.
SIDECAR="$( dirname "$ZIP" )/update-package.json"
if [ -f "$SIDECAR" ]; then
   want_sha="$( sha1sum "$ZIP" | cut -d' ' -f1 )"
   got="$( python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(m.get("fileName",""), m.get("sha1",""))' "$SIDECAR" )"
   if [ "$got" = "$(basename "$ZIP") $want_sha" ]; then
      note "update-package.json: fileName and sha1 match ($want_sha)"
   else
      bad "update-package.json does not describe this zip (has: $got; zip sha1 $want_sha)"
   fi
fi

echo
[ "$fail" -eq 0 ] && echo "PASS" || echo "FAILED"
exit "$fail"
