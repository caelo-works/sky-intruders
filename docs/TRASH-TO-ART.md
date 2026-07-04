# Sky Intruders — Trash to Art mode

*Your rejects have talent.* All those frames the analyzers set aside — satellite
trails, wind gusts, clouds — get recycled into art instead of the bin: an
intruder-choreography poster of the night's passes, a classic star-trail
composite, or a designed *"the 47 intruders of my night"* poster. Nothing is
lost, everything is shareable. It closes the loop with the two analyzers:
*your trash, we make it art.*

This is the third mode of the Sky Intruders suite. Where **Night trails** asks
*who crossed your photo* and **Treasure Hunt** asks *what's already in it*,
**Trash to Art** asks *what can we make from what you threw away.*

## Inputs (both supported)

- **The current session's rejects** — chain straight after a Night-trails
  analysis: the frames Sky Intruders just flagged as carrying trails become the
  raw material, no re-selection. The poetic *analyze → art* loop.
- **A folder of rejects** — point at any directory (e.g. the `rejected/`
  subfolder dark-frame-analyzer moves its outliers to). Standalone, no prior
  analysis needed; trails are detected on the spot with the Night-trails engine.

## Outputs (v1: all three)

1. **Intruder choreography** — the star of the mode, and the cheapest because it
   reuses Night-trails detection. Every detected trail is drawn onto one canvas
   (black sky, or a chosen base light for context), color-coded by a scheme:
   - *time* — a dawn→dusk gradient so the eye reads the night's chronology;
   - *type* — satellite / meteor / asteroid / unknown each its own hue;
   - *operator* — Starlink / OneWeb / ISS / … each its own hue.
   A legend and the night's headline stats frame it.
2. **Star-trail composite** — the classic lighten/maximum per-pixel combine of
   the frames into star trails. Works best with many frames; honest about it when
   given only a handful of rejects (says so rather than producing a sparse mess).
3. **Designed poster** — a laid-out, high-resolution shareable piece combining the
   choreography, a few zoomed intruder thumbnails, and the stats, titled
   *"the N intruders of my night"*. Astrophoto-native dark aesthetic consistent
   with the script's brand (NOT the internal homelab design system). Exported as a
   self-contained HTML (embedded PNGs) and a flattened PNG.

## Pipeline

1. Gather frames (session rejects or folder). For folder input, run the
   Night-trails detector on each to get trails (+ classification, + TLE match when
   an observer site and WCS are present; degrades to raw trails otherwise).
2. Normalize trail geometry onto a common canvas (frames of equal dimensions map
   1:1; mixed sizes are scaled to the target canvas).
3. Assign colors per the chosen scheme.
4. Render:
   - choreography → a new image window + PNG;
   - star-trail composite → a new image window + PNG (max-combine engine);
   - designed poster → self-contained HTML + flattened PNG.

## Modules

```
pjsr/lib/TrashArt.js     pure: color schemes, canvas-normalization math, poster
                         text model, legend layout, poster HTML assembly
```

PI-facing compositing (max-combine, drawing trails onto a Bitmap, PNG/base64
export) lives in the entry script's Trash-to-Art mode and shares the common
rendering helpers with Treasure Hunt (annotated bitmap, crops, base64 PNG).

## Shared with the other modes

- Night-trails detection (`SITrailDetect`) supplies the trails.
- The rendering primitives (Bitmap draw, PNG encode, base64) are shared with
  Treasure Hunt's overlay/thumbnail rendering — one helper, two consumers.
- The color-by-operator mapping reuses `SIReport.classifyOperator`.

## Pure, testable

Color assignment (schemes, deterministic hues), canvas normalization (endpoint
scaling across mixed frame sizes), the poster text model (title/stat lines/legend
from a night summary), and the poster HTML assembly are all pure and unit-tested
under Node. The compositing itself is validated headless on synthetic frames.
