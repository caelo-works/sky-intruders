// SITleNet: the pure parsers of the TLE / SATCAT download layer
// (countTlePairs, buildUrl, parseSatcatInfo, parseSatcatOwners). The
// NetworkTransfer-backed fetchers are exercised in PixInsight only.
const assert = require("assert");
const { SITleNet } = require(__dirname + "/build/module.js");

// --- countTlePairs -------------------------------------------------------
const tle3 = [
   "ISS (ZARYA)",
   "1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9005",
   "2 25544  51.6400 208.9163 0006703  35.4700  90.3700 15.49560000000000",
   "STARLINK-1007",
   "1 44713U 19074A   24001.50000000  .00001000  00000-0  10000-3 0  9990",
   "2 44713  53.0500 100.0000 0001000  90.0000 270.0000 15.06000000000000",
   ""
].join("\n");
assert.strictEqual(SITleNet.countTlePairs(tle3), 2, "3-line TLE: two pairs");
assert.strictEqual(SITleNet.countTlePairs(tle3.replace(/\n/g, "\r\n")), 2, "CRLF payload counts the same");
assert.strictEqual(SITleNet.countTlePairs(""), 0, "empty payload");
assert.strictEqual(SITleNet.countTlePairs("<html><body>Blocked</body></html>\n"), 0, "HTML error page is not a TLE");
// A 2-line TLE (no name line) is not counted: the i / i+1 / i+2 window
// needs the name line, which is what both sources deliver.
assert.strictEqual(SITleNet.countTlePairs(tle3.split("\n").slice(1, 3).join("\n") + "\n"), 0, "bare 2-line TLE without name line");

// --- buildUrl ------------------------------------------------------------
const celestrak = SITleNet.DEFAULT_SOURCES[0];
const mirror = SITleNet.DEFAULT_SOURCES[1];
assert.strictEqual(SITleNet.buildUrl(celestrak, "starlink"),
   "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle", "{group} template");
assert.strictEqual(SITleNet.buildUrl(mirror, "active"),
   "https://raw.githubusercontent.com/caelo-works/tle-mirror/main/tle/active.tle", "mirror template");
assert.strictEqual(SITleNet.buildUrl(SITleNet.DEFAULT_BASE, "active"),
   SITleNet.DEFAULT_BASE + "?GROUP=active&FORMAT=tle", "legacy bare base gets the query appended");
assert.strictEqual(SITleNet.buildUrl(celestrak, "catalog"), null, "full catalog is never asked from gp.php");
assert.strictEqual(SITleNet.buildUrl(mirror, "catalog"),
   "https://raw.githubusercontent.com/caelo-works/tle-mirror/main/tle/catalog.tle", "full catalog comes from the mirror");

// --- parseSatcatInfo / parseSatcatOwners ---------------------------------
const csv = [
   "OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE",
   "ISS (ZARYA),1998-067A,25544,PAY,+,ISS,1998-11-20\r",
   "SL-16 R/B,1985-097B,16182,R/B,,CIS,1985-10-22",
   "COSMOS 1408 DEB,1982-092AB,49999,DEB,,CIS,1982-09-16",
   "BAD ROW,xxx,notanumber,PAY,+,US,2000-01-01",
   "SHORT",
   ""
].join("\n");
const info = SITleNet.parseSatcatInfo(csv);
assert.deepStrictEqual(info[25544], { owner: "ISS", ops: "+", type: "PAY" }, "payload row, CR stripped");
assert.deepStrictEqual(info[16182], { owner: "CIS", ops: "", type: "R/B" }, "rocket body carries no ops status");
assert.deepStrictEqual(info[49999], { owner: "CIS", ops: "", type: "DEB" }, "debris row");
assert.strictEqual(Object.keys(info).length, 3, "non-numeric id and short rows are skipped");

const owners = SITleNet.parseSatcatOwners(csv);
assert.deepStrictEqual(owners, { 25544: "ISS", 16182: "CIS", 49999: "CIS" }, "owners map");

// Column order is taken from the header, not assumed
const reordered = "OWNER,NORAD_CAT_ID\nUS,900\n";
assert.deepStrictEqual(SITleNet.parseSatcatInfo(reordered)[900], { owner: "US", ops: "", type: "" }, "columns located by name");
assert.deepStrictEqual(SITleNet.parseSatcatInfo("NORAD_CAT_ID,OBJECT_NAME\n1,X\n"), {}, "missing OWNER column yields nothing");
assert.deepStrictEqual(SITleNet.parseSatcatInfo(""), {}, "empty CSV");

console.log("net.test.js: all assertions passed");
