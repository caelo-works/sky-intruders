# Sky Intruders — support knowledge base

Written for a **support agent**, not for a user. It is exhaustive on purpose: it
states what every control does, what every message means, and what is actually
broken today. Quote it, don't paraphrase it.

Three rules when you use it:

- **The UI is bilingual.** A user describes *their* window, so they will say
  « Chasse au trésor », not "Treasure Hunt". Every label below is given in both
  languages.
- **Never invent a figure, a path or a compatibility.** This script's whole pitch
  is that it separates what it *measured* from what it merely *predicted* —
  support has to hold the same line. If you don't know, say so and escalate.
- **"I can't find it" and "it found nothing" are usually two different bugs.**
  Read the Known bugs section before answering either one.

Applies to **0.3.0**. To check a user's version: in the script window, hover the
**"by CaeloWorks"** line just under the title — the tooltip ends with the build
number. There is no other version display.

---

## 1. The facts card

| | |
|---|---|
| What it is | A PixInsight script that finds who crossed your light frames, and what hid in your image |
| Version | 0.3.0 · GPL-3.0 · free and open source |
| Requires | **PixInsight 1.9.4 or newer** — Windows, macOS, Linux |
| Where it lives | **Script → CaeloWorks → Sky Intruders** |
| Internet | Needed for satellite elements and deep-sky catalogs. HTTPS only, no telemetry, no personal data sent (see 6.1). Everything is cached; it degrades gracefully offline |
| Files | One folder in the home directory, `.caeloworks/sky-intruders` (see 6.3), plus temp files (see 6.6). Nothing inside the PixInsight installation |
| Repository | https://github.com/caelo-works/sky-intruders |
| Product page | EN https://pixinsight-scripts.caelo.works/en/scripts/sky-intruders · FR https://pixinsight-scripts.caelo.works/scripts/sky-intruders |

**Two modes, one dialog.** *Night trails* (the tab it opens on) scans a night of
light frames and **names** the satellites that crossed them. *Treasure Hunt*
takes one **plate-solved** image and finds the galaxies, quasars, planetary
nebulae and asteroids hiding in the field.

The two modes share almost nothing. Always establish which one the user is in
before diagnosing anything.

---

## 2. Installing it

### Route A — the CaeloWorks update repository (recommended)

1. **Resources → Updates → Manage Repositories**
2. Add `https://pixinsight-scripts.caelo.works/update/`
3. **Resources → Updates → Check for Updates**, accept, **restart PixInsight**.

Updates then arrive through the same channel automatically.

> **The repository is CPD-signed.** PixInsight shows no signature warning for
> it. If a user reports a signature or "unsigned repository" warning on this
> repository, something is wrong (a mistyped address, a proxy rewriting the
> traffic, or a problem on the repository side): tell them **not** to accept
> it, and escalate (section 10).

### Route B — manual

Download the archive from the
[Releases](https://github.com/caelo-works/sky-intruders/releases) page and
extract it. Then **Script → Feature Scripts… → Add**, and select the folder that
contains `SkyIntruders.js`. Or run it once with **Script → Execute Script
File…**, which does not register it in the menus.

### "I installed it and I can't find it in the menus"

This is the number one question. Almost always one of:

- **PixInsight was not restarted** after the update.
- **The feature registry is stale.** PixInsight caches where scripts live. Fix:
  **Script → Feature Scripts… → Regenerate**. This is also the answer when the
  script appears under an *old* menu category after an update.
- **The user is looking in the wrong place.** It is **Script → CaeloWorks → Sky
  Intruders**.

If the script runs but its **icon** is missing from the menu, that is a
packaging problem, not something the user can fix. Escalate it.

---

## 3. The window, control by control

### 3.1 Label map — English / French

The user will name things in their own language. This is the lookup.

| English | Français |
|---|---|
| Night trails | Traînées de nuit |
| Treasure Hunt | Chasse au trésor |
| Detection threshold (σ): | Seuil de détection (σ) : |
| Advanced | Avancé |
| Single-frame threshold (σ): | Seuil brute par brute (σ) : |
| Flag slow movers as asteroid candidates | Signaler les objets lents comme candidats astéroïdes |
| Orbital data max age (h): | Âge max des données orbitales (h) : |
| Orbital data mirror URL: | URL du miroir orbital : |
| Draw predicted crossers on the result image | Tracer les passages prédits sur l'image résultat |
| Also draw shadow crossers | Tracer aussi les passages dans l'ombre |
| Observer site — only if the FITS headers carry none | Site d'observation — seulement si les headers FITS n'en ont pas |
| Lat (°, +N): / Lon (°, +E): / Alt (m): | Lat (°, +N) : / Lon (°, +E) : / Alt (m) : |
| No observer site — satellites not identified. | Pas de site d'observation — satellites non identifiés. |
| Max catalog rows / type: | Objets max / type de catalogue : |
| Hunt for: | Chercher : |
| Galaxies / Quasars / Planetary nebulae / Asteroids | Galaxies / Quasars / Nébuleuses planétaires / Astéroïdes |
| Overlay color: | Couleur du tracé : |
| Input | Entrée |
| Light frames | Brutes (lights) |
| Plate-solved image — active window used if empty | Image résolue — fenêtre active si la liste est vide |
| Add files… / Add folder… / Clear | Ajouter des fichiers… / Ajouter un dossier… / Vider |
| Language: | Langue : |
| Analyze night | Analyser la nuit |
| Hunt treasures | Chasser les trésors |
| Save report… | Enregistrer le rapport… |
| Open image | Ouvrir l'image |
| Open HTML / Save HTML… | Ouvrir le HTML / Enregistrer le HTML… |
| below the noise | sous le bruit |
| in service / out of service | en service / hors service |
| rocket body / debris / unknown | étage de fusée / débris / inconnu |

The **Language** combo switches the whole interface, the reports **and** the star
chart, live, in both directions. Every setting is remembered between sessions.

### 3.2 The input list (shared by both modes)

**Add files…** accepts `.fits`, `.fit`, `.fts`, `.xisf`. **Add folder…** scans
one folder (it does not recurse). Duplicates (same full path) are ignored.
Files from **several folders** can be mixed in one list; when two of them share
a file name (`Light_001.fits` from two capture folders), the status line says
so — *"Same file name in several folders (Light_001.fits): frames are told apart
by their position in the list."* — and the run proceeds: since 0.2.2 every frame
is keyed on its position in the list, not on its name, so nothing collides. The
log and the report still show the plain file name, so two lines may look alike
in that case. 0.2.1 and earlier silently mixed such frames up (one registered
copy overwrote the other).

> **The first file in the list matters more than the others.** In Night trails it
> is the registration reference and the source of the field's plate solve. If the
> first frame is not plate-solved, the whole set is treated as unsolved. If a user
> has a half-solved set, tell them to put a solved frame first.

In **Treasure Hunt** the list holds **one** image. If the list is empty, the
script uses the **active image window** instead — that is by design, and it is
why a user with nothing in the list can still get a result.

### 3.3 Tab 1 — Night trails

*"Who crossed your photo last night?" — detects the trails and names them.*

- **Detection threshold (σ)** — default **4.5**, range 2.5 to 8. The threshold
  on the **registered difference image**, i.e. the one every normal run (3+
  frames) uses. Lower catches fainter streaks at the price of noise; 3.5 is a
  reasonable first step for a faint trail that was missed, below 3 expect false
  positives. (On **0.2.1 and earlier** this slider drove the single-frame
  threshold only and did nothing on a normal run — see 8.1.)
- **Draw predicted crossers on the result image** — default **off**. Draws, as
  pale ghost lines, the satellites the orbit model puts inside the field during
  an exposure but that no detected trail confirmed.
- **Also draw shadow crossers** — default **off**. Same, for satellites the model
  puts inside the Earth's shadow — invisible by definition, drawn in grey.
- **Observer site (Lat (°, +N) / Lon (°, +E) / Alt (m))** — empty by default.
  This is only a **fallback**: if the frames carry site headers
  (`SITELAT`/`SITELONG`, `OBSGEO-B`/`OBSGEO-L` or `LAT-OBS`/`LONG-OBS`), those
  win and these fields are ignored. Altitude is optional and defaults to 0 m.
  Sign convention is in the label: **north and east positive**, south and west
  negative (Paris is `48.85` / `2.35`; New York is `40.71` / `-74.01`). The
  fields accept a decimal with a **dot or a comma** (`48.85` and `48,85` are
  the same) and the sexagesimal forms the headers use (`48 51 24`,
  `-2:21:00`). A value outside ±90° / ±180° (or −500…9000 m) or an unreadable
  one is **rejected**: the field is cleared and the status line at the bottom
  says why (exact texts in 7.1). An accepted value is echoed normalized in the
  field, and the field's tooltip shows it with its hemisphere ("Accepted:
  48.8500° N"). (On **0.2.1 and earlier** a comma was silently truncated —
  `48,85` became 48 — and any number was accepted; if a user on an old version
  types French-style decimals, that is why their identifications are off.)
