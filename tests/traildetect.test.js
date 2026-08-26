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

// ---------------------------------------------------------------------------
// Static-sky model: medianStack votes out single-frame transients, and
// subtractModel leaves only the transient (with borders neutralized).

{
   const a = new Float32Array([0.10, 0.10, 0.50, 0.10]);
   const b = new Float32Array([0.10, 0.12, 0.10, 0.10]);
   const c = new Float32Array([0.12, 0.10, 0.10, 0.00]);
   const model = T.medianStack([a, b, c]);
   assert.ok(Math.abs(model[0] - 0.10) < 1e-6);
   assert.ok(Math.abs(model[2] - 0.10) < 1e-6, "trail pixel voted out of the model");

   const diff = T.subtractModel(a, model);
   assert.ok(Math.abs(diff[2] - 0.40) < 1e-6, "transient survives subtraction");
   assert.ok(diff[0] === 0 && diff[1] === 0, "static pixels vanish");
   const diffC = T.subtractModel(c, model);
   assert.strictEqual(diffC[3], 0, "zero (border) pixels stay zero");
   assert.strictEqual(T.subtractModel(new Float32Array([0.2]), new Float32Array([0]))[0], 0,
      "pixels outside the model coverage are neutralized");
}

console.log("traildetect: median stack + model subtraction OK");

// ---------------------------------------------------------------------------
// Faint-streak pass (weighted Hough): a trail at ~0.4 sigma per pixel is
// invisible to any per-pixel threshold but must be found by the line
// integral; pure noise must yield nothing.

{
   const W = 800, H = 500;
   // deterministic gaussian-ish noise (sum of 12 uniforms), clamped at 0.
   // xorshift128, NOT an LCG: the LCG lattice forms genuine directional
   // structure in the field that the detector correctly reports.
   let s0 = 123456789, s1 = 362436069, s2 = 521288629, s3 = 88675123;
   const rnd = () => { let tt = s0^(s0<<11); s0=s1; s1=s2; s2=s3; s3=(s3^(s3>>>19))^(tt^(tt>>>8)); return (s3>>>0)/4294967296; };
   const gauss = () => { let s = 0; for (let i = 0; i < 12; i++) s += rnd(); return s - 6; };
   const SIGMA = 0.01;
   const mkNoise = () => {
      const a = new Float32Array(W*H);
      for (let i = 0; i < a.length; i++) a[i] = Math.max(0, gauss()*SIGMA);
      return a;
   };

   const noisy = mkNoise();
   // faint trail: 0.5 sigma per pixel, from (60,80) to (740,420)
   const x1 = 60, y1 = 80, x2 = 740, y2 = 420;
   const len = Math.hypot(x2 - x1, y2 - y1);
   for (let t = 0; t <= Math.ceil(len); t++) {
      const f = t/len;
      const x = Math.round(x1 + (x2 - x1)*f), y = Math.round(y1 + (y2 - y1)*f);
      noisy[y*W + x] += 0.5*SIGMA;
   }
   const found = T.detectFaintCore(noisy, W, H, {});
   assert.strictEqual(found.trails.length, 1, `faint trail found (${found.trails.length})`);
   const tr = found.trails[0];
   const angle = Math.atan2(y2 - y1, x2 - x1)*180/Math.PI;
   assert.ok(Math.abs(tr.angleDeg - angle) < 3, `angle ${tr.angleDeg} vs ${angle}`);
   const dist = (px, py) => {
      const dx = x2 - x1, dy = y2 - y1;
      return Math.abs(dy*px - dx*py + x2*y1 - y2*x1)/len;
   };
   assert.ok(dist(tr.x1, tr.y1) < 6 && dist(tr.x2, tr.y2) < 6,
      "endpoints lie on the injected line");
   assert.ok(tr.lengthPx > 0.7*len, `length ${tr.lengthPx} vs ${len}`);
   assert.ok(tr.faint === true, "flagged faint");

   const clean = T.detectFaintCore(mkNoise(), W, H, {});
   assert.strictEqual(clean.trails.length, 0, "pure noise stays clean");
}

console.log("traildetect: faint weighted-Hough pass OK");

