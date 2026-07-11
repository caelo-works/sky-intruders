# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
