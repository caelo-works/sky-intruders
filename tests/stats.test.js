// SIStats: histogramMAD against the exact reference MAD (sorted deviations)
const assert = require("assert");
const { SIStats } = require(__dirname + "/build/module.js");

// Deterministic pseudo-random generator (LCG) — tests must be reproducible
let seed = 42;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
function gauss(mu, sigma) {
   const u = Math.max(rnd(), 1e-12), v = rnd();
   return Math.round(mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
}
function clampADU(v) { return Math.min(65535, Math.max(0, v)); }

function refMAD(values) {
   const med = SIStats.arrayMedian(values);
   const devs = values.map(v => Math.abs(v - med)).sort((a, b) => a - b);
   const n = devs.length, mid = Math.floor(n / 2);
   const mad = (n % 2) ? devs[mid] : (devs[mid - 1] + devs[mid]) / 2;
   return { median: med, mad: mad * 1.4826 };
}

function toHistogram(values) {
   const h = new Array(65536).fill(0);
   for (const v of values) h[v]++;
   return h;
}

const cases = {
   "gaussian (mu=672, sigma=200)":
      Array.from({ length: 200000 }, () => clampADU(gauss(672, 200))),
   "peaked distribution (16 ADU quantization)":
      Array.from({ length: 100000 }, () => Math.max(0, 672 + 16 * Math.round(gauss(0, 1.2)))),
   "single value":
      Array.from({ length: 5000 }, () => 700)
};
// Gaussian polluted by 2% violent hot pixels — the case that biases avgDev
cases["gaussian + 2% hot pixels"] = cases["gaussian (mu=672, sigma=200)"]
   .map(v => rnd() < 0.02 ? 20000 + Math.floor(rnd() * 40000) : v);

for (const [name, values] of Object.entries(cases)) {
   const ref = refMAD(values);
   const got = SIStats.histogramMAD(toHistogram(values), ref.median);
   // 1 ADU step tolerance (integer walk of the histogram)
   assert.ok(Math.abs(got - ref.mad) <= 1.4826 + 1e-9,
      `${name}: histogramMAD=${got.toFixed(2)} vs ref=${ref.mad.toFixed(2)}`);
}

// Empty histogram → 0
assert.strictEqual(SIStats.histogramMAD(new Array(65536).fill(0), 0), 0);

// arrayMedian / arrayMAD on small known arrays
assert.strictEqual(SIStats.arrayMedian([]), 0);
assert.strictEqual(SIStats.arrayMedian([3, 1, 2]), 2);
assert.strictEqual(SIStats.arrayMedian([4, 1, 3, 2]), 2.5);
// median 2, |deviations| sorted = [0,0,1,1,2,4,7], MAD raw = 1
assert.ok(Math.abs(SIStats.arrayMAD([1, 1, 2, 2, 4, 6, 9]) - 1.4826) < 1e-12);
// typed arrays are accepted too
assert.strictEqual(SIStats.arrayMedian(new Float32Array([5, 1, 3])), 3);

console.log("stats: histogramMAD matches the exact MAD on 4 distributions; array helpers OK");
