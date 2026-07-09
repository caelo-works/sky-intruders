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

// ---------------------------------------------------------------------------
// Circular FOV (rotation unknown): a point inside the bounding circle must
// pass, one beyond it must fail, and rotationDeg: null must never yield NaN.

{
   const fov = { raDeg: 100, decDeg: 20, widthDeg: 2, heightDeg: 1, rotationDeg: null };
   assert.strictEqual(core.fovContains(fov, { raDeg: 100.4, decDeg: 20.4 }), true,
      "inside the bounding circle");
   assert.strictEqual(core.fovContains(fov, { raDeg: 101.5, decDeg: 21 }), false,
      "outside the bounding circle");
   const rot = { raDeg: 100, decDeg: 20, widthDeg: 2, heightDeg: 1, rotationDeg: 0 };
   assert.strictEqual(core.fovContains(rot, { raDeg: 100.9, decDeg: 20.4 }), true,
      "rotation 0 still uses the rectangle");
}

// ---------------------------------------------------------------------------
// Field-orientation fit: trails generated in a grid of KNOWN rotation and
// parity (with a small pointing error on the center) must be recovered by
// fitOrientation, and assignTrails must then name every crossing.

{
   const field = { raDeg: 313.973, decDeg: 31.415, pixScaleArcsec: 1.78,
                   width: 3856, height: 2180 };
   const ROT = 287, PARITY = -1;
   // ground truth: the REAL pointing is ~2.4 arcmin off the header value
   const truthCenter = { raDeg: field.raDeg + 0.04, decDeg: field.decDeg - 0.03 };
   const truthTan = core.tanForOrientation(truthCenter, field.pixScaleArcsec,
                                           field.width, field.height, ROT, PARITY);

   const segs = [
      { x1: 150, y1: 260, x2: 3700, y2: 850 },
      { x1: 400, y1: 2050, x2: 3500, y2: 300 },
      { x1: 2000, y1: 60, x2: 2300, y2: 2120 }
   ];
   const frames = segs.map((s, i) => {
      const p1 = core.tanProject(truthTan, s.x1, s.y1);
      const p2 = core.tanProject(truthTan, s.x2, s.y2);
      return {
         crossings: [
            { noradId: 1000 + i, name: "SYN-" + i, sunlit: true,
              path: { p1, p2 }, matchedTrailIndex: null },
            // decoy: sunlit crossing far from every trail (parallel offset)
            { noradId: 2000 + i, name: "DECOY-" + i, sunlit: true,
              path: { p1: { raDeg: p1.raDeg + 1.4, decDeg: p1.decDeg + 0.9 },
                      p2: { raDeg: p2.raDeg + 1.4, decDeg: p2.decDeg + 0.9 } },
              matchedTrailIndex: null }
         ],
         trails: [{ index: 0, x1: s.x1 + 1, y1: s.y1 - 1, x2: s.x2 - 1, y2: s.y2 + 1 }]
      };
   });

   const fit = SISatMatch.fitOrientation(frames, field, {});
   assert.ok(fit !== null, "fit must succeed");
   assert.strictEqual(fit.parity, PARITY, "parity recovered");
   const dRot = Math.abs(((fit.rotationDeg - ROT) % 360 + 360) % 360);
   assert.ok(Math.min(dRot, 360 - dRot) < 0.5, `rotation recovered (${fit.rotationDeg})`);
   assert.strictEqual(fit.pairs.length, 3, "all three trails paired");
   const dRa = Math.abs(fit.center.raDeg - truthCenter.raDeg);
   const dDec = Math.abs(fit.center.decDeg - truthCenter.decDeg);
   assert.ok(dRa < 0.03 && dDec < 0.03, `center corrected (${dRa}, ${dDec})`);

   // Assignment with the fitted TAN: every real crossing gets its trail,
   // every decoy stays unmatched.
   frames.forEach(fr => {
      fr.trails.forEach(t => {
         t.p1 = core.tanProject(fit.tan, t.x1, t.y1);
         t.p2 = core.tanProject(fit.tan, t.x2, t.y2);
      });
      core.assignTrails(fr.crossings, fr,
         core.normalizedOptions({ matchMaxSepDeg: 0.35 }));
      assert.strictEqual(fr.crossings[0].matchedTrailIndex, 0,
         fr.crossings[0].name + " must match trail 0");
      assert.strictEqual(fr.crossings[1].matchedTrailIndex, null,
         fr.crossings[1].name + " must stay unmatched");
   });

   console.log("satmatch: circular FOV + orientation fit (rot " +
      fit.rotationDeg.toFixed(2) + ", parity " + fit.parity + ") OK");
}

// ---------------------------------------------------------------------------
// Loose (no-plate-solve) assignment: an along-track offset of 0.6 degree —
// a satellite running late on its ephemeris — must still match when the
// orientation agrees; a wrong orientation or a cross-track offset must not.

