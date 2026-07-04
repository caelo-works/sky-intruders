# Sky Intruders

**The hidden and discarded life of your astrophotos.**

Sky Intruders is a [PixInsight](https://pixinsight.com) script — a small suite of
three modes that surface what you photographed but never noticed, and turn what you
threw away into art. Everything runs inside PixInsight; there is no native helper to
install or trust.

## 🛰️ Night trails — *who crossed your photo last night?*

Scans a night's light frames for trails and, instead of just rejecting them,
**identifies them**:

- **Satellites** — trails are cross-matched against up-to-date TLE orbital data
  (CelesTrak) propagated with SGP4, so the report reads *"02:13 — STARLINK-4512"*,
  not just "trail".
- **Meteors** — unmatched trails are tested against the active meteor showers
  (radiant alignment, brightness profile): *"04:02 — probable Perseid"*.
- **Asteroid candidates** — slow movers drifting coherently across frames.

Every session ends with a **night log**: a chronological journal of everything that
crossed your field, fun stats ("14 satellites, 11 of them Starlink — personal
record"), persistent personal records, and a Reddit-ready post.

## 💎 Treasure Hunt — *what you photographed without knowing*

Point it at a single plate-solved final image and it hunts the deep catalogs for
everything hiding in your field: PGC galaxies down to mag ~17, quasars with their
redshift, asteroids that drifted through at the moment of capture, tiny planetary
nebulae. Then it tells the story — *"this 4-pixel smudge is a quasar at z = 2.3: its
light left 11 billion years ago, before the Sun existed. You captured 47 galaxies
without knowing."* — as an interactive annotated overlay in PixInsight and a
standalone illustrated HTML post ready for a forum.

## 🎨 Trash to Art — *your rejects have talent*

Recycles the frames the analyzers set aside (satellite trails, wind gusts, clouds)
into art instead of the bin: an intruder-choreography poster of the night's passes
(color-coded by time, type or operator), a classic star-trail composite, or a
designed *"the 47 intruders of my night"* poster. Works on the current session's
rejects or any folder of discarded frames. *Your trash, we make it art.*

## Requirements

- PixInsight ≥ 1.9.4
- **Night trails**: light frames with `DATE-OBS`/`EXPTIME`; satellite identification
  needs an observer site (`SITELAT`/`SITELONG` headers or a manual fallback) and
  works best on plate-solved frames.
- **Treasure Hunt**: a plate-solved image (valid WCS).
- Internet access for the online catalogs (TLE, VizieR, SkyBoT) — all cached, with
  graceful offline degradation.

## Installation

Add the CaeloWorks update repository in PixInsight
(*Resources > Updates > Manage Repositories*):

```
https://pixinsight-scripts.caelo.works/update/
```

then *Check for Updates*. The script appears under
**Scripts > Batch Processing > Sky Intruders**.

## How it works

All computation is native PJSR: robust background statistics, a Hough transform and
contiguity validation for trail detection; SGP4 orbital propagation (via the bundled
MIT-licensed [satellite.js](https://github.com/shashwatak/satellite-js)) for
satellite identification; VizieR and SkyBoT cone searches for the deep catalogs;
Bitmap/Graphics rendering for the overlays, posters and thumbnails. Networking uses
PixInsight's own `NetworkTransfer` — nothing leaves the application.

Design docs: [Night trails](docs/ARCHITECTURE.md) ·
[Treasure Hunt](docs/TREASURE-HUNT.md) · [Trash to Art](docs/TRASH-TO-ART.md).

## License

See [LICENSE](LICENSE).
