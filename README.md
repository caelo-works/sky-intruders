<div align="center">

# Sky Intruders

### The hidden life of your astrophotos — who crossed them, and what they caught without you knowing

[![Version](https://img.shields.io/badge/version-0.1.0-22d3ee?style=for-the-badge&labelColor=0f172a)](https://github.com/caelo-works/sky-intruders/releases/latest)
[![PixInsight](https://img.shields.io/badge/PixInsight-%E2%89%A5%201.9.4-67e8f9?style=for-the-badge&labelColor=0f172a)](https://pixinsight.com/)
[![Status](https://img.shields.io/badge/status-beta-fbbf24?style=for-the-badge&labelColor=0f172a)](https://pixinsight-scripts.caelo.works/en/scripts/sky-intruders)
[![License](https://img.shields.io/badge/license-GPL--3.0-94a3b8?style=for-the-badge&labelColor=0f172a)](LICENSE)
[![Website](https://img.shields.io/badge/%E2%86%92%20see%20all%20scripts-pixinsight--scripts.caelo.works-0f172a?style=for-the-badge&labelColor=22d3ee)](https://pixinsight-scripts.caelo.works/en)

[![CaeloWorks · PixInsight Scripts](https://pixinsight-scripts.caelo.works/assets/readme-banner.png)](https://pixinsight-scripts.caelo.works/en)

</div>

---

## Overview

Every imaging session collects more than your target. Satellites streak through
your subs, meteors flash by, asteroids drift across the field — and behind your
nebula hide galaxies and quasars you never knew you captured. Sky Intruders
surfaces all of it, in two modes, everything running inside PixInsight — no
native helper to install or trust.

**Night trails** scans a night's light frames and, instead of just rejecting the
streaks, **identifies them by name**: every trail is cross-matched against
up-to-date orbital data propagated with SGP4, so the night log reads
*"02:13 — STARLINK-4512"*, not just "trail". Unmatched trails are tested against
the active meteor showers; slow coherent movers become asteroid candidates. The
session ends with an annotated composite — each streak labeled with the
satellite's name, country flag, altitude and speed — and a bilingual night log
with fun stats and a ready-to-post report.

**Treasure Hunt** points at a single plate-solved image and hunts the deep
catalogs for everything hiding in the field: PGC galaxies, quasars with their
redshift, planetary nebulae, asteroids that drifted through at the moment of
capture. Every catalog position is then **measured on your image**, so the
report honestly separates *captured* from *in the field, below your noise* —
and the story writes itself: *"this smudge is a quasar at z = 2.2: its light
left 10.7 billion years ago, before the Sun existed."* The result renders as a
star chart — leader lines, corner cards, the field's principal stars and
deep-sky neighbors for context — plus a standalone illustrated HTML post.

> 📖 **Full details, screenshots & docs:** **[pixinsight-scripts.caelo.works/en/scripts/sky-intruders](https://pixinsight-scripts.caelo.works/en/scripts/sky-intruders)**

## Features

| | |
|---|---|
| 🛰️ **Named satellites** | Trails cross-matched against CelesTrak TLEs (active + recent launches, merged and cached) propagated with SGP4; identification survives missing plate solves via a field-orientation fit, and each match carries a confidence grade |
| ☄️ **Meteors & movers** | Unmatched trails tested against the active IAU shower radiants; coherent slow drift across frames flagged as asteroid candidates; parallel bundles grouped into satellite trains or planes |
| 🖼️ **Annotated composite** | The night's best frame (quality-scored) with every streak highlighted and labeled — name, country flag from the satellite catalog, altitude · angular speed · launch year · status — with label collision avoidance; optional ghost layer for predicted crossers |
| 💎 **Honest captures** | Treasure Hunt measures an aperture detection at every catalog position, with decoy apertures and per-type magnitude consistency as false-alarm guards — a mag-20 asteroid in the field is never sold as "captured" |
| 🗺️ **Star-chart overlay** | One accent color (user-selectable), thin markers, elbowed leader lines, corner cards for title / legend / observation data; context from Hipparcos stars and NGC/IC objects at their true catalog size |
| 📜 **Stories, not rows** | Redshifts become lookback times ("before the Sun existed"), sizes become pixel smudges, and the whole hunt exports as a self-contained illustrated HTML post ready for a forum |
| 🌐 **Online catalogs, cached** | CelesTrak, VizieR (HyperLEDA, Milliquas, MASH, Hipparcos) and SkyBoT through PixInsight's own networking — responses cached on disk, outages reported instead of read as "zero finds" |
| 🌍 **Bilingual UI** | English and French, switchable live — interface, night log, chart and HTML report alike; settings remembered across sessions |

## Installation

### From the CaeloWorks update repository (recommended)

In PixInsight, open **Resources → Updates → Manage Repositories** and add
`https://pixinsight-scripts.caelo.works/update/`, then run
**Resources → Updates → Check for Updates**, accept the install and restart.
Updates are then delivered automatically through the same channel.

> The repository is not CPD-signed yet, so PixInsight shows an
> "unsigned repository" warning; signing is underway.

### Manual install

Download the archive from the **[Releases](https://github.com/caelo-works/sky-intruders/releases)**, then in
PixInsight use **Script → Feature Scripts…**, click **Add** and select the
folder containing `SkyIntruders.js`. Alternatively, run it once via
**Script → Execute Script File…**.

> **Requires PixInsight 1.9.4 or newer** — Windows, macOS and Linux.
> Internet access is needed for the orbital and deep-sky catalogs (all cached,
> with graceful offline degradation).

## Getting started

**Night trails**
1. Add a night's light frames — FITS or XISF, files or a whole directory. They
   need `DATE-OBS`/`EXPTIME`; satellite identification also wants an observer
   site (`SITELAT`/`SITELONG` headers, or the manual fallback in the dialog).
2. Click **Analyze night**. Frames are registered internally and trails are
   detected on the registered difference — nebulosity does not fool it.
3. Read the night log, and open the annotated composite: every streak labeled,
   identified satellites with flag and telemetry.

**Treasure Hunt**
1. Open (or add) a **plate-solved** image — a WBPP master solved with
   ImageSolver is perfect. Without a solution the mode tells you and stops.
2. Pick which object types to hunt and click **Hunt treasures**.
3. You get the star chart as a new image window, and an illustrated HTML
   report — open it in your browser, or share it as a single file.

## Development

<details>
<summary><b>Tests &amp; validation</b></summary>

Logic-level tests (robust statistics, WCS math, trail detection, SGP4 matching
against certified fixtures, meteor radiants, cosmology, catalog parsing,
treasure cross-match and capture scoring) run under Node without PixInsight:

```bash
tests/run.sh
```

PixInsight-side behavior is validated headless on real data: a construction
smoke test for the full GUI (`SI_CONSTRUCT_TEST=1`), integration self-tests on
synthetic images, and testset runners (`tests/run-night-testset.js`,
`tests/run-treasure-testset.js`) that drive the production pipelines end to
end. Every release passes two gates: a clean console log, and outputs matched
against a known-good reference night.

</details>

## Releasing — update-repository package

Distribution through the CaeloWorks update repository relies on a
standardized artifact built here and ingested by the site repository
(which owns the aggregated, signed `updates.xri`). To build it:

```bash
scripts/build-update-package.sh <version> [releaseDate YYYYMMDD]
```

This produces two files under `dist/`:

- **`SkyIntruders-<version>.zip`** — the install tree extracted as-is by the
  PixInsight updater (`src/scripts/CaeloWorks/SkyIntruders/SkyIntruders.js`,
  the menu icon and the bundled assets). The archive is reproducible on a
  given build environment: rebuilt there, its sha1 only changes when the
  content changes.
- **`update-package.json`** — the metadata contract for the site: name, slug,
  version, `fileName`, `sha1`, type, `releaseDate`, `piVersionRange`, title
  and `descriptionHtml`.

## License

[GPL-3.0](LICENSE) © CaeloWorks
