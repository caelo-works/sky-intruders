# Sky Intruders — architecture

*Who crossed your photo last night?* Sky Intruders scans a night's light frames for
trails, identifies them (satellite via TLE cross-match, meteor via active-shower
heuristics, slow movers as asteroid candidates) and renders a night-log report with
fun stats, personal records and a forum-ready Markdown post. A second mode,
**Treasure Hunt**, inventories what a single plate-solved image already contains
(see `docs/TREASURE-HUNT.md`).

**100% PJSR — no native helper.** Networking uses PixInsight's `NetworkTransfer`
(validated under `#engine v8`, see `tests/probe-networktransfer.js`); orbital
mechanics uses a vendored [satellite.js](https://github.com/shashwatak/satellite-js)
5.0.0 (SGP4, MIT) plus our own matching engine. The matching fixtures under
`tests/fixtures/match/` predate the JS engine (see their README for what they pin
and what was re-pinned when the frame model was corrected).

This document is the contributor's map: every number in it is read from the
code, and `docs/RELEASING.md` requires it to be re-read against the code before
each tag.

## Module map

Include order in `pjsr/SkyIntruders.js` — which is also the dependency
direction: a library may use only what was included before it.

```
pjsr/lib/vendor/satellite.js satellite-js 5.0.0 UMD (unmodified, MIT); defines the
                             global `satellite` that SatMatch resolves
pjsr/lib/Geom.js             SIGeom — spherical geometry: great-circle separation,
                             position angle, TAN projection both ways, sexagesimal
                             parser. The only copy; no dependency on anything.
pjsr/lib/Stats.js            SIStats — median/MAD, histogram MAD (pure), plus PI
                             image helpers (Histogram/Rect, need the runtime)
pjsr/lib/FrameMeta.js        SIFrameMetaCore (pure: DATE-OBS, EXPTIME, angles,
                             TAN from CRVAL/CRPIX/CD, approximate FOV, frame ids)
                             + SIFrameMeta.read (PI: window keywords, astrometric
                             solution projector, WCS kind resolution, observer)
pjsr/lib/TrailDetect.js      SITrailCore (pure: binning, adaptive threshold, Hough,
                             run walking, refineGrid, faint weighted-Hough pass,
                             merge, photometry) + SITrailDetect (PI: detect /
                             detectDiff over an Image)
pjsr/lib/Net.js              SITleNet (TLE + SATCAT download: disk cache, two-pass
                             source list with a mirror, stale-cache fallback,
                             group merge with NORAD dedup, SATCAT parsers) and
                             SINet, the one HTTP text getter (+ pause) every fetch
                             in the script goes through
pjsr/lib/SatMatch.js         SISatMatch — TLE parse/validate, SGP4 via satellite.js,
                             Meeus sun + cylindrical Earth shadow, WGS84 observer,
                             TEME→J2000 rotation, topocentric RA/Dec, FOV crossing
                             scan, strict/loose trail assignment, orientation fit
pjsr/lib/Meteors.js          SIMeteors — IAU major-shower table, meteor/satellite-
                             candidate classifier, slow-mover (asteroid) tracker,
                             airplane/train bundle grouping
pjsr/lib/SatLabels.js        SISatLabels — operator flag (SATCAT owner, name
                             heuristic), object nature (payload in/out of service,
                             rocket body, debris), telemetry sub-line, per-class
                             colours, fallback labels
pjsr/lib/NightEvents.js      SINightEvents.build — frame by frame: matched
                             satellites, bundles, classified leftovers, predicted
                             passes, the segments the composite draws, clean-frame
                             and exposure totals
pjsr/lib/Report.js           SIReport — night log Markdown, fun stats, personal
                             records, forum title; history.json load/save (PI)
pjsr/lib/Cosmology.js        SICosmology — redshift → lookback time, light-travel
                             and comoving distance (flat ΛCDM, Simpson)
pjsr/lib/Catalogs.js         SICatalogs — VizieR/SkyBoT URL builders and parsers
                             (pure), body gates, AdP CSV parsers; query layer over
                             SINet with the per-field disk cache (PI)
pjsr/lib/Treasure.js         SITreasure — cross-match to pixels, notability,
                             aperture detection + decoy verdict, magnitude
                             consistency, display names, narrative, summary
pjsr/lib/TreasureReport.js   SITreasureReport — the standalone illustrated HTML
                             (pure string assembly, everything inlined)
pjsr/lib/Render.js           SIRender — PI-only rendering: STF-like autostretch to
                             Bitmap, trail annotation with flags, star-chart
                             rendering, thumbnails, PNG→base64, StarAlignment
                             registration, max-combine, showBitmap
pjsr/SkyIntruders.js         entry: feature-id, DEFAULT_PARAMS + settings.json,
                             night pipeline orchestration (analyzeNightSet,
                             runAnalysis), Treasure Hunt orchestration
                             (runTreasureHunt), dialogs, headless gates
```

`Render.js` is included last because it is consumed only by the entry script;
it is the one library that is not bundled by the Node harness.

## Test harness

`bash tests/run.sh` (also run by `.github/workflows/ci.yml` and by the Release
workflow, which refuses to publish on a red run):

1. `export TZ=UTC` — the night log prints every clock in UT and the report
   goldens are written that way; a host-local regression must fail everywhere.
2. Builds `tests/build/module.js`: the vendored satellite.js first (with
   `module`/`exports` hidden so the UMD takes the global branch), then every
   library with PixInsight preprocessor lines stripped, in this order: Geom,
   Stats, FrameMeta, TrailDetect, Net, SatMatch, Meteors, SatLabels,
   NightEvents, Report, Cosmology, Catalogs, Treasure, TreasureReport; then a
   `module.exports` block exposing `SIGeom`, `SIStats`, `SIFrameMetaCore`,
   `SITrailCore`, `SITleNet`, `SISatMatch`, `SIMeteors`, `SISatLabels`,
   `SINightEvents`, `SIReport`, `SICosmology`, `SICatalogs`, `SITreasure`,
   `SITreasureReport`.
3. `node --check` on that bundle, then on the two unbundled PI-facing files
   (`pjsr/SkyIntruders.js`, `pjsr/lib/Render.js`) after the same strip plus
   the mid-line `#__FILE__` token rewritten to a string literal.
4. Runs every `tests/*.test.js` against the bundle.

What Node tests: pure logic only — geometry, stats, keyword parsing, the trail
detector on synthetic fields, the TLE/SATCAT parsers, the matching engine, the
meteor/mover heuristics, labels, event assembly, the report, cosmology, the
catalog parsers, the treasure cross-match/narrative/HTML. What Node cannot
test: anything touching `ImageWindow`, `Image`, `Bitmap`, `NetworkTransfer`,
`StarAlignment`, `File` — i.e. `SIFrameMeta.read`, `SITrailDetect`, the
fetchers, `SIRender`, the query layer, the dialogs.

Fixtures:

- `tests/fixtures/match/` — `request.json` / `response.json` /
  `propagation.json` / `delta.tle` replayed by `satmatch.test.js` within
  tolerances, and `assign-snapshot.json`, a seeded-PRNG scenario set whose
  assigner outputs `assign.test.js` compares bit-for-bit (regenerate on
  purpose with `node tests/assign.test.js --write`).
- `tests/fixtures/report/night-<n>.<lang>.md` — golden Markdown of three
  synthetic nights in both languages (`report.test.js`, byte for byte).
- `tests/fixtures/movers/night13-pool.json` — the real 13-frame blob pool of
  the reference night, used by `meteors.test.js` to pin zero slow-mover
  candidates on the artifact storm and to recover injected synthetic movers.
- `tests/fixtures/treasure/` — recorded VizieR/SkyBoT bodies (HyperLEDA around
  M51, Milliquas around 3C 273, MASH around the bulge, SkyBoT around M51, a
  VizieR `#INFO Error=` body) for `catalogs.test.js`.

PixInsight-side scripts (run with
`<PI-exe> -n --automation-mode --force-exit -r=<abs path>`; results go to a
JSON marker in the system temp directory because the console is not reliably
visible headless):

- `tests/selftest-pi.js` — include chain, satellite.js on the v8 global, SGP4
  and NetworkTransfer under the real engine; writes
  `skyintruders-selftest.json`.
- `tests/selftest-integration.js` — Treasure Hunt engine path on synthetic
  images (data → render → bitmap → base64 → HTML → window);
  `skyintruders-integration.json`.
- `tests/run-night-testset.js` — the production night pipeline
  (`runAnalysis`) on `<scriptdir>/data`; `si-night-testset.json` plus the
  composite PNG. `tests/run-treasure-testset.js` — the production Treasure
  Hunt on `<scriptdir>/masters-solved`, produced first by
  `tests/solve-masters.js` (default engine: the AdP solver stack does not load
  under `#engine v8`).
- `tests/gen-testdata.js` — writes a synthetic night of FITS frames with full
  headers for hand-testing; `tests/debug-*.js` — forensic dumps of the
  registered-difference stages; `tests/probe-networktransfer.js` — the
  NetworkTransfer API probe.

Environment gates read by the entry script (`siEnvFlag`, value `1`):
`SI_CONSTRUCT_TEST` builds every dialog headless, drives the handlers and
writes `skyintruders-construct.json` instead of running; `SI_HEADLESS_LIB`
makes including `SkyIntruders.js` define everything without launching the GUI
(what the testset runners rely on). There is no other gate — `selftest-pi.js`
includes the libraries directly and needs none.

## Night pipeline

### Parameters

`DEFAULT_PARAMS` (entry script), persisted as JSON at
`~/.caeloworks/sky-intruders/settings.json` — full rewrite on every save; on
load each saved value is taken only when it has the default's type (finite
numbers, arrays of strings, typed nullables `tleBaseUrl` / `observerLatDeg` /
`observerLonDeg`), and a saved `tleExtraGroups` equal to the pre-0.2.0 default
`["last-30-days"]` is upgraded in place:

