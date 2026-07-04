// SISatMatch: replay the Go-engine reference fixtures (tests/fixtures/match/).
// The Go sidecar is the certified reference; these tests pin the JS port to
// its propagation (ECI, topocentric RA/Dec, sunlit, range) and to its full
// match response (crossing identity, times, path, rate, score).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { SISatMatch } = require(__dirname + "/build/module.js");

const core = SISatMatch.core;
const fixDir = path.join(__dirname, "fixtures", "match");
const readJson = f => JSON.parse(fs.readFileSync(path.join(fixDir, f), "utf8"));

const tleText = fs.readFileSync(path.join(fixDir, "delta.tle"), "utf8");
const propagation = readJson("propagation.json");
const request = readJson("request.json");
const reference = readJson("response.json");

// ---------------------------------------------------------------------------
// TLE parsing (same validation semantics as tle.go)

const tles = SISatMatch.parseTles(tleText);
assert.strictEqual(tles.length, 1, "delta.tle must yield exactly one record");
assert.strictEqual(tles[0].noradId, 6251);
assert.strictEqual(tles[0].intlDes, "1962-025E");
assert.strictEqual(tles[0].name, "DELTA 1 DEB");

// A bad record must be skipped silently, not kill the parse
const lines = tleText.trim().split("\n");
const garbled = "This is not a TLE\n1 garbage line that starts like one\n" + tleText;
assert.strictEqual(SISatMatch.parseTles(garbled).length, 1, "bad records must be skipped");

// Alpha-5 satnums (letter-prefixed) are rejected like in the Go engine
const alpha5 = lines[0] + "\n" +
   lines[1].substring(0, 2) + "A6251" + lines[1].substring(7) + "\n" +
   lines[2].substring(0, 2) + "A6251" + lines[2].substring(7) + "\n";
assert.strictEqual(SISatMatch.parseTles(alpha5).length, 0, "Alpha-5 must be rejected");

// ---------------------------------------------------------------------------
// Propagation replay: fixture steps run every 10 s from the frame start.
// propagation.json prints whole-second UTC labels (Go RFC3339 truncation);
// the exact instants carry the frame start's fractional second, recovered
// from request.json (fixture provenance: sidecar/fixtures_test.go).

const startMs = core.parseRfc3339Ms(request.frames[0].startUtc);
assert.ok(startMs !== null, "request startUtc must parse");

const entry = core.newSatEntry(tles[0]);
propagation.steps.forEach((s, i) => {
   const t = startMs + i * 10000;
   assert.strictEqual(core.formatRfc3339Ms(t), s.utc, `step ${i}: time mismatch`);

   const pv = core.propagateAt(entry, t);
   assert.ok(pv !== null, `step ${i}: propagation failed`);
   for (const [axis, ref] of [["x", s.xKm], ["y", s.yKm], ["z", s.zKm]])
      assert.ok(Math.abs(pv.pos[axis] - ref) < 1.0,
         `step ${i}: ECI ${axis} = ${pv.pos[axis]} vs ${ref} (>1 km)`);

   const jd = core.jdayOfMs(t);
   const obs = core.observerEci(propagation.observer, jd);
   const rd = core.topocentricRaDec(pv.pos, obs.pos);
   const sep = core.angularSepDeg(rd, { raDeg: s.raDeg, decDeg: s.decDeg });
   assert.ok(sep < 0.05, `step ${i}: RA/Dec off by ${sep} deg (>0.05)`);

   const sunlit = core.isSunlit(pv.pos, core.sunDirection(jd));
   assert.strictEqual(sunlit, s.sunlit, `step ${i}: sunlit flag`);

   const dx = pv.pos.x - obs.pos.x, dy = pv.pos.y - obs.pos.y, dz = pv.pos.z - obs.pos.z;
   const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
   assert.ok(Math.abs(range - s.rangeKm) < 2.0,
      `step ${i}: range ${range} vs ${s.rangeKm} (>2 km)`);
});

// ---------------------------------------------------------------------------
// Full match replay against the Go CLI response

const res = SISatMatch.match(request, tleText, "delta");
assert.strictEqual(res.error, null, "match must succeed: " + JSON.stringify(res.error));
assert.strictEqual(res.tle.count, 1);
assert.strictEqual(res.tle.source, "delta");
assert.strictEqual(res.frames.length, reference.frames.length);
assert.strictEqual(res.frames[0].id, reference.frames[0].id);