// ---------------------------------------------------------------------------
// Ridge snapping: the faint-pass line is fitted on a 3-wide corridor, which
// is flat to +-0.5 px across a thin trail, while the emptiness veto reads one
// pixel per step. A 0.6-px offset turns a continuous 1-px trail into a
// "holey" line; snapToRidge must bring it back onto the ridge (measured on a
// real 24-sigma streak: zeroFrac 0.21 -> 0.39 over that offset, straddling
// the 0.38 bar).

{
   const W = 400, H = 300;
   const z = new Float32Array(W*H);
   const thetaDeg = 22.45, rho0 = 100.3;
   const th = thetaDeg*Math.PI/180, c = Math.cos(th), s = Math.sin(th);
   for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
         if (Math.abs(x*c + y*s - rho0) <= 0.5) z[y*W + x] = 2; // 2 sigma, 1 px wide
   const segAt = (rho) => {
      // in-image chord of the line rho = x cos + y sin, parametrised by t
      const pts = [];
      for (let t = -2000; t <= 2000; t++) {
         const x = rho*c - t*s, y = rho*s + t*c;
         if (x >= 0 && x < W && y >= 0 && y < H) pts.push({ x, y });
      }
      return { x1: pts[0].x, y1: pts[0].y, x2: pts[pts.length - 1].x, y2: pts[pts.length - 1].y };
   };
   const off = T.lineEmptiness(z, W, H, segAt(rho0 + 0.6));
   assert.ok(off.zeroFrac > 0.38, `0.6-px offset line reads holey (zeroFrac ${off.zeroFrac.toFixed(2)})`);
   const snapped = T.snapToRidge(z, W, H, thetaDeg, rho0 + 0.6, 0.75, 0.25);
   assert.ok(Math.abs(snapped - rho0) <= 0.3, `snapped rho ${snapped.toFixed(2)} vs ridge ${rho0}`);
   const on = T.lineEmptiness(z, W, H, segAt(snapped));
   assert.ok(on.zeroFrac < 0.15, `snapped line is continuous (zeroFrac ${on.zeroFrac.toFixed(2)})`);
   assert.ok(!T.isNoiseLine(z, W, H, segAt(snapped), 1), "snapped line passes the noise veto");
   // the other way round too, and an empty map leaves rho alone
   assert.ok(Math.abs(T.snapToRidge(z, W, H, thetaDeg, rho0 - 0.6, 0.75, 0.25) - rho0) <= 0.3, "snap from below");
   assert.strictEqual(T.snapToRidge(new Float32Array(W*H), W, H, thetaDeg, 50.5, 0.75, 0.25), 50.5, "empty map: unchanged");
}

console.log("traildetect: faint-pass ridge snapping OK");

// ---------------------------------------------------------------------------
// Photometric normalization: a frame seen through a clearer sky (signal
// scaled up, offset shifted) must be brought back onto the model.

{
   const n = 5000;
   const model = new Float32Array(n);
   let seed = 3;
   const rnd = () => { seed = (seed*1103515245 + 12345) & 0x7fffffff; return seed/0x7fffffff; };
   for (let i = 0; i < n; i++) model[i] = 0.05 + 0.1*rnd();
   const frame = new Float32Array(n);
   for (let i = 0; i < n; i++) frame[i] = (model[i] - 0.01)/0.8; // inverse of a=0.8,b=0.01
   const fit = T.linearFitToModel(frame, model, null);
   assert.ok(Math.abs(fit.a - 0.8) < 0.01 && Math.abs(fit.b - 0.01) < 0.001,
      `linear fit recovered (a=${fit.a}, b=${fit.b})`);
   const norm = T.applyLinear(frame, fit.a, fit.b);
   let worst = 0;
   for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(norm[i] - model[i]));
   assert.ok(worst < 1e-4, `normalized frame matches model (worst ${worst})`);
   assert.strictEqual(T.applyLinear(new Float32Array([0, 0.5]), 0.8, 0.01)[0], 0,
      "empty pixels stay empty");
}

console.log("traildetect: photometric normalization OK");

// ---------------------------------------------------------------------------
// Clamped-residual threshold: median/MAD collapses on half-zero data (the
// adaptive loop then lands near 1.4 sigma and noise chains get through);
// with noiseOverride the threshold is honest — a strong trail is found,
// clamped pure noise stays clean.