- **Advanced** group:
  - **Single-frame threshold (σ)** — default **5.0**, range 3 to 12. Used
    **only** in the degraded per-frame path (fewer than 3 frames, or a set that
    could not be registered), where the sky is not subtracted. Irrelevant to a
    normal run.
  - **Flag slow movers as asteroid candidates** — default **on**. Unticking it
    skips the slow-mover search entirely (see 8.6 for what a candidate means).
  - **Orbital data max age (h)** — default **12**, range 1 to 168. Cached
    satellite elements older than this are re-downloaded. Raising it lets a
    user work offline on a recent cache; predictions degrade with age.
  - **Orbital data mirror URL** — empty by default. Base URL of a
    CelesTrak-compatible mirror, tried first when set; empty means the default
    sources (CelesTrak, then the CaeloWorks mirror — see 6.2). **It must start
    with `https://`.** Anything else is refused on the spot: the field is
    cleared and the status line reads *"Mirror URL must start with https:// —
    ignored."* (« L'URL du miroir doit commencer par https:// — ignorée. »).
    A non-https value written by hand into `settings.json` is dropped when the
    script starts.

Without an observer site — from the headers *or* from these fields — **satellite
identification is switched off entirely**. Trails are still detected, they simply
cannot be named. This is the most common cause of "why is nothing identified?".
Since 0.2.2 that state is visible: the status line at the bottom of the window
and a banner at the top of the report window both read **"No observer site —
satellites not identified."** (« Pas de site d'observation — satellites non
identifiés. »); the banner adds which headers were looked for and tells the
user to fill in Lat / Lon and run again. The console still prints the message
in 7.2 as well, and on a run *with* a site prints where it came from.

### 3.4 Tab 2 — Treasure Hunt

*"What you photographed without knowing" — on one plate-solved image.*

