<div align="center">

# Sky Intruders

### The hidden life of your astrophotos — who crossed them, and what they caught without you knowing

[![Version](https://img.shields.io/badge/version-0.4.0-22d3ee?style=for-the-badge&labelColor=0f172a)](https://github.com/caelo-works/sky-intruders/releases/latest)
[![PixInsight](https://img.shields.io/badge/PixInsight-%E2%89%A5%201.9.4-67e8f9?style=for-the-badge&labelColor=0f172a)](https://pixinsight.com/)
[![Status](https://img.shields.io/badge/status-beta-fbbf24?style=for-the-badge&labelColor=0f172a)](https://pixinsight-scripts.caelo.works/en/scripts/sky-intruders)
[![License](https://img.shields.io/badge/license-GPL--3.0-94a3b8?style=for-the-badge&labelColor=0f172a)](LICENSE)

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

## Screenshots

<div align="center">

![Sky Intruders — Night trails: annotated composite of a night on the Veil Nebula, twelve trails detected, eight satellites identified by name with country flag, altitude, angular speed and UT time; unidentified trails honestly left orange](https://pixinsight-scripts.caelo.works/assets/scripts/sky-intruders-3-night.webp)

*The **Night trails** result — a night on the Veil: twelve trails detected, eight satellites named with flag, altitude, angular speed and UT time; the uncataloged ones honestly left orange.*

![Sky Intruders — Treasure Hunt: star chart of the Crescent Nebula (NGC 6888) circled at its catalog size, with the Wolf-Rayet star HD 192163 at its heart, Star chart and Observation data cards](https://pixinsight-scripts.caelo.works/assets/scripts/sky-intruders-4-treasure-crescent.webp)

*A **Treasure Hunt** star chart — the Crescent circled at its catalog size, the Wolf-Rayet star HD 192163 at its heart, and the field's principal stars with magnitude and spectral type.*

![Sky Intruders — Treasure Hunt on the Veil: three NGC objects circled, eight stars labeled, and a Gaia quasar at z = 2.2 marked below the noise — in the field, but under this image's noise floor](https://pixinsight-scripts.caelo.works/assets/scripts/sky-intruders-5-treasure-veil.webp)

*Honest captures — a Gaia quasar at z = 2.2 sits in the Veil field, and the chart says so: "below the noise", not "captured".*

![Sky Intruders — the Night trails tab: detection threshold in sigma, optional predicted-crosser overlay, fallback observer site, and the frame list](https://pixinsight-scripts.caelo.works/assets/scripts/sky-intruders-1-ui-night.webp)
![Sky Intruders — the Treasure Hunt tab: catalog row cap, per-type hunt checkboxes, chart accent color, and the plate-solved input image](https://pixinsight-scripts.caelo.works/assets/scripts/sky-intruders-2-ui-treasure.webp)

*The two tabs — bilingual, live-switchable, every setting remembered.*

</div>

## Installation

### From the CaeloWorks update repository (recommended)

In PixInsight, open **Resources → Updates → Manage Repositories** and add
`https://pixinsight-scripts.caelo.works/update/`, then run
**Resources → Updates → Check for Updates**, accept the install and restart.
Updates are then delivered automatically through the same channel. The
repository is CPD-signed, and so is the script itself (from 0.4.0): it carries
the CaeloWorks code signature (`SkyIntruders.xsgn`), so it runs with
**Allow execution of unsigned scripts** turned off. Editing an installed file
invalidates the signature; reinstall from the repository to restore it.

The package also installs the script's reference documentation, in English
and French: open it from the documentation button at the bottom left of the
script window.

### Manual install

Download the archive from the **[Releases](https://github.com/caelo-works/sky-intruders/releases)**, then in
PixInsight use **Script → Feature Scripts…**, click **Add** and select the
folder containing `SkyIntruders.js`. Alternatively, run it once via
**Script → Execute Script File…**.

> **Requires PixInsight 1.9.4 or newer** — Windows, macOS and Linux.
> Internet access is needed for the orbital and deep-sky catalogs (all cached,
> with graceful offline degradation) — see [Network and privacy](#network-and-privacy).

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

## Network and privacy

Every connection is HTTPS, made through PixInsight's own networking
(`NetworkTransfer`); a plain `http://` address is refused. The script contacts:

| Host | When | What is sent |
|---|---|---|
| `celestrak.org` | Night trails | the name of the orbital-element group (e.g. `active`); the satellite catalog (SATCAT) is a plain file download |
| `raw.githubusercontent.com/caelo-works/tle-mirror` | Night trails, only when CelesTrak does not answer | the same group name. This is a CaeloWorks-operated snapshot of CelesTrak data, published with a SHA-256 manifest |
| `vizier.cds.unistra.fr` | Treasure Hunt | the field centre (RA/Dec), the search radius and the catalog columns wanted |
| `ssp.imcce.fr` (SkyBoT) | Treasure Hunt, asteroids | the field centre (RA/Dec), the search radius and the capture epoch |
| a mirror of your own | Night trails, only if you fill **Orbital data mirror URL** | the group name. The URL must start with `https://`; anything else is ignored |

The script window names these services too: CelesTrak and the CaeloWorks
mirror in the Night trails help line, VizieR and SkyBoT in the Treasure Hunt
one. The **by CaeloWorks** link opens the product page only when you click it;
nothing connects to `caelo.works` otherwise.

What is **not** sent: your observer site (satellite orbits are computed on your
computer), file names, image data, or any identifier. There is no telemetry and
no usage tracking. Everything downloaded is data (orbital elements and catalog
rows); nothing is ever executed.

## Data integrity

- **Orbital elements** — every element line carries a modulo-10 checksum,
  verified whatever the source. An element set that fails is dropped (the
  console says how many); a download where more than 5 % fail is rejected as
  corrupt and the next source, or the cache, is used.
- **CaeloWorks mirror** — every file downloaded from it is checked against the
  mirror's SHA-256 manifest (`tle/SHA256SUMS`). After one retry, a file that
  still does not match, or a manifest that cannot be fetched, means the mirror
  is not used: CelesTrak or the cache is used instead.
- **VizieR, SkyBoT and the CelesTrak SATCAT** publish no checksums. They are
  protected by HTTPS plus strict format validation: an answer that is not
  genuine catalog data (an error or maintenance page, for instance) is
  rejected, reported, and never cached.

## Files written on your computer

Everything persistent lives in one folder in your home directory
(`%USERPROFILE%` on Windows, `~` on macOS and Linux):
`.caeloworks/sky-intruders/`. Nothing is written inside the PixInsight
installation.

| Path | Content | Safe to delete? |
|---|---|---|
| `settings.json` | dialog settings | yes — resets every setting to its default |
| `history.json` | your personal night records | yes, but the records are gone for good |
| `tle/` | orbital-element and SATCAT cache | yes — downloaded again on the next run |
| `treasure-cache/` | deep-catalog answers, kept 30 days | yes — the catalogs are queried again |

To stop keeping night records, close the script, open `settings.json` in a
text editor and set `"saveHistory": false`; delete `history.json` if you want
the existing records gone too. To remove everything the script stores, delete
the whole `.caeloworks/sky-intruders` folder while the script is closed.

In the system temporary folder:

- `si-night-reg-<token>/` (registered frames) — removed at the end of each run.
- `si-render-*` (image encoding scratch) — removed right after use.
- The Treasure Hunt HTML report copy written by **Open HTML**, and the
  optional debug overlays `si-frame-annotated-<token>-*.png` — removed when the
  script window closes.
- `SkyIntruders-night-<date>-<token>.png`, the annotated night image — **kept
  on purpose, and never cleaned up automatically**: it is the image the result
  window opens (**Open image**). Save it where you want it; the copy in the
  temp folder can be deleted at any time.

Files you save yourself (**Save report…**, **Save HTML…**) go only where you
choose.

## Report attribution

Reports do not mention Sky Intruders unless you ask: tick **Credit Sky
Intruders at the end of reports**, under the mode tabs, to end the night log,
its forum text and the Treasure Hunt HTML report with "Report generated by Sky
Intruders for PixInsight" and the product page address. It is **off by
default** (also after an upgrade from 0.3.x, whose reports always carried it)
and saved in `settings.json` as `reportAttribution`.

## Programs launched

Sky Intruders starts no program of its own and ships no executable. On your
click only — **Open image**, **Open HTML**, or the **by CaeloWorks** link
to the product page — it asks the operating system to open the file or address
with its default application: `cmd /c start` on Windows, `/usr/bin/open` on
macOS, `xdg-open` on Linux.

## Third-party notices

- [satellite.js](https://github.com/shashwatak/satellite-js) 5.0.0 (SGP4
  propagation) — MIT License, bundled in `pjsr/lib/vendor/`.
- [circle-flags](https://github.com/kapowaz/circle-flags) (country flags) —
  MIT License, see `pjsr/assets/flags/LICENSE.md`.
- Sky Intruders itself is released under the [GPL-3.0](LICENSE).

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
  PixInsight updater: `src/scripts/CaeloWorks/SkyIntruders/` (the script, its
  libraries and assets), the menu icon under `rsc/icons/script/`, and the
  documentation pages under `doc/scripts/SkyIntruders/` and
  `doc/scripts/SkyIntruders-fr/`. The unsigned archive is reproducible on a
  given build environment: rebuilt there, its sha1 only changes when the
  content changes.
- **`update-package.json`** — the metadata contract for the site: name, slug,
  version, `fileName`, `sha1`, type, `releaseDate`, `piVersionRange`, title
  and `descriptionHtml`.

`scripts/check-package.sh [--signed] <zip>` checks the package against that
contract. A release is then signed with the CaeloWorks CPD identity by
`scripts/sign-package.sh <zip>` (PixInsight and the signing keys required; a
signed zip is no longer reproducible, its sidecar carries the new sha1). The
documentation pages are compiled from `docs/pidoc/` by
`scripts/build-script-doc.sh` and committed. See
[docs/RELEASING.md](docs/RELEASING.md).

## License

[GPL-3.0](LICENSE) © CaeloWorks