{
   const W = 800, H = 500;
   let seed = 11;
   const rnd = () => { seed = (seed*1103515245 + 12345) & 0x7fffffff; return seed/0x7fffffff; };
   const gauss = () => { let s = 0; for (let i = 0; i < 12; i++) s += rnd(); return s - 6; };
   const SIGMA = 0.01;
   const mk = () => {
      const a = new Float32Array(W*H);
      for (let i = 0; i < a.length; i++) a[i] = Math.max(0, gauss()*SIGMA);
      return a;
   };
   const noisy = mk();
   const x1 = 90, y1 = 430, x2 = 700, y2 = 60;
   const len = Math.hypot(x2 - x1, y2 - y1);
   for (let t = 0; t <= Math.ceil(len); t++) {
      const f = t/len;
      noisy[Math.round(y1 + (y2 - y1)*f)*W + Math.round(x1 + (x2 - x1)*f)] += 6*SIGMA;
   }
   const over = { median: 0, sigma: SIGMA };
   const withTrail = T.detectCore(noisy, W, H, { kSigma: 4.5, noiseOverride: over });
   assert.strictEqual(withTrail.trails.length, 1, "bright trail found with honest threshold");
   const clean = T.detectCore(mk(), W, H, { kSigma: 4.5, noiseOverride: over });
   assert.strictEqual(clean.trails.length, 0, "clamped pure noise stays clean");
}

console.log("traildetect: clamped-residual noise override OK");

// ---------------------------------------------------------------------------
// High-pass flattening: a thin streak keeps its amplitude, a wide blob is
// removed, and the faint pass still finds a trail crossing a blob field.

{
   const W = 400, H = 300;
   const a = new Float32Array(W*H);
   // wide gaussian blob (nebula mottle scale)
   for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
         a[y*W + x] = 0.05*Math.exp(-((x - 200)**2 + (y - 150)**2)/(2*30*30));
   // thin streak
   for (let x = 50; x < 350; x++) a[100*W + x] += 0.04;
   const f = T.boxBlurSubtract(a, W, H, 7);
   assert.ok(f[100*W + 200] > 0.03, `streak survives (${f[100*W + 200]})`);
   assert.ok(f[150*W + 200] < 0.01, `blob flattened (${f[150*W + 200]})`);
}

console.log("traildetect: high-pass flattening OK");

// ---------------------------------------------------------------------------
// Bright-pass angular refinement: an edge-to-edge trail at a non-integer
// angle used to come back as 2-3 collinear fragments (1-degree Hough bins,
// 1-px walk tolerance); it must be ONE trail with true endpoints.

{
   const W = 1500, H = 1000;
   let s0 = 123456789, s1 = 362436069, s2 = 521288629, s3 = 88675123;
   const rnd = () => { let tt = s0^(s0<<11); s0=s1; s1=s2; s2=s3; s3=(s3^(s3>>>19))^(tt^(tt>>>8)); return (s3>>>0)/4294967296; };
   const gauss = () => { let s = 0; for (let i = 0; i < 12; i++) s += rnd(); return s - 6; };
   for (const ang of [30.5, 37.3, 0.5, 120.2]) {
      const a = new Float32Array(W*H);
      for (let i = 0; i < a.length; i++) a[i] = 100 + 10*gauss();
      // 1-px edge-to-edge line through the centre, S/N 25
      const th = ang*Math.PI/180, ux = Math.cos(th), uy = Math.sin(th);
      const cx = W/2, cy = H/2;
      let tmin = -1e9, tmax = 1e9;
      if (Math.abs(ux) > 1e-9) { const t1 = (0 - cx)/ux, t2 = (W - 1 - cx)/ux; tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2)); }
      if (Math.abs(uy) > 1e-9) { const t1 = (0 - cy)/uy, t2 = (H - 1 - cy)/uy; tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2)); }
      for (let t = tmin; t <= tmax; t += 0.5)
         a[Math.round(cy + uy*t)*W + Math.round(cx + ux*t)] = 350;
      const res = T.detectCore(a, W, H, PARAMS);
      assert.strictEqual(res.trails.length, 1,
         `${ang} deg: expected one trail, got ${res.trails.map(t => Math.round(t.lengthPx))}`);
      const t = res.trails[0];
      const err = endpointError(t, cx + ux*tmin, cy + uy*tmin, cx + ux*tmax, cy + uy*tmax);
      assert.ok(err <= 4, `${ang} deg: endpoints off by ${err.toFixed(2)} px (limit 4)`);
      assert.ok(angleDiff(t.angleDeg, ang) <= 0.3, `${ang} deg: angle ${t.angleDeg.toFixed(2)}`);
   }
}

