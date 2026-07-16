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

Applies to **0.2.0**. To check a user's version: in the script window, hover the
**"by CaeloWorks"** line just under the title — the tooltip ends with the build
number. There is no other version display.

---

## 1. The facts card

| | |
|---|---|
| What it is | A PixInsight script that finds who crossed your light frames, and what hid in your image |
| Version | 0.2.0 · GPL-3.0 · free and open source |
| Requires | **PixInsight 1.9.4 or newer** — Windows, macOS, Linux |
| Where it lives | **Script → CaeloWorks → Sky Intruders** |
| Internet | Needed for satellite elements and deep-sky catalogs. Everything is cached; it degrades gracefully offline |
| Repository | https://github.com/caelo-works/sky-intruders |
| Product page | https://pixinsight-scripts.caelo.works/en/scripts/sky-intruders |

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

> **"Unsigned repository" warning.** Expected. The repository is not CPD-signed
> yet; signing is underway. It is safe to accept. Make clear to the user that
> this is a missing signature on the *repository*, not a virus warning and not a
> sign that anything was tampered with.

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
| Draw predicted crossers on the result image | Tracer les passages prédits sur l'image résultat |
| Also draw shadow crossers | Tracer aussi les passages dans l'ombre |
| Observer site — only if the FITS headers carry none | Site d'observation — seulement si les headers FITS n'en ont pas |
| Lat (°): / Lon (°): / Alt (m): | Lat (°) : / Lon (°) : / Alt (m) : |
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
one folder (it does not recurse). Duplicates are ignored.

> **The first file in the list matters more than the others.** In Night trails it
> is the registration reference and the source of the field's plate solve. If the
> first frame is not plate-solved, the whole set is treated as unsolved. If a user
> has a half-solved set, tell them to put a solved frame first.

In **Treasure Hunt** the list holds **one** image. If the list is empty, the
script uses the **active image window** instead — that is by design, and it is
why a user with nothing in the list can still get a result.

### 3.3 Tab 1 — Night trails

*"Who crossed your photo last night?" — detects the trails and names them.*

- **Detection threshold (σ)** — default **5.0**, range 3 to 12. **Warning: on a
  normal night run this slider does nothing.** The real detection happens on a
  registered difference image, which uses its own fixed internal threshold.
  The slider only takes effect in the degraded fallback path (fewer than 3
  frames). Do not tell a user to lower it to catch a faint trail — it will not
  help. This is a known interface trap.
- **Draw predicted crossers on the result image** — default **off**. Draws, as
  pale ghost lines, the satellites the orbit model puts inside the field during
  an exposure but that no detected trail confirmed.
- **Also draw shadow crossers** — default **off**. Same, for satellites the model
  puts inside the Earth's shadow — invisible by definition, drawn in grey.
- **Observer site (Lat / Lon / Alt)** — empty by default. This is only a
  **fallback**: if the frames carry site headers (`SITELAT`/`SITELONG`,
  `OBSGEO-B`/`OBSGEO-L` or `LAT-OBS`/`LONG-OBS`), those win and
  these fields are ignored. Altitude is optional and defaults to 0 m.

Without an observer site — from the headers *or* from these fields — **satellite
identification is switched off entirely**. Trails are still detected, they simply
cannot be named. This is the most common cause of "why is nothing identified?".

### 3.4 Tab 2 — Treasure Hunt

*"What you photographed without knowing" — on one plate-solved image.*

- **Max catalog rows / type** — default **400**, range 50 to 2000. It is a hard
  truncation per catalog, **not** a magnitude cut, and the catalog does not
  guarantee brightest-first order. A dense field can silently lose objects past
  row 400. Raising it is safe: slower, busier chart, nothing else.
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
  `--:--`.
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

Trails **wider than about 12 pixels are discarded** as cloud bands or stacking
artefacts. There is no user setting for this.

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
  meteor shower's radiant. Radiant alignment **alone is never enough**.
- **airplane** (olive) — a parallel bundle whose brightness flickers (strobes).
- **satellite train** (green) — a parallel bundle of steady brightness, typically
  a recent constellation launch.
- **unknown** (pale grey) — no distinguishing cue.

Ghost lines for predicted-but-unconfirmed passes are pale yellow (sunlit) or grey
(in shadow), and only appear if the user ticked the corresponding box.

### 4.5 What you get at the end

