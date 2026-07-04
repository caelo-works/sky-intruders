package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// celestrakBase is the GP catalog endpoint; a var so tests can point it at an
// httptest server.
var celestrakBase = "https://celestrak.org/NORAD/elements/gp.php"

// retryBaseDelay is the first backoff step (doubles per retry); a var so tests
// stay fast.
var retryBaseDelay = 2 * time.Second

// fetchAttemptTimeout bounds each individual download attempt.
var fetchAttemptTimeout = 30 * time.Second

const fetchAttempts = 3

type fetchResponse struct {
	TLEPath    string      `json:"tlePath"`
	Count      int         `json:"count"`
	FetchedUtc string      `json:"fetchedUtc"`
	FromCache  bool        `json:"fromCache"`
	Stale      bool        `json:"stale,omitempty"`
	SourceURL  string      `json:"sourceUrl"`
	Error      interface{} `json:"error"` // always null here; failures go through fatalJSON
}

// cacheMeta is the sidecar-private <group>.meta.json next to <group>.tle.
type cacheMeta struct {
	FetchedUtc string `json:"fetchedUtc"`
	SourceURL  string `json:"sourceUrl"`
	Count      int    `json:"count"`
}

func runFetchTLE(args []string) {
	fs := flag.NewFlagSet("fetch-tle", flag.ExitOnError)
	group := fs.String("group", "", "CelesTrak GP group name (e.g. active, starlink)")
	cacheDir := fs.String("cache-dir", "", "TLE cache directory")
	maxAgeHours := fs.Float64("max-age-hours", 12, "serve from cache when younger than this")
	outFile := fs.String("out-file", "", "write the JSON response to this file")
	_ = fs.Parse(args)

	if *group == "" || *cacheDir == "" || *outFile == "" {
		fatalJSON(*outFile, "fetch-tle: --group, --cache-dir and --out-file are required")
	}

	url := celestrakBase + "?GROUP=" + *group + "&FORMAT=tle"
	res, err := fetchTLE(context.Background(), url, *group, *cacheDir,
		time.Duration(*maxAgeHours*float64(time.Hour)), time.Now().UTC())
	if err != nil {
		fatalJSON(*outFile, "fetch-tle: %v", err)
	}
	writeJSON(*outFile, res)
}

// fetchTLE serves <cacheDir>/<group>.tle from cache when fresh, otherwise
// downloads and re-caches. On download failure a stale cache is still served
// (fromCache + stale) so a night's run survives a CelesTrak outage.
func fetchTLE(ctx context.Context, url, group, cacheDir string, maxAge time.Duration, now time.Time) (fetchResponse, error) {
	tlePath := filepath.Join(cacheDir, group+".tle")
	metaPath := filepath.Join(cacheDir, group+".meta.json")

	if meta, ok := readCacheMeta(metaPath, tlePath); ok {
		if fetched, err := time.Parse(time.RFC3339, meta.FetchedUtc); err == nil && now.Sub(fetched) < maxAge {
			return fetchResponse{
				TLEPath: tlePath, Count: meta.Count, FetchedUtc: meta.FetchedUtc,
				FromCache: true, SourceURL: meta.SourceURL,
			}, nil
		}
	}

	body, err := download(ctx, url)
	if err == nil {
		tles := parseTLEs(body)
		if len(tles) == 0 {
			// CelesTrak serves HTML error pages with status 200; never cache those.
			err = fmt.Errorf("response from %s is not TLE data (0 valid records)", url)
		} else {
			if werr := writeCache(cacheDir, tlePath, metaPath, body, cacheMeta{
				FetchedUtc: now.Format(time.RFC3339), SourceURL: url, Count: len(tles),
			}); werr != nil {
				return fetchResponse{}, fmt.Errorf("write cache: %w", werr)
			}
			return fetchResponse{
				TLEPath: tlePath, Count: len(tles), FetchedUtc: now.Format(time.RFC3339),
				FromCache: false, SourceURL: url,
			}, nil
		}
	}

	// Network (or payload) failure: fall back to a stale cache when one exists.
	if meta, ok := readCacheMeta(metaPath, tlePath); ok {
		return fetchResponse{
			TLEPath: tlePath, Count: meta.Count, FetchedUtc: meta.FetchedUtc,
			FromCache: true, Stale: true, SourceURL: meta.SourceURL,
		}, nil
	}
	return fetchResponse{}, fmt.Errorf("download failed and no cache available: %v", err)
}

// download GETs url with fetchAttempts tries and exponential backoff; every
// attempt gets its own fetchAttemptTimeout.
func download(ctx context.Context, url string) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt < fetchAttempts; attempt++ {
		if attempt > 0 {
			delay := retryBaseDelay << (attempt - 1)
			select {
			case <-time.After(delay):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		body, err := downloadOnce(ctx, url)
		if err == nil {
			return body, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func downloadOnce(ctx context.Context, url string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, fetchAttemptTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent",
		"sky-intruders/"+buildVersion+" (+https://pixinsight-scripts.caelo.works)")
	// http.DefaultClient uses DefaultTransport, which honors HTTP(S)_PROXY.
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: status %d", url, resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

func readCacheMeta(metaPath, tlePath string) (cacheMeta, bool) {
	var meta cacheMeta
	if _, err := os.Stat(tlePath); err != nil {
		return meta, false
	}
	b, err := os.ReadFile(metaPath)
	if err != nil {
		return meta, false
	}
	if err := json.Unmarshal(b, &meta); err != nil || meta.FetchedUtc == "" {
		return meta, false
	}
	return meta, true
}

func writeCache(cacheDir, tlePath, metaPath string, body []byte, meta cacheMeta) error {
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(tlePath, body, 0o644); err != nil {
		return err
	}
	b, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return os.WriteFile(metaPath, b, 0o644)
}
