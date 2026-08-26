# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The Release workflow now runs the Node test harness before building and
  refuses to publish on a red run; the harness also syntax-checks the
  unbundled PJSR files (entry script, `Render.js`) and bundles `Net.js` with
  unit tests for its TLE/SATCAT parsers. `docs/RELEASING.md` orders the steps
  as tests → commit → push `main` → tag → push tag and uses a process-local
  token instead of `gh auth switch`. Fixes #7.
- Every first-party source under `pjsr/` now opens with an SPDX licence
  identifier (`GPL-3.0-only`); the vendored `satellite.js` keeps its own
  MIT notice.
- The update package built by `scripts/build-update-package.sh` ships the
  repository `LICENSE` next to the entry script (still a reproducible zip).
- Node harness: the meteor slow-mover suite injects two synthetic rates
  (0.5 and 3 arcsec/min) into the real storm pool instead of four, cutting
  the harness run time by roughly half while keeping the zero-candidate
  storm pin and the drift-artifact family test.

### Fixed

- Satellite matching no longer loses a satellite that enters or leaves the
  Earth's shadow inside the field. The sunlit test used to run once, at the
  crossing midpoint: when more than half of the pass was eclipsed the crossing
  was rejected as a candidate, and the streak that fades out mid-frame — the
  textbook shadow-entry trail — went to the meteor heuristic, sometimes with a
  shower name attached. The flag is now evaluated at every fine sample, the
  transition instant is refined by bisection between samples, and the trail is
  matched on the lit sub-path (`path`, rate, range and elevation describe that
  sub-path; `sunlitFraction`, `shadowEntryUtc` and `shadowExitUtc` are new
  response fields). The night log then reads "entered Earth's shadow at
  HH:MM:SS UT" / "left Earth's shadow at …" (FR "entré dans l'ombre de la
  Terre à …" / "sorti de l'ombre de la Terre à …"), and the composite label
  carries "into shadow …" / "out of shadow …". A crossing lit at no sample is
  still listed as eclipsed and never matched. In the same pass the
  orientation gate now compares position angles measured at the segment
  midpoints instead of at one endpoint, which removed a ~6° spurious
  misalignment at δ = 80° that depended on which end the detector labelled
  first. Fixes #16.
- Night trails: a bright trail at a non-integer angle is no longer reported
  as 2–3 collinear fragments. The binary Hough pass now refines each peak to
  sub-degree / sub-pixel geometry the way the faint pass already did (shared
  helper; the search pivots on a point of the line, which also makes the
  faint-pass refinement effective far from the image origin), erases only
  the accepted segment instead of the whole line (collinear train members
  and flasher dashes are no longer swallowed), and the merge step joins
  collinear fragments separated by at most 3 % of the diagonal into one
  trail with the union extent. A crossing trail is now returned at full
  length instead of the half beyond the crossing. Fixes #14.
- Night trails: the 12-px width veto now works. The perpendicular profile
  used to hold 7 samples, so the measured FWHM could never exceed 6 px and
  the veto never fired; it now spans ±16 px with a robust background from
  the outer annulus (each side separately), reports `widthPx = null` when
  no half-max crossing exists inside the window, and the veto drops both
  cases (`WIDTH_VETO_PX`). Photometry moved into `SITrailCore.measureTrail`
  and subtracts a per-station local background before `meanFluxAdu` and
  `brightnessVariation`; the variation is floored at 6 × the per-sample
  noise so a trail invisible at full resolution no longer fires the 0.35
  flasher/meteor cue. Fixes #15.
- `tests/treasure.test.js`: the "no external asset URLs" check was written
  as `A && B || C`, which the credit link made vacuously true; it now lists
  every `http(s)` URL in the report and requires all of them to be the
  caelo.works credit. Fixes #13.
- Treasure Hunt no longer mistakes a VizieR error answer for an empty field.
  A live error body (`#INFO Error=…`) carries the same comment banner as a
  genuine answer, so the previous comment-line check accepted it and the empty
  result was cached for 30 days. VizieR bodies are now accepted only when they
  carry the data section (`#RESOURCE=` or the column header) and rejected
  outright when they carry an `Error=` line — both are reported as an outage
  (console line, report banner, nothing cached). The VizieR cache key moved to
  v3 so entries poisoned by earlier builds are never read again. The error body
  is pinned as a test fixture.