| key | default | note |
|---|---|---|
| `kSigma` | 5.0 | single-frame threshold (median + k·MAD) |
| `diffKSigma` | 4.5 | threshold on the registered difference; `> 0` overrides `kSigma` there |
| `minLengthFrac` | 0.15 | of the binned diagonal |
| `fillRatioMin` | 0.6 | contiguity fill of a run |
| `maxTrails` | 10 | per frame; the difference path uses `max(25, maxTrails)` so a train cannot exhaust the slots |
| `tleGroup` | `"active"` | primary CelesTrak group |
| `tleExtraGroups` | `["last-30-days", "catalog"]` | merged in, NORAD-deduped; no dialog control |
| `tleMaxAgeHours` | 12 | cache max age |
| `tleBaseUrl` | `null` | extra first source (mirror), see Net |
| `matchMaxSepDeg` | 0.2 | strict cross-track gate |
| `matchMaxAngleDiffDeg` | 12 | orientation gate (both assigners) |
| `stepSec` | 1.0 | fine sampling step |
| `detectAsteroids` | true | slow-mover search |
| `nightShowPredicted` / `nightShowShadow` | false / false | ghost layer on the composite |
| `maxSources` | 600 | point sources per frame for the mover search |
| `lang` | `"en"` | |
| `observerLatDeg` / `observerLonDeg` / `observerAltM` | null / null / 0 | dialog fallback site |
| `mode` | `"night"` | or `"treasure"` |
| `treasureMaxRows` | 400 | `-out.max` per cone search |
| `treasureGalaxies` / `treasureQuasars` / `treasurePne` / `treasureAsteroids` | true | |
| `treasureAccent` | `SI_DEFAULT_ACCENT` | chart colour |
| `saveHistory` | true | settings.json only; headless runs switch it off |
| `nightResultImage` | true | settings.json only |
| `nightResultCombine` | `"best"` | settings.json only; `"max"` = max-combine of the set |
| `debugFrameOverlays` / `matchDiagnostics` | false | settings.json only |