- An **annotated composite** as a new image window (named `SkyIntruders_night`),
  built on the best frame of the night, with every streak labelled — name,
  country flag, altitude, angular speed, time, and the object's nature: **in
  service** / **out of service** for payloads, **rocket body** (« étage de
  fusée ») or **debris** for the rest, **unknown** when the public catalog has
  no status (typically classified objects). The same tag appears on the night
  log's satellite lines. It comes from the public satellite catalog; if that
  download failed for the session, the tag is simply absent — not an error.
- The same composite as a **PNG in the system temp folder**. The **Open image**
  button in the report window reopens it.
- A **night log** in markdown, shown in a window and printed to the console, with
  fun stats and a forum-ready post title. **Save report…** writes it next to the
  frames.
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
  written to disk automatically.** *Open HTML* writes it to a temporary folder and
  opens the browser; *Save HTML…* offers to save it next to the input image.
- A **copy-paste forum summary** inside that report.

**The chart deliberately draws fewer objects than the report counts.** Captured
objects are all labelled, but only the 6 most notable *below-noise* ones appear,
and past 40 labelled items the rest get a bare marker. The HTML illustrates the
top 8 with thumbnails and lists up to 60. So "the summary says 47 galaxies but I
only see 12 on the map" is expected: the counts are complete, the drawing is
curated for legibility.

---

## 6. Internet, catalogs and caches

### 6.1 What it contacts, and firewalls

Four hosts, all HTTPS. A restrictive firewall must allow them:

- `celestrak.org` — satellite orbital elements.
- `raw.githubusercontent.com` — the CaeloWorks mirror of those elements.
- `vizier.cds.unistra.fr` — galaxies, quasars, planetary nebulae, bright stars.
- `ssp.imcce.fr` — asteroids.

**The script sets no proxy of its own.** It uses PixInsight's networking, so a
user behind a corporate proxy must configure it **in PixInsight**, not in the
script.

### 6.2 Satellite elements and the mirror — why it sometimes pauses

Orbital elements are fetched from CelesTrak first, then from the CaeloWorks
mirror on GitHub if CelesTrak does not answer. CelesTrak rate-limits or blocks
some networks outright, so **a pause of 10 to 25 seconds before satellites
resolve is normal**: that is CelesTrak timing out and the mirror taking over. It
is not a bug and needs no action.

Elements are cached for 12 hours.

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

- **`settings.json`** — all dialog settings. Deleting it resets them to defaults.
- **`history.json`** — the personal records. **Deleting it destroys them
  permanently.**
- **`tle/`** — the satellite element cache. **Deleting this folder is the standard
  fix for stale or wrong satellite names.**
- **`treasure-cache/`** — the deep-catalog cache, kept for **30 days**. **Deleting
  this folder is the standard fix for "Treasure Hunt still finds nothing after I
  fixed my internet".**

> **Never tell a user to delete the whole `.caeloworks/sky-intruders` folder.** It
> takes their settings *and their personal records* with it. Always name the
> subfolder: `tle` or `treasure-cache`.

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

### 7.2 Console messages, Night trails

- *"no observer site in the FITS headers (SITELAT, OBSGEO-B/L, LAT/LONG-OBS) or
  dialog fallback — satellite identification disabled."* — **the number one
  cause of "nothing was identified"**. Trails are detected but cannot be named.
  Fix: any of the listed header pairs in the frames, or fill the Observer site
  fields in the Night trails tab. (Versions 0.1.1 and earlier word this message
  "no observer site (SITELAT/SITELONG headers or dialog fallback)" — same
  meaning.)
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
- *"Field orientation fit found only N matched pair(s) — not enough to trust
  satellite names; crossers are reported as predictions only."* — no plate solve,
  and the fallback fit could not be trusted. **Nothing gets named.** Fix:
  plate-solve at least the first frame in the list.
- *"no frame could be analyzed"* — fatal; nothing could be opened at all.

### 7.3 Console messages, Treasure Hunt

- *"Treasure/Catalogs: galaxy query failed: …"* (also `quasar`, `pne`,
  `asteroid`) — **a catalog was unreachable.** This is important: the report will
  still cheerfully say `0 row(s)`. See the Known bugs section — an outage looks
  exactly like an empty field.
- *"Treasure/Catalogs: asteroid query failed after retries"* — the asteroid
  service did not answer after three tries.
- *"galaxies: 0 row(s)"* — **ambiguous by itself.** It means either "nothing is
  there" or "the catalog did not answer". Always ask for the lines above it.