console.log("traildetect: bright-pass angular refinement OK");

// ---------------------------------------------------------------------------
// mergeDuplicateTrails: collinear fragments join into the union extent,
// overlapping near-duplicates keep the longest, distant collinear segments
// (train members) and parallel pairs stay separate.

{
   const seg = (x1, y1, x2, y2, extra) => Object.assign({
      x1, y1, x2, y2, lengthPx: Math.hypot(x2 - x1, y2 - y1),
      angleDeg: ((Math.atan2(y2 - y1, x2 - x1)*180/Math.PI) + 180) % 180,
      fill: 1, score: 0.5 }, extra || {});
   // two fragments of one horizontal trail, 5-px gap, 1 px across
   let out = T.mergeDuplicateTrails([seg(0, 100, 200, 100), seg(205, 101, 400, 101)], 20);
   assert.strictEqual(out.length, 1, "collinear fragments merge");
   assert.ok(Math.abs(out[0].lengthPx - 400) < 1.5, `union length ${out[0].lengthPx}`);
   assert.ok(Math.min(out[0].x1, out[0].x2) < 0.5 && Math.max(out[0].x1, out[0].x2) > 399.5, "union extent");
   // three fragments chain into one
   out = T.mergeDuplicateTrails([seg(0, 50, 100, 50), seg(210, 50, 300, 50), seg(104, 50, 205, 50)], 20);
   assert.strictEqual(out.length, 1, "fragment chain merges");
   // gap beyond the bound: separate trails (a train)
   out = T.mergeDuplicateTrails([seg(0, 100, 200, 100), seg(260, 100, 400, 100)], 20);
   assert.strictEqual(out.length, 2, "distant collinear segments stay separate");
   // parallel, 8 px apart, overlapping: near-duplicate, keep the longest
   out = T.mergeDuplicateTrails([seg(0, 100, 200, 100), seg(50, 108, 300, 108)], 20);
   assert.strictEqual(out.length, 1, "overlapping near-duplicates collapse");
   assert.ok(Math.abs(out[0].lengthPx - 250) < 1e-9, "the longest survives");
   // parallel, 30 px apart: a real pair
   out = T.mergeDuplicateTrails([seg(0, 100, 200, 100), seg(0, 130, 200, 130)], 20);
   assert.strictEqual(out.length, 2, "a real parallel pair is untouched");
   // a bright fragment joined to a faint one is not flagged faint
   out = T.mergeDuplicateTrails([seg(0, 100, 200, 100), seg(203, 100, 400, 100, { faint: true })], 20);
   assert.strictEqual(out.length, 1);
   assert.strictEqual(out[0].faint, false, "bright+faint union is not faint");
}

console.log("traildetect: duplicate / fragment merge OK");

// ---------------------------------------------------------------------------
// Photometry against a local annulus background: width measured on trails
// of FWHM 3 / 8 / 14 px (14 must exceed the 12-px veto, 8 must not), a
// profile with no half-max crossing inside the +-16 px window yields the
// null sentinel, a uniform
// trail over a sky gradient with stars on it stays below the 0.35 flasher
// cue, a real flasher stays above it, and noise alone does not fire it.