- Catalog answers that fill the row cap are no longer silently truncated: the
  console now warns *"catalog answer truncated at N rows"*, and every VizieR
  query carries a deterministic sort (largest galaxies and nebulae first,
  brightest quasars and stars first) so the rows dropped by the cap are the
  least notable ones rather than an arbitrary index order. Fixes #12.
- Night trails: a single frame with a corrupt header (bad `DATE-OBS`, zero
  `EXPTIME`, a propagation exception) no longer aborts satellite matching for
  the whole night. Frames with a non-positive `EXPTIME` are skipped with a
  console warning naming the frame; `match()` now isolates per-frame failures
  in an `errors[]` array and keeps matching the other frames; every match
  error is written to the console instead of being silently dropped, so
  "nothing identified" is no longer indistinguishable from a real empty result.
- Night trails: when the plate-solved reference cannot be re-opened after
  detection, the console now says so explicitly and the run downgrades to the
  header-based field-orientation fit, with the fit line labelled
  "(plate solve unavailable — orientation fit used instead)". Fixes #11.
- The night log now prints every time in UT with an explicit ` UT` suffix
  (chronology, predicted crossers, rush hour), matching the composite overlay
  instead of the computer's local clock. Same pass: the session exposure can
  no longer read `1h60`, the stats and forum title agree in number (`1
  satellite`, `one satellite crossed`, `nothing crossed`) and name the night
  instead of "last night", FITS quotes are stripped from the `OBJECT` target,
  operator labels are localized, and the predicted-crossers list is kept on
  nights with no detected trail. The Node harness runs under `TZ=UTC` and
  checks EN/FR golden markdown over a synthetic three-night history. Fixes
  #10.
- Night trails no longer leaks image windows or registered frames when the
  registered-difference analysis fails part-way. Every "open a file, use its
  first window, close it" site now goes through one `withWindow` helper with a
  `try/finally` (the plate-solved reference window keeps its extended lifetime
  until the projections are done), and the registration scratch directory is
  wiped in a `finally` of `runAnalysis` on every exit path. The scratch
  directory, the night result PNG and the per-frame debug overlays carry a
  per-run token (`si-night-reg-<token>`, `SkyIntruders-night-<date>-<token>.png`,
  `si-frame-annotated-<token>-<n>.png`) so concurrent PixInsight instances do
  not collide. Fixes #6.

- Asteroid candidates: the shared-velocity veto no longer discards real
  asteroid families. Main-belt asteroids in one ecliptic field near
  opposition move in step (a few tenths of an arcsec/min, within ~10 % of
  each other), and the previous rule — any 3 tracks within 25 % of one
  velocity are a registration-drift artifact family — reported none of them.
  A family is now vetoed on sensor evidence: when the blobs carry sensor
  pixel coordinates (single-frame path), 3+ co-moving tracks are dropped only
  if every member stays within 2 px of one sensor position; without pixels
  (registered path, whose reference-grid pixels only restate the sky) the
  blind rule requires 5+ tracks within max(0.2 arcsec/min, 8 % of the rate).
  The Node harness injects three synthetic asteroids at ~0.4 arcsec/min into
  the real storm pool (all three reported, with and without pixels), keeps
  the storm pinned at zero and the drift-artifact family vetoed in both
  branches, and checks that a pixel-stationary trio is still rejected. Fixes
  #17.
- The "Detection threshold (σ)" slider now drives the threshold a normal night
  run actually uses (`diffKSigma`, on the registered difference image; default
  4.5, range 2.5–8) instead of the single-frame fallback value it silently
  fed before. A new **Advanced** group on the Night trails tab exposes the
  single-frame threshold, the asteroid-candidate search toggle, the orbital
  data max age and a mirror URL, in both languages. `saveHistory`,
  `nightResultImage`, `nightResultCombine`, `debugFrameOverlays` and
  `matchDiagnostics` are declared in the defaults with the values the code
  implied, so they can be set from `settings.json`; loaded values are now
  type-checked (finite numbers, arrays of strings, `"best"`/`"max"` for the
  composite mode) and the max-combine composite is reachable through that key.
  Fixes #8.

