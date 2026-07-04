package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func fastRetries(t *testing.T) {
	t.Helper()
	old := retryBaseDelay
	retryBaseDelay = time.Millisecond
	t.Cleanup(func() { retryBaseDelay = old })
}

func TestFetchTLESuccess(t *testing.T) {
	fastRetries(t)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if got := r.Header.Get("User-Agent"); got == "" || got[:14] != "sky-intruders/" {
			t.Errorf("unexpected User-Agent %q", got)
		}
		_, _ = w.Write([]byte(sampleCatalog))
	}))
	defer srv.Close()

	dir := t.TempDir()
	now := time.Date(2026, 7, 4, 1, 0, 0, 0, time.UTC)
	res, err := fetchTLE(context.Background(), srv.URL, "active", dir, 12*time.Hour, now)
	if err != nil {
		t.Fatal(err)
	}
	if res.FromCache || res.Stale {
		t.Errorf("fresh download flagged as cache: %+v", res)
	}
	if res.Count != 2 || res.TLEPath != filepath.Join(dir, "active.tle") ||
		res.FetchedUtc != "2026-07-04T01:00:00Z" || res.SourceURL != srv.URL {
		t.Errorf("bad response: %+v", res)
	}
	if _, err := os.Stat(res.TLEPath); err != nil {
		t.Errorf("tle file not written: %v", err)
	}
	meta, ok := readCacheMeta(filepath.Join(dir, "active.meta.json"), res.TLEPath)
	if !ok || meta.Count != 2 || meta.SourceURL != srv.URL {
		t.Errorf("bad meta: %+v ok=%v", meta, ok)
	}

	// second call inside max-age: served from cache, no extra hit
	res2, err := fetchTLE(context.Background(), srv.URL, "active", dir, 12*time.Hour, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if !res2.FromCache || res2.Stale || res2.Count != 2 {
		t.Errorf("expected fresh-cache hit: %+v", res2)
	}
	if hits.Load() != 1 {
		t.Errorf("server hit %d times, want 1", hits.Load())
	}

	// past max-age: re-downloaded
	res3, err := fetchTLE(context.Background(), srv.URL, "active", dir, 12*time.Hour, now.Add(13*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if res3.FromCache {
		t.Errorf("expected re-download: %+v", res3)
	}
	if hits.Load() != 2 {
		t.Errorf("server hit %d times, want 2", hits.Load())
	}
}

func TestFetchTLERetriesThenSucceeds(t *testing.T) {
	fastRetries(t)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) < 3 {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(sampleCatalog))
	}))
	defer srv.Close()

	res, err := fetchTLE(context.Background(), srv.URL, "active", t.TempDir(), time.Hour, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if res.FromCache || res.Count != 2 {
		t.Errorf("bad response after retries: %+v", res)
	}
	if hits.Load() != 3 {
		t.Errorf("server hit %d times, want 3", hits.Load())
	}
}

func TestFetchTLEStaleCacheOnNetworkError(t *testing.T) {
	fastRetries(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(sampleCatalog))
	}))
	dir := t.TempDir()
	now := time.Date(2026, 7, 4, 1, 0, 0, 0, time.UTC)
	if _, err := fetchTLE(context.Background(), srv.URL, "active", dir, time.Hour, now); err != nil {
		t.Fatal(err)
	}
	srv.Close() // network now dead

	res, err := fetchTLE(context.Background(), srv.URL, "active", dir, time.Hour, now.Add(2*time.Hour))
	if err != nil {
		t.Fatalf("stale cache should have been served: %v", err)
	}
	if !res.FromCache || !res.Stale || res.Count != 2 {
		t.Errorf("expected stale cache response: %+v", res)
	}
}

func TestFetchTLENetworkErrorNoCache(t *testing.T) {
	fastRetries(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	srv.Close()
	_, err := fetchTLE(context.Background(), srv.URL, "active", t.TempDir(), time.Hour, time.Now().UTC())
	if err == nil {
		t.Fatal("expected error with dead server and empty cache")
	}
}

func TestFetchTLERejectsHTMLGarbage(t *testing.T) {
	fastRetries(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// CelesTrak failure mode: HTML error page with HTTP 200
		_, _ = w.Write([]byte("<html><body><h1>Rate limit exceeded</h1></body></html>"))
	}))
	defer srv.Close()

	dir := t.TempDir()
	_, err := fetchTLE(context.Background(), srv.URL, "active", dir, time.Hour, time.Now().UTC())
	if err == nil {
		t.Fatal("expected error on HTML payload")
	}
	if _, statErr := os.Stat(filepath.Join(dir, "active.tle")); statErr == nil {
		t.Error("HTML garbage must not be cached")
	}
}

func TestFetchTLEHTMLGarbageKeepsGoodCache(t *testing.T) {
	fastRetries(t)
	var good atomic.Bool
	good.Store(true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if good.Load() {
			_, _ = w.Write([]byte(sampleCatalog))
			return
		}
		_, _ = w.Write([]byte("<html>oops</html>"))
	}))
	defer srv.Close()

	dir := t.TempDir()
	now := time.Date(2026, 7, 4, 1, 0, 0, 0, time.UTC)
	if _, err := fetchTLE(context.Background(), srv.URL, "active", dir, time.Hour, now); err != nil {
		t.Fatal(err)
	}
	good.Store(false)

	res, err := fetchTLE(context.Background(), srv.URL, "active", dir, time.Hour, now.Add(2*time.Hour))
	if err != nil {
		t.Fatalf("stale cache should have been served: %v", err)
	}
	if !res.FromCache || !res.Stale {
		t.Errorf("expected stale cache fallback: %+v", res)
	}
	data, err := os.ReadFile(filepath.Join(dir, "active.tle"))
	if err != nil || len(parseTLEs(data)) != 2 {
		t.Errorf("good cache was clobbered: err=%v", err)
	}
}
