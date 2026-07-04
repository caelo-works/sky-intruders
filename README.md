# Sky Intruders

**Who crossed your photo last night?**

Sky Intruders is a [PixInsight](https://pixinsight.com) script that scans a night's
light frames for trails — and instead of just rejecting them, **identifies them**:

- 🛰️ **Satellites** — trails are cross-matched against up-to-date TLE orbital data
  (CelesTrak), so the report reads *"02:13 — STARLINK-4512"*, not just "trail".
- ☄️ **Meteors** — unmatched trails are tested against the active meteor showers
  (radiant alignment, brightness profile): *"04:02 — probable Perseid"*.
- 🪨 **Asteroid candidates** — slow movers drifting coherently across frames.

Every session ends with a **night log**: a chronological journal of everything that
crossed your field, fun stats ("14 satellites, 11 of them Starlink — personal
record"), persistent personal records, and a Reddit-ready markdown post.

## Requirements

- PixInsight ≥ 1.9.4
- Light frames with `DATE-OBS` and `EXPTIME` headers; satellite identification
  needs an observer site (`SITELAT`/`SITELONG` headers or a manual fallback) and
  works best on plate-solved frames (WCS)
- Internet access for TLE downloads (cached, with graceful offline degradation)

## Installation

Add the CaeloWorks update repository in PixInsight
(*Resources > Updates > Manage Repositories*):

```
https://pixinsight-scripts.caelo.works/update/
```

then *Check for Updates*. The script appears under
**Scripts > Batch Processing > Sky Intruders**.

## How it works

Trail detection runs entirely in PixInsight (robust background statistics, Hough
transform, contiguity validation to reject chance star alignments). Orbital
mechanics and networking run in a small bundled native helper (`sky-sidecar`,
static binaries for Windows/macOS/Linux) that downloads and caches TLE catalogs
and propagates them with SGP4 to find which satellites crossed each frame's
field of view during its exposure.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design.

## License

See [LICENSE](LICENSE).