{
   const mk = (raOff, decOff, paRotDeg) => {
      // crossing path along +RA at dec 30, optionally rotated
      const p1 = { raDeg: 100 - 0.8, decDeg: 30 };
      const p2 = { raDeg: 100 + 0.8, decDeg: 30 };
      const rot = (p, ang, c) => {
         const t = ang*Math.PI/180;
         const dx = (p.raDeg - c.raDeg)*Math.cos(30*Math.PI/180), dy = p.decDeg - c.decDeg;
         return { raDeg: c.raDeg + (dx*Math.cos(t) - dy*Math.sin(t))/Math.cos(30*Math.PI/180),
                  decDeg: c.decDeg + dx*Math.sin(t) + dy*Math.cos(t) };
      };
      const c = { raDeg: 100, decDeg: 30 };
      return { p1: rot({ raDeg: p1.raDeg + raOff, decDeg: p1.decDeg + decOff }, paRotDeg, c),
               p2: rot({ raDeg: p2.raDeg + raOff, decDeg: p2.decDeg + decOff }, paRotDeg, c) };
   };
   const crossing = (path, id) => ({ noradId: id, name: "SAT-" + id, sunlit: true,
                                     path, matchedTrailIndex: null });

   // trail = the crossing shifted 0.6 deg ALONG track (in RA)
   const alongTrail = { index: 0, p1: { raDeg: 100 - 0.8 + 0.6/Math.cos(30*Math.PI/180), decDeg: 30 },
                        p2: { raDeg: 100 + 0.8 + 0.6/Math.cos(30*Math.PI/180), decDeg: 30 } };
   let crs = [crossing(mk(0, 0, 0), 1)];
   SISatMatch.core.assignTrailsLoose(crs, { trails: [alongTrail] }, {});
   assert.strictEqual(crs[0].matchedTrailIndex, 0, "along-track offset matches");

   // cross-track 1.0 deg with a near-exact angle: the angle-dominant lone
   // rescue claims it (maneuvering-constellation TLEs land that far out)
   const crossTrail = { index: 0, p1: { raDeg: 100 - 0.8, decDeg: 31.0 },
                        p2: { raDeg: 100 + 0.8, decDeg: 31.0 } };
   crs = [crossing(mk(0, 0, 0), 2)];
   SISatMatch.core.assignTrailsLoose(crs, { trails: [crossTrail] }, {});
   assert.strictEqual(crs[0].matchedTrailIndex, 0, "aligned sideways offset rescued");
   assert.strictEqual(crs[0].matchConfidence, "medium", "sideways rescue is medium");

   // cross-track 2.0 deg: beyond every gate -> no match
   const farTrail = { index: 0, p1: { raDeg: 100 - 0.8, decDeg: 32.0 },
                      p2: { raDeg: 100 + 0.8, decDeg: 32.0 } };
   crs = [crossing(mk(0, 0, 0), 4)];
   SISatMatch.core.assignTrailsLoose(crs, { trails: [farTrail] }, {});
   assert.strictEqual(crs[0].matchedTrailIndex, null, "very large cross-track offset rejected");

   // wrong orientation (30 deg): must NOT match
   crs = [crossing(mk(0, 0, 30), 3)];
   SISatMatch.core.assignTrailsLoose(crs, { trails: [alongTrail] }, {});
   assert.strictEqual(crs[0].matchedTrailIndex, null, "wrong orientation rejected");

   console.log("satmatch: loose along-track assignment OK");
}

// Rescue pass: a lone sunlit crossing 0.6 deg SIDEWAYS of a lone trail with
// near-perfect orientation is matched at medium confidence; ambiguity
// (two crossings) blocks the rescue.

{
   const path = { p1: { raDeg: 99.2, decDeg: 30 }, p2: { raDeg: 100.8, decDeg: 30 } };
   const trail = { index: 0, p1: { raDeg: 99.2, decDeg: 30.6 }, p2: { raDeg: 100.8, decDeg: 30.6 } };
   let crs = [{ noradId: 9, name: "LONE", sunlit: true, path, matchedTrailIndex: null }];
   SISatMatch.core.assignTrailsLoose(crs, { trails: [trail] }, {});
   assert.strictEqual(crs[0].matchedTrailIndex, 0, "lone sideways crossing rescued");
   assert.strictEqual(crs[0].matchConfidence, "medium", "rescue is medium confidence");

   // second crossing ALSO within the rescue gates (cross 0.65 deg from the
   // trail) — a genuine ambiguity, so neither may be named
   const path2 = { p1: { raDeg: 99.2, decDeg: 29.95 }, p2: { raDeg: 100.8, decDeg: 29.95 } };
   crs = [{ noradId: 9, name: "A", sunlit: true, path, matchedTrailIndex: null },
          { noradId: 10, name: "B", sunlit: true, path: path2, matchedTrailIndex: null }];
   SISatMatch.core.assignTrailsLoose(crs, { trails: [trail] }, {});
   assert.strictEqual(crs[0].matchedTrailIndex, null, "ambiguous rescue blocked (A)");
   assert.strictEqual(crs[1].matchedTrailIndex, null, "ambiguous rescue blocked (B)");

   console.log("satmatch: medium-confidence rescue OK");
}