{
   const W = 600, H = 400;
   let s0 = 123456789, s1 = 362436069, s2 = 521288629, s3 = 88675123;
   const rnd = () => { let tt = s0^(s0<<11); s0=s1; s1=s2; s2=s3; s3=(s3^(s3>>>19))^(tt^(tt>>>8)); return (s3>>>0)/4294967296; };
   const gauss = () => { let s = 0; for (let i = 0; i < 12; i++) s += rnd(); return s - 6; };
   const seg = { x1: 40, y1: 60, x2: 560, y2: 340 };
   const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1, len = Math.hypot(dx, dy), ux = dx/len, uy = dy/len;
   const frame = (fwhm, amp, opts) => {
      opts = opts || {};
      const a = new Float32Array(W*H);
      for (let y = 0; y < H; y++)
         for (let x = 0; x < W; x++)
            a[y*W + x] = 0.10 + 0.10*x/W + 0.05*y/H + 0.004*gauss(); // sky + gradient + noise
      const sig = fwhm/2.3548;
      for (let y = 0; y < H; y++)
         for (let x = 0; x < W; x++) {
            const t = (x - seg.x1)*ux + (y - seg.y1)*uy;
            if (t < 0 || t > len) continue;
            const d = -(x - seg.x1)*uy + (y - seg.y1)*ux;
            let A = amp;
            if (opts.flashPeriod) A = (Math.floor(t/opts.flashPeriod) % 2 === 0) ? amp : 0;
            a[y*W + x] += A*Math.exp(-d*d/(2*sig*sig));
            if (opts.shoulder && d >= 1 && d <= 40) a[y*W + x] += 0.8*amp; // plateau on one side
         }
      if (opts.stars)
         for (let k = 0; k < opts.stars; k++) {
            const t = len*(k + 0.5)/opts.stars, cx = Math.round(seg.x1 + ux*t), cy = Math.round(seg.y1 + uy*t);
            for (let yy = -2; yy <= 2; yy++)
               for (let xx = -2; xx <= 2; xx++)
                  a[(cy + yy)*W + cx + xx] += 0.5*Math.exp(-(xx*xx + yy*yy)/2);
         }
      return a;
   };
   const measure = a => T.measureTrail((x, y) => a[y*W + x], W, H, seg);

   const w3 = measure(frame(3, 0.3)), w8 = measure(frame(8, 0.3)), w14 = measure(frame(14, 0.3));
   assert.ok(Math.abs(w3.widthPx - 3) <= 1.2, `fwhm 3 measured ${w3.widthPx}`);
   assert.ok(Math.abs(w8.widthPx - 8) <= 1.2, `fwhm 8 measured ${w8.widthPx}`);
   assert.ok(w8.widthPx <= 12, "an 8-px trail is kept by the 12-px veto");
   assert.ok(Math.abs(w14.widthPx - 14) <= 1.5, `fwhm 14 measured ${w14.widthPx}`);
   assert.ok(w14.widthPx > 12, "a 14-px band is vetoed");
   assert.ok(Math.abs(w3.meanFlux - 0.3) < 0.03, `flux is background-subtracted (${w3.meanFlux})`);

   const band = measure(frame(40, 0.3));
   assert.ok(band.widthPx > 12, `a 40-px band is vetoed (${band.widthPx})`);
   // trail against a plateau: no half-max crossing on that side inside the
   // window -> the sentinel, which the caller's veto treats as "too wide"
   const shoulder = measure(frame(3, 0.3, { shoulder: true }));
   assert.strictEqual(shoulder.widthPx, null, "no crossing inside the window yields the null sentinel");

   const steady = measure(frame(3, 0.3, { stars: 5 }));
   assert.ok(steady.brightnessVariation < 0.15,
      `steady trail over gradient + stars: variation ${steady.brightnessVariation}`);
   const flasher = measure(frame(3, 0.3, { flashPeriod: 30 }));
   assert.ok(flasher.brightnessVariation > 0.35, `flasher: variation ${flasher.brightnessVariation}`);
   const noise = measure(frame(3, 0));
   assert.ok(noise.brightnessVariation < 0.35, `noise alone must not fire the cue (${noise.brightnessVariation})`);
   assert.ok(noise.widthPx === null || noise.widthPx <= 12, "noise alone is not vetoed as broad");

   // fwhmOfProfile: missing crossing -> null, not a clipped number
   assert.strictEqual(T.fwhmOfProfile([0, 1, 1, 1, 1, 1, 1], 0), null, "no right crossing -> null");
   assert.ok(Math.abs(T.fwhmOfProfile([0, 0, 2, 4, 2, 0, 0], 0, 3) - 2) < 1e-9, "explicit bg and peak index");
}

console.log("traildetect: annulus-background photometry + width veto OK");
