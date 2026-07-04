// SIFrameMetaCore: sexagesimal parsing, DATE-OBS parsing, TAN projection
const assert = require("assert");
const { SIFrameMetaCore: C } = require(__dirname + "/build/module.js");

function close(a, b, tol, msg) {
   assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
}

// --- Sexagesimal parsing -----------------------------------------------------

close(C.parseSexagesimal("20 30 15.5"), 20 + 30 / 60 + 15.5 / 3600, 1e-12, "sexagesimal H M S");
close(C.parseSexagesimal("-12 30 00"), -12.5, 1e-12, "negative degrees");
close(C.parseSexagesimal("-0 30 00"), -0.5, 1e-12, "negative zero degrees (sign kept)");
close(C.parseSexagesimal("+48 51 24"), 48 + 51 / 60 + 24 / 3600, 1e-12, "plus sign");
close(C.parseSexagesimal("12:34:56.7"), 12 + 34 / 60 + 56.7 / 3600, 1e-12, "colon separators");
close(C.parseSexagesimal("48.85"), 48.85, 1e-12, "plain decimal");
close(C.parseSexagesimal("20 30.5"), 20 + 30.5 / 60, 1e-12, "two fields");
assert.strictEqual(C.parseSexagesimal(""), null);
assert.strictEqual(C.parseSexagesimal("N/A"), null);
assert.strictEqual(C.parseSexagesimal(null), null);
assert.strictEqual(C.parseSexagesimal("1 2 3 4"), null);

// OBJCTRA is sexagesimal HOURS
close(C.parseHoursToDeg("20 30 15.5"), 15 * (20 + 30 / 60 + 15.5 / 3600), 1e-9, "OBJCTRA hours→deg");
// RA keyword: decimal is degrees, sexagesimal is hours
close(C.parseRaDeg("307.5645833"), 307.5645833, 1e-9, "RA decimal degrees");
close(C.parseRaDeg("20 30 15.5"), 307.56458333333, 1e-6, "RA sexagesimal hours");

// --- DATE-OBS parsing --------------------------------------------------------

let d = C.parseDateObs("2026-07-03T02:13:05");
assert.strictEqual(d.getTime(), Date.UTC(2026, 6, 3, 2, 13, 5), "no-Z ISO is UTC");
d = C.parseDateObs("2026-07-03T02:13:05Z");
assert.strictEqual(d.getTime(), Date.UTC(2026, 6, 3, 2, 13, 5), "Z ISO");
d = C.parseDateObs("2026-07-03T02:13:05.25");
assert.strictEqual(d.getTime(), Date.UTC(2026, 6, 3, 2, 13, 5, 250), "fractional seconds");
d = C.parseDateObs("2026-07-03T02:13");
assert.strictEqual(d.getTime(), Date.UTC(2026, 6, 3, 2, 13, 0), "no seconds");
d = C.parseDateObs("2026-07-03");
assert.strictEqual(d.getTime(), Date.UTC(2026, 6, 3), "date only → midnight UTC");
assert.strictEqual(C.parseDateObs("garbage"), null);
assert.strictEqual(C.parseDateObs(null), null);

// --- TAN projection ----------------------------------------------------------

// Hand-computed case at dec0 = 0 with a diagonal CD matrix: the gnomonic
// formulas reduce to ra = ra0 + atan(xi), dec = atan(eta / sqrt(1 + xi^2)).
const DEG = Math.PI / 180;
const tan0 = { crval1: 180, crval2: 0, crpix1: 1, crpix2: 1,
               cd11: 1e-3, cd12: 0, cd21: 0, cd22: 1e-3 };
// image (100, 0) → FITS px (101, 1) → xi = 0.1 deg, eta = 0
let p = C.tanImageToCelestial(tan0, 100, 0);
close(p.raDeg, 180 + Math.atan(0.1 * DEG) / DEG, 1e-12, "dec0=0 RA offset");
close(p.decDeg, 0, 1e-12, "dec0=0 Dec stays 0");
// image (0, 100) → eta = 0.1 deg, xi = 0
p = C.tanImageToCelestial(tan0, 0, 100);
close(p.raDeg, 180, 1e-12, "dec0=0 RA stays");
close(p.decDeg, Math.atan(0.1 * DEG) / DEG, 1e-12, "dec0=0 Dec offset");