- **Max catalog rows / type** — default **400**, range 50 to 2000. It is a hard
  truncation per catalog, **not** a magnitude cut. Each catalog is asked to
  sort its answer — largest galaxies and nebulae first, brightest quasars and
  stars first — so when the cap is hit it is the faintest / smallest objects
  that are dropped, and the console says so (*"catalog answer truncated at N
  rows"*, see 7.3). Raising it is safe: slower, busier chart, nothing else.
- **Hunt for: Galaxies / Quasars / Planetary nebulae / Asteroids** — all four on
  by default. Unticking one skips that catalog entirely.
- **Overlay color** — default `#9FD8D2`. The colour of the star chart's markers,
  leader lines, labels and corner cards. The swatch button opens a colour picker.

The input image **must be plate-solved**. Without an astrometric solution the
mode refuses to run and says so in a warning box.

---

## 4. Night trails — what it needs and what it does

### 4.1 The FITS headers it reads

Per frame, in priority order:

- **Date/time**: `DATE-OBS` — **no fallback**. A frame without it is excluded
  from satellite matching, the night is labelled `(undated)`, and log times show
  `--:--` instead of `HH:MM UT`.
- **Exposure**: `EXPTIME`, else `EXPOSURE`. A frame without either is excluded
  from satellite matching.
- **Latitude**: `SITELAT`, else `OBSGEO-B`, else `LAT-OBS`.
- **Longitude**: `SITELONG`, else `OBSGEO-L`, else `LONG-OBS`.
- **Elevation**: `SITEELEV`, else `OBSGEO-H`, else `ALT-OBS`. Optional, defaults
  to 0 m — a missing elevation is harmless.
- **Filter**: `FILTER`. Frames are grouped by it (see below). Frames with no
  `FILTER` all merge into a single group.
- **Target name**: `OBJECT`. Used in the report and on the chart.
- **Plate scale**: `XPIXSZ` + `FOCALLEN`, else derived from the plate solve.

Latitude **and** longitude are both required to build an observer. Missing either
one, with no fallback typed into the dialog, disables satellite identification.

Sexagesimal and decimal forms are both accepted (`48 51 24`, `-12 30 00`,
`12:34:56.7`, `+48.85`).

### 4.2 Why three frames is a hard minimum

Detection does not look at the raw frame. The script registers the frames, builds
a **median model of the static sky**, and hunts trails in the *difference*. That
is why nebulosity and stars do not fool it — but it needs a population to take a
median of.

**The floor is 3 frames — and 3 frames *per filter*.**

- Fewer than 3 frames in total, or fewer than 3 that successfully register: the
  script falls back to detecting on the raw frames. That only finds bright
  streaks, and it produces **no night composite image at all**.
- **A filter group with fewer than 3 frames is skipped entirely.** Those frames
  yield zero trails. The console says so, and nothing else does.

So a session of 26 Ha subs and 2 OIII subs will report trails for the Ha frames
and, silently, none for the OIII pair. That is expected behaviour. One sky model
per filter is deliberate: mixing narrowband channels into one model was measured
to lose trails outright.

Trails **wider than 12 pixels (FWHM, full resolution) are discarded** as cloud
bands or stacking artefacts. The width is measured on a ±16 px profile across
the trail against the local background next to it; a trail with no measurable
edge inside that window counts as too wide. A bright, slightly defocused
satellite trail of 6–9 px is kept. There is no user setting for this.

The brightness-variation index behind the meteor / flasher cue (threshold
0.35) is measured after subtracting the local background at each of 64
points along the trail, so sky gradients and stars crossing the trail do not
create false flickering, and a trail too faint to measure at full resolution
reads as steady rather than flickering.

### 4.3 How a trail gets a satellite's name

Naming needs three things: **an observer site**, **fresh orbital elements**, and
**sky coordinates for the trail** (i.e. a plate solve).

- **With a plate solve**, the match is geometric, and the tolerance is
  direction-aware: the satellite's propagated path must pass within **0.2°
  *across* the predicted track**, within **0.6° *along* it**, and agree in
  orientation within 12°. The along-track allowance is deliberately looser:
  published orbital elements put a satellite slightly early or late on its
  path far more often than they put it sideways of it. A match that looks
  "half a degree off" along the trail's own direction can still be a
  confident, correct identification — do not treat the along-track slack as
  sloppiness.
- The predicted positions account for the observatory's true position on the
  WGS84 ellipsoid and are compared in the same J2000 frame the plate solve
  uses. If a user on an **old version (0.1.1 or earlier)** reports that
  *nothing* is ever identified on plate-solved frames even with a correct
  site and fresh elements, that is a known geometry bug in those versions —
  the fix is to **update the script**, not to fiddle with settings. Escalate
  if updating does not resolve it.
- **Without a plate solve**, the script attempts a **field-orientation fit**: it
  knows the field's centre and scale but not its rotation or mirror parity, so it
  searches for the orientation that makes the most trails agree with predicted
  passes. **It gives up if fewer than 3 trails pair up**, because with only two
  pairs a rotation can almost always be contrived and the names would not be
  trustworthy. It then reports crossers as predictions only, and names nothing.
- **Satellites in the Earth's shadow are never matched to a trail.** An eclipsed
  object cannot leave a streak, so the model refuses to explain one with it.
  Since 0.2.2 this is judged along the whole crossing, not at its midpoint: a
  satellite that **enters or leaves the shadow while inside the field** is
  matched on the part of its path that was lit, and the night log says so —
  *"entered Earth's shadow at HH:MM:SS UT"* / *"left Earth's shadow at
  HH:MM:SS UT"* (FR *"entré dans l'ombre de la Terre à …"* / *"sorti de l'ombre
  de la Terre à …"*); the composite label carries *"into shadow …"* / *"out of
  shadow …"* (FR *"entre dans l'ombre …"* / *"sort de l'ombre …"*). A streak
  that **fades out mid-frame at dusk or dawn** is therefore usually a named
  satellite, not a meteor. On **0.2.1 and earlier** the same streak was
  rejected as eclipsed and handed to the meteor heuristic, which could attach
  a shower name to it — advise updating rather than trusting that label.
  The shadow model itself is coarse (no penumbra): the instant is good to a
  few tens of seconds, and the streak's brightness tapers over that span.
- **Matching is the same whichever way a trail was measured.** Orientation is
  compared at the middle of each segment, so a trail near the pole (δ > 60°)
  is treated identically whether the detector listed its endpoints north-first
  or south-first. On 0.2.1 and earlier, high-declination fields could lose or
  gain a name on that accident alone.

**Identification quality decays with the age of the orbital elements.**
Elements are a prediction, and the prediction drifts — mostly along the track —
by roughly half a degree within a few days, more for maneuvering
constellations. Advise users to **analyze a night within ~48 hours of shooting
it**. Frames analyzed weeks later still get their trails detected, but names
become progressively less trustworthy and more trails fall out as uncataloged.
This is physics, not a bug.

Matches carry a confidence. **Confirmed** matches are shown plainly. **Probable**
matches are shown with a trailing `?` on the image and `[probable]` in the
report — they are explicitly uncertain, and in a tightly-packed group of
identical satellites they can pick the wrong member.

Parallel bundles — satellite trains, aircraft strobe sequences — are grouped
*before* matching and are **never given satellite names**, by design.

### 4.4 What a trail can end up being called

Each trail gets a class and a colour on the result image:

- **satellite** (cyan) — matched to a catalogued object and named.
- **satellite-candidate** (orange) — a steady, edge-to-edge trail with **no**
  catalog match. This is the honest "uncatalogued" answer: a fresh launch, a
  classified object, or debris. **It is a correct result, not a failure.**
- **meteor** (pink) — needs **two** cues out of: the trail stops inside the frame;
  its brightness varies strongly along its length; it aligns with an active
  meteor shower's radiant. Radiant alignment **alone is never enough**. A
  satellite entering the Earth's shadow shows the first two cues too; since
  0.2.2 it is named first (see 4.3) and only unexplained leftovers reach this
  heuristic.
- **airplane** (olive) — a parallel bundle whose brightness flickers (strobes).
- **satellite train** (green) — a parallel bundle of steady brightness, typically
  a recent constellation launch.
- **unknown** (pale grey) — no distinguishing cue.

Ghost lines for predicted-but-unconfirmed passes are pale yellow (sunlit) or grey
(in shadow), and only appear if the user ticked the corresponding box. "In
shadow" here means lit at **no** point of the crossing; a pass that was lit for
any part of it is drawn yellow and carries the *"into shadow …"* / *"out of
shadow …"* tag when it changed state in the field.

### 4.5 What you get at the end

- An **annotated composite** as a new image window (named `SkyIntruders_night`),
  built on the best frame of the night, with every streak labelled — name,
  country flag, altitude, angular speed, time, and the object's nature: **in
  service** / **out of service** for payloads, **rocket body** (« étage de
  fusée ») or **debris** for the rest, **unknown** when the public catalog has
  no status (typically classified objects). The same tag appears on the night
  log's satellite lines. It comes from the public satellite catalog; if that
  download failed for the session, the tag is simply absent — not an error.
- The same composite as a **PNG in the system temp folder**, named
  `SkyIntruders-night-<date>-<run token>.png` (the token is the run's start
  time plus a random number, so two runs — or two PixInsight instances — never
  overwrite each other's image). The **Open image** button in the report window
  reopens it. This PNG is **kept on purpose** when the script closes (it is the
  result the user may want to keep): they save it where they want, and the temp
  copy can be deleted at any time (see 6.6). The registered frames themselves live in a private scratch folder
  `si-night-reg-<run token>` in the same temp folder, named
  `<NNN>_<file name>_r.xisf` (`NNN` = the frame's position in the input list,
  from 000), for the duration of the run and are deleted when it ends — on success, on a fallback to per-frame
  detection, and on an error alike. A leftover `si-night-reg-…` folder means
  PixInsight itself was killed mid-run; it is safe to delete.
- A **night log** in markdown, shown in a window and printed to the console, with
  fun stats and a forum-ready post title. **Save report…** writes it next to the
  frames. **Every time in the log is UT**, written `HH:MM UT` (chronology,
  predicted crossers, rush hour), the same clock as the composite overlay —
  never the computer's local time. The forum title names the night
  (`… crossed my M 57 session (2026-07-10/11)`) rather than saying "last
  night", and agrees in number: `one satellite crossed`, `4 satellites and one
  meteor crossed`, `nothing crossed`. A night with no detected trail still
  lists the **predicted crossers** when the orbit model puts cataloged
  satellites in the field during the exposures.
- **Personal records**, kept between sessions. They track three things only —
  most satellites, most Starlinks, most meteors in one night — and only fire when
  a night strictly beats every previous one. Re-analysing the same night
  *replaces* its entry, so records cannot be inflated by re-running.

---

## 5. Treasure Hunt — what it needs and what it does

### 5.1 The plate solve is mandatory

The image must carry a **real astrometric solution**: either PixInsight's own
(what **ImageSolver** writes, and what a WBPP master already has) or a complete
FITS WCS. An *approximate* centre from `RA`/`DEC` or `OBJCTRA`/`OBJCTDEC`
keywords is **not accepted** — it is good enough for Night trails, but not for
this mode.

Without it, the run stops immediately with this warning box:

> *This image has no astrometric solution (WCS). Plate-solve it first
> (ImageSolver), then run Treasure Hunt.*

No catalog is queried, so **no other message appears either**. A user who says
"it did nothing" with an unsolved image saw exactly this and nothing more.

When a user insists their image *is* solved: check that the solve is on the image
the script actually opened. Common causes are solving a different file, or
solving the open window while pointing the script at the file on disk (or the
reverse — with an empty input list, the script uses the **active window**).

### 5.2 Which catalogs are searched

The search is a cone centred on the field, with a radius equal to half the
field's diagonal, so it circumscribes the frame. The console prints the exact
centre and radius used.

- **Galaxies** — HyperLEDA, with apparent sizes.
- **Quasars** — Milliquas, with redshift. Redshifts are turned into lookback
  times ("its light left about 10.8 billion years ago, before the Sun existed").
- **Planetary nebulae** — the MASH survey. **This catalog essentially only covers
  the galactic plane.** Away from the plane, zero planetary nebulae is the normal,
  correct answer — not a bug and not an outage.
- **Asteroids** — SkyBoT, queried **at the moment of capture**, read from
  `DATE-OBS`. If `DATE-OBS` is missing, the query silently uses *the current
  time*, which is simply wrong for archival images.

The star chart additionally labels bright stars and NGC/IC neighbours for
context; those come from PixInsight's own bundled catalogs plus Hipparcos.

### 5.3 "Captured" vs "below the noise" — how it decides

This is the heart of the mode, and the source of most questions. Finding an
object in a catalog proves nothing about whether the user actually *photographed*
it, so the script **measures every catalog position on the image** and then tries
hard to disprove the detection.

1. **It measures an aperture** at the object's position, sized to the object.
2. **The noise floor is raised by local structure.** An object sitting on
   nebulosity, inside a bright halo, or in a rich star field must beat *its
   surroundings*, not just the sky background. This is deliberate.
3. **It needs a real signal**: a sharp peak, or a filled aperture.
4. **It plants 12 decoy apertures** in a ring around the object. In a rich star
   field, a blind aperture lands on a chance star roughly one time in three, so
   the decoys measure the local false-alarm floor. The object must clearly beat
   the best decoy.
5. **It checks magnitude consistency per type.** If brighter objects of the same
   type went undetected, a much fainter one claiming a detection is demoted — you
   cannot have caught a magnitude-24 quasar while missing magnitude-20 ones.
6. **For asteroids**, if the catalog's own position uncertainty is larger than
   the aperture, the detection is dropped: a position that loose cannot attribute
   the light to that object.

Anything that fails is reported honestly, and the user sees:

> *It sits in the field, below the noise of this image.*
> *Il est dans le champ, mais sous le bruit de cette image.*

or, for asteroids, *"Too faint to leave a visible trace here."* / *« Trop faible
pour laisser une trace visible ici. »*, and a **below the noise** / **sous le
bruit** badge in the report and on the chart.

**"Below the noise" is the product working, not failing.** A magnitude-20
asteroid in the field is never sold as "captured". When a user protests that they
can clearly see the object, the cause is almost always one of: it sits on
structure (nebula, galaxy halo, dense star field); the decoys caught chance stars
just as bright; or magnitude consistency demoted it. All three are intended.

One real exception: **a saturated or blown-out core can be reported as below the
noise.** If the ring around the object is flat or clipped, the script refuses to
claim a detection rather than divide by zero.

### 5.4 What you get at the end

- A **star chart** as a new image window, `Sky Intruders Treasure Map`: thin
  markers, leader lines, corner cards, in the chosen overlay colour.
- An **illustrated HTML report**, self-contained in a single file. **Nothing is
  written to disk automatically.** *Open HTML* writes a copy to the system temp
  folder and opens the browser (that copy is deleted when the Sky Intruders
  window is closed); *Save HTML…* offers to save it next to the input image.
- A **copy-paste forum summary** inside that report.

**The chart deliberately draws fewer objects than the report counts.** Captured
objects are all labelled, but only the 6 most notable *below-noise* ones appear,
and past 40 labelled items the rest get a bare marker. The HTML illustrates the
top 8 with thumbnails and lists up to 60. So "the summary says 47 galaxies but I
only see 12 on the map" is expected: the counts are complete, the drawing is
curated for legibility.

---

## 6. Internet, catalogs and caches

### 6.1 What it contacts, what it sends, and firewalls

Four hosts, **all HTTPS** — the script refuses any address that does not start
with `https://`, including a custom mirror (see 3.3). Every request goes
through PixInsight's own networking (`NetworkTransfer`). A restrictive firewall
must allow them:

- `celestrak.org` — satellite orbital elements and the satellite catalog
  (SATCAT), **Night trails** only. Sent: the element group name (`active`,
  `last-30-days`…); the SATCAT is a plain file download.
- `raw.githubusercontent.com` (`caelo-works/tle-mirror`) — the CaeloWorks
  snapshot of the same CelesTrak data, used when CelesTrak does not answer
  (and for the full `catalog` group, which only it provides), with a SHA-256
  manifest (see 6.5). Sent: the group name.
- `vizier.cds.unistra.fr` — galaxies, quasars, planetary nebulae, bright stars,
  **Treasure Hunt** only. Sent: field centre RA/Dec, search radius, the catalog
  and columns wanted, the row cap.
- `ssp.imcce.fr` (SkyBoT) — asteroids, **Treasure Hunt** only. Sent: field
  centre RA/Dec, search radius and the capture epoch.
- Optionally, the user's own mirror (**Orbital data mirror URL**), https only.
  Sent: the group name.

**What is never sent:** the observer site (satellite orbits are computed
locally, on the user's computer), file names, image data, or any identifier.
**There is no telemetry and no usage tracking.** Everything downloaded is data
(orbital elements, catalog rows); nothing downloaded is ever executed. If a user
asks "what does it send about me?", the answer is: nothing that identifies them
— a group name, or a patch of sky and a date.

**The script sets no proxy of its own.** It uses PixInsight's networking, so a
user behind a corporate proxy must configure it **in PixInsight**, not in the
script.

### 6.2 Satellite elements and the mirror — why it sometimes pauses

Orbital elements are fetched from CelesTrak first, then from the CaeloWorks
mirror on GitHub if CelesTrak does not answer. CelesTrak rate-limits or blocks
some networks outright, so **a pause of 10 to 25 seconds before satellites
resolve is normal**: that is CelesTrak timing out and the mirror taking over. It
is not a bug and needs no action.

Elements are cached for 12 hours by default — the **Orbital data max age (h)**
control in the Advanced group changes that, and **Orbital data mirror URL**
points the first attempt at a mirror of the user's own.

The download includes the **full GP catalog** (~31k objects) on top of the
active and recent-launch groups. Versions **0.1.1 and earlier** covered roughly
19k of the ~34k objects on orbit — missing most rocket bodies, defunct payloads
and debris. Those are exactly the high-altitude objects still sunlit deep in
the night, so on old versions a bright late-night trail often came out
"uncatalogued" simply because the object was never in the list. If a user on
an old version reports many orange (satellite-candidate) trails late at night,
the first answer is **update the script**; the fuller catalog usually names
them. The larger download makes the first fetch of a session a little slower —
normal, no action needed.

If **every** source fails and a cache exists, the script uses the expired cache
and says so in the console, with the words **`(STALE — network unreachable)`**.
That phrase is the smoking gun for *"the satellite names are wrong"* or *"the
positions are off"*: old elements propagate to the wrong place. The fix is to
restore internet access, delete the cache folder, and re-run.

If every source fails and there is **no** cache, satellite identification is
disabled for that run — a warning, not a crash. Trails are still detected, just
unnamed.

### 6.3 The cache and settings files, and when to delete them

Everything lives in the user's home folder, under **`.caeloworks/sky-intruders`**:

- **`settings.json`** — all dialog settings, plus a few keys with no control
  that support may ask a user to set by hand (a value of the wrong type is
  ignored and the default used): `saveHistory` (default `true` — `false` stops
  the night being added to the personal records), `nightResultImage` (default
  `true` — `false` skips the annotated composite), `nightResultCombine`
  (`"best"`, the default, or `"max"` for a max-combine of the whole registered
  set as the composite background — every streak in the pixels, and every
  frame's hot pixels too), `debugFrameOverlays` (default `false` — `true`
  writes one annotated PNG per registered frame, `si-frame-annotated-<run
  token>-<NNN>_<file name>.png`, to the temp folder) and `matchDiagnostics` (default
  `false` — `true` records, for every unnamed trail, the nearest predicted
  crossing and how far it missed the tolerances). Deleting the file resets
  everything to defaults.
- **`history.json`** — the personal records, written after every night run.
  **Deleting it destroys them permanently.** To stop the script keeping them:
  close the script, set `"saveHistory": false` in `settings.json` with a text
  editor (the script rewrites `settings.json` when its window closes, so an edit
  made while it is open is lost).
- **`tle/`** — the satellite element cache. **Deleting this folder is the standard
  fix for stale or wrong satellite names.**
- **`treasure-cache/`** — the deep-catalog cache, kept for **30 days**. Only
  genuine catalog answers are stored (a failed query is never cached), so
  deleting it is rarely needed; it remains the way to force fresh queries on a
  field the user re-runs often.

> **Never tell a user to delete the whole `.caeloworks/sky-intruders` folder** to
> fix a problem. It takes their settings *and their personal records* with it.
> Always name the subfolder: `tle` or `treasure-cache`. The one exception is a
> user who explicitly wants to remove everything the script stores (uninstall,
> privacy): then the whole folder is the answer — with the script closed, and
> after warning them the records go with it.

Nothing is written inside the PixInsight installation. Temp files are covered
in 6.6.

### 6.4 When a deep catalog does not answer

Treasure Hunt separates "the catalog said this field is empty" from "the
catalog did not answer". On any failure — the host unreachable, an HTTP error,
a 200 response that is not catalog data (an HTML maintenance page, a proxy or
captive-portal page), or the catalog service reporting its own error (VizieR
answers a broken or unavailable table with a normal-looking banner plus an
`Error=` line and no data section; SkyBoT with its error flag) — the run:

- **continues** with the other catalogs; the failed one counts 0 objects;
- prints two console lines: *"Treasure/Catalogs: … query failed: …"* and
  *"…: catalog did not answer — flagged in the report"*;
- shows the **"some catalogs did not respond" banner** in the report, naming
  the affected catalog(s);
- **caches nothing** for that query, so the next run asks again.

A VizieR answer only counts as genuine when it carries the data section (the
catalog resource line or the column header) — an empty field still has one; a
banner alone, or a banner with an `Error=` line, does not.

So a report **without** the banner genuinely means every catalog answered, and
its zeros are real zeros. A report **with** the banner must never be read as
"the field is empty" for the named catalogs — have the user re-run once their
network (or the service) is back.

### 6.5 Integrity checks on downloaded data

What the script verifies before it uses or caches a download:

- **Orbital elements (every source: CelesTrak, the CaeloWorks mirror, a custom
  mirror).** Each element line carries the standard modulo-10 checksum in its
  last column. An element set whose line 1 or line 2 fails is **dropped**, and
  the console says *"<group>: N element set(s) dropped (bad TLE checksum)"*. If
  **more than 5 %** of the sets in one download fail, the whole download is
  rejected as corrupt: that source counts as failed and the next source (or the
  cache, possibly stale — 6.2) is used.
- **The CaeloWorks mirror** publishes a SHA-256 manifest, `tle/SHA256SUMS`.
  Every file taken from the mirror (element groups and `satcat.csv`) is hashed
  and compared with it. On a mismatch or a missing entry, the manifest and the
  file are fetched **once more** (GitHub's CDN can briefly serve files from two
  different snapshots). Still wrong: the mirror is not used for that file —
  console *"mirror file <name> failed SHA-256 verification — not used"* — and
  the next source or the cache takes over. If the manifest itself cannot be
  fetched, no mirror file is used at all: *"mirror manifest unavailable —
  mirror not used"*.
- **CelesTrak and a custom mirror** publish no manifest: HTTPS, the TLE
  checksum and the format checks are what protect them.
- **VizieR, SkyBoT and the CelesTrak SATCAT** publish no checksums at all.
  They are protected by HTTPS plus strict format validation (6.4): an answer
  that is not genuine catalog data is rejected and never cached.

None of these messages needs action from the user unless it **repeats run
after run** (see section 9).

### 6.6 Temporary files

Written to the operating system's temp folder, and what happens to them:

- `si-night-reg-<run token>/` — the registered frames of a Night trails run.
  Deleted at the end of every run (success, fallback or error). A leftover one
  means PixInsight was killed mid-run; safe to delete.
- `si-render-*.png` — image-encoding scratch, deleted right after use.
- The Treasure Hunt **HTML report copy** written by *Open HTML*
  (`SkyIntruders-Treasure-<OBJECT>.html`) and the optional debug overlays
  `si-frame-annotated-<run token>-*.png` (only with `debugFrameOverlays: true`)
  — deleted when the Sky Intruders window is closed (best effort: a file still
  held open by another program may stay; it is safe to delete by hand).
- `SkyIntruders-night-<date>-<run token>.png` — the annotated night image.
  **Kept on purpose**: it is the result the user may want. Tell them to save it
  where they want it; the temp copy can be deleted at any time.

Files the user saves (**Save report…**, **Save HTML…**) go only where they
choose.

### 6.7 Programs it launches

Sky Intruders ships no executable and starts no program of its own. **Only on a
user click** — **Open image** (the night PNG), **Open HTML** (the Treasure Hunt
report), or the **"by CaeloWorks"** link under the title (it opens the product
page in the interface language: …/en/scripts/sky-intruders in English,
…/scripts/sky-intruders in French) — it
asks the operating system to open the file or address with its default
application: `cmd /c start` on Windows, `open` on macOS, `xdg-open` on Linux.
If nothing opens on Linux, `xdg-open` is missing or no default browser /
image viewer is set: the file is still in the temp folder (6.6) and can be
opened by hand.

---

## 7. Error messages — exact text

The user will copy-paste. These are the messages, word for word.

### 7.1 Dialog boxes

- *"Sky Intruders requires PixInsight 1.9.4 or newer (this is X.Y.Z)."* — the
  version gate. There is no workaround; 1.9.4 is the floor.
- *"This image has no astrometric solution (WCS). Plate-solve it first
  (ImageSolver), then run Treasure Hunt."* — Treasure Hunt on an unsolved image.
  Solve it with **Script → Image Analysis → ImageSolver**. A WBPP master is
  usually already solved.
- *"Add some light frames first."* / « Ajoute d'abord des brutes (lights). » —
  Analyze pressed with an empty list in Night trails.
- *"Add one plate-solved image, or open one in PixInsight first."* — Hunt pressed
  in Treasure Hunt with an empty list **and** no active image window.
- *"Cannot open <path>"* — the listed file could not be read.
- *"Same file name in several folders (<names>): frames are told apart by their
  position in the list."* / « Même nom de fichier dans plusieurs dossiers
  (<noms>) : les brutes sont distinguées par leur position dans la liste. » —
  informational, shown right after adding files; see 3.2.
- *"No observer site — satellites not identified."* / « Pas de site
  d'observation — satellites non identifiés. » — shown on the status line of the
  main window after the run and as a banner at the top of the night report
  window, with the hint *"The frames carry no site headers (SITELAT / SITELONG,
  OBSGEO-B / OBSGEO-L, LAT-OBS / LONG-OBS) and the Observer site fields are
  empty. Trails were detected but cannot be named: fill in Lat / Lon and run
  again."* Same meaning as the console message in 7.2.
- Observer-site field rejections, on the status line, the field cleared:
  *"Latitude must be between −90 and +90° (+N). Field cleared."*, *"Longitude
  must be between −180 and +180° (+E). Field cleared."*, *"Elevation must be
  between −500 and 9000 m. Field cleared."*, *"Coordinate not understood — use
  48.85, 48,85 or 48 51 24. Field cleared."* (French: « La latitude doit être
  entre −90 et +90° (+N). Champ vidé. », « La longitude doit être entre −180 et
  +180° (+E). Champ vidé. », « L'altitude doit être entre −500 et 9000 m. Champ
  vidé. », « Coordonnée incomprise — écris 48,85, 48.85 ou 48 51 24. Champ
  vidé. »). The user typed something outside the range or unreadable; the
  parameter is empty until they re-enter it.
- *"Mirror URL must start with https:// — ignored."* / « L'URL du miroir doit
  commencer par https:// — ignorée. » — on the status line, after typing an
  **Orbital data mirror URL** that does not start with `https://`. The field is
  cleared and the default sources are used. Only https mirrors are accepted.

### 7.2 Console messages, Night trails

- *"no observer site in the FITS headers (SITELAT, OBSGEO-B/L, LAT/LONG-OBS) or
  dialog fallback — satellite identification disabled."* — **the number one
  cause of "nothing was identified"**. Trails are detected but cannot be named.
  Fix: any of the listed header pairs in the frames, or fill the Observer site
  fields in the Night trails tab. Since 0.2.2 the same state is also shown in
  the window (7.1). (Versions 0.1.1 and earlier word this message "no observer
  site (SITELAT/SITELONG headers or dialog fallback)" — same meaning.)
- *"Observer site (FITS headers): lat +48.8500, lon +2.3500, alt 120 m"* / *"…
  (dialog fallback): …"* — the site that was used and where it came from. The
  first thing to check when names look wrong: a longitude with the wrong sign
  shows here.
- *"NNNN satellites, from cache (STALE — network unreachable)"* — every source
  for the orbital elements failed and expired ones were used. Names and positions
  may be wrong. Restore the internet, delete the `tle` cache folder, re-run.
- *"TLE matching unavailable — …"* — no source reachable and no cache at all.
  Trails are detected, nothing is named.
- *"only N/M frames registered — falling back to per-frame detection"* — star
  alignment failed on most frames (clouds, too few stars). Detection degrades to
  bright streaks only and no composite is produced.
- *"filter group 'X' has only N frame(s) — 3+ are needed for difference
  detection; skipped."* — those frames get **zero trails**. Expected with a stray
  filter; three frames per filter is the minimum.
- *"geometry mismatch, skipped: <file>"* — that frame's dimensions differ from
  the first frame's. Don't mix sensors or crops in one run.
- *"not registered, skipped: <file>"* — star alignment rejected that frame.
- *"only N usable registered frame(s) (M geometry mismatch) — falling back to
  per-frame detection"* — alignment worked but fewer than three frames survived
  the geometry check above; same consequence as the "only N/M frames registered"
  line.
- *"duplicate file names in the set: registering in N batches"* — informational:
  the list mixes folders with identical file names, alignment runs in several
  passes so no registered copy overwrites another. Slightly slower, not an error.
- *"Field orientation fit found only N matched pair(s) — not enough to trust
  satellite names; crossers are reported as predictions only."* — no plate solve,
  and the fallback fit could not be trusted. **Nothing gets named.** Fix:
  plate-solve at least the first frame in the list.
- *"plate-solved reference could not be re-opened (…) — falling back to the
  field-orientation fit"* — the first frame IS solved, but its registered copy
  could not be opened again after detection (disk full, file locked, temp folder
  cleaned). The run continues on the header-based orientation fit; the fit line
  then ends with *"(plate solve unavailable — orientation fit used instead)"*.
  Names are still trustworthy when the fit locks (3+ pairs). Fix: free disk
  space / close whatever holds the temp folder, re-run. 0.2.1 and earlier stay
  silent here and name nothing.
- *"frame <name>: EXPTIME is 0 — no exposure window, skipped for satellite
  identification"* — that frame's exposure header is zero or missing a value.
  Its trails are detected but cannot be named; the other frames are unaffected.
  Fix the header in that frame.
- *"frame <name>: satellite matching failed — …"* — one frame's headers broke
  the matcher (bad date, bad exposure). Only that frame loses its names; the
  rest of the night is matched. On 0.2.1 and earlier a single such frame
  silently emptied the whole night's identifications.
- *"satellite matching failed — …"* (no frame name) — the whole match was
  refused: no valid orbital elements in the catalog, or no observer/frames in
  the request. Nothing is named.
- *"custom mirror URL ignored: not https://"* — a non-https mirror address
  reached the download step (normally caught earlier, 3.3); it was skipped and
  the default sources were used. Fix: an `https://` address, or empty the
  field.
- *"<group>: N element set(s) dropped (bad TLE checksum)"* (e.g. *"active: 3
  element set(s) dropped (bad TLE checksum)"*) — N satellites failed the
  element-line checksum and were left out; the rest of the group is used.
  Harmless when occasional. If it repeats run after run, escalate (6.5).
- *"<group>: payload rejected as corrupt: N of M element sets fail the TLE
  checksum"* — more than 5% of the group failed its checksum, so the whole
  download was refused as damaged; the next source (or the cached copy) was
  used instead. Harmless once; if it repeats, escalate (6.5).
- *"mirror manifest unavailable — mirror not used"* — the CaeloWorks mirror's
  SHA-256 manifest could not be fetched, so no file from the mirror was
  trusted. CelesTrak or the cache was used instead. Harmless once; escalate if
  it persists.
- *"mirror file <name> failed SHA-256 verification — not used"* (e.g.
  `active.tle`, `satcat.csv`) — the file still did not match the manifest
  after one retry. CelesTrak or the cache was used instead. Escalate if it
  persists.
- *"… refused: not an https:// URL"* (inside a fetch error) — the script
  refused a plain-http address. Same fix as the custom-mirror line above.
- *"no frame could be analyzed"* — fatal; nothing could be opened at all.

### 7.3 Console messages, Treasure Hunt

- *"Treasure/Catalogs: galaxy query failed: …"* (also `quasar`, `pne`,
  `asteroid`) — **a catalog was unreachable.** The run continues, the count for
  that catalog reads 0, and the report shows the "some catalogs did not respond"
  banner naming it.
- *"Treasure/Catalogs: galaxy query failed: response is not catalog output
  (outage page?)"* — the server answered, but with something other than catalog
  data (an HTML maintenance page, a proxy or captive-portal page). Treated as an
  outage: banner in the report, nothing cached.
- *"Treasure/Catalogs: galaxy query failed: catalog reported an error: …"*
  (also `quasar`, `pne`) — the catalog server itself answered with an error
  line (table unavailable, malformed query, service overloaded) instead of
  data; the rest of the line is the server's own message. Treated as an
  outage: banner in the report, nothing cached.
- *"Treasure/Catalogs: galaxy catalog answer truncated at 400 rows (raise 'Max
  catalog rows' to see more)"* (also `quasar`, `pne`, `hipstar`; the number is
  the current cap) — **not an error.** The answer filled the row cap, so the
  smallest / faintest objects of that catalog may be missing from the report.
  The catalog answered sorted (largest or brightest first), so what is shown is
  the notable end. Raise **Max catalog rows** and re-run if the user wants the
  rest.
- *"Treasure/Catalogs: asteroid query failed after retries"* — the asteroid
  service did not answer usefully after three tries (unreachable, or it
  reported its own service error). Banner in the report.
- *"galaxies: catalog did not answer — flagged in the report"* (also the other
  catalog names) — the run-level confirmation that the failure above was
  recorded and will appear as the report banner.
- *"galaxies: 0 row(s)"* — **the field is genuinely empty for that catalog.**
  This line is only printed when the catalog actually answered; an outage
  prints the "did not answer" warning instead.

---

## 8. Known bugs and limitations — read before answering

> Earlier builds (up to 0.2.0) had two Treasure Hunt bugs here: a catalog
> outage read exactly like an empty field (the report banner could never
> fire), and that false empty was then cached for 30 days. Both are fixed —
> outages now show the report banner and are never cached (see 6.4). 0.2.1
> still had one gap: a VizieR answer that was an *error* (banner plus an
> `Error=` line, no data) passed the check and was cached as an empty field.
> Builds after 0.2.1 reject such bodies and use a new cache key, so the old
> entries are simply never read again. If the user's version is 0.2.1 or
> older, those symptoms are expected: the fix is to **update the script**,
> then delete the `treasure-cache` folder inside `.caeloworks/sky-intruders`
> once to clear any cached false empties.

### 8.1 The detection threshold slider did nothing on a normal night run (0.2.1 and earlier)

On **0.2.1 and earlier** the **Detection threshold (σ)** slider only drove the
single-frame fallback threshold; a normal run (3+ frames) used a fixed internal
threshold of 4.5 on the registered difference image, so dragging the slider
changed nothing. **Fixed:** the slider now drives that difference-image
threshold (default 4.5, range 2.5–8), and the single-frame value moved to the
Advanced group. If a user on an old version reports the slider does nothing,
the answer is **update the script**.

### 8.2 Longitude sign is taken at face value

`SITELONG` is read exactly as written — there is no East/West convention
correction. A file that writes West longitudes as positive silently places the
observer on the wrong side of the planet, and **every satellite identification
then fails**, with no error message.

**Symptom:** "trails are detected, the site is filled in, and still nothing is
named." Have the user check the sign of their longitude — the console line
*"Observer site (…): lat …, lon …"* shows the value actually used, and the
dialog fields are labelled **+N** / **+E** (east positive, so a French site
is positive and an American one negative). Escalate if it is correct.

### 8.3 Trains and aircraft can be confused, and parallel satellites merged

The distinction between a **satellite train** and an **airplane** rests on a
single measurement: whether the brightness flickers along the trail. A steadily
lit aircraft can therefore be reported as a satellite train, and a tumbling train
as an aircraft.

Separately, **three genuinely unrelated but roughly parallel satellite trails can
be merged into one "train"** — and a bundle is never given satellite names, so
those three lose their identities. Known limitation, no workaround.

### 8.4 The star chart shows fewer objects than the summary counts

Not a bug. Treasure Hunt labels every *captured* object, but only the 6 most
notable *below-noise* ones, and past 40 labelled items the remainder get a bare
marker with no label. The HTML report illustrates the top 8 and lists up to 60.

The counts in the summary are complete and correct. The drawing is curated so the
chart stays readable. Reassure the user; nothing was lost.

### 8.5 A saturated core can be reported as "below the noise"

If the ring the script measures around an object is flat or clipped — which
happens on very bright, blown-out targets — it refuses to claim a detection
rather than compute a meaningless signal-to-noise value. The object is then
reported as below the noise even though it is plainly visible.

Rare, but real. Confirm it rather than arguing with the user, and escalate.

### 8.6 Asteroid candidates are candidates, not confirmed detections

The slow-mover detector is hardened against sensor artifacts: a candidate must
hold at least 4 points (3 on a 3-frame set), follow a straight constant-rate
line within tight residuals, move well beyond centroid noise, never chain
across gaps longer than 2 hours — and a group of "candidates" all moving with
one shared velocity is tested as a possible registration-drift artifact
family (sensor-fixed points such as hot pixels, carried together by the
frame-to-frame alignment offset). On earlier builds (0.2.0 and older) this
hardening did not exist and plate-solved sets could print dozens of false
*asteroid candidate* lines: tell those users to update.

The shared-velocity test is deliberately not a blanket veto, because real
main-belt asteroids in one ecliptic field near opposition **do** move in step
(retrograde, a few tenths of an arcsec per minute, within ~10 % of each
other). Builds after 0.2.1 apply this rule:

- **Single-frame runs** (each frame plate-solved on its own grid): the
  detector knows every source's position on the sensor. A family of 3 or
  more tracks within max(0.5 arcsec/min, 25 % of the rate) of one velocity is
  dropped **only if every member stays within 2 pixels of one sensor
  position** across the frames — the signature of a sensor-fixed point. A
  family that walks across the sensor is kept whole: those are asteroids.
- **Registered runs** (the normal 3+ frame night): sources are measured on
  the reference grid, where pixels merely restate the sky, so the detector
  has no sensor evidence. It then vetoes a family only when it is both large
  and tight: **5 or more tracks within max(0.2 arcsec/min, 8 % of the
  rate)**. Two, three or four co-moving asteroids survive; a drift family of
  a dozen hot pixels does not.

On **0.2.1 and earlier** any 3 tracks within 25 % of one velocity were
dropped, so a field holding three or more asteroids reported *none* of them.
A user on those builds who images ecliptic fields at opposition and never
sees an asteroid candidate is hitting that limit: the answer is **update the
script**.

Two behaviours remain by design:

- **Storm breaker.** If more than 5 candidates still appear on one field, the
  whole list is suppressed and the console says: *"N slow-mover candidates on
  one field look like a sensor-artifact storm, not asteroids — list
  suppressed."* Expected behaviour, not a failure — a real night holds zero to
  a couple of slow movers, never dozens. If a user reports a **confirmed**
  real asteroid suppressed this way, that report is valuable: escalate it.
- The *asteroid candidate* lines that do appear are **candidates to verify**
  (against SkyBoT or a minor-planet checker), not confirmed detections, and
  a mover slower than ~0.1 arcsec/min or visible in fewer than 3 frames is
  below the detector's floor by construction.

---

## 9. Troubleshooting — symptom → cause → answer

### 9.1 Installing and the update repository

| The user says | It means | Tell them |
|---|---|---|
| "I installed it but there is no menu entry" | PixInsight not restarted, or the feature registry is stale | Restart PixInsight, then **Script → Feature Scripts… → Regenerate**. It lives under **Script → CaeloWorks → Sky Intruders**. |
| "PixInsight warns about an unsigned repository / a bad signature" | Not expected — the repository is CPD-signed | Do **not** accept it. Check the address is exactly `https://pixinsight-scripts.caelo.works/update/`. If it is, escalate. |

### 9.2 Night trails

| The user says | It means | Tell them |
|---|---|---|
| "It found no trails at all" | Fewer than 3 frames, or fewer than 3 **per filter** | Difference detection needs at least 3 frames of the same filter. Check the console for *"filter group … has only N frame(s)"*. |
| "Trails are found but nothing is identified" | **No observer site** — by far the most common | Since 0.2.2 the window says so: the status line and the report banner read **"No observer site — satellites not identified."** The frames need site headers (`SITELAT`/`SITELONG`, `OBSGEO-B`/`OBSGEO-L` or `LAT-OBS`/`LONG-OBS`), or the user fills Lat (+N) / Lon (+E) in the Night trails tab — decimal with dot or comma, or sexagesimal. Without a site, identification is switched off entirely. |
| "I typed my latitude and it disappeared" | The value was out of range or unreadable | The status line said why (7.1). Latitude within ±90, longitude within ±180 (east positive), decimal with dot or comma, or `48 51 24`. On **0.2.1 and earlier** a comma was silently truncated instead (`48,85` → 48): update the script. |
| "Still nothing is identified, and my site is filled in" | No plate solve, and the orientation fallback gave up (fewer than 3 matching trails) | Plate-solve at least the **first** frame in the list. |
| "Nothing is identified since one of my frames has a broken header" | On **0.2.1 or older**, one frame with a bad `DATE-OBS`/`EXPTIME` silently aborted the whole night's matching | Update the script: the bad frame is now reported (*"frame … : satellite matching failed"* / *"EXPTIME is 0"*) and the other frames are named. Then fix or drop that frame. |
| "The satellite names look wrong" | Stale orbital elements, or a wrong longitude sign | Look for **`(STALE — network unreachable)`** in the console; if present, delete the `tle` folder in `.caeloworks/sky-intruders` and re-run. Then check the longitude sign. |
| "It says 'unidentified satellite' / orange trail" | No catalog match — a fresh launch, a classified object, or debris | **This is a correct, honest answer, not a failure.** The script refuses to guess a name it cannot support. |
| "Lowering the σ slider changed nothing" | Version **0.2.1 or earlier** — the slider did not affect a normal night run | Update the script. On the current version the slider drives the real threshold; going from 4.5 to 3.5 is a visible change. |

### 9.3 Treasure Hunt

| The user says | It means | Tell them |
|---|---|---|
| "Treasure Hunt says my image has no WCS, but I solved it" | The solve is not on the image the script opened | With an empty input list the script uses the **active window**. Make sure the solved image is the one being read. A WBPP master is normally already solved. |
| "Treasure Hunt found nothing" | An empty field — or a catalog outage, which the report now flags | Ask whether the report shows the **"some catalogs did not respond"** banner. No banner: every catalog answered, the zeros are real. Banner: the named catalogs did not answer — re-run once the network or service is back (failures are not cached). On **0.2.0 or older** the banner never fires and a false empty can sit in the cache; on **0.2.1** a catalog-side error could still be cached as empty. Either way: update the script, then delete the `treasure-cache` folder once. |
| "It found no planetary nebulae" | Normal away from the Milky Way | The nebula catalog essentially only covers the galactic plane. Zero is the correct answer for most fields. |
| "It says below the noise but I can see the object" | Working as intended in most cases | The object must beat its local surroundings and 12 decoy apertures. Objects on nebulosity or in dense star fields legitimately fail. A blown-out saturated core can also trigger it — that one is a real bug, escalate. |
| "I got exactly 400 objects" | The per-catalog row cap | Raise **Max catalog rows / type**. |
| "The map shows far fewer objects than the summary" | Deliberate — the chart is curated | The counts are complete; only the most notable below-noise objects are drawn. |

### 9.4 Network, downloads and integrity

| The user says | It means | Tell them |
|---|---|---|
| "My custom mirror URL is ignored / disappears" | The address is not `https://` | Only https mirrors are accepted (status line: *"Mirror URL must start with https:// — ignored."*). Use the `https://` form of the address, or leave the field empty for the default sources. |
| "The console says N element set(s) dropped (bad TLE checksum)" | A few element sets failed their checksum and were left out | Harmless: the other satellites are used, only the dropped ones cannot be named this run. If it repeats run after run on the same group, escalate with the console output. |
| "The console says mirror manifest unavailable / mirror file failed SHA-256 verification" | The CaeloWorks mirror could not be verified, so it was not used | No action: CelesTrak or the cache was used instead. If it persists over several runs (and especially if names go stale), escalate. |
| "It takes 20 seconds before it finds any satellites" | CelesTrak timing out, mirror taking over | Normal. No action needed. |

---

## 10. Escalating

**Stop and hand over to a human** when: the user reports one of the known bugs
above (a saturated core called "below the noise", a merged train, a σ slider
that does nothing on an up-to-date version); when PixInsight shows a signature
warning for the CaeloWorks repository; when the checksum or SHA-256 messages of
6.5 persist run after run; when they have lost data (a
deleted `history.json` cannot be recovered); when the answer is not in this
document. **Do not improvise a threshold, a file path, or a compatibility claim.**

Collect these five things first. Without them the report is not actionable:

1. **PixInsight version and OS** (Help → About).
2. **Sky Intruders version** — hover the **"by CaeloWorks"** line under the title
   in the script window; the tooltip ends with the build number.
3. **The complete console output of the run.** The script logs every decision it
   makes there, and several failures appear *nowhere else*. This alone usually
   settles the diagnosis.
4. **Which mode**, how many frames, and **whether the frames are plate-solved** —
   specifically whether the **first** frame in the list is.
5. **The FITS header of one frame**: `DATE-OBS`, `EXPTIME`, `SITELAT`,
   `SITELONG`, `FILTER`, `OBJECT`.

For a misidentification, also ask **which name they expected** and which name they
got.

File issues at https://github.com/caelo-works/sky-intruders/issues.