### Run layout

`runAnalysis` mints a run token `YYYYMMDD-HHMMSS-<4 random digits>` and a
private scratch directory `<system temp>/si-night-reg-<token>`, wiped in a
`finally` on every exit path. Every frame gets the run-unique id
`NNN_<base name>` (`SIFrameMetaCore.frameId`: zero-padded index, width
`max(3, digits of count-1)`); the id keys every per-frame map, names the
registered copy `<NNN>_<base>_r.xisf` in the scratch directory and the debug
overlays; `meta.name` (the base name) is what the user reads.

### Registered-difference analysis (3+ frames)

Nebulosity defeats any single-frame line detector — the Veil's filaments are
longer, brighter and just as straight as a faint streak — so the static sky is
removed first. `analyzeNightSet`:

1. `SIRender.registerFramesMapped` — StarAlignment of every frame onto the
   first, keeping the input↔output mapping. Fewer than 3 registered (or
   openable, or geometry-consistent) frames → per-frame fallback.
2. Pass A: each registered frame is opened, its metadata read (falling back to
   the source file when registration lost DATE-OBS/EXPTIME), and average-binned
   so the long side is ≤ 1500 px (`SITrailDetect.binned`); the binned sky
   median is kept as a quality cue.
3. The plate-solved reference is re-opened and kept alive until every trail
   endpoint has been projected (an ImageSolver spline solution projects through
   the live window); if it cannot be re-opened the run says so and downgrades
   to the header-only approximate WCS (orientation fit later).
