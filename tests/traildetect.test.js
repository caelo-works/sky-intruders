// SITrailCore: synthetic star fields with injected trails
const assert = require("assert");
const { SITrailCore: T } = require(__dirname + "/build/module.js");

// Deterministic pseudo-random generator (LCG) — tests must be reproducible
let seed = 1234;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
function gauss(mu, sigma) {
   const u = Math.max(rnd(), 1e-12), v = rnd();
   return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const W = 400, H = 300, BG = 100, SIGMA = 10;
const PARAMS = { kSigma: 5, minLengthFrac: 0.15, maxTrails: 10, fillRatioMin: 0.6 };

function makeField(nStars) {
   const data = new Float64Array(W * H);
   for (let i = 0; i < data.length; ++i) data[i] = gauss(BG, SIGMA);
   for (let s = 0; s < nStars; ++s) {
      const x = 3 + Math.floor(rnd() * (W - 6));
      const y = 3 + Math.floor(rnd() * (H - 6));
      const amp = (8 + 7 * rnd()) * SIGMA; // 8..15 sigma
      for (let dy = -1; dy <= 1; ++dy)
         for (let dx = -1; dx <= 1; ++dx)
            data[(y + dy) * W + (x + dx)] += (dx === 0 && dy === 0) ? amp : 0.6 * amp;
   }
   return data;
}

function drawSegment(data, x1, y1, x2, y2, amp) {
   // ~2 px wide solid segment; each pixel gets amp exactly once
   const dx = x2 - x1, dy = y2 - y1;
   const len = Math.hypot(dx, dy);
   const ux = dx / len, uy = dy / len, px = -uy, py = ux;
   const visited = new Set();
   for (let t = 0; t <= len; t += 0.5)
      for (const o of [-0.6, 0, 0.6]) {
         const xi = Math.round(x1 + ux * t + px * o);
         const yi = Math.round(y1 + uy * t + py * o);
         if (xi < 0 || xi >= W || yi < 0 || yi >= H) continue;
         const idx = yi * W + xi;
         if (!visited.has(idx)) { visited.add(idx); data[idx] += amp; }
      }
}

function drawDashed(data, x1, y1, x2, y2, amp, onLen, offLen) {
   // Isolated dots: onLen px of dash, offLen px of gap (fill = on/(on+off))
   const dx = x2 - x1, dy = y2 - y1;
   const len = Math.hypot(dx, dy);
   const ux = dx / len, uy = dy / len;
   const visited = new Set();
   for (let t = 0; t <= len; t += 0.5) {
      if ((t % (onLen + offLen)) >= onLen) continue;
      const xi = Math.round(x1 + ux * t);
      const yi = Math.round(y1 + uy * t);
      if (xi < 0 || xi >= W || yi < 0 || yi >= H) continue;
      const idx = yi * W + xi;
      if (!visited.has(idx)) { visited.add(idx); data[idx] += amp; }
   }
}

function angleDiff(a, b) {
   let d = Math.abs(a - b) % 180;
   return Math.min(d, 180 - d);
}

function endpointError(trail, x1, y1, x2, y2) {
   const d = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
   const direct = Math.max(d(trail.x1, trail.y1, x1, y1), d(trail.x2, trail.y2, x2, y2));
   const swapped = Math.max(d(trail.x1, trail.y1, x2, y2), d(trail.x2, trail.y2, x1, y1));
   return Math.min(direct, swapped);
}

// --- binImage: 4x4 → 2x2 block averages --------------------------------------

{
   const src = [ 1, 2, 3, 4,
                 5, 6, 7, 8,
                 9, 10, 11, 12,
                 13, 14, 15, 16 ];
   const strips = [];
   const binned = T.binImage(4, 4, 2,
      (y0, rows) => src.slice(y0 * 4, (y0 + rows) * 4),
      (i, total) => strips.push([i, total]));
   assert.strictEqual(binned.width, 2);
   assert.strictEqual(binned.height, 2);
   assert.deepStrictEqual(Array.from(binned.data), [3.5, 5.5, 11.5, 13.5]);
   assert.deepStrictEqual(strips, [[0, 2], [1, 2]]);
}

// --- one injected trail among 80 stars ---------------------------------------

{
   const data = makeField(80);
   drawSegment(data, 50, 60, 350, 240, 8 * SIGMA);
   const res = T.detectCore(data, W, H, PARAMS);
   assert.strictEqual(res.trails.length, 1,
      `expected exactly 1 trail, got ${res.trails.length}`);
   const t = res.trails[0];
   const err = endpointError(t, 50, 60, 350, 240);
   assert.ok(err <= 3, `endpoints off by ${err.toFixed(2)} px (limit 3)`);
   const expAngle = Math.atan2(240 - 60, 350 - 50) * 180 / Math.PI; // 30.96
   assert.ok(angleDiff(t.angleDeg, expAngle) <= 2,
      `angle ${t.angleDeg.toFixed(2)} vs expected ${expAngle.toFixed(2)}`);
   assert.ok(t.score > 0 && t.score <= 1, "score in (0,1]");
   // stats sanity: median ≈ BG, MAD ≈ SIGMA
   assert.ok(Math.abs(res.stats.median - BG) < 1, "median ≈ background");
   assert.ok(Math.abs(res.stats.mad - SIGMA) < 1, "MAD ≈ noise sigma");
}

// --- stars only: no false positive --------------------------------------------

{
   const data = makeField(80);
   const res = T.detectCore(data, W, H, PARAMS);
   assert.strictEqual(res.trails.length, 0,
      `stars only must yield 0 trails, got ${res.trails.length}`);
}

// --- two crossing trails -------------------------------------------------------

{
   const data = makeField(80);
   drawSegment(data, 50, 50, 350, 250, 8 * SIGMA);   // +33.69 deg
   drawSegment(data, 50, 250, 350, 50, 8 * SIGMA);   // 146.31 deg
   const res = T.detectCore(data, W, H, PARAMS);
   assert.strictEqual(res.trails.length, 2,
      `expected 2 crossing trails, got ${res.trails.length}`);
   const angles = res.trails.map(t => t.angleDeg);
   const expected = [Math.atan2(200, 300) * 180 / Math.PI,
                     (Math.atan2(-200, 300) * 180 / Math.PI + 180)];
   for (const e of expected)
      assert.ok(angles.some(a => angleDiff(a, e) <= 2),
         `no detected trail matches angle ${e.toFixed(2)} (got ${angles.map(a => a.toFixed(1))})`);
}

// --- sparse dashed alignment (30% fill) must be rejected ------------------------

{
   const data = makeField(80);
   drawDashed(data, 60, 80, 340, 220, 8 * SIGMA, 3, 7); // fill 30% < 0.6
   const res = T.detectCore(data, W, H, PARAMS);
   assert.strictEqual(res.trails.length, 0,
      `dashed 30%-fill line must be rejected, got ${res.trails.length} trails`);
}

// --- helpers: bestRun, fwhmOfProfile, scaleSegment ------------------------------

{
   // gap of 2 tolerated inside a run, gap of 3 splits it
   const hits = [0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 1].map(Boolean);
   const run = T.bestRun(hits, 2);
   assert.strictEqual(run.start, 1);
   assert.strictEqual(run.end, 7);
   assert.strictEqual(run.hitCount, 5);
   assert.ok(Math.abs(run.fill - 5 / 7) < 1e-12);

   // triangular profile peaked at center: FWHM = 3 (half-max crossings ±1.5)
   const f = T.fwhmOfProfile([0, 1, 2, 3, 2, 1, 0]);
   assert.ok(Math.abs(f - 3) < 1e-9, `fwhm ${f}`);
   assert.strictEqual(T.fwhmOfProfile([5, 5, 5, 5, 5]), 0, "flat profile has no width");

   const seg = T.scaleSegment({ x1: 10, y1: 20, x2: 30, y2: 40, lengthPx: 28.28 }, 4);
   assert.deepStrictEqual([seg.x1, seg.y1, seg.x2, seg.y2], [42, 82, 122, 162]);
   assert.ok(Math.abs(seg.lengthPx - 113.12) < 1e-9);
}

console.log("traildetect: binning, single trail, no-line, crossing, dashed rejection OK");