- The observer-site fields accept a decimal comma (`48,85` no longer becomes
  48) and the sexagesimal forms the headers use, reject values outside
  ±90° / ±180° with a message on the status line instead of taking them at
  face value, carry the sign convention in their labels (+N / +E) and echo
  the accepted value with its hemisphere. A run without any observer site now
  says "No observer site — satellites not identified." on the status line and
  as a banner in the report window, in both languages, not only in the
  console; the console also prints the site that was used and where it came
  from. Fixes #9.

- Frames are identified by their position in the input list plus their file
  name (`NNN_<name>`) instead of the file name alone, so a night assembled
  from several capture folders that reuse `Light_001.fits` no longer merges
  two frames' satellite crossings, mover tracks or overlays into one.
  Registered copies in the scratch folder are named `NNN_<name>_r.xisf`
  (StarAlignment runs in as many batches as the largest name multiplicity,
  one in the usual case), the per-frame debug overlays carry the same tag,
  and the input list warns on duplicate file names in both languages. The
  night log and console still show the plain file name. The single-frame
  fallback no longer runs StarDetector on unsolved frames whose sources
  could never be projected, and the pass-A profiler timer and GUI yield now
  run on every skip path (a "geometry mismatch" drop is counted in the
  fallback warning). Fixes #18.

## [0.2.1] - 2026-08-17

