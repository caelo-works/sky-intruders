# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Every release entry states its VALIDATION evidence (which run, which gates).

### Added
- **Night trails mode** — detect trails in light frames and identify them:
  satellites by TLE cross-match (CelesTrak) + SGP4 propagation, meteors by active
  IAU shower radiant alignment, asteroid candidates by coherent slow motion across
  frames. Bilingual night-log report with fun stats, persistent personal records
  and a Reddit-ready post.
- **Treasure Hunt mode** — on a plate-solved image, cone-search VizieR (HyperLEDA
  galaxies, Milliquas quasars with redshift, MASH planetary nebulae) and SkyBoT
  (asteroids at the capture epoch); narrate the finds with cosmology facts; render
  an interactive PixInsight overlay and a standalone illustrated HTML post.
- **Trash to Art mode** — recycle rejected frames into an intruder-choreography
  poster, a star-trail composite, and a designed poster.
- 100% PJSR: networking via `NetworkTransfer`, SGP4 via a vendored satellite.js
  5.0.0 (MIT); no native helper. A Go reference implementation of the orbital
  engine lives in git history and generated the `tests/fixtures/match/` fixtures
  the JS port is verified against.

### Validation
- Node pure-logic harness (`tests/run.sh`): 10 suites green (stats, frame
  metadata/WCS, trail detection, SGP4 matching vs the Go fixtures, meteors/movers,
  cosmology, catalog parsing, treasure cross-match, trash-to-art composition).
- Headless PixInsight self-test (`tests/selftest-pi.js`) on 1.9.4/Windows: include
  chain, satellite.js on the v8 global, SGP4 fixture match, live NetworkTransfer
  download, StarDetector shape, report build — all pass.