4. Frames are grouped **by FILTER** — one static-sky model per group, a group
   needs 3+ frames. Model, two rounds: per-pixel median of the non-empty binned
   values (`medianStackMasked`, zero-filled borders never vote), valid where at
   least `max(3, ceil(0.6·N))` frames cover; every frame is then linearly
   fitted onto that model (`linearFitToModel` / `applyLinear`) and the median
   rebuilt. The validity mask is eroded by 6 binned px; per frame it is ANDed
   with the frame's own coverage eroded by 6 px (Lanczos ringing sits inside a
   frame's coverage).
5. `SITrailDetect.detectDiff` per frame, on the **signed** residual
   (`subtractSigned`) high-passed by a 7-px box (`boxBlurSubtract`, clamped at
   zero afterwards); the noise level is estimated from the positive
   half-distribution (`noiseSigmaFromPositives`) and passed as
   `noiseOverride` because median/MAD collapse on clamped data. Two passes:
   - **Bright pass** — `detectCore` with `kSigma = diffKSigma`, gated per run
     by `thinOnly`: corridor concentration ≥ 0.45, not a noise line
     (`isNoiseLine`: rejected only when holey AND faint — zero fraction > 0.38
     and mean occupied value < 1.25 σ), and edge affinity ≤ 0.35 (fraction of
     the segment hugging the mask border at ±8 px).
   - Accepted bright segments are erased from the residual (half-width 5),
     then the **faint pass** (`detectFaintCore`, `FAINT_DEFAULTS`): z-normalize
     with `faintZCap` 4 and `faintZMin` 0.5, weighted Hough, box-smooth each θ
     row over `faintSmooth` 7 ρ bins, normalize to significance, accept peaks
     with refined line-integral significance ≥ `faintKLine` 6.0 σ (a peak
     under `max(3.5, faintKLine − 2)` is suppressed before refinement), up to
     `faintMaxTrails` 8, `minLengthFrac` 0.10, `maxPeekCandidates` 60; a
     candidate is also dropped when it hugs the mask (> 0.35), is a noise line
     at σ = 1, or fails uniformity (`faintChunks` 6 chunks, at least
     `faintChunkMinFrac` 0.75 of them populated). `faintFlattenRadius` is 0
     because the caller already flattened. Faint trails carry `faint: true`.
   - Both lists are merged (`mergeDuplicateTrails`, below) and photometry runs
     at full resolution on the registered image.
6. Width veto (entry script): a trail with `widthPx === null` or
   `widthPx > WIDTH_VETO_PX` (12) is dropped — residual cloud bands and
   stacking artefacts are broad, a 6–9 px bright satellite trail is kept.
7. Trails are projected to the sky through the reference WCS when it is a
   real solution or a manual TAN (`hasUsableWcs`); otherwise `p1`/`p2` stay
   `null` until the orientation fit. `spansEdgeToEdge` is set when both ends
   lie within `max(8, 3 %)` px of the border.
8. Point sources for the mover search (`extractPixelSources`, at most
   `maxSources`) are measured only when the reference has a usable WCS.
9. `SIMeteors.groupPlanes` bundles 3+ near-parallel segments (4° mod 180,
   within a 500-px perpendicular corridor) of one frame; the bundle is a
   `"plane"` when the median `brightnessVariation` of its members exceeds 0.3,
   a `"train"` otherwise. Bundles are excluded from matching and from the fit.
10. Best-frame pick for the composite background: rank by sky background and
    binned peak count, then measure star FWHM (StarDetector) on the top 3.

### Single-frame path (fallback)

`SITrailDetect.detect`: bin (long side ≤ 1500), median + MAD on the binned
array, threshold `median + k·MAD` with `kSigma` 5, k raised by ×1.4 (up to 12
times) while more than `maxAboveFrac` 8 % of pixels exceed it (clouds,
gradients), then the shared line stage below with `DEFAULTS` (`gapTol` 2,
`perpTol` 1, `corridorHalfWidth` 3, `maxPeekCandidates` 30).

