# Sky Intruders — architecture

*Who crossed your photo last night?* Sky Intruders scans a night's light frames for
trails, identifies them (satellite via TLE cross-match, meteor via active-shower
heuristics, slow movers as asteroid candidates) and renders a night-log report with
fun stats and a Reddit-ready post.

Two halves, same pattern as Distributed WBPP:

- **PJSR** (`pjsr/`) — UI, frame I/O, trail detection (pixel work through the PI C++
  engine), pixel→sky conversion (WCS), classification, report rendering.
- **Go sidecar** (`sidecar/`, static per-OS binaries under the package's `bin/`) —
  everything PJSR can't do: network (TLE download + cache) and orbital mechanics
  (SGP4 propagation, FOV crossing search, trail matching).

PJSR⇄sidecar protocol is the DWBPP one: one-shot `ExternalProcess` invocations,
request via `--in-file <json>`, response via `--out-file <json>` (stdout is not
capturable from PJSR). The out-file always contains either a result or
`{"error": "..."}`.

## Module map

```
pjsr/SkyIntruders.js        entry: feature-id, dialog, run orchestration
pjsr/lib/Stats.js           robust stats (ported from dark-frame-analyzer):
                            arrayMedian/arrayMAD, histogram MAD, clipped stats
pjsr/lib/FrameMeta.js       FITS/XISF metadata: DATE-OBS→Date, EXPTIME, observer
                            site, WCS (window.imageToCelestial when solved, manual
                            TAN fallback from CRVAL/CRPIX/CD, else approximate FOV)
pjsr/lib/TrailDetect.js     per-frame trail finder (downsample → MAD threshold →
                            Hough → contiguity validation → endpoints + photometry)
pjsr/lib/SidecarBridge.js   spawn/resolve sidecar, tmp-file JSON round trips
pjsr/lib/Meteors.js         IAU major-shower table + meteor/asteroid heuristics
pjsr/lib/Report.js          night log, fun stats, personal records, Reddit markdown
sidecar/                    Go module `sky-sidecar` (fetch-tle, match)
scripts/build-sidecar.sh    CGO_ENABLED=0 cross-compile matrix (win/linux/darwin ×
                            amd64/arm64) → bin/sky-sidecar-<os>-<arch>[.exe]
```

## Pipeline

1. User picks light frames (or a directory). Per frame: read metadata, detect
   trails, convert trail endpoints to RA/Dec (when WCS available).
2. Sidecar `fetch-tle` — CelesTrak GP catalog, disk cache (default max-age 12 h).
3. Sidecar `match` — for each frame's exposure window, propagate the catalog,
   find satellites crossing the FOV, match them to detected trails by angular
   separation + orientation + rate; flags sunlit vs eclipsed.
4. Classification of leftovers (JS): unmatched satellite-like trail →
   "unidentified satellite"; brightness-variable / interior trail aligned with an
   active shower radiant → "probable <shower> meteor"; compact sources drifting
   coherently across ≥3 frames (WCS required) → asteroid candidate.
5. Report: chronological night log, stats (counts by operator, Starlink share),
   personal records (persistent history), Markdown export ready for Reddit.

## Trail detection (PJSR)

Per frame, all heavy passes in the C++ engine:

1. Duplicate + `IntegerResample` (average) so the long side is ≤ ~1500 px.
2. Background/noise on the small image: median + histogram-MAD (from Stats.js).
3. Binary map: `sample > median + k·MAD` (k default 5) via one `getSamples` pull
   on the small image.
4. Hough transform (θ×ρ accumulator) on the binary map.
5. **Contiguity validation** (kills star-alignment false positives): a candidate
   line must have a contiguous above-threshold run ≥ minLength with ≥60% fill;
   stars along a chance line are sparse, trails are continuous.
6. Accept → record endpoints (scaled back to full-res pixels), then null out a
   corridor around the line and iterate (multi-trail, cap 10).
7. Photometry at full res: mean flux sampled along the segment, perpendicular
   width profile, brightness-variation index (meteor cue).

## Sidecar contracts

### `sky-sidecar fetch-tle`

```
sky-sidecar fetch-tle --group active --cache-dir <dir> --max-age-hours 12 --out-file r.json
```

Downloads `https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=tle`
(30 s timeout, 3 retries with backoff, honors HTTP(S)_PROXY). Cache key =
group; served from cache when younger than max-age. Response:

```json
{ "tlePath": "<cache-dir>/active.tle", "count": 10234,
  "fetchedUtc": "2026-07-04T01:02:03Z", "fromCache": false,
  "sourceUrl": "https://celestrak.org/...", "error": null }
```

### `sky-sidecar match`

```
sky-sidecar match --tle-file <path> --in-file req.json --out-file res.json
```

Request:

```json
{
  "observer": { "latDeg": 48.85, "lonDeg": 2.35, "altM": 100 },
  "frames": [ {
    "id": "L_0042.fits",
    "startUtc": "2026-07-03T02:13:05Z",
    "exposureSec": 120,
    "fov": { "raDeg": 300.1, "decDeg": 45.2, "widthDeg": 2.1, "heightDeg": 1.4,
             "rotationDeg": 12.3, "hasWcs": true },
    "trails": [ { "index": 0,
      "p1": { "raDeg": 299.8, "decDeg": 44.9 }, "p2": { "raDeg": 300.4, "decDeg": 45.5 },
      "pixLength": 1234, "meanFluxAdu": 5678, "widthPx": 3.2,
      "brightnessVariation": 0.15 } ]
  } ],
  "options": { "stepSec": 1.0, "matchMaxSepDeg": 0.2, "matchMaxAngleDiffDeg": 12 }
}
```

`trails` may be empty or lack sky coords (`"p1": null`) when the frame has no WCS —
the sidecar still reports FOV crossings (time-window only, using the approximate
FOV) with `"matchedTrailIndex": null`.

Response:

```json
{
  "tle": { "count": 10234, "source": "active" },
  "frames": [ {
    "id": "L_0042.fits",
    "crossings": [ {
      "noradId": 45123, "name": "STARLINK-4512", "intlDes": "2020-001A",
      "entryUtc": "2026-07-03T02:13:41Z", "exitUtc": "2026-07-03T02:13:49Z",
      "path": { "p1": { "raDeg": 299.7, "decDeg": 44.8 },
                "p2": { "raDeg": 300.5, "decDeg": 45.6 } },
      "angularRateDegPerSec": 0.31, "rangeKm": 812, "elevationDeg": 42.5,
      "sunlit": true,
      "matchedTrailIndex": 0, "matchScore": 0.93,
      "sepDeg": 0.04, "angleDiffDeg": 2.1
    } ]
  } ],
  "error": null
}
```

Matching: a crossing matches a trail when the great-circle midpoint separation ≤
`matchMaxSepDeg` (TLE epoch drift allowance) and path orientation differs ≤
`matchMaxAngleDiffDeg`; score blends separation, angle and rate agreement. Only
sunlit crossings above the horizon are candidates; eclipsed crossers are still
listed (`"sunlit": false`) since they explain nothing visible.

SGP4: `github.com/joshuaferrara/go-satellite` (pure Go, MIT). Sunlit test:
solar position (low-precision Meeus) + cylindrical Earth-shadow model.

## Persistent data

- Script parameters: PixInsight `Settings` (same pattern as dark-frame-analyzer),
  including observer site fallback.
- Personal records history: JSON at `~/.caeloworks/sky-intruders/history.json`
  (full rewrite each save — PJSR append is broken under v8). One entry per
  analyzed night: date, frame count, per-class counts, notable names.
- TLE cache: `~/.caeloworks/sky-intruders/tle/`.

## Testing

- Go: `go vet`, `go test -race` — table tests for TLE parse/cache, `httptest`
  server for fetch (timeout/retry/error paths), SGP4 propagation against known
  ISS ephemeris fixtures, matching geometry unit tests.
- PJSR pure logic: Node harness (dark-frame-analyzer pattern — strip PI
  directives, stub runtime, unit-test Stats/TrailDetect/Meteors/Report math on
  synthetic data: injected lines + Gaussian noise + fake stars).
- Two-gate validation on real data (PJSR-NOTES §8): clean console log AND
  baseline-compared report output on a reference night.
