# shellcheck shell=bash
#
# pi-run.sh — sourced, not executed. Runs a PJSR file in a headless PixInsight
# and hands its inputs over the right way on every host the release is cut from.
#
# The catch it exists for: on WSL, PixInsight is a Windows program. It sees
# neither Linux paths nor the Linux environment, so paths go through wslpath and
# variables through WSLENV, and its working files live under the Windows %TEMP%,
# where it can reach them by a native path.
#
#   pi_setup             resolve PI_EXE (defaults to the standard Windows install
#                        when run from WSL)
#   pi_native <path>     the path as PixInsight must be given it
#   pi_tmpdir            a fresh work directory PixInsight can read and write
#   pi_run <js> VAR...   run <js>, forwarding the named environment variables
#
# PixInsight's exit status says nothing about what the script did: callers make
# the script write a report file and judge that.
#
# The scripts run this way are unsigned. A PixInsight with "Allow execution of
# unsigned scripts" turned off refuses them silently: no report appears. The
# machine that signs and verifies must keep that option on.

pi_setup() {
  if [ -z "${PI_EXE:-}" ] && [ -f "/mnt/c/Program Files/PixInsight/bin/PixInsight.exe" ]; then
    PI_EXE="/mnt/c/Program Files/PixInsight/bin/PixInsight.exe"
  fi
  : "${PI_EXE:?set PI_EXE to your PixInsight executable}"
  [ -f "$PI_EXE" ] || { echo "error: PI_EXE not found: $PI_EXE" >&2; return 1; }
  if [[ "$PI_EXE" == *.exe ]] && command -v wslpath >/dev/null 2>&1; then
    PI_WSL=1
  else
    PI_WSL=0
  fi
}

pi_native() {
  if [ "$PI_WSL" = 1 ]; then wslpath -w "$1"; else printf '%s\n' "$1"; fi
}

pi_tmpdir() {
  if [ "$PI_WSL" = 1 ]; then
    local win_tmp
    # cmd.exe reads stdin when it has one, and would swallow input meant for the
    # caller (a password prompt, for one): give it none.
    win_tmp="$( cd /mnt/c && cmd.exe /c "echo %TEMP%" </dev/null 2>/dev/null | tr -d '\r' )"
    if [ -z "$win_tmp" ] || [[ "$win_tmp" == *%* ]]; then
      echo "error: cannot resolve the Windows %TEMP%" >&2
      return 1
    fi
    mktemp -d "$( wslpath "$win_tmp" )/si-pi.XXXXXX"
  else
    mktemp -d
  fi
}

pi_run() {
  local js="$1"; shift
  local fwd
  fwd="$( IFS=:; printf '%s' "$*" )"
  ( cd "$( dirname "$js" )" && \
    WSLENV="${fwd}${WSLENV:+:$WSLENV}" \
    "$PI_EXE" -n --automation-mode --no-splash --no-startup-scripts --force-exit \
      -r="$( pi_native "$js" )" </dev/null >/dev/null 2>&1 ) || true
}
