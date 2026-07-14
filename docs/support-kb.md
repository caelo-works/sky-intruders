# Sky Intruders — support knowledge base

**Applies to: v0.1.1** · PixInsight ≥ 1.9.4 · Windows, macOS, Linux

This document is the reference for anyone answering user questions about Sky
Intruders. It describes what the script actually does — not what it ought to
do. Every threshold, message and file path below is taken from the shipping
code of the version named above. When a behavior looks like a bug, it is
labeled as such; when it looks like a bug but is deliberate, it is in
[By design, not a bug](#12-by-design-not-a-bug).

> **Maintenance rule:** this KB is part of the release ritual. It must be
> re-verified against the code and updated at **every** release — see
> `docs/RELEASING.md`. A KB that lags the code is worse than no KB.

---

## Table of contents

1. [How to triage a report](#1-how-to-triage-a-report)
2. [What the script is](#2-what-the-script-is)
3. [Install, update, menu location](#3-install-update-menu-location)
4. [The interface, control by control](#4-the-interface-control-by-control)
5. [Night trails — how it works](#5-night-trails--how-it-works)
6. [Treasure Hunt — how it works](#6-treasure-hunt--how-it-works)
7. [Files on disk, and how to reset](#7-files-on-disk-and-how-to-reset)
8. [Network, catalogs, caches](#8-network-catalogs-caches)
9. [Troubleshooting playbook](#9-troubleshooting-playbook)
10. [Message reference](#10-message-reference)
11. [Defaults reference](#11-defaults-reference)
12. [By design, not a bug](#12-by-design-not-a-bug)
13. [Known limitations and rough edges](#13-known-limitations-and-rough-edges)
14. [Escalation checklist](#14-escalation-checklist)

---

## 1. How to triage a report

Almost every question resolves to one of five root causes. Ask for these five
things **before** theorizing:

1. **The Process Console text**, in full. The script prints its whole decision
   trail there, and several failures are *console-only* — they never reach a
   dialog. A user who says "it found nothing" while a
   `Treasure/Catalogs: galaxy query failed:` line sits in their console has a
   network problem, not a catalog problem.
2. **Which mode** — Night trails or Treasure Hunt. They share almost nothing.
3. **How many frames**, and whether they are **plate-solved**.
4. **The FITS headers** of one frame — specifically `DATE-OBS`, `EXPTIME`,
   `SITELAT`, `SITELONG`, `FILTER`, and whether a WCS is present.
5. **The script version**, from the update repository or the release zip.

The five root causes, in rough order of frequency:

| Root cause | Tell-tale |
|---|---|
| No observer site | `no observer site (SITELAT/SITELONG headers or dialog fallback) — satellite identification disabled.` |
| No plate solve | Treasure Hunt refuses outright; Night trails silently loses satellite names and the asteroid search |
| Fewer than 3 frames (or fewer than 3 per filter) | `falling back to per-frame detection`, or `filter group '…' has only N frame(s)` |
| A network/catalog failure that reads as "zero results" | `Treasure/Catalogs: … query failed:` **or** `(STALE — network unreachable)` |
| A cached empty result being re-served | Nothing in the console at all, and the user "already fixed their internet" |

---

## 2. What the script is

A PixInsight script (PJSR, pure — no native helper, no sidecar binary) with two
independent modes.

**Night trails.** Point it at a night of light frames. It registers them
internally, builds a static-sky model, and detects trails on the *difference*
— so stars and nebulosity do not fool it. Each trail is then identified:
cross-matched against orbital elements (TLE) propagated with SGP4 to give the
satellite its **name**, or tested against active meteor-shower radiants, or
flagged as a slow coherent mover (asteroid candidate). Output is an annotated
composite image plus a bilingual night log with fun stats, personal records and
a forum-ready post.

**Treasure Hunt.** Point it at one **plate-solved** image. It cone-searches the
deep catalogs (galaxies, quasars, planetary nebulae, and asteroids at the
capture epoch) and then **measures every catalog position on the image**, so the
report can honestly separate *captured* from *in the field, below your noise*.
Output is a star-chart overlay as a new image window plus a standalone
illustrated HTML report.

Everything runs inside PixInsight. Networking goes through PixInsight's own
`NetworkTransfer`, which means it also inherits PixInsight's proxy settings.

---

## 3. Install, update, menu location

### Version gate

Below PixInsight 1.9.4 the script refuses to start with:

> `Sky Intruders requires PixInsight 1.9.4 or newer (this is X.Y.Z).`

There is no workaround. 1.9.4 is the floor.

### From the CaeloWorks update repository (recommended)

**Resources → Updates → Manage Repositories**, add
`https://pixinsight-scripts.caelo.works/update/`, then **Resources → Updates →
Check for Updates**, accept, restart PixInsight.

> **Expected warning:** PixInsight reports the repository as **unsigned**. The
> CaeloWorks code-signing certificate is not distributed yet, so packages ship
> unsigned. This is expected and not a compromise indicator. Users who refuse
> unsigned repositories should use the manual install.

### Manual install

Download the zip from the GitHub Releases page, extract, then
**Script → Feature Scripts…**, **Add**, select the folder containing
`SkyIntruders.js`. Alternatively **Script → Execute Script File…** runs it once
without registering it.

### Menu location

Once registered: **Script → CaeloWorks → Sky Intruders**.

> **Common false alarm:** after an update or a re-install, the script may still
> appear under its old menu category, or not appear at all. PixInsight caches
> the feature-id registry. Fix: **Script → Feature Scripts… → Regenerate**, or
> restart PixInsight. This is not a broken install.

The menu icon comes from the script identifier declared in the source
(`SkyIntruders : CaeloWorks > Sky Intruders`). If the icon is missing but the
script runs, the icon file did not land in the PixInsight `rsc/icons/script/`
tree — a packaging problem, not a user problem. Escalate.

---

## 4. The interface, control by control

One window, a header, two tabs, a shared input list, and a footer. The language
combo switches **the whole UI, the reports and the chart** live, in both
directions. Every setting is remembered between sessions (see
[§7](#7-files-on-disk-and-how-to-reset)).

### Shared

| Control | EN label | FR label | Notes |
|---|---|---|---|
| Input list | `Input` | `Entrée` | Header text changes per mode |
| Add files | `Add files…` | `Ajouter des fichiers…` | Filter: `*.fits *.fit *.fts *.xisf` |
| Add folder | `Add folder…` | `Ajouter un dossier…` | Non-recursive scan of that one folder, same four extensions |
| Clear | `Clear` | `Vider` | |
| Language | `Language:` | `Langue :` | English / Français |
| Run | `Analyze night` | `Analyser la nuit` | Label changes to `Hunt treasures` / `Chasser les trésors` in Treasure mode |
| Close | `Close` | `Fermer` | |

Duplicate paths are silently ignored on add. Files are listed in plain
lexicographic order, **not** by `DATE-OBS` — the chronology in the report is
re-sorted by time later, so this only matters for one thing:

> **The first file in the list is the registration reference and the source of
> the field's WCS.** If frame 1 is unsolved, the whole set is treated as
> unsolved. If a user's set is half-solved, tell them to put a solved frame
> first.

### Night trails tab

| Control | EN label | Default | Range |
|---|---|---|---|
| Detection threshold | `Detection threshold (σ):` | `5.0` | 3 – 12 |
| Predicted crossers | `Draw predicted crossers on the result image` | off | |
| Shadow crossers | `Also draw shadow crossers` | off | |
| Observer site | `Observer site — only if FITS headers lack SITELAT / SITELONG` | empty | Lat °, Lon °, Alt m |

**Detection threshold** is the σ used on *raw* frames. On the registered
difference image — the normal path — the script uses a **separate, lower
internal threshold of 4.5 σ** (`diffKSigma`), not the value in this control.
The static sky has been subtracted there, so a lower bar is safe and catches
the faint streaks narrowband filters leave. **Consequence for support: turning
the visible σ control down does not make the normal night path more sensitive.**
It only affects the fallback per-frame path (fewer than 3 frames).

**Observer site** is only a fallback. If `SITELAT`/`SITELONG` are in the
headers, they win and these fields are ignored. Longitude is taken **as-is** —
no East/West convention correction. A header written West-positive yields a
mirrored site and satellite identification will fail wholesale.

### Treasure Hunt tab

| Control | EN label | Default | Range |
|---|---|---|---|
| Row cap | `Max catalog rows / type:` | `400` | 50 – 2000 |
| Types | `Hunt for:` `Galaxies` `Quasars` `Planetary nebulae` `Asteroids` | all on | |
| Chart color | `Overlay color:` | `#9FD8D2` | swatch opens a color picker |

The row cap is a **hard truncation per catalog**, not a magnitude cut, and
VizieR does not guarantee brightest-first ordering. A dense field can silently
lose objects past row 400. Raising it is safe (slower, busier chart), **but the
cap is part of the cache key**, so changing it forces a fresh query — which is
also the cleanest way to bypass a stale cached result.

---

## 5. Night trails — how it works

### What it needs from the headers

| Datum | Keywords tried, in order | Missing → |
|---|---|---|
| Date/time | `DATE-OBS` **only** | Frame is **excluded from satellite matching**; night label becomes `(undated)`; log times show `--:--` |
| Exposure | `EXPTIME` → `EXPOSURE` | Frame is **excluded from satellite matching**; contributes 0 to total exposure |
| Latitude | `SITELAT` → `OBSGEO-B` → `LAT-OBS` | See below |
| Longitude | `SITELONG` → `OBSGEO-L` → `LONG-OBS` | See below |
| Elevation | `SITEELEV` → `OBSGEO-H` → `ALT-OBS` | Defaults to **0 m** (harmless) |
| Filter | `FILTER` | All filterless frames merge into one sky model |
| Target name | `OBJECT` | Report and chart omit the target |
| Plate scale | `XPIXSZ` + `FOCALLEN`, else derived from the WCS | Some size/rate figures are omitted |

Latitude **and** longitude are both required to build an observer. Missing
either one (and no dialog fallback) disables satellite identification entirely:

> `Sky Intruders: no observer site (SITELAT/SITELONG headers or dialog fallback) — satellite identification disabled.`

Trails are still detected. They just cannot be named. This is the single most
common "why is nothing identified?" cause.

Sexagesimal and decimal forms are both accepted (`48 51 24`, `-12 30 00`,
`12:34:56.7`, `+48.85`).

### The detection pipeline

1. **Registration** — StarAlignment onto the first frame, into a temp directory.
2. **Grouping by filter** — one static-sky model per `FILTER` value. Mixing
   narrowband channels into one model was measured to lose every OIII trail.
3. **Static-sky model** — a masked median stack; a pixel needs at least
   **3 covering frames** to be valid.
4. **Difference** — each frame minus the (photometrically fitted) model, then a
   high-pass. Stars and nebula are gone by this point.
5. **Detection** — adaptive threshold at **4.5 σ**, Hough line search, then a
   faint second pass. Candidates must survive thinness, gap, fill-ratio,
   uniformity and edge-affinity tests.
6. **Vetoes** — anything **wider than 12 px is discarded** as a cloud band or
   stacking artifact. There is no user knob for this.

**Three frames is a hard floor.** Fewer than 3 usable frames — or fewer than 3
*in a given filter group* — means no difference imaging for them:

- fewer than 3 frames total, or fewer than 3 that register: the script falls
  back to per-frame detection on the raw images, which only finds bright
  streaks, and **produces no night composite at all**.
- a filter group with fewer than 3 frames is **skipped entirely**: those frames
  yield zero trails, announced by one console line and nothing else.

So a session with 26 Ha and 2 OIII subs will report trails for the Ha frames
and silently none for the OIII pair. That is expected behavior; say so plainly.

### How a trail gets a name

Identification needs three things: **an observer site**, **fresh TLEs**, and
**sky coordinates for the trail** (i.e. a plate solve).

- With a plate solve, each trail's endpoints are real sky positions, and the
  match is geometric: the satellite's propagated path must pass within **0.2°**
  of the trail and agree in orientation within **12°**.
- Without a plate solve, the script tries a **field-orientation fit**: it knows
  the field center and scale but not the rotation or the mirror parity, so it
  scans all rotations and both parities looking for the orientation that makes
  the most trails agree with predicted crossings. It reports, e.g.
  `Field orientation fitted from 5 trail(s): rotation 136.9°, direct`.
  **It gives up if fewer than 3 trails pair up** — with only two pairs, a
  rotation can almost always be contrived, so the names would not be
  trustworthy. In that case crossers are reported as predictions only:
  `Field orientation fit found only N matched pair(s) — not enough to trust satellite names; crossers are reported as predictions only.`
- **Satellites in the Earth's shadow are never matched.** An eclipsed object
  cannot leave a streak, so the model refuses to explain a trail with one.

Matches carry a confidence: **confirmed** (`high`), **probable** (`medium`,
shown with a trailing `?` on the image and `[probable]` in the log), or
low. Parallel bundles (satellite trains, airplane strobe sequences) are grouped
*before* matching and are **never given satellite names**.

### What a trail can end up as

| Class | Image color | Meaning |
|---|---|---|
| satellite | cyan `#22d3ee` | Named from the TLE catalog |
| satellite-candidate | orange `#ffa05f` | A steady edge-to-edge trail with **no** catalog match — an honest "uncataloged" |
| meteor | pink `#ff5f8f` | Contained in the frame and/or strongly varying in brightness, ideally aligned with an active shower radiant |
| plane | olive `#a7b34d` | A parallel bundle whose brightness flickers (strobes) |
| train | green `#8fd18f` | A parallel bundle with steady brightness — typically a fresh Starlink/Qianfan launch |
| unknown | pale grey `#c9d2dd` | No distinguishing cue |

Ghost lines (predicted crossers that matched no trail) are pale yellow when
sunlit, grey when in shadow, and only drawn if the user ticked the boxes.

A meteor verdict needs **two** cues out of: the trail stops inside the frame;
its brightness varies strongly along its length; it aligns with an active IAU
shower radiant (within 8°, radiant outside the segment). Radiant alignment
**alone is never enough**.

### Outputs

| What | Where |
|---|---|
| Annotated composite | A new image window, `SkyIntruders_night` (PixInsight appends a counter) |
| The same composite as a PNG | The system temp directory, `SkyIntruders-night-result.png` — the `Open image` button reopens this |
| Night log (markdown) | Shown in a dialog and printed to the console; `Save report…` writes `SkyIntruders-<date>.md` next to the frames |
| Forum post title | The bold line at the top of the report dialog |
| Personal records | Appended to `history.json` (see [§7](#7-files-on-disk-and-how-to-reset)) |

Personal records only track three things — most satellites, most Starlinks, most
meteors in one night — and only fire when a night **strictly beats** all
previous ones. Re-analyzing the same night **replaces** its history entry rather
than adding one, so records cannot be inflated by re-running.

---

## 6. Treasure Hunt — how it works

### The plate-solve requirement is absolute

The image must carry a real astrometric solution: either PixInsight's own
(what ImageSolver writes) or a full FITS TAN WCS (`CRVAL1/2`, `CRPIX1/2`, plus
either the `CD` matrix or `CDELT1/2`). An *approximate* center from `RA`/`DEC`
or `OBJCTRA`/`OBJCTDEC` keywords is **not** accepted — it is enough for Night
trails, not for this mode.

Without it the run stops immediately with a warning box:

> `This image has no astrometric solution (WCS). Plate-solve it first (ImageSolver), then run Treasure Hunt.`

No catalog is queried, so **no network warning appears either** — a user who
reports "it did nothing" with an unsolved image sees exactly this and nothing
else.

### The search

The cone radius is the **half-diagonal of the solved field**, so the search
circle circumscribes the frame. Objects landing outside the rectangle are
dropped afterwards. Console line, useful to reproduce a search by hand:

> `Field center RA 311.6170 Dec 45.2800, search radius 0.512 deg`

| Type | Source |
|---|---|
| Galaxies | HyperLEDA (VizieR `VII/237`) — sizes from `logD25` |
| Quasars | Milliquas (VizieR `VII/294`) — with redshift |
| Planetary nebulae | MASH-I (VizieR `V/127A/mash1`) |
| Asteroids | SkyBoT / IMCCE, cone search **at the capture epoch** (`DATE-OBS`) |
| *(chart context only)* | Hipparcos bright stars, and PixInsight's own NGC/IC and named-star catalogs |

If `DATE-OBS` is missing, the asteroid query silently uses **the current time** —
which is simply wrong for archival data, and gets cached under that epoch.

### Capture scoring — the heart of the mode

This is what makes the report honest, and it is the source of most "why does it
say below the noise?" questions. At every catalog position the script does
aperture photometry and then tries hard to *disprove* the detection.

**Step 1 — the aperture.** Radius 4 px for a point source; for an object with a
catalog size, half its apparent diameter, clamped to 3–40 px. A background
annulus surrounds it.

**Step 2 — the noise floor is inflated by local structure.** Sigma is the
annulus MAD, but if the annulus's 90th percentile implies a larger spread, that
larger value is used instead. **Objects sitting on nebulosity, inside a bright
halo, or in a rich star field must beat their surroundings, not just Gaussian
noise.** This is deliberate.

**Step 3 — the raw verdict.** Captured if peak SNR ≥ **4**, *or* if ≥ **30 %**
of the aperture pixels sit above background + 2σ. A sharp peak or a filled disc.

**Step 4 — the decoy ring.** If step 3 said captured, the script measures **12
decoy apertures** on a ring around the target, identical in size. In a rich star
field a blind aperture catches a chance star roughly one time in three, so the
decoys measure the *local false-alarm floor*. The target must now beat the best
decoy by **1.3× in SNR** or **2× in fill fraction**. Near a frame edge, where
fewer than 6 decoys fit inside the image, this guard is skipped and the raw
verdict stands.

**Step 5 — magnitude consistency, per type.** If at least 5 objects of a type
carry magnitudes and at least one was *not* detected, then anything fainter than
(median magnitude of the non-detections + 1) is **demoted to not-captured** — it
cannot be true that you caught a mag-24 quasar while missing mag-20 ones.

**Step 6 — asteroids only.** If SkyBoT's own position uncertainty is larger than
the aperture, the detection is dropped: a position that loose cannot attribute
the flux to that object.

The user sees the outcome as either a normal narrative sentence, or the same
sentence with a suffix:

> `It sits in the field, below the noise of this image.`
> `Too faint to leave a visible trace here.` *(asteroids)*

and as a `below the noise` / `sous le bruit` badge in the HTML report, on the
chart, and in the result dialog.

**A saturated or clipped core can report "below the noise."** If the annulus is
flat, sigma collapses to zero and the code refuses to claim a detection rather
than divide by nothing. Rare, but it happens on very bright targets.

### Outputs

| What | Where |
|---|---|
| Star chart | A new image window, `Sky Intruders Treasure Map` (sanitized and numbered by PixInsight) |
| Illustrated HTML report | Nothing is written automatically. `Open HTML` writes it to the temp directory and opens the browser; `Save HTML…` defaults to the input image's folder, named `SkyIntruders-Treasure-<OBJECT>.html` |
| Forum-ready summary | A copy-paste block inside the HTML report |

Chart budget: **captured** objects are all labeled; only the **6** most notable
below-noise ones appear at all, and past **40** labeled items objects get a bare
marker. The HTML illustrates the **top 8** with thumbnails and lists up to
**60**. So "the summary says 47 galaxies but the map shows 12" is expected —
the counts are complete, the drawing is curated.

Redshifts are turned into lookback times with a flat ΛCDM model
(H₀ = 69.6, Ωm = 0.286), and phrased with the most dramatic true landmark:
"before the Sun existed", "before the Cambrian explosion", and so on.

---

## 7. Files on disk, and how to reset

Everything lives under **`~/.caeloworks/sky-intruders/`** (the user's home
directory as PixInsight sees it).

| File / folder | Contents | Safe to delete? |
|---|---|---|
| `settings.json` | All dialog parameters | Yes — resets to defaults |
| `history.json` | Personal records, one entry per night | Yes — **loses the user's records forever** |
| `tle/` | TLE + satellite-catalog cache | **Yes — this is the standard fix for stale/wrong satellite names** |
| `treasure-cache/` | Cached catalog cone searches, 30-day TTL | **Yes — this is the standard fix for "it still finds nothing"** |

> **Never tell a user to delete `~/.caeloworks/sky-intruders/` wholesale** — it
> takes their settings and their personal records with it. Name the
> subdirectory.

Temporary files (system temp directory): `si-night-reg/` holds a registered copy
of every frame during a run — **disk usage roughly equal to the session** — and
is cleared before and after. If PixInsight crashes mid-run it can be left
behind, and it is safe to delete by hand.

A corrupt `settings.json` silently reverts to defaults; a corrupt `history.json`
silently resets records to "first night". Neither shows an error.

---

## 8. Network, catalogs, caches

### Hosts to allow-list

| Host | Used for |
|---|---|
| `celestrak.org` | TLE orbital elements, satellite catalog |
| `raw.githubusercontent.com` | The CaeloWorks TLE mirror (fallback) |
| `vizier.cds.unistra.fr` | Galaxies, quasars, planetary nebulae, bright stars |
| `ssp.imcce.fr` | SkyBoT asteroids |

All HTTPS. The script sets **no proxy of its own** — it inherits PixInsight's
network settings. A user behind a corporate proxy must configure it in
PixInsight, not in the script.

### TLE fetching and the mirror

CelesTrak is tried first, then the CaeloWorks mirror on GitHub. CelesTrak
rate-limits or blocks some ISPs outright, so **a 10–25 second pause before
satellites resolve is normal**: that is CelesTrak timing out and the mirror
taking over. It is not a bug.

The mirror is a scheduled snapshot, so its elements can be a few hours older
than CelesTrak's. TLEs are cached for **12 hours** by default.

If **every** source fails and a cache exists, the script uses the expired cache
and says so:

> `   11234 satellites, from cache (STALE — network unreachable)`

**That suffix is the smoking gun for "the satellite names are wrong / positions
are off".** Old elements propagate to wrong places. Fix: restore network access,
delete `~/.caeloworks/sky-intruders/tle/`, re-run.

If every source fails and there is **no** cache, satellite identification is
disabled for the run (a warning, not a crash) — trails are still detected, just
unnamed.

### Catalog failures are nearly silent — read this twice

A VizieR or SkyBoT failure **returns an empty result rather than an error**. The
consequences for support:

- The run continues and reports `galaxies: 0 row(s)`.
- The HTML report's "some catalogs did not respond" banner **does not fire**.
- The *only* evidence is a console warning:
  `Treasure/Catalogs: galaxy query failed: HTTP 503`

So **"Treasure Hunt found nothing" and "Treasure Hunt could not reach the
catalogs" look identical to the user.** Always ask for the console text.

Worse: a captive portal or an error page that parses to nothing is
indistinguishable from a genuinely empty field, and **an empty result gets
cached for 30 days**. A user who hits an outage, fixes their network, and
re-runs will get the same empty result from cache. This is the single most
likely cause of "I fixed my internet and it still finds nothing." Fix: delete
`~/.caeloworks/sky-intruders/treasure-cache/`, or nudge the row cap (it is part
of the cache key).

One more proxy trap: VizieR queries put a literal `+` between RA and Dec. A
gateway that re-encodes it breaks **every** VizieR query while leaving SkyBoT
working — signature: galaxies, quasars and nebulae all return 0 rows, asteroids
work fine.

---

## 9. Troubleshooting playbook

### "No trails were detected"

1. **How many frames?** Fewer than 3 → per-frame fallback, bright streaks only.
   Fewer than 3 *in a filter group* → that group is skipped entirely. Check the
   console for `filter group '…' has only N frame(s)`.
2. **Did the frames register?** `only N/M frames registered — falling back to
   per-frame detection` means StarAlignment failed on most of them (too few
   stars, clouds).
3. **Is the streak wider than ~12 px?** Bright, defocused or heavily bloated
   trails are vetoed as artifacts. No knob; escalate if a genuine trail is being
   eaten.
4. **Clouds?** Above 8 % of pixels over threshold, the threshold auto-raises up
   to 12 times. A cloudy sub can end up detecting nothing at all, by design.
5. Note that lowering the visible σ control does **not** affect the normal night
   path (see [§4](#4-the-interface-control-by-control)).

### "Trails are detected but nothing is identified"

In order of likelihood:

1. **No observer site.** Check the console. Fix: `SITELAT`/`SITELONG` in the
   headers, or fill the Observer site fields in the Night trails tab.
2. **No plate solve, and the orientation fit gave up** (fewer than 3 pairs).
   Fix: plate-solve at least the *first* frame in the list.
3. **Stale or missing TLEs.** Look for `(STALE — network unreachable)`.
4. **The satellite is genuinely not in the catalog** — a fresh launch, a
   classified object, or debris. It will be reported honestly as an *uncataloged
   satellite candidate*, in orange. That is a correct answer, not a failure.
5. **The trail is part of a parallel bundle** (train/plane). Bundles are never
   named, by design.

### "The satellite names look wrong"

Check for `(STALE — network unreachable)` first; then check the observer
longitude sign; then check whether the run used the orientation fit rather than
a real plate solve (the console says so). Medium-confidence matches — shown with
a `?` and `[probable]` — are explicitly uncertain, and the rescue pass that
produces them can pick the wrong member of a tightly-packed Starlink plane.

### "Treasure Hunt says my image has no WCS, but I solved it"

The solution must be on the image the script actually opens. Common causes: the
user solved a different file; the solve lives only in the open window and they
pointed the script at the file on disk (or the reverse — with an empty list the
script uses the **active window**); or the file carries only `RA`/`DEC`
keywords, which is an *approximate* center and is refused on purpose.

### "Treasure Hunt found nothing / far too few objects"

1. Console: any `Treasure/Catalogs: … query failed`? → network. See
   [§8](#8-network-catalogs-caches).
2. All four types return 0 but the network is fine? → suspect the proxy `+`
   trap, or a cached empty result. Delete `treasure-cache/`.
3. Only planetary nebulae are empty? → **normal.** MASH-I is essentially a
   galactic-plane survey; away from the plane there are none to find.
4. Small field? The catalogs may genuinely hold nothing there.
5. Exactly 400 objects of a type? → the row cap truncated it. Raise it.

### "It says below the noise but I can clearly see it"

Walk through [§6](#6-treasure-hunt--how-it-works) step by step. In practice it is
almost always one of:

- **the object sits on structure** (nebula, galaxy halo, dense star field) and
  the sigma inflation raised the bar above it — intended;
- **the decoy ring caught chance stars** at comparable brightness, so the
  detection could not be distinguished from a lucky aperture — intended;
- **magnitude consistency demoted it** because brighter objects of the same type
  went undetected — intended;
- **a big galaxy measured through a small aperture**: if the plate scale is
  unknown, every extended object falls back to a 4 px point-source aperture,
  whose annulus then sits *on the galaxy itself*. Fix: make sure `XPIXSZ` and
  `FOCALLEN` are in the headers.

If none of these fit, it is worth escalating with the image.

### "The chart shows fewer objects than the summary counts"

Expected. See the chart budget in [§6](#6-treasure-hunt--how-it-works).

### "The script does not appear in the menu / is in the wrong category"

**Script → Feature Scripts… → Regenerate**, or restart PixInsight. PixInsight
caches the registry.

### "PixInsight says the repository is unsigned"

Expected, see [§3](#3-install-update-menu-location).

---

## 10. Message reference

Console messages the user is most likely to quote. All are prefixed by the
script name unless noted.

| Message | Meaning | Action |
|---|---|---|
| `no observer site (SITELAT/SITELONG headers or dialog fallback) — satellite identification disabled.` | Warning. Trails detected, none named. | Add site headers or fill the dialog fields |
| `NNNN satellites, from cache (STALE — network unreachable)` | Every TLE source failed; expired elements were used | Restore network, delete `tle/`, re-run |
| `TLE matching unavailable — …` | No source reachable and no cache | Same, but nothing to fall back on this run |
| `only N/M frames registered — falling back to per-frame detection` | StarAlignment failed on most frames | Check frame quality |
| `filter group 'X' has only N frame(s) — 3+ are needed for difference detection; skipped.` | Those frames get zero trails | Expected with a stray filter |
| `geometry mismatch, skipped: <file>` | Frame dimensions differ from the reference | Don't mix sensors/crops in one run |
| `not registered, skipped: <file>` | StarAlignment rejected it | Usually clouds or too few stars |
| `Field orientation fitted from N trail(s): rotation X°, direct\|mirrored` | Names come from the orientation fit, not a plate solve | Fine, but less certain |
| `Field orientation fit found only N matched pair(s) — not enough to trust satellite names…` | Fit abandoned | Plate-solve the first frame |
| `Treasure/Catalogs: <kind> query failed: …` | **A catalog was unreachable.** The report will still say 0 rows | Network; then clear `treasure-cache/` |
| `Treasure/Catalogs: asteroid query failed after retries` | SkyBoT unreachable after 3 tries | Same |
| `no frame could be analyzed` | Fatal; nothing could be opened | Check paths and formats |
| `Sky Intruders requires PixInsight 1.9.4 or newer …` | Version gate | Upgrade PixInsight |

Dialog boxes:

| Box | Trigger |
|---|---|
| `Add some light frames first.` | Run pressed with an empty list, Night mode |
| `Add one plate-solved image, or open one in PixInsight first.` | Run pressed with an empty list and no active window, Treasure mode |
| `This image has no astrometric solution (WCS). Plate-solve it first (ImageSolver), then run Treasure Hunt.` | Treasure mode, unsolved image |
| `Cannot open <path>` | The listed file could not be opened |

---

## 11. Defaults reference

| Parameter | Default | Notes |
|---|---|---|
| Detection threshold (σ) | 5.0 | Raw frames only |
| Difference threshold | 4.5 | Internal, not exposed |
| Max trails per frame | 10 | Raised to ≥ 25 on the difference path |
| Trail width veto | > 12 px | Internal, not exposed |
| Minimum trail length | 15 % of the frame diagonal | 10 % on the faint pass |
| TLE group | `active` + `last-30-days` | The second catches fresh launches |
| TLE cache max age | 12 h | |
| Satellite catalog cache | 7 days | |
| Match tolerance | 0.2° separation, 12° orientation | |
| Orientation fit | needs ≥ 3 matched pairs | |
| Asteroid (mover) detection | on | Requires a real plate solve |
| Predicted / shadow crossers | off | |
| Language | English | |
| Treasure row cap | 400 per catalog | 50–2000 |
| Treasure catalogs | all four on | |
| Chart accent | `#9FD8D2` | |
| Catalog cache TTL | 30 days | |
| Capture: SNR / fill | ≥ 4 σ **or** ≥ 30 % of the aperture | |
| Capture: decoys | 12, must beat the best by 1.3× SNR or 2× fill | Skipped near frame edges |

---

## 12. By design, not a bug

Report these back to users with confidence — they are deliberate, and several
exist precisely to keep the script honest.

- **"Uncataloged satellite" is a real answer.** The script would rather say "a
  steady trail I cannot name" than guess. Fresh launches, classified objects and
  debris legitimately land here.
- **"Below the noise" is the whole point of Treasure Hunt.** A mag-20 asteroid
  in the field is never sold as "captured". The decoy ring and the magnitude
  consistency check exist to make the *captured* list defensible.
- **Eclipsed satellites are never matched to a trail.** An object in Earth's
  shadow cannot streak your frame.
- **Trails in a parallel bundle get no names.** A train is reported as a train.
- **Fewer than 3 frames per filter means no difference detection.** The static
  sky model needs a population to take a median of.
- **The σ control does not affect the normal night path.** The difference image
  has its own, lower threshold.
- **The star chart draws fewer objects than the report counts.** Curated for
  legibility; the counts are complete.
- **Planetary nebulae are absent off the galactic plane.** The catalog is a
  plane survey.
- **The update repository is unsigned.** Signing is pending.

---

## 13. Known limitations and rough edges

Things that are genuinely imperfect. Do not promise fixes; log them.

- **Catalog outages masquerade as empty fields.** VizieR and SkyBoT failures
  return an empty list, so the report's "some catalogs did not respond" banner
  does not fire and the user sees `0 row(s)`. The console warning is the only
  evidence. *(A cached empty result then persists for 30 days.)* This is the
  weakest point in the whole product from a support standpoint.
- **Longitude sign convention is taken at face value.** A West-positive
  `SITELONG` silently mirrors the observer.
- **`OBJCTRA` is always read as hours; `RA` is read as degrees when decimal.** A
  file that violates this is off by a factor of 15.
- **The train/plane distinction rests on a single brightness-variability
  threshold.** A steadily-lit airplane can be reported as a satellite train, and
  three genuinely unrelated parallel satellites can be merged into one "train"
  and lose their names.
- **Label collision avoidance can give up.** On very crowded frames the last
  candidate position is used even if it overlaps.
- **Operator classification is substring-based**, so a satellite whose name
  happens to contain `ISS` or `CSS` can be miscounted in the stats.
- **A missing plate scale degrades extended-object photometry** to a 4 px
  aperture (see [§9](#9-troubleshooting-playbook)).
- **The registration scratch directory can survive a PixInsight crash**, holding
  a full copy of the session on disk.

---

## 14. Escalation checklist

Before escalating a bug, collect:

1. Script version, PixInsight version, operating system.
2. **The complete Process Console output** for the run.
3. Which mode, and how many frames.
4. The FITS header dump of one representative frame (`DATE-OBS`, `EXPTIME`,
   `SITELAT`, `SITELONG`, `FILTER`, `OBJECT`, `XPIXSZ`, `FOCALLEN`, and whether
   a WCS is present).
5. Whether the frames are plate-solved, and whether the **first** frame in the
   list is.
6. What the user expected versus what they got — for a misidentification, the
   name they expected and the name they were given.
7. Whether the problem survives deleting `~/.caeloworks/sky-intruders/tle/` and
   `~/.caeloworks/sky-intruders/treasure-cache/`.

Issues: <https://github.com/caelo-works/sky-intruders/issues>
