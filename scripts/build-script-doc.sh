#!/usr/bin/env bash
# ============================================================================
# build-script-doc.sh — compile the PIDoc sources of the script documentation
# ============================================================================
#
# Compiles, through the Documentation Compiler script of a local PixInsight
# installation (command-line, no dialog):
#
#   docs/pidoc/SkyIntruders.pidoc     -> doc/scripts/SkyIntruders/
#                                             SkyIntruders.html
#   docs/pidoc/SkyIntruders-fr.pidoc  -> doc/scripts/SkyIntruders-fr/
#                                             SkyIntruders-fr.html
#
# The generated pages are VERSIONED: build-update-package.sh ships them as
# they are, so the update package stays buildable (and testable in CI)
# without PixInsight. Run this script after every change to a .pidoc source
# and commit the regenerated pages together with it.
#
# The pages reference the stylesheets of the PixInsight documentation system
# through relative paths (../../pidoc/...): they render correctly once
# deployed under <PixInsight>/doc/scripts/, not from the repository.
#
# The compiler runs against a throwaway documentation system in a temporary
# directory: the PixInsight installation is never written to, and the
# compiler settings saved by the user are left untouched.
#
# Environment:
#   PIXINSIGHT_BIN  PixInsight executable (default: the standard Windows
#                   installation, reached from WSL)
#   PIDOC_WORK_DIR  Windows-visible scratch directory (default: C:\Temp)
#
# The driver below is an unsigned script: PixInsight must allow the execution
# of unsigned scripts, or it refuses it silently.
#
# PixInsight must NOT be running: a running instance would receive the
# command line instead of executing it.
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_ROOT/docs/pidoc"
OUT_DIR="$REPO_ROOT/doc/scripts"
PAGES=(SkyIntruders SkyIntruders-fr)

PIXINSIGHT_BIN="${PIXINSIGHT_BIN:-/mnt/c/Program Files/PixInsight/bin/PixInsight.exe}"
PIDOC_WORK_DIR="${PIDOC_WORK_DIR:-/mnt/c/Temp}"

die() { echo "ERROR: $*" >&2; exit 1; }

command -v wslpath > /dev/null || die "this script drives a Windows PixInsight from WSL (wslpath not found)"
command -v powershell.exe > /dev/null || die "powershell.exe not found"
[ -f "$PIXINSIGHT_BIN" ] || die "PixInsight not found: $PIXINSIGHT_BIN (set PIXINSIGHT_BIN)"
[ -d "$PIDOC_WORK_DIR" ] || die "work directory not found: $PIDOC_WORK_DIR (set PIDOC_WORK_DIR)"

running="$(powershell.exe -NoProfile -Command \
   "(Get-Process PixInsight -ErrorAction SilentlyContinue | Measure-Object).Count" | tr -d '\r')"
[ "$running" = "0" ] || die "PixInsight is running: close it first"

# Paths as the Windows-side PixInsight sees them, with forward slashes
win() { wslpath -m "$1"; }
PI_ROOT="$(dirname "$(dirname "$PIXINSIGHT_BIN")")"
COMPILER_DIR="$(win "$PI_ROOT")/src/scripts/PIDocCompiler"

WORK="$PIDOC_WORK_DIR/si-pidoc.$$"
rm -rf "$WORK"
mkdir -p "$WORK/sys"
trap 'rm -rf "$WORK"' EXIT

# The compiler turns a source line break into nothing (a line marker renders
# as an empty string), so the last word of a line and the first word of the
# next one are glued together in the page ("do not" + "belong" -> "do
# notbelong"). Leading whitespace is kept as a separator, so the working copy
# indents every continuation line (a non-empty line that follows a non-empty,
# non-comment line) by one space. Comment lines are left alone: once its
# comment is stripped, an indented comment line would become a blank line,
# that is, a paragraph break. The sources have no verbatim or code blocks,
# where the extra space would be visible.
for page in "${PAGES[@]}"; do
   [ -f "$SRC_DIR/$page.pidoc" ] || die "source not found: $SRC_DIR/$page.pidoc"
   if grep -qE '#:|\\code|\\verbatim' "$SRC_DIR/$page.pidoc"; then
      die "$page.pidoc has a verbatim or code block: the line-break workaround would alter it"
   fi
   python3 - "$SRC_DIR/$page.pidoc" "$WORK/$page.pidoc" <<'PY'
