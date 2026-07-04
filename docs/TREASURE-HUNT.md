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

- One image window with a **valid astrometric solution** (WCS). Without it there
  is no way to place catalog objects on pixels — the mode refuses to run and says
  so. Plate-solve first (ImageSolver / the mount's solver).
- Internet access (VizieR + SkyBoT cone searches, cached per field).

## Pipeline

1. From the WCS: field center (RA, Dec), search radius (half the field diagonal),
   and pixel scale. Build `wcs.celestialToImage` (the inverse of the trails
   mode's `imageToCelestial`).
2. Cone-search each catalog (see below) through `SINet` / NetworkTransfer.
3. For each returned object: project to pixels via `celestialToImage`; drop those
   outside the frame; measure a **local detection score** (peak vs local
   background+noise in a small aperture) so the report can distinguish *captured*
   (signal present) from *in field, below your noise floor*.
4. Enrich: cosmology facts from redshift (lookback time, light-travel distance),
   physical size hints, "before the Sun / before Earth" hooks.
5. Render:
   - **Overlay** — a new image window "Sky Intruders — Treasure Map": the stretched
     image with catalog markers (per-type color/glyph) and labels.
   - **HTML** — a self-contained illustrated post: the annotated map (embedded
     PNG), zoomed base64 thumbnails per notable treasure, the narrative, and a
     forum-ready summary. No external assets (CSP-safe, shareable as one file).

## Catalogs (online, verified reachable)

All via VizieR TSV cone search
`https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=<cat>&-c=<raDeg>+<decDeg>&-c.rd=<radiusDeg>&-out.add=_RAJ,_DEJ&-out=<cols>&-out.max=<n>`
(request `_RAJ2000/_DEJ2000` for computed decimal degrees; skip `#`-comment and
the unit/dashes header rows; tab-separated).

| Treasure | VizieR source | Key columns | Notes |
|---|---|---|---|
| Galaxies | `VII/237` (HyperLEDA) | `_RAJ2000 _DEJ2000 PGC logD25` | `logD25` = log 0.1-arcmin diameter → apparent size |
| Quasars | `VII/294` (Milliquas) | `_RAJ2000 _DEJ2000 Name z Rmag` | `z` = redshift (may be blank for photometric candidates) |
| Planetary nebulae | *agent to finalize* (Acker `V/84`, HASH, or MASH) | name, position, size | pick a source that actually returns rows and verify |

Asteroids/comets in the field **at the capture epoch** via SkyBoT (IMCCE):
`https://ssp.imcce.fr/webservices/skybot/api/conesearch.php?-ra=<raDeg>&-dec=<decDeg>&-rd=<radiusDeg>&-ep=<jd|iso>&-mime=text&-output=object`
— `#`-comment header then `|`-separated rows: `Num | Name | RA(h) | DE(deg) |
Class | Mv | Err | d`. **RA is sexagesimal hours** → convert to degrees. Epoch =
`DATE-OBS` (mid-exposure). SkyBoT is occasionally flaky (transient 5xx / closed
connection) — retry with backoff, degrade gracefully.

Recorded fixtures live in `tests/fixtures/treasure/` (real responses: HyperLEDA
around M51, Milliquas around 3C 273, SkyBoT around the M51 field) so parsing is
tested deterministically without the live network.

## Modules

```
pjsr/lib/Cosmology.js       pure: redshift -> lookback time / light-travel
                            distance / comoving distance (flat LambdaCDM)
pjsr/lib/Catalogs.js        cone-search URL builders + TSV/pipe parsers (pure) +
                            query layer over SINet; per-field disk cache
pjsr/lib/Treasure.js        orchestration (pure parts) + narrative generation
pjsr/lib/TreasureReport.js  standalone illustrated HTML assembly (pure)
```

PI-facing rendering (overlay bitmap, thumbnail crops, PNG/base64) lives in the
entry script's Treasure mode; the pure pieces above are Node-testable and the
whole path is smoke-tested headless on a synthetic solved image.

## Narrative facts (pure, testable)

- Quasar/galaxy redshift `z` → lookback time `t(z)` (Gyr) and light-travel
  distance (Gly), flat ΛCDM H0 = 69.6, Ωm = 0.286, ΩΛ = 0.714 (numerical
  integral). Hooks: light left *before the Sun* (> 4.6 Gyr) / *before Earth*
  (> 4.54 Gyr) / *before complex life*.
- Galaxy `logD25` → apparent diameter in arcmin; with a redshift/velocity,
  a rough physical size.
- Count hooks: "N galaxies / M quasars / K asteroids captured without knowing".