---

## 8. Known bugs and limitations — read before answering

### 8.1 A catalog outage looks exactly like an empty field

**This is the most dangerous gap in the product for support.** When a deep-sky
catalog (VizieR or SkyBoT) is unreachable, the query returns an *empty result*
rather than an error. Consequences:

- The run completes normally and reports `galaxies: 0 row(s)`.
- The report's "some catalogs did not respond" banner **does not appear**.
- The **only** evidence is a console warning line: *"Treasure/Catalogs: … query
  failed: …"*.

So *"Treasure Hunt found nothing"* and *"Treasure Hunt could not reach the
catalogs"* are indistinguishable to the user. **Always ask for the full console
text** before concluding that a field is empty. Confirm the bug if you see the
warning; do not tell the user their field is empty. Escalate.

### 8.2 An empty result stays cached for 30 days

When a deep-sky catalog is unreachable, Treasure Hunt reports zero objects rather
than an error — and that empty result is then **cached for 30 days**. A user who
hits an outage, fixes their network, and re-runs will get **the same empty result
straight from the cache**, with nothing in the console at all.

This is the single most likely cause of *"I fixed my internet and it still finds
nothing."*

**Workaround:** have them delete the `treasure-cache` folder inside
`.caeloworks/sky-intruders` in their home folder, then re-run. Changing the "Max
catalog rows / type" value also forces a fresh query. Escalate the bug itself.

### 8.3 The detection threshold slider does nothing on a normal night run

The **Detection threshold (σ)** slider in the Night trails tab does **not** affect
a normal run. Detection happens on a registered difference image, which uses its
own fixed internal threshold; the slider only applies to the degraded fallback
path used when there are fewer than three frames.

**Do not tell a user to lower it to catch a faint trail.** It will change
nothing, and they will lose confidence in the advice. If they need more
sensitivity, there is currently no setting for it — escalate.

### 8.4 Longitude sign is taken at face value

`SITELONG` is read exactly as written — there is no East/West convention
correction. A file that writes West longitudes as positive silently places the
observer on the wrong side of the planet, and **every satellite identification
then fails**, with no error message.

**Symptom:** "trails are detected, the site is filled in, and still nothing is
named." Have the user check the sign of their longitude. Escalate if it is
correct.

### 8.5 Trains and aircraft can be confused, and parallel satellites merged

The distinction between a **satellite train** and an **airplane** rests on a
single measurement: whether the brightness flickers along the trail. A steadily
lit aircraft can therefore be reported as a satellite train, and a tumbling train
as an aircraft.

Separately, **three genuinely unrelated but roughly parallel satellite trails can
be merged into one "train"** — and a bundle is never given satellite names, so
those three lose their identities. Known limitation, no workaround.

### 8.6 The star chart shows fewer objects than the summary counts

Not a bug. Treasure Hunt labels every *captured* object, but only the 6 most
notable *below-noise* ones, and past 40 labelled items the remainder get a bare
marker with no label. The HTML report illustrates the top 8 and lists up to 60.

The counts in the summary are complete and correct. The drawing is curated so the
chart stays readable. Reassure the user; nothing was lost.

### 8.7 A saturated core can be reported as "below the noise"

If the ring the script measures around an object is flat or clipped — which
happens on very bright, blown-out targets — it refuses to claim a detection
rather than compute a meaningless signal-to-noise value. The object is then
reported as below the noise even though it is plainly visible.

Rare, but real. Confirm it rather than arguing with the user, and escalate.

### 8.8 Asteroid candidates are unreliable on plate-solved sets, and a crowd of them is suppressed

On a plate-solved night set, the slow-mover detector can mistake dithered
sensor artifacts (hot pixels) for asteroid candidates. As a stopgap, when more
than 5 candidates appear on one field the whole list is suppressed and the
console says:

> *"N slow-mover candidates on one field look like a sensor-artifact storm,
> not asteroids — list suppressed."*

That message is expected behaviour, not a failure — a real night holds zero to
a couple of slow movers, never dozens. The cost of the stopgap: on such a
night, a *real* slow mover would be suppressed along with the noise. A proper
hardening is planned; treat any user report of a **confirmed** real asteroid
being suppressed as valuable and escalate it. Up to 5 candidates are still
reported normally, and the *asteroid candidate* lines that do appear should be
treated as candidates to verify, not confirmed detections.

