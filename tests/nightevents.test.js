// SINightEvents.build: events, drawn segments, predicted passes and counts
// assembled from frames + crossings, in frame order.
const assert = require("assert");
const { SINightEvents, SISatLabels } = require(__dirname + "/build/module.js");

const t0 = new Date("2026-08-14T22:15:00Z");
const frames = [
   { meta: { id: "000_a.fits", name: "a.fits", dateObs: t0, exposureSec: 120 },
     trails: [
        { index: 0, x1: 10, y1: 10, x2: 900, y2: 700, planeGroup: null, spansEdgeToEdge: true,
          p1: { raDeg: 10, decDeg: 20 }, p2: { raDeg: 11, decDeg: 20.5 } },
        { index: 1, x1: 100, y1: 500, x2: 300, y2: 520, planeGroup: null, spansEdgeToEdge: false,
          brightnessVariation: 0.6, p1: { raDeg: 12, decDeg: 21 }, p2: { raDeg: 12.2, decDeg: 21 } },
        { index: 2, x1: 0, y1: 0, x2: 1, y2: 1, planeGroup: 0 }
     ],
     planeGroups: [ { kind: "plane", segments: 3, x1: 0, y1: 0, x2: 50, y2: 5 } ] },
   { meta: { id: "001_b.fits", name: "b.fits", dateObs: new Date(t0.getTime() + 130000), exposureSec: 120 },
     trails: [], planeGroups: [] }
];
const crossingsByFrame = {
   "000_a.fits": [
      { noradId: 44713, name: "STARLINK-1007", intlDes: "2019-074A", sunlit: true, sunlitFraction: 1,
        entryUtc: "2026-08-14T22:15:31.250Z", elevationDeg: 55, angularRateDegPerSec: 0.9, rangeKm: 600,
        matchedTrailIndex: 0, matchConfidence: "medium", shadowEntryUtc: null, shadowExitUtc: null },
      { noradId: 25544, name: "ISS (ZARYA)", sunlit: true, entryUtc: "2026-08-14T22:16:10.000Z",
        elevationDeg: 30, matchedTrailIndex: null },
      { noradId: 1, name: "DARK", sunlit: false, entryUtc: "2026-08-14T22:16:20.000Z", matchedTrailIndex: null }
   ]
};
const satcat = { 44713: { owner: "US", type: "PAY", ops: "+" } };

const r = SINightEvents.build(frames, crossingsByFrame, satcat, "en");

assert.strictEqual(r.cleanFrames, 1);
assert.strictEqual(r.totalExposureSec, 240);
assert.strictEqual(r.events.length, 3, "matched satellite + plane bundle + leftover trail");
assert.deepStrictEqual(r.events.map(e => e.klass), ["satellite", "plane", r.events[2].klass]);
assert.ok(r.events[2].klass === "meteor" || r.events[2].klass === "unknown" || r.events[2].klass === "satellite-candidate",
   "leftover trail goes through the meteor heuristic");

const sat = r.events[0];
assert.strictEqual(sat.name, "STARLINK-1007");
assert.strictEqual(sat.confidence, "medium");
assert.strictEqual(sat.satClass, "active");
assert.strictEqual(sat.timeUtc.toISOString(), "2026-08-14T22:15:31.250Z");
assert.strictEqual(sat.frameName, "a.fits");
assert.strictEqual(r.events[1].segments, 3);
assert.strictEqual(r.events[1].timeUtc, t0, "bundle dated by the frame");

assert.strictEqual(r.labeledTrails.length, 3);
assert.strictEqual(r.labeledTrails[0].label, "STARLINK-1007 ? · 22:15 UT");
assert.strictEqual(r.labeledTrails[0].flag, "us");
assert.strictEqual(r.labeledTrails[0].color, SISatLabels.TRAIL_STYLE.satellite);
assert.strictEqual(r.labeledTrails[0].sub, SISatLabels.telemetryLine(crossingsByFrame["000_a.fits"][0], satcat, "en"));
assert.strictEqual(r.labeledTrails[1].label, "airplane (3)");
assert.strictEqual(r.labeledTrails[2].x1, 100, "the leftover trail is drawn on its own coordinates");

assert.strictEqual(r.predicted.length, 1, "only the unmatched SUNLIT crosser is a predicted pass");
assert.strictEqual(r.predicted[0].name, "ISS (ZARYA)");
assert.strictEqual(r.predicted[0].timeUtc.toISOString(), "2026-08-14T22:16:10.000Z");

// no crossings at all, French labels
const r2 = SINightEvents.build(frames, {}, {}, "fr");
assert.strictEqual(r2.events.length, 3);
assert.strictEqual(r2.events[0].klass, "plane");
assert.strictEqual(r2.labeledTrails[0].label, "avion (3)");
assert.strictEqual(r2.predicted.length, 0);

console.log("nightevents: ok");
