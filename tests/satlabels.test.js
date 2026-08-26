// SISatLabels: flag, nature, telemetry line and labels of a satellite.
const assert = require("assert");
const { SISatLabels } = require(__dirname + "/build/module.js");
const L = SISatLabels;

// flag: SATCAT owner first, catalog-name heuristic as fallback
assert.strictEqual(L.countryCode("STARLINK-31234"), "us");
assert.strictEqual(L.countryCode("QIANFAN-42"), "cn");
assert.strictEqual(L.countryCode("COSMOS 2551"), "ru");
assert.strictEqual(L.countryCode("ONEWEB-0512"), "gb");
assert.strictEqual(L.countryCode(null), "xx");
assert.strictEqual(L.flagCode({ owner: "PRC" }, "STARLINK-1"), "cn", "SATCAT owner wins over the name");
assert.strictEqual(L.flagCode({ owner: "ZZZ" }, "STARLINK-1"), "us", "unmapped owner falls back to the name");
assert.strictEqual(L.flagCode(undefined, "GALILEO 27"), "eu");

// nature from the SATCAT record
assert.strictEqual(L.classCode(null), null, "no record: no relabeling");
assert.strictEqual(L.classCode({ type: "R/B", ops: "+" }), "rb");
assert.strictEqual(L.classCode({ type: "DEB" }), "debris");
assert.strictEqual(L.classCode({ type: "PAY", ops: "P" }), "active");
assert.strictEqual(L.classCode({ type: "PAY", ops: "-" }), "dead");
assert.strictEqual(L.classCode({ type: "PAY", ops: "?" }), "unknown");
assert.strictEqual(L.CLASS_LABEL.fr.rb, "étage de fusée");

// telemetry line
const crossing = { noradId: 44713, name: "STARLINK-1007", intlDes: "2019-074A", rangeKm: 551.4,
                   angularRateDegPerSec: 0.9345, entryUtc: "2026-08-14T22:15:31.250Z",
                   shadowEntryUtc: "2026-08-14T22:15:40.000Z", sunlit: true };
const satcat = { 44713: { owner: "US", type: "PAY", ops: "+" } };
assert.strictEqual(L.telemetryLine(crossing, satcat, "en"),
   "551 km · 0.93°/s · 2019 · in service · into shadow 22:15:40 UT");
assert.strictEqual(L.telemetryLine(crossing, satcat, "fr"),
   "551 km · 0,93°/s · 2019 · en service · entre dans l'ombre 22:15:40 UT");
assert.strictEqual(L.telemetryLine({ noradId: 1 }, {}, "en"), "", "nothing known: empty line");

// labels
assert.strictEqual(L.displayName({ name: null, noradId: 99 }), "NORAD 99");
assert.strictEqual(L.matchedLabel(crossing), "STARLINK-1007 · 22:15 UT");
assert.strictEqual(L.matchedLabel(Object.assign({}, crossing, { matchConfidence: "medium" })),
   "STARLINK-1007 ? · 22:15 UT");
assert.strictEqual(L.predictedLabel(Object.assign({}, crossing, { sunlit: false }), "fr"),
   "STARLINK-1007 · 22:15 UT (ombre)");
assert.strictEqual(L.predictedLabel(Object.assign({}, crossing, { sunlit: false, entryUtc: null }), "en"),
   "STARLINK-1007 (shadow)");
assert.strictEqual(L.fallbackLabels("fr").plane, "avion");
assert.strictEqual(L.fallbackLabels("xx").unknown, "intruder?", "unknown language falls back to English");
assert.strictEqual(L.TRAIL_STYLE.satellite, "#22d3ee");

console.log("satlabels: ok");