### 8.9 The update repository is unsigned

PixInsight warns that the CaeloWorks repository is not signed. Expected; signing
is underway. It is safe to accept, and it says nothing about the integrity of the
files.

---

## 9. Troubleshooting — symptom → cause → answer

| The user says | It means | Tell them |
|---|---|---|
| "I installed it but there is no menu entry" | PixInsight not restarted, or the feature registry is stale | Restart PixInsight, then **Script → Feature Scripts… → Regenerate**. It lives under **Script → CaeloWorks → Sky Intruders**. |
| "It found no trails at all" | Fewer than 3 frames, or fewer than 3 **per filter** | Difference detection needs at least 3 frames of the same filter. Check the console for *"filter group … has only N frame(s)"*. |
| "Trails are found but nothing is identified" | **No observer site** — by far the most common | The frames need site headers (`SITELAT`/`SITELONG`, `OBSGEO-B`/`OBSGEO-L` or `LAT-OBS`/`LONG-OBS`), or the user fills Lat/Lon in the Night trails tab. Without a site, identification is switched off entirely. |
| "Still nothing is identified, and my site is filled in" | No plate solve, and the orientation fallback gave up (fewer than 3 matching trails) | Plate-solve at least the **first** frame in the list. |
| "The satellite names look wrong" | Stale orbital elements, or a wrong longitude sign | Look for **`(STALE — network unreachable)`** in the console; if present, delete the `tle` folder in `.caeloworks/sky-intruders` and re-run. Then check the longitude sign. |
| "It says 'unidentified satellite' / orange trail" | No catalog match — a fresh launch, a classified object, or debris | **This is a correct, honest answer, not a failure.** The script refuses to guess a name it cannot support. |
| "Treasure Hunt says my image has no WCS, but I solved it" | The solve is not on the image the script opened | With an empty input list the script uses the **active window**. Make sure the solved image is the one being read. A WBPP master is normally already solved. |
| "Treasure Hunt found nothing" | Possibly a **catalog outage**, which reads as an empty field | Ask for the console text and look for *"Treasure/Catalogs: … query failed"*. If they "already fixed their internet", have them delete the `treasure-cache` folder — an empty result is cached for 30 days. |
| "It found no planetary nebulae" | Normal away from the Milky Way | The nebula catalog essentially only covers the galactic plane. Zero is the correct answer for most fields. |
| "It says below the noise but I can see the object" | Working as intended in most cases | The object must beat its local surroundings and 12 decoy apertures. Objects on nebulosity or in dense star fields legitimately fail. A blown-out saturated core can also trigger it — that one is a real bug, escalate. |
| "I got exactly 400 objects" | The per-catalog row cap | Raise **Max catalog rows / type**. |
| "The map shows far fewer objects than the summary" | Deliberate — the chart is curated | The counts are complete; only the most notable below-noise objects are drawn. |
| "Lowering the σ slider changed nothing" | **Known bug** — the slider does not affect a normal night run | Confirm it. Do not blame the user. Escalate. |
| "PixInsight warns about an unsigned repository" | Expected — not signed yet | Safe to accept. |
| "It takes 20 seconds before it finds any satellites" | CelesTrak timing out, mirror taking over | Normal. No action needed. |

---

## 10. Escalating

**Stop and hand over to a human** when: the user reports one of the known bugs
above (an outage that reads as an empty field, the dead σ slider, a saturated
core called "below the noise", a merged train); when they have lost data (a
deleted `history.json` cannot be recovered); when the answer is not in this
document. **Do not improvise a threshold, a file path, or a compatibility claim.**

Collect these five things first. Without them the report is not actionable:

1. **PixInsight version and OS** (Help → About).
2. **Sky Intruders version** — hover the **"by CaeloWorks"** line under the title
   in the script window; the tooltip ends with the build number.
3. **The complete console output of the run.** The script logs every decision it
   makes there, and several failures — including catalog outages — appear
   *nowhere else*. This alone usually settles the diagnosis.
4. **Which mode**, how many frames, and **whether the frames are plate-solved** —
   specifically whether the **first** frame in the list is.
5. **The FITS header of one frame**: `DATE-OBS`, `EXPTIME`, `SITELAT`,
   `SITELONG`, `FILTER`, `OBJECT`.

For a misidentification, also ask **which name they expected** and which name they
got.

File issues at https://github.com/caelo-works/sky-intruders/issues.
