#!/usr/bin/env bash
# Cross-compile the sky-sidecar into fully static, dependency-free binaries for
# every OS PixInsight runs on. CGO is disabled so each binary is self-contained
# and needs no runtime on the target machine (PJSR spawns it directly from the
# package's bin/ directory).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/sidecar"
OUT="$ROOT/bin"
mkdir -p "$OUT"

# version stamp: $1 > $VERSION > git tag/sha > "dev"
VERSION="${1:-${VERSION:-$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo dev)}}"
LDFLAGS="-s -w -X main.buildVersion=${VERSION}"

# os/arch  ->  output filename
targets=(
  "windows/amd64 sky-sidecar-windows-amd64.exe"
  "linux/amd64   sky-sidecar-linux-amd64"
  "linux/arm64   sky-sidecar-linux-arm64"
  "darwin/amd64  sky-sidecar-darwin-amd64"
  "darwin/arm64  sky-sidecar-darwin-arm64"
)

echo "Building sky-sidecar ${VERSION}"
for t in "${targets[@]}"; do
  read -r osarch name <<<"$t"
  GOOS="${osarch%/*}"; GOARCH="${osarch#*/}"
  echo "  -> $GOOS/$GOARCH  $name"
  ( cd "$SRC" && CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" \
      go build -trimpath -ldflags "$LDFLAGS" -o "$OUT/$name" . )
done

echo "Done. Artifacts in $OUT:"
ls -lh "$OUT"