import sys
lines = open(sys.argv[1], encoding="utf-8").read().split("\n")
out, prev_text = [], False
for line in lines:
    text = line.strip() != "" and not line.lstrip().startswith("%")
    out.append(" " + line if text and prev_text and not line[:1].isspace() else line)
    prev_text = text
open(sys.argv[2], "w", encoding="utf-8", newline="\n").write("\n".join(out))
PY
done

WORK_WIN="$(win "$WORK")"
sources_js=""
for page in "${PAGES[@]}"; do sources_js+="\"$page.pidoc\", "; done

# Driver: the compiler's own files, included as pidoc.js does, then a
# compilation with in-memory options only (no saveSettings call)
cat > "$WORK/compile.js" <<JS
#engine v8
#include "$COMPILER_DIR/PIDocGlobal.js"
#include "$COMPILER_DIR/PIDocCommand.js"
#include "$COMPILER_DIR/PIDocCompiler.js"
#include "$COMPILER_DIR/PIDocDialog.js"
#include "$COMPILER_DIR/PIDocDocument.js"
#include "$COMPILER_DIR/PIDocOptions.js"
#include "$COMPILER_DIR/PIDocSystem.js"
#include "$COMPILER_DIR/SyntaxHighlighter.js"
#include "$COMPILER_DIR/Utility.js"

var BASE = "$WORK_WIN";
var log = [];
try
{
   options.loadSettings();
   options.baseDirectory = BASE + "/sys";
   options.generateOutput = true;
   options.backupExistingFiles = false;
   options.treatWarningsAsErrors = true;
   PIDocSystem.generateNewSystem( options.baseDirectory );
   var sources = [ $sources_js ];
   for ( var i = 0; i < sources.length; ++i )
   {
      (new PIDocCompiler).compile( BASE + "/" + sources[i] );
      if ( !document.hasXhtmlDocument() )
         throw new Error( "no document generated for " + sources[i] );
      document.writeXhtmlDocument();
      log.push( "OK " + sources[i] );
   }
}
catch ( x )
{
   log.push( "ERROR " + x.toString() );
}
File.writeTextFile( BASE + "/compile.log", log.join( "\n" ) + "\n" );
JS

echo "Compiling ${PAGES[*]} with $(basename "$PIXINSIGHT_BIN")..."
powershell.exe -NoProfile -Command \
   "Start-Process -Wait '$(wslpath -w "$PIXINSIGHT_BIN")' -WorkingDirectory '$(wslpath -w "$WORK")' -ArgumentList '--automation-mode','--no-splash','--force-exit','--run=$(wslpath -w "$WORK")\\compile.js'" \
   > /dev/null

[ -f "$WORK/compile.log" ] || die "the compiler produced no log: did PixInsight start, and is Preferences > Security > Allow execution of unsigned scripts turned on? (the driver is an unsigned script)"
cat "$WORK/compile.log"
grep -q '^ERROR' "$WORK/compile.log" && die "compilation failed"

for page in "${PAGES[@]}"; do
   html="$WORK/sys/scripts/$page/$page.html"
   [ -f "$html" ] || die "missing output: scripts/$page/$page.html"
   mkdir -p "$OUT_DIR/$page"
   # LF only, like every versioned text file of the repository
   python3 -c 'import sys; d=open(sys.argv[1],"rb").read().replace(b"\r\n",b"\n"); open(sys.argv[2],"wb").write(d)' \
      "$html" "$OUT_DIR/$page/$page.html"
   echo "  -> doc/scripts/$page/$page.html"
done
