# Sky Intruders — Treasure Hunt mode

*What you photographed without knowing.* Point Treasure Hunt at a single
plate-solved final image and it hunts the deep catalogs for everything hiding in
your field: PGC galaxies down to mag ~17, quasars with their redshift, asteroids
that drifted through at the moment of capture, tiny planetary nebulae. Then it
tells the story — *"this 4-pixel smudge is a quasar at z = 2.3: its light left
11 billion years ago, before the Sun existed. You captured 47 galaxies without
knowing."* — as an interactive annotated overlay in PixInsight and a standalone
illustrated HTML post ready for a forum.

This is a **second mode** of the Sky Intruders script, sharing its WCS,
networking and reporting DNA. Where the night-trails mode asks *who crossed your
photo*, Treasure Hunt asks *what's already in it*.

## Input & requirements

- One image window with a **valid astrometric solution** — a WCS of kind
  `solution` (ImageSolver / the mount's solver, projected through the live
  window) or `tan` (manual CRVAL/CRPIX/CD keywords). Without it there is no way
  to place catalog objects on pixels — the mode refuses to run and says so.
- Internet access (VizieR + SkyBoT cone searches, cached per field for 30
  days).

## Pipeline (`runTreasureHunt`)

1. From the WCS: field center (RA, Dec), search radius = half the field
   diagonal, pixel scale. Epoch = `DATE-OBS` (the frame's start; current time
   when the keyword is missing). `wcs.celestialToImage` is the inverse of the
   trails mode's `imageToCelestial`.
