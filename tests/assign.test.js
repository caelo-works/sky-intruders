// assignTrails / assignTrailsLoose: snapshot pin. The scenarios are generated
// from a seeded PRNG (so the file is the only fixture), run through both
// assigners, and the crossing fields the assigners write are compared
// bit-for-bit with tests/fixtures/match/assign-snapshot.json, recorded from
// the implementation as it stood before the two were merged into one core.
// Regenerate deliberately with:  node tests/assign.test.js --write
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { SISatMatch } = require(__dirname + "/build/module.js");

const core = SISatMatch.core;
const fixture = path.join(__dirname, "fixtures", "match", "assign-snapshot.json");
const DEG = Math.PI / 180;

let seed = 424242;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(a) { return a[Math.floor(rnd() * a.length)]; }

// Point at (along, cross) degrees from a center along a track of position
// angle pa: small-field planar offsets, enough to exercise the gates.
function offsetPoint(center, paDeg, alongDeg, crossDeg) {
   const pa = paDeg * DEG;
   const dN = alongDeg * Math.cos(pa) - crossDeg * Math.sin(pa);
   const dE = alongDeg * Math.sin(pa) + crossDeg * Math.cos(pa);
   return { raDeg: center.raDeg + dE / Math.cos(center.decDeg * DEG), decDeg: center.decDeg + dN };
}
function segment(center, paDeg, lenDeg, alongDeg, crossDeg) {
   const mid = offsetPoint(center, paDeg, alongDeg, crossDeg);
   const p1 = offsetPoint(mid, paDeg, -lenDeg / 2, 0), p2 = offsetPoint(mid, paDeg, lenDeg / 2, 0);
   return rnd() < 0.5 ? { p1, p2 } : { p1: p2, p2: p1 };
}

function scenario(k) {
   const center = { raDeg: rnd() * 360, decDeg: -60 + rnd() * 120 };
   const nCross = 1 + Math.floor(rnd() * 4), crossings = [], trails = [];
   for (let c = 0; c < nCross; c++) {
      const pa = rnd() * 360, len = 0.3 + rnd() * 2.5;
      const along = -0.8 + rnd() * 1.6, cross = -0.8 + rnd() * 1.6;
      const s = segment(center, pa, len, along, cross);
      crossings.push({ noradId: 10000 + k * 10 + c, name: "SAT " + c, sunlit: rnd() > 0.15,
                       path: s, matchedTrailIndex: null });
      // 0-2 trails derived from this crossing, perturbed across the gates
      const nDerived = Math.floor(rnd() * 3);
      for (let d = 0; d < nDerived; d++) {
         const dAng = pick([0, 0.5, 1.2, 2, 4, 7, 9, 13, 20]) * (rnd() < 0.5 ? -1 : 1);
         const dCross = pick([0, 0.05, 0.2, 0.39, 0.41, 0.6, 0.79, 0.81, 1.0, 1.5, 1.7]) * (rnd() < 0.5 ? -1 : 1);
         const dAlong = pick([0, 0.1, 0.3, 0.59, 0.61, 1.0, 1.49, 1.51, 2.0]) * (rnd() < 0.5 ? -1 : 1);
         const t = segment(center, pa + dAng, len * (0.5 + rnd()), along + dAlong, cross + dCross);
         trails.push({ index: trails.length, p1: t.p1, p2: t.p2 });
      }
   }
   // a stray trail or two, and one without sky coordinates
   for (let s = Math.floor(rnd() * 3); s > 0; s--) {
      const t = segment(center, rnd() * 360, 0.3 + rnd() * 2, -1 + rnd() * 2, -1 + rnd() * 2);
      trails.push({ index: trails.length, p1: t.p1, p2: t.p2 });
   }
   if (rnd() < 0.2) trails.push({ index: trails.length, p1: null, p2: null });
   return { crossings, trails };
}

function assigned(crossings) {
   return crossings.map(c => ({ matchedTrailIndex: c.matchedTrailIndex,
                                 matchScore: c.matchScore, sepDeg: c.sepDeg,
                                 angleDiffDeg: c.angleDiffDeg, matchConfidence: c.matchConfidence }));
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }

const strictOpt = core.normalizedOptions({ matchMaxSepDeg: 0.5, matchMaxAngleDiffDeg: 10 });
const strictOptAlong = core.normalizedOptions({ matchMaxSepDeg: 0.35, matchMaxAngleDiffDeg: 15, alongTolDeg: 1.0 });
const looseOpts = [{}, { crossTolDeg: 0.3, alongTolDeg: 1.0, angleTolDeg: 8 }];

const out = [];
for (let k = 0; k < 400; k++) {
   const sc = scenario(k);
   const strictCrs = clone(sc.crossings);
   core.assignTrails(strictCrs, { trails: clone(sc.trails) }, (k % 2) ? strictOpt : strictOptAlong);
   const looseCrs = clone(sc.crossings);
   core.assignTrailsLoose(looseCrs, { trails: clone(sc.trails) }, looseOpts[k % 2]);
   out.push({ strict: assigned(strictCrs), loose: assigned(looseCrs) });
}

// the generator must exercise every path: strict matches, loose high and
// medium (rescue) matches, and crossings left unmatched
const count = (mode, pred) => out.reduce((n, s) => n + s[mode].filter(pred).length, 0);
assert.ok(count("strict", c => c.matchedTrailIndex != null) > 50, "strict matches");
assert.ok(count("loose", c => c.matchConfidence === "high") > 50, "loose high matches");
assert.ok(count("loose", c => c.matchConfidence === "medium") > 10, "loose rescue matches");
assert.ok(count("loose", c => c.matchedTrailIndex == null) > 50, "unmatched crossings");

if (process.argv.indexOf("--write") >= 0) {
   fs.writeFileSync(fixture, JSON.stringify(out));
   console.log("assign: snapshot written (" + out.length + " scenarios)");
} else {
   const ref = JSON.parse(fs.readFileSync(fixture, "utf8"));
   assert.strictEqual(out.length, ref.length, "scenario count");
   for (let k = 0; k < out.length; k++)
      for (const mode of ["strict", "loose"])
         assert.deepStrictEqual(clone(out[k][mode]), ref[k][mode], `scenario ${k} (${mode}) differs from the snapshot`);
   console.log("assign: ok (" + out.length + " scenarios, both modes bit-identical to the snapshot)");
}