### Shared line stage (`detectCore`)

- Hough transform (θ×ρ) over the binary map; per iteration up to
  `maxPeekCandidates` peaks are tried.
- Each peak is refined by `refineGrid` about a pivot on the coarse line: a
  coarse grid (±0.9° in 0.15° steps, ±3 px in 0.5 px steps) then a fine one
  about the run midpoint (±0.15° / 0.03°, ±0.5 px / 0.125 px), so an
  edge-to-edge trail at a non-integer angle stays one run (1° bins drift
  ~13 px across a 1500-px frame).
- Contiguity validation: the refined run must be ≥ `minLengthFrac·diagonal`
  long with fill ≥ `fillRatioMin` (stars along a chance line are sparse,
  trails are continuous), and pass the caller's `acceptSeg` gate if any.
- Accept → record endpoints, erase a corridor around the accepted **segment
  only** (other collinear runs — train members, flasher dashes — are
  re-proposed), iterate up to `maxTrails`.
- `mergeDuplicateTrails`: overlapping near-duplicates keep the longest;
  collinear fragments within `MERGE_PERP_PX` 4 binned px across at both ends,
  `MERGE_ANGLE_DEG` 2 in direction and a gap ≤ `MERGE_GAP_FRAC` 0.03 of the
  diagonal become one trail with the union extent. A merged trail is `faint`
  only when both parts were.
- Endpoints are scaled back to full-resolution pixels (`scaleSegment`).

### Photometry (`SITrailCore.measureTrail`, `PHOT`)

At `stations` 64 positions along the trail a perpendicular profile of
±`profileHalf` 16 px is read; the local background is the median of the
annulus |o| ∈ [`annulusInner` 10, 16] (each side separately, the lower one
used), the signal is the maximum within ±`probeHalf` 1 px of the line.
`meanFluxAdu` is the mean excess ×65535; `brightnessVariation` =
MAD(excess) / max(median(excess), 6 × median per-station noise) — sky level
and gradients cancel, a star crossing the trail only touches its own station,
and a trail below the full-resolution noise reads ~0.15–0.22, under the
**0.35** flasher/meteor cue (`SIMeteors.classifyTrail`), while a flasher's
alternating dashes give ~0.45+. `widthPx` is the median FWHM over
`widthStations` 8 (peak searched within `coreHalf` 6 px); a station whose
half-max crossing falls outside the window counts as broad, and when broad
stations outnumber measured ones `widthPx` is `null` (the veto's "too wide"
sentinel). No measurable signal at all gives `widthPx = 0` (not vetoed).

### Observer site and TLEs

Observer: the first frame whose headers carry a site wins —
`SIFrameMeta.read` takes latitude from `SITELAT`, `OBSGEO-B`, `LAT-OBS`,
longitude from `SITELONG`, `OBSGEO-L`, `LONG-OBS`, altitude from `SITEELEV`,
`OBSGEO-H`, `ALT-OBS` (first present, sexagesimal accepted); otherwise the
dialog fallback `observerLatDeg`/`observerLonDeg`/`observerAltM`. Without a
site, satellite identification is disabled with a console warning;
`observerSource` (`"headers"` | `"dialog"` | null) travels with the result.

TLEs: `SITleNet.fetchMergedTleText(tleGroup, tleExtraGroups, <config>/tle,
tleMaxAgeHours, tleBaseUrl)`. Per group, `fetchTle` serves the cache
(`<group>.tle` + `<group>.meta.json`) when younger than the max age, else
walks the source list — `tleBaseUrl` first if set, then CelesTrak
`gp.php?GROUP=<group>&FORMAT=tle`, then the mirror
`raw.githubusercontent.com/caelo-works/tle-mirror/main/tle/<group>.tle` — in
two passes (10 s per source, then 1.5 s pause and 25 s per source); a payload
must parse as ≥ 1 TLE record before it may overwrite the cache; when every
source fails an expired cache is served with `stale: true`; only a missing
cache throws. The `catalog` group exists only on the mirror (full GP
aggregate), so CelesTrak-style templates are skipped for it. Extra groups that
fail are warned and skipped; the merged text is NORAD-deduped
(`mergeTleTexts`). The SATCAT (`satcat.csv`, same cache discipline, 7 days,
sources CelesTrak then the mirror) gives owner/ops/type per NORAD id for flags
and natures; failure leaves an empty map.