// Reference pixel maps exactly to CRVAL (rotated CD, dec0 = 45)
const tan1 = { crval1: 300, crval2: 45, crpix1: 201, crpix2: 151,
               cd11: -8e-4, cd12: 3e-4, cd21: 3e-4, cd22: 8e-4 };
p = C.tanImageToCelestial(tan1, 200, 150); // 0-based = CRPIX - 1
close(p.raDeg, 300, 1e-9, "center RA = CRVAL1");
close(p.decDeg, 45, 1e-9, "center Dec = CRVAL2");

// Round trip image → sky → image, several points, rotated matrix
for (const [x, y] of [[0, 0], [399, 0], [0, 299], [399, 299], [123.25, 45.75], [200, 150]]) {
   const sky = C.tanImageToCelestial(tan1, x, y);
   const back = C.tanCelestialToImage(tan1, sky.raDeg, sky.decDeg);
   close(back.x, x, 1e-6, `round trip x (${x},${y})`);
   close(back.y, y, 1e-6, `round trip y (${x},${y})`);
}

// tanParamsFromKeywords: CD matrix path
let kw = { CTYPE1: "RA---TAN", CTYPE2: "DEC--TAN",
           CRVAL1: "300.0", CRVAL2: "45.0", CRPIX1: "201", CRPIX2: "151",
           CD1_1: "-8e-4", CD1_2: "3e-4", CD2_1: "3e-4", CD2_2: "8e-4" };
let t = C.tanParamsFromKeywords(kw);
assert.ok(t !== null, "CD matrix keywords accepted");
close(t.cd12, 3e-4, 1e-18, "cd12 parsed");
// CDELT + CROTA2 path
t = C.tanParamsFromKeywords({ CRVAL1: "10", CRVAL2: "20", CRPIX1: "50", CRPIX2: "60",
                              CDELT1: "-1e-3", CDELT2: "1e-3", CROTA2: "0" });
assert.ok(t !== null, "CDELT keywords accepted");
close(t.cd11, -1e-3, 1e-18, "cd11 from CDELT1");
close(t.cd12, 0, 1e-18, "cd12 zero at CROTA2=0");
// non-TAN projection rejected
assert.strictEqual(C.tanParamsFromKeywords({ ...kw, CTYPE1: "RA---SIN" }), null);
// incomplete keywords rejected
assert.strictEqual(C.tanParamsFromKeywords({ CRVAL1: "1", CRVAL2: "2" }), null);

// --- FOV ----------------------------------------------------------------------

// fovFromProjector on a plain unrotated, north-up TAN: image y runs down
// the screen, so north-up means Dec decreases with y → CD2_2 < 0.
const tan2 = { crval1: 300, crval2: 45, crpix1: 200.5, crpix2: 150.5,
               cd11: -1e-3, cd12: 0, cd21: 0, cd22: -1e-3 };
const fov = C.fovFromProjector((x, y) => C.tanImageToCelestial(tan2, x, y), 400, 300);
assert.ok(fov.hasWcs === true, "fov hasWcs");
close(fov.raDeg, 300, 1e-6, "fov center RA");
close(fov.decDeg, 45, 1e-6, "fov center Dec");
close(fov.widthDeg, 0.399, 0.004, "fov width ≈ 0.4 deg");
close(fov.heightDeg, 0.299, 0.003, "fov height ≈ 0.3 deg");
close(fov.rotationDeg, 0, 0.01, "fov rotation ≈ 0 (north up)");

// approxFov
const af = C.approxFov(300, 45, 2.0, 4000, 3000);
close(af.widthDeg, 4000 * 2 / 3600, 1e-9, "approx width");
assert.strictEqual(af.rotationDeg, null, "approx rotation unknown");
assert.strictEqual(af.hasWcs, false, "approx hasWcs false");
assert.strictEqual(C.approxFov(null, 45, 2, 100, 100), null, "approx needs a center");
assert.strictEqual(C.approxFov(300, 45, null, 100, 100), null, "approx needs a scale");

// pixScaleFromKeywords: 3.76 µm on 250 mm → 3.102 arcsec per px
close(C.pixScaleFromKeywords(3.76, 250), 206.265 * 3.76 / 250, 1e-12, "plate scale");
assert.strictEqual(C.pixScaleFromKeywords(null, 250), null);

console.log("framemeta: sexagesimal, DATE-OBS, TAN projection and FOV OK");