**Validation** — all gates green on PixInsight 1.9.4 / Windows, 2026-08-17:
GUI construction smoke test in both languages (emblem, live language switch,
HTML and color dialogs); v8 runtime selftest clean; the 13-frame reference
night on the no-plate-solve path locks the orientation fit at 12 anchor pairs
and names 12 of 12 trails at high confidence (constellation-neighbour
identities re-rank with today's orbital elements, as documented); the
slow-mover storm pool that yielded 126 raw candidates on 0.2.0 yields 0, with
the storm breaker never invoked, on a full production re-run; catalog-outage
simulation against the production Treasure Hunt pipeline passes 13/13 checks
(null contract, no cache writes on failure, genuine empties cached, end-to-end
banner naming the one stubbed-down catalog while the others answer live);
Node pure-logic harness: all suites green, including the committed
126-candidate storm fixture pinned at zero and synthetic movers at
0.3–8 arcsec/min each recovered exactly once.

### Fixed

- The slow-mover (asteroid-candidate) detector no longer floods plate-solved
  night sets with sensor-artifact tracks (#5). A candidate now needs 4 points
  (3 only on a 3-frame set), a constant-velocity fit within 2.5″ rms, strictly
  monotonic motion totalling at least 10″, chaining only across gaps of up to
  2 hours; duplicate sub-tracks of one object are merged, and a family of 3+
  tracks sharing one velocity vector — sensor-fixed points carried by a
  registration drift — is dropped as a whole. The >5-candidate storm breaker
  stays as a backstop. Validated on the 13-frame reference set (126-candidate
  storm → 0, kept as a committed regression fixture) with synthetic movers at
  0.3–8 arcsec/min recovered exactly once each, including one seeded among a
  drifting artifact family.

- Treasure Hunt now distinguishes a catalog outage from an empty field (#1).
  The query layer returns a failure — instead of an empty result — when a
  catalog is unreachable, errors out, or answers with something that is not
  catalog data (an HTML maintenance or captive-portal page; a SkyBoT body
  reporting `Flag: -1`). The report's "some catalogs did not respond" banner,
  which could never fire before, now names the affected catalogs, and the
  console prints `catalog did not answer — flagged in the report` per failed
  catalog. `N row(s)` lines are now only printed when the catalog actually
  answered.
- A failed deep-catalog query is no longer cached as an empty field for 30
  days (#2). Only genuine catalog answers reach the treasure cache, and the
  cache key format was versioned so entries poisoned by earlier builds are
  ignored instead of being served.

## [0.2.0] - 2026-07-16

**Validation** — all gates green on PixInsight 1.9.4 / Windows, 2026-07-16:
GUI construction smoke test in both languages (including the new observer-site
tooltip key); the 13-frame reference night on the no-plate-solve path locks the
orientation fit at 12 anchor pairs and names 12 of 12 trails at high
confidence, matching the day's post-fix reference exactly; the plate-solved
reference night names 3 of 5 trails at high confidence (SPACEMOBILE-009,
SL-14 R/B, QIANFAN-2 — the remaining two have no sunlit counterpart within
2.5° of 31k cataloged objects) with the slow-mover storm breaker verified (41
artifact candidates on the same input before, zero reported after, real-mover
budget preserved); frame corrections anchored on sky at 0.009° (32″)
cross-track residual through the rebuilt Node module; Node pure-logic harness:
all suites green. Console log clean (the only grep hits are PixInsight's usual
headless GLES-fallback notices, present on every headless run). Note for
future baseline comparisons: identifications of past nights are only
reproducible with observation-epoch orbital elements — week-stale replays
re-rank along-track neighbors within constellations by simple physics.

### Added
- Identified satellites now say what they are: the overlay telemetry line and
  the night-log lines carry the object's nature from the SATCAT — *in service*
  / *out of service* for payloads, *rocket body* or *debris* for the rest,
  *unknown* when the catalog has no status (typically classified objects).
  Rocket bodies and debris carry no operational status at all, which is why
  they used to show nothing; with the full-catalog group now naming them, a
  1986 Tsyklon-3 stage reads `1 449 km · 0.36°/s · 1986 · rocket body`.
- `docs/support-kb.md` — the knowledge base the Discord support agent answers
  from: the facts card, install routes, every control in both languages with its
  default, both modes end to end, the exact text of every message, the known bugs
  to read *before* answering, a symptom → cause → answer table, and when to stop
  and escalate. Structured for the KB importer (no section runs past the chunk
  limit without subheadings, and each one stands on its own). Keeping it 100% in
  sync with the code is a step of the release ritual (`docs/RELEASING.md`).

### Fixed
- Night trails: a plate-solved reference frame now actually drives strict
  per-trail WCS matching. An ImageSolver solution projects through the live
  image window, but the pipeline closed the reference window before it projected
  the trail endpoints, so every real plate solve produced null sky coordinates
  and identification silently fell back to the field-orientation fit. The
  reference now stays open until every projection is done, then is released. The
  non-plate-solved path is byte-identical (validated on the 13-frame reference
  night: same 8 named satellites, same events and report). Fixes #3.
- Satellite matching frames of reference: SGP4 states are now rotated from
  TEME of date to J2000 before comparison with plate-solved coordinates, and
  the observer sits on the WGS84 ellipsoid instead of a sphere with geodetic
  latitude read as geocentric (23.7 km of site misplacement at mid-latitudes —
  0.2° to ~2° of topocentric error at LEO ranges). The two errors added up to
  more than the 0.2° strict gate, so the strict matcher could practically
  never match; the layer was unreachable until the window-lifetime fix above.
  Proof on the reference night: a QIANFAN-2 trail's cross-track residual drops
  from 0.351° to 0.009° (32 arcsec), and two more trails gain names —
  SPACEMOBILE-009 at 0.04° (its mismodeled track previously passed 0.875° off,
  outside the search FOV) and SL-14 R/B from the widened catalog. Fixes #4.
- Slow-mover storm breaker: on plate-solved sets the mover detector can chain
  dithered sensor artifacts into dozens of fake "asteroid candidates" (the
  stationarity test works in sky coordinates; hot pixels sit still in sensor
  coordinates). Until that is hardened (#5), more than 5 candidates on one
  field is treated as an artifact storm: the list is suppressed and the log
  says so instead of reporting dozens of false asteroids.
- The coarse candidate cull sampled position and angular rate only at the
  exposure midpoint, so a fast, low satellite that cut the field in the first
  seconds of a long exposure was culled tens of degrees away before the fine
  sampler ever saw it. The window is now sampled at start, middle and end, and
  the satellite is kept if any sample makes the field reachable.

### Changed
- The Observer site group no longer names only SITELAT/SITELONG: its label
  reads "only if the FITS headers carry none" and a new tooltip lists every
  header pair actually read (SITELAT/SITELONG, OBSGEO-B/L, LAT/LONG-OBS,
  decimal or sexagesimal, plus the elevation keywords). The no-observer console
  warning lists them too — all three families were already read; the wording
  just stopped pretending otherwise.
- The strict trail assigner now gates on a cross/along decomposition of the
  midpoint offset — within 0.2° *across* the predicted track, 0.6° *along* it,
  orientation within 12° — the same form the field-orientation path already
  used. Raw midpoint separation let ordinary along-track TLE timing error eat
  the whole budget; cross-track is what a TLE actually gets right.
- Satellite elements now include the full GP catalog group (a mirror-side
  aggregate, ~31k objects), on top of the active/recent groups. The old merge
  covered ~19k of ~34k on-orbit objects — missing ~2.3k rocket bodies, ~1.5k
  defunct payloads and most debris — exactly the high-orbit population still
  sunlit deep in the night, which is why bright late-night trails came out
  "uncataloged". Saved settings carrying the former default are upgraded in
  place (the group list has no dialog control).
- `tests/fixtures/match/` re-pinned for the corrected geometry; the ECI states,
  times, ranges and elevations remain pinned to the reference engine, so it
  stays the certified oracle for propagation.

## [0.1.1] - 2026-07-11

**Validation** — all gates green on PixInsight 1.9.4 / Windows, 2026-07-11:
GUI construction smoke test in both languages, including a new assertion that
the header emblem actually rasterized the icon; Night trails on the 13-frame
reference night — output matches the 0.1.0 baseline exactly (12 trails, 8
satellites named, 4 honestly uncataloged, zero false movers); update package
rebuilt and inspected — the icon ships byte-identical at both install
locations; Node pure-logic harness: all suites green. Console log clean (the
only grep hits are PixInsight's usual headless GLES-fallback notices, present
on every headless run).

### Changed
- New script icon (`SkyIntruders.svg`): the tile is the sky field itself — one
  bold diagonal trail as the silhouette, the amber treasure star in the corner
  the trail leaves free. Used everywhere the previous placeholder appeared:
  Scripts menu and Feature Scripts (`#feature-icon`), dialog header emblem, and
  both install locations in the update package.
- The script now registers in the dedicated **CaeloWorks** menu category, with
  a script identifier in `#feature-id` (`SkyIntruders : CaeloWorks > Sky
  Intruders`) — the identifier is required by PixInsight to resolve the menu
  icon and to code-sign the script.
- The dialog header emblem follows the UI scaling of high-density displays
  (rasterized at physical-pixel size, like every other control).

### Fixed
- The installed-layout icon lookup walked three directory levels up instead of
  four, so the `rsc/icons/script/` fallback could never resolve; the emblem
  only appeared thanks to the copy shipped next to the script.

## [0.1.0] - 2026-07-09

Every release entry states its VALIDATION evidence (which run, which gates).

**Validation** — all gates green on PixInsight 1.9.4 / Windows, 2026-07-09:
GUI construction smoke test (both languages, color picker); Night trails on the
13-frame reference night — output matches the baseline exactly (12 trails, 8
satellites named, 4 honestly uncataloged, zero false positives); Treasure Hunt
on three plate-solved masters (M 16, NGC 6888, NGC 6992) — no errors, capture
scoring matches the baseline (one credible capture on M 16, the mag-19 quasar
correctly reported below the noise); Node pure-logic harness: all suites green.

### Added
- **Night trails mode** — detect trails in light frames and identify them:
  satellites by TLE cross-match (CelesTrak) + SGP4 propagation, meteors by active
  IAU shower radiant alignment, asteroid candidates by coherent slow motion across
  frames. Bilingual night-log report with fun stats, persistent personal records
  and a Reddit-ready post.
- **Treasure Hunt mode** — on a plate-solved image, cone-search VizieR (HyperLEDA
  galaxies, Milliquas quasars with redshift, MASH planetary nebulae) and SkyBoT
  (asteroids at the capture epoch); measure every catalog position on the image so
  the report honestly separates *captured* from *in the field, below your noise*;
  narrate the finds with cosmology facts; render a star-chart overlay (leader
  lines, corner cards, context stars from Hipparcos and NGC/IC neighbors, user
  accent color) and a standalone illustrated HTML post.
- 100% PJSR: networking via `NetworkTransfer`, SGP4 via a vendored satellite.js
  5.0.0 (MIT); no native helper. A Go reference implementation of the orbital
  engine lives in git history and generated the `tests/fixtures/match/` fixtures
  the JS port is verified against.

### Validation
- Node pure-logic harness (`tests/run.sh`): 10 suites green (stats, frame
  metadata/WCS, trail detection, SGP4 matching vs the Go fixtures, meteors/movers,
  cosmology, catalog parsing, treasure cross-match and capture scoring).
- Headless PixInsight self-test (`tests/selftest-pi.js`) on 1.9.4/Windows: include
  chain, satellite.js on the v8 global, SGP4 fixture match, live NetworkTransfer
  download, StarDetector shape, report build — all pass.