### Matching (`SISatMatch.match(request, tleText)`)

Request: `observer {latDeg, lonDeg, altM}`, `frames[] {id, startUtc,
exposureSec, fov {raDeg, decDeg, widthDeg, heightDeg, rotationDeg, hasWcs},
trails[] {index, p1, p2, pixLength, meanFluxAdu, widthPx,
brightnessVariation}}`, `options {stepSec, matchMaxSepDeg,
matchMaxAngleDiffDeg, alongTolDeg}` (defaults 1.0 / 0.2 / 12 / 0.6). Frames
without a positive `EXPTIME` or without a FOV are skipped by the caller with a
warning; registered sets pass the reference FOV for every frame; bundle
members are left out of `trails`. Trails may lack sky coordinates
(`p1: null`) — crossings are still reported with `matchedTrailIndex: null`.

Response: `{ tle: {count, source}, frames[] {id, crossings[]}, errors[]
{frame, message}, error }` — `error` is set only when the whole request is
unusable; per-frame failures land in `errors[]` and the other frames are
still matched. A crossing carries `noradId, name, intlDes, entryUtc, exitUtc,
path {p1, p2}, angularRateDegPerSec, rangeKm, elevationDeg, sunlit,
sunlitFraction, shadowEntryUtc, shadowExitUtc, matchedTrailIndex, matchScore,
sepDeg, angleDiffDeg` (+ `matchConfidence` in loose mode).

Geometry chain per satellite and sample: SGP4 (satellite.js, WGS72 constants
as standard) gives a TEME state; the observer is placed on the **WGS84
ellipsoid** at its geodetic latitude/longitude/altitude and rotated by GMST
into the same frame; the topocentric vector (satellite − observer) is rotated
**TEME → J2000** (IAU76 precession + main nutation terms + equation of the
equinoxes, matrix cached per 0.01 day) before it becomes RA/Dec — the
plate-solved WCS is J2000, and skipping the rotation costs ~0.35° in 2026.

Coarse gate (`coarseCandidate`): the exposure window is sampled at **start,
middle and end**; from any sample the satellite is kept when its separation
from the field centre is ≤ half diagonal + (topocentric rate × exposure) +
`matchMaxSepDeg`, unless it sits below the horizon by more than that reach
plus 2°. A single midpoint sample would cull a fast low crosser that cut the
field in the first seconds.

Fine scan (`fineCrossings`): every `stepSec`, in-FOV (rotation-aware
rectangle, or the bounding circle when `rotationDeg` is null) and above the
horizon; each contiguous in-FOV run is one crossing. `isSunlit` (cylindrical
shadow, no penumbra — ±tens of seconds near the terminator) is evaluated at
**every sample**; the longest lit run inside the crossing is the lit
sub-path, and a lit/dark boundary between two samples is refined by bisection
(6 SGP4 calls, ~step/64) into `shadowExitUtc` (dark → lit) or
`shadowEntryUtc` (lit → dark). `sunlitFraction` is the lit share of the
in-FOV run; `sunlit` is `sunlitFraction > 0`. For a partially lit crossing
`path`, rate, range and elevation describe the **lit sub-path** — the only
part that can leave a streak — while `entryUtc`/`exitUtc` stay the FOV entry
and exit; range and elevation are taken at the sub-path midpoint. A crossing
lit at no sample keeps its full path and is listed with `sunlit: false` for
the ghost layer; only sunlit crossings are candidates anywhere.

Assignment (`assignTrailsCore`, one core, two modes; crossings and trails each
used at most once, conflicts resolved globally by score order). The trail
midpoint's offset from the crossing midpoint is decomposed against the
predicted track (`crossAlongDeg`): **cross-track** (sideways) and
**along-track** (early/late on the ephemeris, where TLE error lives).
Orientations are position angles at each segment's **midpoint**
(`segmentPaDeg`, mod 180°) — an endpoint PA carries the convergence of
meridians (5.9° over a 1° segment at δ = 80°). A pair is a candidate when
`cross ≤ gate.cross`, `along ≤ gate.along` and the orientation difference
`≤ gate.angle`; `lenScore = 1 − |cLen − tLen| / max(cLen, tLen)` compares
the rate as path lengths over the same window.