2. Cone-search each enabled catalog (see below) through `SICatalogs` /
   `SINet`, capped at `treasureMaxRows` rows (default 400). Each query returns
   **`null` for an outage and `[]` for a genuinely empty field**: a `null` is
   recorded in `queryFailures` (console line *"catalog did not answer — flagged
   in the report"*, banner in the HTML) and never cached; an exception is
   treated the same way.
3. `SITreasure.crossMatch`: project every row to pixels, keep those inside the
   frame, attach a **notability** score (quasars 300 + 20·z + (24 − Rmag);
   galaxies 200 + min(90, 6·diameter′); planetary nebulae 150 + min(90,
   30·diameter′); asteroids 100 + (22 − Vmag)) and sort descending. A pixel
   diameter is attached from the catalog size and the plate scale.
4. **Capture scoring** — separates *captured* (signal present) from *in field,
   below your noise floor*:
   - Aperture radius `apR` = half the pixel diameter clamped to [3, 40] px
     (4 px without a size); background annulus [apR + 3, apR + 3 + max(4, apR)].
   - `SITreasure.apertureDetection`: background = annulus median, σ = the
     larger of 1.4826·MAD and the annulus 90th-percentile spread
     (structured backgrounds are not Gaussian); `snr` = (peak − bg)/σ,
     `fracAbove` = share of aperture pixels above bg + 2σ; captured when
     `snr ≥ SNR_MIN` 4 or `fracAbove ≥ FRAC_MIN` 0.30.
   - `SITreasure.captureVerdict`: a positive aperture must beat the same
     measurement at up to 12 **decoy** apertures on a ring of radius
     annulus-outer + apR + 4 around the position (chance field stars set the
     local false-alarm floor): `snr ≥ max(4, SNR_MARGIN 1.3 × best decoy snr)`
     or `fracAbove ≥ max(0.30, FRAC_MARGIN 2 × best decoy fracAbove)`; with
     fewer than `MIN_DECOYS` 6 decoys (frame edge) the plain verdict stands.
     Decoy measurement stops early once the running maxima already sink both
     conditions.
   - A capture whose catalog position error (`errArcsec`, SkyBoT) exceeds the
     aperture radius on the sky is withdrawn — the flux cannot be attributed.
   - `SITreasure.applyMagConsistency`: per type with ≥ 5 magnitude-bearing
     objects and ≥ 1 non-detection, captured objects fainter than
     (median magnitude of the non-detections + 1) are demoted — a "detected"
     mag-26 asteroid among honest mag-20 non-detections is a chance star.
   - Captured objects lead the list; the rest keep their notability order.
5. Enrich: `SITreasure.narrate` — cosmology facts from redshift (lookback
   time, hooks), pixel-size phrases, per-type sentences; `summarize` — counts
   and headlines.
6. Render:
   - **Overlay** — `SIRender.chartField` on the auto-stretched image, shown as
     a new image window whose id derives from `Sky Intruders Treasure Map`:
     single accent color, thin circled markers, elbowed leader lines into
     small-caps labels with data sub-lines (magnitude, class, diameter, "below
     the noise"), corner cards for title / legend / observation data. Every
     captured treasure and at most 6 below-noise ones are labeled, 40 labels
     at most (markers only past the cap). Context objects keep the chart
     readable when the deep catalogs come home empty: named stars and NGC/IC
     objects from PixInsight's own AdP catalog files (`NamedStars.csv`,
     `NGC-IC.csv`, when the install directory is found) and the brightest
     Hipparcos stars through VizieR, at their catalog size.
   - **HTML** — `SITreasureReport.buildHtml`: the annotated map (embedded PNG,
     downscaled to 2400 px when larger), zoomed base64 thumbnails of the 8 most
     notable treasures, narratives for the first 60, the summary, the outage
     banner when a catalog failed, and a forum-ready plain-text block. No
     external assets (CSP-safe, shareable as one file). Offered for saving as
     `SkyIntruders-Treasure-<OBJECT>.html` next to the source image.

## Catalogs (online, verified reachable)

All via VizieR TSV cone search
`https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=<cat>&-c=<raDeg>+<decDeg>&-c.rd=<radiusDeg>&-out.add=_RAJ,_DEJ&-out=<cols>&-out.max=<n>&-sort=<col>`
(`_RAJ2000/_DEJ2000` give computed decimal degrees; `#`-comment and unit/dashes
header rows are skipped; tab-separated). `-out.max` is a hard truncation, so
each query carries a deterministic `-sort` (`-` prefix = descending) that makes
the surviving rows the notable ones; an answer that fills the cap is warned on
the console (*"catalog answer truncated at N rows"*).

| Treasure | VizieR source | Key columns | Sort | Notes |
|---|---|---|---|---|
| Galaxies | `VII/237` (HyperLEDA) | `PGC logD25` | `-logD25` | `logD25` = log 0.1-arcmin diameter → apparent size |
| Quasars | `VII/294` (Milliquas) | `Name z Rmag` | `Rmag` | `z` = redshift (may be blank for photometric candidates) |
| Planetary nebulae | `V/127A/mash1` (MASH-I) | `PNG Name MajDiam MinDiam` | `-MajDiam` | Acker `V/84` has no cone-searchable position index (returns empty); MASH-I carries H-alpha diameters |
| Chart stars | `I/239/hip_main` (Hipparcos) | `HIP HD Vmag SpType` | `Vmag` | context only; HD positions are epoch-1900 and miss their stars by tens of arcsec, Hipparcos is milliarcsecond |

**VizieR body gate.** A `#`-comment banner alone proves nothing: VizieR's own
error answers carry it too. A body is accepted only when it passes
`isVizierBody` — a `#RESOURCE=` line or the column-header line with the
`_RAJ`/`_DEJ` columns we asked for — and carries no `#INFO Error=` line
(`vizierError`). An HTTP failure, an `Error=` body or a non-catalog body
(proxy/captive-portal page, empty 200) all return `null`.

Asteroids/comets in the field **at the capture epoch** via SkyBoT (IMCCE):
`https://ssp.imcce.fr/webservices/skybot/api/conesearch.php?-ra=<raDeg>&-dec=<decDeg>&-rd=<radiusDeg>&-ep=<jd|iso>&-mime=text&-output=object`
— `#`-comment header then `|`-separated rows: `Num | Name | RA(h) | DE(deg) |
Class | Mv | Err | d`. **RA is sexagesimal hours** → convert to degrees.
SkyBoT states its own status in the header: `# Flag: 1` (objects found),
`# Flag: 0` (genuinely empty cone), `# Flag: -1` (service error). Up to 3
attempts with 2 s then 4 s backoff; an attempt with an HTTP failure, a
negative Flag or a body without the Flag line (outage page) is a failed
attempt, and after the last one the query returns `null` — never `[]` for an
outage.

**Cache.** `~/.caeloworks/sky-intruders/treasure-cache/<key>.json`, 30 days
(720 h). Keys: `<kind>_v3_<ra>_<dec>_<radius>_<max>` for VizieR,
`asteroid-v3_<ra>_<dec>_<radius>_<epoch>` for SkyBoT (coordinates rounded to
3 decimals). Only genuine catalog bodies reach the cache — a real empty field
is one and caching it is correct. Key history: `v2` fixed outage bodies being
cached as empty fields; `v3` fixed the VizieR `#INFO Error=` body slipping
through the comment-line check (and the `-sort` changed which rows survive
the cap) and the SkyBoT `Flag: -1` body being cached as empty. Each bump
orphans the entries written before it.

Recorded fixtures live in `tests/fixtures/treasure/` (real responses:
HyperLEDA around M51, Milliquas around 3C 273, MASH around the bulge, SkyBoT
around the M51 field, a VizieR error body) so parsing and the gates are tested
deterministically without the live network.

## Modules

```
pjsr/lib/Cosmology.js       pure: redshift -> lookback time / light-travel
                            distance / comoving distance (flat LambdaCDM)
pjsr/lib/Catalogs.js        cone-search URL builders + TSV/pipe/AdP-CSV parsers
                            and body gates (pure) + query layer over SINet with
                            the per-field disk cache
pjsr/lib/Treasure.js        cross-match, notability, aperture detection + decoy
                            verdict, magnitude consistency, names, narrative,
                            summary (pure)
pjsr/lib/TreasureReport.js  standalone illustrated HTML assembly (pure)
```

PI-facing rendering (overlay bitmap, thumbnail crops, PNG/base64) lives in
`pjsr/lib/Render.js` and the entry script's Treasure mode; the pure pieces
above are Node-testable (`tests/cosmology.test.js`, `catalogs.test.js`,
`treasure.test.js`) and the whole path is smoke-tested headless on a synthetic
solved image (`tests/selftest-integration.js`) and on real solved masters
(`tests/run-treasure-testset.js`).

## Narrative facts (pure, testable)

- Quasar/galaxy redshift `z` → lookback time `t(z)` (Gyr) and light-travel
  distance (Gly), flat ΛCDM H0 = 69.6, Ωm = 0.286, ΩΛ = 0.714 (composite
  Simpson integral). Hooks — every landmark the light predates, the narrative
  quotes the most dramatic: ≥ 13.3 Gyr *from the cosmic dawn*, ≥ 4.6 Gyr
  *before the Sun existed*, ≥ 4.54 Gyr *before the Earth formed*, ≥ 2.0 Gyr
  *before complex life appeared on Earth*.
- Galaxy `logD25` → apparent diameter in arcmin; planetary nebula `MajDiam`
  (arcsec) → arcmin; both → a pixel size on the image.
- Count hooks: "N galaxies / M quasars / K asteroids captured without knowing".
