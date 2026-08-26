// SIGeom: the shared spherical geometry. The reference forms below are the
// verbatim implementations the libraries carried before they were merged
// into SIGeom; the assertions pin SIGeom to them — bit-exact where the
// merge kept a form as is, within a measured bound where two haversine or
// TAN spellings differing in evaluation order were unified.
const assert = require("assert");
const { SIGeom, SISatMatch, SIFrameMetaCore, SIMeteors } = require(__dirname + "/build/module.js");

const DEG = Math.PI / 180;
let seed = 20260826;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

// --- reference forms -------------------------------------------------------
// FrameMeta (atan2 haversine, (ra2-ra1)*DEG)
function refSepAtan2(ra1, dec1, ra2, dec2) {
   const dRA = (ra2 - ra1) * DEG, dDec = (dec2 - dec1) * DEG;
   const a = Math.sin(dDec / 2) * Math.sin(dDec / 2) +
      Math.cos(dec1 * DEG) * Math.cos(dec2 * DEG) * Math.sin(dRA / 2) * Math.sin(dRA / 2);
   return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) / DEG;
}
// SatMatch (asin haversine, object arguments)
function refSepAsin(a, b) {
   const ra1 = a.raDeg * DEG, de1 = a.decDeg * DEG, ra2 = b.raDeg * DEG, de2 = b.decDeg * DEG;
   const sd = Math.sin((de2 - de1) / 2), sr = Math.sin((ra2 - ra1) / 2);
   const h = sd * sd + Math.cos(de1) * Math.cos(de2) * sr * sr;
   return 2 * Math.asin(Math.min(1, Math.sqrt(h))) * (180 / Math.PI);
}
// Meteors (dot product / acos)
function refUnit(raDeg, decDeg) {
   const ra = raDeg * DEG, dec = decDeg * DEG;
   return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
}
function refSepAcos(aRa, aDec, bRa, bDec) {
   const a = refUnit(aRa, aDec), b = refUnit(bRa, bDec);
   const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
   return Math.acos(Math.max(-1, Math.min(1, d))) / DEG;
}
// FrameMeta position angle, (-180, 180]
function refPaSigned(ra1, dec1, ra2, dec2) {
   const dRA = (ra2 - ra1) * DEG, d1 = dec1 * DEG, d2 = dec2 * DEG;
   const y = Math.sin(dRA) * Math.cos(d2);
   const x = Math.cos(d1) * Math.sin(d2) - Math.sin(d1) * Math.cos(d2) * Math.cos(dRA);
   let pa = Math.atan2(y, x) / DEG;
   if (pa <= -180) pa += 360;
   if (pa > 180) pa -= 360;
   return pa;
}
// SatMatch position angle, [0, 360)
function refPa360(a, b) {
   const ra1 = a.raDeg * DEG, de1 = a.decDeg * DEG, ra2 = b.raDeg * DEG, de2 = b.decDeg * DEG;
   const dra = ra2 - ra1;
   const y = Math.sin(dra) * Math.cos(de2);
   const x = Math.cos(de1) * Math.sin(de2) - Math.sin(de1) * Math.cos(de2) * Math.cos(dra);
   let pa = Math.atan2(y, x) * (180 / Math.PI);
   if (pa < 0) pa += 360;
   return pa;
}
// FrameMeta TAN deprojection (ra/DEG)
function refTanDeprojectDiv(tan, x, y) {
   const dp1 = (x + 1) - tan.crpix1, dp2 = (y + 1) - tan.crpix2;
   const xi = (tan.cd11 * dp1 + tan.cd12 * dp2) * DEG, eta = (tan.cd21 * dp1 + tan.cd22 * dp2) * DEG;
   const ra0 = tan.crval1 * DEG, dec0 = tan.crval2 * DEG;
   const sinD0 = Math.sin(dec0), cosD0 = Math.cos(dec0);
   const denom = Math.sqrt(1 + xi * xi + eta * eta);
   const dec = Math.asin((sinD0 + eta * cosD0) / denom);
   const ra = ra0 + Math.atan2(xi, cosD0 - eta * sinD0);
   let raDeg = ra / DEG;
   raDeg -= 360 * Math.floor(raDeg / 360);
   return { raDeg, decDeg: dec / DEG };
}
// SatMatch TAN deprojection (ra*RAD2DEG)
function refTanDeprojectMul(tan, x, y) {
   const RAD2DEG = 180 / Math.PI;
   const dp1 = (x + 1) - tan.crpix1, dp2 = (y + 1) - tan.crpix2;
   const xi = (tan.cd11 * dp1 + tan.cd12 * dp2) * DEG, eta = (tan.cd21 * dp1 + tan.cd22 * dp2) * DEG;
   const ra0 = tan.crval1 * DEG, dec0 = tan.crval2 * DEG;
   const sinD0 = Math.sin(dec0), cosD0 = Math.cos(dec0);
   const denom = Math.sqrt(1 + xi * xi + eta * eta);
   const dec = Math.asin((sinD0 + eta * cosD0) / denom);
   const ra = ra0 + Math.atan2(xi, cosD0 - eta * sinD0);
   let raDeg = ra * RAD2DEG;
   raDeg -= 360 * Math.floor(raDeg / 360);
   return { raDeg, decDeg: dec * RAD2DEG };
}
// FrameMeta / entry-script TAN projection (identical in both places)
function refTanProject(tan, raDeg, decDeg) {
   const ra0 = tan.crval1 * DEG, dec0 = tan.crval2 * DEG, ra = raDeg * DEG, dec = decDeg * DEG;
   const dRA = ra - ra0;
   const sinD0 = Math.sin(dec0), cosD0 = Math.cos(dec0), sinD = Math.sin(dec), cosD = Math.cos(dec);
   const D = sinD * sinD0 + cosD * cosD0 * Math.cos(dRA);
   if (D <= 0) return null;
   const xi = (cosD * Math.sin(dRA) / D) / DEG;
   const eta = ((sinD * cosD0 - cosD * sinD0 * Math.cos(dRA)) / D) / DEG;
   const det = tan.cd11 * tan.cd22 - tan.cd12 * tan.cd21;
   if (det === 0) return null;
   return { x: tan.crpix1 + (tan.cd22 * xi - tan.cd12 * eta) / det - 1,
            y: tan.crpix2 + (tan.cd11 * eta - tan.cd21 * xi) / det - 1 };
}