- **Strict** (`assignTrails`, plate-solved frames): gates
  `matchMaxSepDeg` across, `alongTolDeg` or `STRICT_ALONG_TOL_DEG` **0.6**
  along, `matchMaxAngleDiffDeg`; score
  `0.4·(1 − cross/gate) + 0.3·(1 − angle/gate) + 0.2·lenScore + 0.1·(1 − along/gate)`;
  no confidence tag.
- **Loose** (`assignTrailsLoose`, fitted orientation): gates
  `LOOSE_CROSS_TOL_DEG` **0.4**, `LOOSE_ALONG_TOL_DEG` **1.5**,
  `LOOSE_ANGLE_TOL_DEG` **12** (the entry script passes 0.4 / 1.5 /
  `matchMaxAngleDiffDeg`); score
  `0.5·cross + 0.3·angle + 0.1·along + 0.1·lenScore` (same normalization);
  matches tagged `matchConfidence: "high"`; then a **rescue pass**
  (`rescueTrails`) for the maneuvering constellations whose prediction lands
  sideways of the streak: an unmatched sunlit crossing and an unmatched trail
  pair up when their orientation differs by ≤ `RESCUE_MAX_ANGLE_DEG` **6**,
  the along-track offset is within the loose along gate and the cross-track
  offset within `RESCUE_CROSS_TOL_DEG` **0.8** — widened to
  `RESCUE_CROSS_TOL_TIGHT_DEG` **1.6** when the angle is ≤
  `RESCUE_TIGHT_ANGLE_DEG` **1.5**; a competitor sharing the crossing or the
  trail kills the pair unless its angle is > `RESCUE_COMPETITOR_MIN_ANGLE_DEG`
  **8** and ≥ `RESCUE_DOMINANCE_RATIO` **5** × max(`RESCUE_ANGLE_FLOOR_DEG`
  **0.5**, the pair's angle). Rescued pairs get `matchScore = RESCUE_SCORE`
  **0.5** and `matchConfidence: "medium"`.

Orientation fit (`fitOrientation`, registered set without a usable WCS): the
field centre and plate scale come from the pointing headers; rotation and
mirror parity are found by brute force against the sunlit crossings, scoring
each trail's best candidate by midpoint separation (≤ `fitMaxSepDeg` 0.6),
orientation (≤ `fitMaxAngleDiffDeg` 15) and length
(`0.5·sep + 0.3·angle + 0.2·len`), then the centre is corrected by the median
offset of the matched pairs. A fit with fewer than 3 pairs is discarded (two
pairs can almost always be made to agree) and crossers are reported as
predictions only. The winning synthetic TAN gives every trail sky coordinates
and `assignTrailsLoose` names them; `matchDiagnostics` adds, per trail, the
nearest sunlit candidate and its distance to every gate (`fitInfo.diag`).

### Classification of leftovers (`SIMeteors.classifyTrail`)

Cues: trail contained within the frame (`spansEdgeToEdge === false`),
`brightnessVariation > 0.35`, and radiant alignment — the great circle
through the trail passes within 8° of an **active** IAU major-shower radiant
(`SHOWERS` activity windows) and the radiant lies outside the segment (farther
than half the segment length from both ends; the highest-ZHR shower wins).
Radiant + one more cue → `meteor` with the shower name (`medium`); any two
cues → `meteor` without shower (`low`); steady (≤ 0.35) and edge-to-edge →
`satellite-candidate` (uncataloged); else `unknown`.

### Slow movers (`SIMeteors.findAsteroidCandidates`)

Runs when `detectAsteroids` is on and the frames have a **real** WCS
(single-frame path with sky coordinates, or a registered set whose reference
is plate-solved — a fitted orientation is only arcminute-accurate and dither
shifts sensor artifacts coherently in the reference grid). `filterStationary`
removes blobs recurring within 5″ in at least `max(2, ceil(N/2))` frames;
`findMovers` chains the rest: consecutive-frame pairs at a rate in
[0.1, 120] ″/min, extended by linear extrapolation within
`max(6, min(20, 5·dt1/dt0))` arcsec, never across gaps > 120 min; a track
needs 4 points when ≥ 4 usable frames exist (else 3), a constant-velocity fit
at rms ≤ 2.5″, monotonic, with total motion ≥ 10″. Dedupe: a candidate
sharing 2+ points with an already kept track is dropped. Then the
drift-family test: tracks sharing one velocity
(within `max(0.5, 25 %·rate)` ″/min) are a candidate registration-drift
family — but asteroids near opposition co-move, so the shared velocity alone
is not a verdict. With sensor pixel coordinates on every member (the
single-frame path passes `x, y` on the frame's own grid) a family of ≥ 3 is
vetoed **only when every member stays within 2 px** of one sensor position;
one member moving in pixels clears the whole family. Without pixels (the
registered path strips them: reference-grid pixels only restate the sky) the
blind rule re-collects the family at `max(0.2, 8 %·rate)` and vetoes it at
≥ 5 members. The entry script keeps a storm breaker behind that: more than
`MAX_PLAUSIBLE_MOVERS` 5 candidates on one field is reported as a
sensor-artifact storm and the list is suppressed.

### Events, report, composite

`SINightEvents.build` walks the frames in order and emits, per frame, the
matched satellites (`klass: "satellite"`, with SATCAT flag, nature, telemetry
line and shadow transitions), one event and one drawn line per bundle
(`plane` / `train`), the classified leftovers, and the sunlit crossers that
matched nothing as predicted passes; it also returns the labeled segments the
composite draws and the clean-frame / total-exposure counts. Movers are
appended as `asteroid` events by the entry script.

`SIReport.build(night, history, lang)` writes the Markdown night log
(chronology in UT, fun stats by operator and Starlink share, predicted
crossers, personal records) and the forum title. History lives at
`~/.caeloworks/sky-intruders/history.json` as `{ nights: [summary] }`, one
summary per night label — re-running a night replaces its entry
(`appendNight`); records compare the night's satellites, Starlink count and
meteors with the best previous night. `saveHistory: false` skips the write.

Composite: background = the best single frame (`nightResultCombine: "best"`)
or a max-combine of the registered set (`"max"`), auto-stretched
(`SIRender.stretchedBitmap`), annotated with every labeled trail plus the
optional ghost layer (predicted sunlit crossers in `#e8d44d`, eclipsed in
`#9aa0a8`, projected through the fitted TAN — only when a fit exists), saved
as `<system temp>/SkyIntruders-night-<date label>-<run token>.png` and shown
as an image window whose id is derived from `SkyIntruders_night` (sanitized
and uniquified with a counter). `debugFrameOverlays` additionally writes
`si-frame-annotated-<token>-<frame id>.png` per frame with that frame's trails
and all its predicted crossings as ghost lines.

## Persistent data (`~/.caeloworks/sky-intruders/`)

- `settings.json` — the parameter table above (full rewrite each save).
- `history.json` — personal records history, one entry per analyzed night.
- `tle/<group>.tle` + `tle/<group>.meta.json` (`fetchedUtc`, `sourceUrl`,
  `count`); `tle/satcat.csv` + `tle/satcat.meta.json`.
- `treasure-cache/<key>.json` — Treasure Hunt cone-search answers, 30 days;
  keys are `<kind>_v3_<ra>_<dec>_<radius>_<max>` for VizieR and
  `asteroid-v3_<ra>_<dec>_<radius>_<epoch>` for SkyBoT (coordinates rounded to
  3 decimals). Every key-version bump orphans the entries written before it;
  outages are never cached (see `docs/TREASURE-HUNT.md`).

## Treasure Hunt

See `docs/TREASURE-HUNT.md` for the catalogs, the body gates, the cache
contract and the capture scoring. In short: `runTreasureHunt` refuses an
image whose WCS kind is not `solution` or `tan`; cone-searches HyperLEDA,
Milliquas, MASH-I and SkyBoT (each `null` answer is recorded as a query
failure and flagged in the report, an empty array is a real empty field);
projects every row to pixels (`SITreasure.crossMatch`, sorted by notability);
measures a local aperture detection against decoy apertures
(`measureCapture` / `SITreasure.captureVerdict`), demotes captures whose
position error exceeds the aperture and those far fainter than their type's
honest non-detections (`applyMagConsistency`); renders the star chart
(`SIRender.chartField`, window id derived from `Sky Intruders Treasure Map`)
with offline context — named stars and NGC/IC objects from PixInsight's AdP
CSV files when found, Hipparcos through VizieR — and assembles the
self-contained HTML (`SITreasureReport.buildHtml`), offered for saving as
`SkyIntruders-Treasure-<OBJECT>.html` next to the source file.
