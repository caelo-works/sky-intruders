# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- The coarse candidate cull sampled position and angular rate only at the
  exposure midpoint, so a fast, low satellite that cut the field in the first
  seconds of a long exposure was culled tens of degrees away before the fine
  sampler ever saw it. The window is now sampled at start, middle and end, and
  the satellite is kept if any sample makes the field reachable.

### Changed
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