// --- separations and position angles ----------------------------------------
const scalesDeg = [0.1 / 3600, 1 / 3600, 2.5 / 3600, 10 / 3600, 0.01, 0.1, 1, 5, 30];
let worstAtan2 = 0, worstPa = 0;
for (const sc of scalesDeg)
   for (let i = 0; i < 4000; i++) {
      const ra1 = rnd() * 360, dec1 = -85 + rnd() * 170, th = rnd() * 2 * Math.PI;
      const ra2 = ra1 + sc * Math.cos(th) / Math.cos(dec1 * DEG), dec2 = dec1 + sc * Math.sin(th);
      const a = { raDeg: ra1, decDeg: dec1 }, b = { raDeg: ra2, decDeg: dec2 };

      // bit-exact: the matching engine's form is the one SIGeom kept
      assert.strictEqual(SIGeom.angularSepDeg(ra1, dec1, ra2, dec2), refSepAsin(a, b));
      assert.strictEqual(SISatMatch.core.angularSepDeg(a, b), refSepAsin(a, b));
      assert.strictEqual(SIGeom.positionAngleDeg(ra1, dec1, ra2, dec2), refPa360(a, b));
      assert.strictEqual(SISatMatch.core.positionAngleDeg(a, b), refPa360(a, b));
      // bit-exact: the slow-mover tracker keeps its arccos form
      assert.strictEqual(SIGeom.angularSepDotDeg(ra1, dec1, ra2, dec2), refSepAcos(ra1, dec1, ra2, dec2));
      assert.strictEqual(SIMeteors.sepDeg(ra1, dec1, ra2, dec2), refSepAcos(ra1, dec1, ra2, dec2));

      // FrameMeta's atan2 spelling was unified onto the asin one
      worstAtan2 = Math.max(worstAtan2,
         Math.abs(SIFrameMetaCore.angularSeparationDeg(ra1, dec1, ra2, dec2) - refSepAtan2(ra1, dec1, ra2, dec2)) * 3600);
      worstPa = Math.max(worstPa,
         Math.abs(SIFrameMetaCore.positionAngleDeg(ra1, dec1, ra2, dec2) - refPaSigned(ra1, dec1, ra2, dec2)));
   }
assert.ok(worstAtan2 < 1e-8, `FrameMeta separation drift ${worstAtan2} arcsec`);
assert.ok(worstPa < 1e-6, `FrameMeta position-angle drift ${worstPa} deg`);

