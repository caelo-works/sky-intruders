// Command sky-sidecar is the orbital-mechanics companion of the Sky Intruders
// PixInsight script. PJSR cannot do networking nor heavy math, so this binary
// provides TLE catalog download/caching (fetch-tle) and SGP4 propagation with
// FOV-crossing / trail matching (match). PJSR drives it via ExternalProcess:
// request through --in-file, response through --out-file (PJSR cannot capture
// stdout). The out-file always holds either the result or {"error": "..."}.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
)

// buildVersion is injected at build time via -ldflags "-X main.buildVersion=...".
var buildVersion = "dev"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "--version", "-version", "version":
		fmt.Printf("sky-sidecar %s (%s/%s)\n", buildVersion, runtime.GOOS, runtime.GOARCH)
	case "fetch-tle":
		runFetchTLE(os.Args[2:])
	case "match":
		runMatchCmd(os.Args[2:])
	default:
		fmt.Fprintln(os.Stderr, "unknown command:", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  sky-sidecar fetch-tle --group <name> --cache-dir <dir> [--max-age-hours <h>] --out-file <path>
  sky-sidecar match --tle-file <path> --in-file <req.json> --out-file <res.json>
  sky-sidecar --version`)
}

// fatalJSON writes {"error": "..."} to outFile (the only channel PJSR can
// read), echoes the message to stderr, and exits non-zero.
func fatalJSON(outFile, format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintln(os.Stderr, "sky-sidecar:", msg)
	if outFile != "" {
		b, _ := json.Marshal(map[string]string{"error": msg})
		_ = os.WriteFile(outFile, b, 0o644)
	}
	os.Exit(1)
}

// writeJSON marshals v to outFile; a marshal/write failure is fatal.
func writeJSON(outFile string, v interface{}) {
	b, err := json.MarshalIndent(v, "", " ")
	if err != nil {
		fatalJSON(outFile, "encode response: %v", err)
	}
	if err := os.WriteFile(outFile, b, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "sky-sidecar: write out-file:", err)
		os.Exit(1)
	}
}