const got = res.frames[0].crossings;
const want = reference.frames[0].crossings;
assert.strictEqual(got.length, want.length, "crossing count");
const c = got[0], w = want[0];

assert.strictEqual(c.noradId, 6251);
assert.strictEqual(c.intlDes, "1962-025E");
assert.strictEqual(c.name, "DELTA 1 DEB");

const dtEntry = Math.abs(core.parseRfc3339Ms(c.entryUtc) - core.parseRfc3339Ms(w.entryUtc));
const dtExit = Math.abs(core.parseRfc3339Ms(c.exitUtc) - core.parseRfc3339Ms(w.exitUtc));
assert.ok(dtEntry <= 2000, `entryUtc ${c.entryUtc} vs ${w.entryUtc} (>2 s)`);
assert.ok(dtExit <= 2000, `exitUtc ${c.exitUtc} vs ${w.exitUtc} (>2 s)`);

const dP1 = core.angularSepDeg(c.path.p1, w.path.p1);
const dP2 = core.angularSepDeg(c.path.p2, w.path.p2);
assert.ok(dP1 < 0.05, `path p1 off by ${dP1} deg (>0.05)`);
assert.ok(dP2 < 0.05, `path p2 off by ${dP2} deg (>0.05)`);

const rateRel = Math.abs(c.angularRateDegPerSec - w.angularRateDegPerSec) / w.angularRateDegPerSec;
assert.ok(rateRel < 0.03, `angular rate ${c.angularRateDegPerSec} vs ${w.angularRateDegPerSec} (>3%)`);
assert.ok(Math.abs(c.rangeKm - w.rangeKm) < 2.0, `rangeKm ${c.rangeKm} vs ${w.rangeKm}`);
assert.ok(Math.abs(c.elevationDeg - w.elevationDeg) < 0.5,
   `elevation ${c.elevationDeg} vs ${w.elevationDeg} (>0.5 deg)`);
assert.strictEqual(c.sunlit, true);

assert.strictEqual(c.matchedTrailIndex, 0, "trail 0 must match");
assert.ok(Math.abs(c.matchScore - w.matchScore) < 0.05,
   `matchScore ${c.matchScore} vs ${w.matchScore} (>0.05)`);
assert.ok(typeof c.sepDeg === "number" && c.sepDeg <= 0.2, "sepDeg present and sane");
assert.ok(typeof c.angleDiffDeg === "number" && c.angleDiffDeg <= 12, "angleDiffDeg present and sane");

// ---------------------------------------------------------------------------
// Negative case: the same trail rotated 90 deg about its midpoint must not
// match (mirrors the Go e2e test's pass 3).

// destination point at a bearing/distance from p (deg), like match_test.go
function destination(p, bearingDeg, distDeg) {
   const D = Math.PI / 180;
   const la1 = p.decDeg * D, lo1 = p.raDeg * D, br = bearingDeg * D, d = distDeg * D;
   const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
   const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2));
   return { raDeg: ((lo2 / D) + 360) % 360, decDeg: la2 / D };
}

const trail = request.frames[0].trails[0];
const mid = core.midpointRaDec(trail.p1, trail.p2);
const pa = core.positionAngleDeg(trail.p1, trail.p2);
const len = core.angularSepDeg(trail.p1, trail.p2);
const rotReq = JSON.parse(JSON.stringify(request));
rotReq.frames[0].trails = [{
   index: 0,
   p1: destination(mid, pa + 90 + 180, len / 2),
   p2: destination(mid, pa + 90, len / 2),
   pixLength: 0, meanFluxAdu: 0, widthPx: 0, brightnessVariation: 0
}];
const resRot = SISatMatch.match(rotReq, tleText, "delta");
assert.strictEqual(resRot.error, null);
assert.strictEqual(resRot.frames[0].crossings.length, 1, "crossing must still be reported");
assert.strictEqual(resRot.frames[0].crossings[0].matchedTrailIndex, null,
   "rotated trail must not match");
assert.ok(!("matchScore" in resRot.frames[0].crossings[0]), "no matchScore when unmatched");

console.log("satmatch: 7 propagation steps within tolerance; match replay == Go reference; rotated trail rejected");