// the acos form really is a different function at arcsecond scales — the
// reason it is kept apart (haversine vs acos at 1 arcsec exceeds 1e-6 arcsec)
let acosVsHav = 0;
for (let i = 0; i < 4000; i++) {
   const ra1 = rnd() * 360, dec1 = -85 + rnd() * 170, th = rnd() * 2 * Math.PI, sc = 1 / 3600;
   const ra2 = ra1 + sc * Math.cos(th) / Math.cos(dec1 * DEG), dec2 = dec1 + sc * Math.sin(th);
   acosVsHav = Math.max(acosVsHav, Math.abs(SIGeom.angularSepDotDeg(ra1, dec1, ra2, dec2) - SIGeom.angularSepDeg(ra1, dec1, ra2, dec2)) * 3600);
}
assert.ok(acosVsHav > 1e-6, "acos and haversine forms are expected to differ at the arcsecond scale");

// normalizations
assert.ok(Math.abs(SIGeom.positionAngleDeg(10, 0, 9, 0) - 270) < 1e-9, "west is 270 in [0,360)");
assert.ok(Math.abs(SIGeom.positionAngleSignedDeg(10, 0, 9, 0) + 90) < 1e-9, "west is -90 signed");
assert.strictEqual(SIGeom.angularSepDeg(10, 20, 10, 20), 0);

// --- TAN both ways -----------------------------------------------------------
let worstDiv = 0;
for (let i = 0; i < 4000; i++) {
   const tan = SISatMatch.core.tanForOrientation({ raDeg: rnd() * 360, decDeg: -80 + rnd() * 160 },
      0.5 + rnd() * 5, 4000, 3000, rnd() * 360, rnd() < 0.5 ? 1 : -1);
   const x = rnd() * 4000, y = rnd() * 3000;
   const p = SIGeom.tanImageToCelestial(tan, x, y);
   const m = refTanDeprojectMul(tan, x, y);
   assert.strictEqual(p.raDeg, m.raDeg);
   assert.strictEqual(p.decDeg, m.decDeg);
   const q = SISatMatch.core.tanProject(tan, x, y);
   assert.strictEqual(q.raDeg, m.raDeg);
   assert.strictEqual(q.decDeg, m.decDeg);
   const d = refTanDeprojectDiv(tan, x, y);
   worstDiv = Math.max(worstDiv, Math.abs(p.raDeg - d.raDeg) * 3600 * Math.cos(p.decDeg * DEG), Math.abs(p.decDeg - d.decDeg) * 3600);

   const back = SIGeom.tanCelestialToImage(tan, p.raDeg, p.decDeg);
   const refBack = refTanProject(tan, p.raDeg, p.decDeg);
   assert.strictEqual(back.x, refBack.x);
   assert.strictEqual(back.y, refBack.y);
   assert.ok(Math.abs(back.x - x) < 1e-6 && Math.abs(back.y - y) < 1e-6, "TAN round trip");
   const fm = SIFrameMetaCore.tanCelestialToImage(tan, p.raDeg, p.decDeg);
   assert.strictEqual(fm.x, refBack.x);
}
assert.ok(worstDiv < 1e-8, `TAN deprojection drift ${worstDiv} arcsec`);
assert.strictEqual(SIGeom.tanCelestialToImage({ crval1: 0, crval2: 0, crpix1: 1, crpix2: 1, cd11: 1, cd12: 0, cd21: 0, cd22: 1 }, 180, 0), null, "behind the tangent plane");

// --- sexagesimal -------------------------------------------------------------
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-12, msg + `: ${a} vs ${b}`);
close(SIGeom.parseSexagesimal("20 30 15.5"), 20 + 30 / 60 + 15.5 / 3600, "H M S");
close(SIGeom.parseSexagesimal("-0 30 00"), -0.5, "negative zero degrees");
close(SIGeom.parseSexagesimal("12:34:56.7"), 12 + 34 / 60 + 56.7 / 3600, "colons");
close(SIGeom.parseSexagesimal("  +47.19 "), 47.19, "padded decimal");
assert.strictEqual(SIGeom.parseSexagesimal(""), null);
assert.strictEqual(SIGeom.parseSexagesimal(undefined), null);
assert.strictEqual(SIGeom.parseSexagesimal("1 2 3 4"), null);
assert.strictEqual(SIGeom.parseSexagesimal("12 -3"), null, "sign only on the leading field");

console.log("geom: ok");
