// Network integrity rules of the download layer: HTTPS only (SINet.getText,
// SINet.isHttpsUrl, the custom mirror in SITleNet.fetchTle). Deterministic:
// NetworkTransfer, File and the console are stubbed, nothing touches the
// network.
const assert = require("assert");
const { SINet, SITleNet } = require(__dirname + "/build/module.js");

// --- console / File stubs --------------------------------------------------
const consoleLog = [];
console.warningln = (s) => consoleLog.push("W " + s);
console.writeln = (s) => consoleLog.push("I " + s);

const files = {};
global.File = {
   exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
   directoryExists: () => true,
   createDirectory: () => {},
   readTextFile: (p) => files[p],
   writeTextFile: (p, t) => { files[p] = t; }
};

// --- isHttpsUrl ------------------------------------------------------------
assert.strictEqual(SINet.isHttpsUrl("https://celestrak.org/x"), true);
assert.strictEqual(SINet.isHttpsUrl("HTTPS://Example.org/"), true, "scheme is case-insensitive");
assert.strictEqual(SINet.isHttpsUrl("http://celestrak.org/x"), false);
assert.strictEqual(SINet.isHttpsUrl("ftp://example.org/"), false);
assert.strictEqual(SINet.isHttpsUrl(" https://example.org/"), false, "no leading blank (callers trim)");
assert.strictEqual(SINet.isHttpsUrl("example.org/https://"), false);
assert.strictEqual(SINet.isHttpsUrl(""), false);
assert.strictEqual(SINet.isHttpsUrl(null), false);
assert.strictEqual(SINet.isHttpsUrl(undefined), false);

// --- getText refuses anything but https:// before any transfer -------------
let constructed = 0;
global.NetworkTransfer = function () {
   constructed++;
   this.responseCode = 200;
   this.errorInformation = "";
   this.setURL = (u) => { this.url = u; };
   this.setConnectionTimeout = () => {};
   this.download = () => {
      this.onDownloadDataAvailable({ toString: () => "payload" });
      return true;
   };
};
for (const bad of ["http://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle",
                   "HTTP://example.org/", "file:///etc/passwd", "ftp://example.org/x", "", null]) {
   const r = SINet.getText(bad, 5);
   assert.deepStrictEqual(r, { ok: false, code: 0, text: "", error: "refused: not an https:// URL" },
      "refused: " + bad);
}
assert.strictEqual(constructed, 0, "NetworkTransfer never constructed for a refused URL");
const okr = SINet.getText("https://example.org/x", 5);
assert.strictEqual(constructed, 1, "https:// goes through NetworkTransfer");
assert.strictEqual(okr.ok, true);
assert.strictEqual(okr.text, "payload");

// --- fetchTle skips a non-https custom mirror ------------------------------
{
   const seen = [];
   const realGetText = SINet.getText;
   SINet.getText = (url) => { seen.push(url); return { ok: false, code: 0, text: "", error: "offline" }; };
   const savedPause = SINet.pause;
   SINet.pause = () => {};
   consoleLog.length = 0;
   assert.throws(() => SITleNet.fetchTle("stations", "/cache-a", 12, "http://mirror.example/{group}.tle"),
      /no source reachable/);
   assert.ok(seen.length > 0, "default sources still tried");
   assert.ok(seen.every((u) => u.indexOf("mirror.example") < 0), "http mirror never requested");
   assert.ok(consoleLog.indexOf("W custom mirror URL ignored: not https://") >= 0, "warning printed");

   seen.length = 0;
   assert.throws(() => SITleNet.fetchTle("stations", "/cache-a", 12, "https://mirror.example/{group}.tle"));
   assert.strictEqual(seen[0], "https://mirror.example/stations.tle", "https mirror tried first");
   SINet.getText = realGetText;
   SINet.pause = savedPause;
}

// --- TLE checksum ------------------------------------------------------------
const fs = require("fs");
const fixture = fs.readFileSync(__dirname + "/fixtures/match/delta.tle", "utf8").split("\n");
const D1 = fixture[1], D2 = fixture[2];                       // real elements (DELTA 1 DEB)
const I1 = "1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927";
const I2 = "2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537";
for (const l of [D1, D2, I1, I2])
   assert.strictEqual(SITleNet.tleLineChecksumOk(l), true, "valid published line: " + l);
assert.strictEqual(SITleNet.tleLineChecksumOk(D1 + "\r"), true, "CR tolerated");

// Any single-digit corruption in columns 1-68 breaks the checksum
function corrupt(line, col) {
   const c = line.charAt(col);
   const d = String((Number(c) + 1) % 10);
   return line.substring(0, col) + d + line.substring(col + 1);
}
for (const l of [D1, D2, I1, I2])
   for (let col = 0; col < 68; ++col)
      if (/[0-9]/.test(l.charAt(col)))
         assert.strictEqual(SITleNet.tleLineChecksumOk(corrupt(l, col)), false,
            "corrupted column " + (col + 1) + " of " + l);
// ...and so does a wrong check digit
assert.strictEqual(SITleNet.tleLineChecksumOk(corrupt(I1, 68)), false, "wrong check digit");

// Minus sign counts as 1: blanking one minus (a 1 -> 0 change of the sum)
// must break a valid line; replacing it with '1' must keep it valid.
const minusAt = I1.indexOf("-");
assert.ok(minusAt > 0);
assert.strictEqual(SITleNet.tleLineChecksumOk(I1.substring(0, minusAt) + " " + I1.substring(minusAt + 1)),
   false, "minus sign contributes 1");
assert.strictEqual(SITleNet.tleLineChecksumOk(I1.substring(0, minusAt) + "1" + I1.substring(minusAt + 1)),
   true, "minus sign weighs exactly like a 1");
// Letters, '+', '.', blanks count 0
assert.strictEqual(SITleNet.tleLineChecksumOk(D1.replace("U", "C")), true, "letters count 0");
assert.strictEqual(SITleNet.tleLineChecksumOk(I1.substring(0, 68)), false, "missing check digit");
assert.strictEqual(SITleNet.tleLineChecksumOk(""), false);
assert.strictEqual(SITleNet.tleLineChecksumOk(I1.substring(0, 68) + "X"), false, "non-digit check column");

// filterTleByChecksum: whole 3-line sets dropped, the rest kept in order
{
   const good = "DELTA 1 DEB\n" + D1 + "\n" + D2;
   const iss = "ISS (ZARYA)\n" + I1 + "\n" + I2;
   const bad1 = "BROKEN-1\n" + corrupt(I1, 20) + "\n" + I2;
   const bad2 = "BROKEN-2\n" + D1 + "\n" + corrupt(D2, 30);
   const f = SITleNet.filterTleByChecksum([good, bad1, iss, bad2, ""].join("\r\n"));
   assert.strictEqual(f.kept, 2);
   assert.strictEqual(f.dropped, 2);
   assert.strictEqual(f.text, good + "\n" + iss + "\n", "bad sets removed, CRLF normalized");
   assert.deepStrictEqual(SITleNet.filterTleByChecksum(""), { text: "", kept: 0, dropped: 0 });
}

// Payload gate inside fetchTle: drop a few, reject above 5 %
function genLine(prefix) {
   // a synthetic line with its check digit computed independently
   let s = 0;
   for (const ch of prefix) s += /[0-9]/.test(ch) ? Number(ch) : (ch === "-" ? 1 : 0);
   return prefix + String(s % 10);
}
function genSet(i, broken) {
   const id = String(10000 + i);
   const l1 = genLine("1 " + id + "U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  900");
   const l2 = genLine("2 " + id + "  51.6400 208.9163 0006703  35.4700  90.3700 15.4956000000000");
   assert.strictEqual(l1.length, 69); assert.strictEqual(l2.length, 69);
   return "SAT-" + id + "\n" + (broken ? corrupt(l1, 10) : l1) + "\n" + l2;
}
function payload(n, nBad) {
   const sets = [];
   for (let i = 0; i < n; ++i) sets.push(genSet(i, i < nBad));
   return sets.join("\n") + "\n";
}
function fetchWith(text, group) {
   const realGetText = SINet.getText, savedPause = SINet.pause;
   const urls = [];
   SINet.getText = (url) => { urls.push(url); return { ok: true, code: 200, text: text, error: "" }; };
   SINet.pause = () => {};
   consoleLog.length = 0;
   try { return { res: SITleNet.fetchTle(group, "/cache-b", 12), urls: urls }; }
   catch (e) { return { err: e, urls: urls }; }
   finally { SINet.getText = realGetText; SINet.pause = savedPause; }
}
{
   // 5 bad of 100 = exactly 5 %: kept (the threshold is "more than 5 %")
   const r = fetchWith(payload(100, 5), "g5");
   assert.ok(r.res, "5 % bad is trimmed, not rejected");
   assert.strictEqual(r.res.count, 95);
   assert.strictEqual(r.urls.length, 1, "first source accepted");
   assert.ok(consoleLog.indexOf("W g5: 5 element set(s) dropped (bad TLE checksum)") >= 0, consoleLog.join("|"));
   assert.strictEqual(SITleNet.countTlePairs(files["/cache-b/g5.tle"]), 95, "cache holds only good sets");

   // 6 bad of 100: the whole payload is corrupt, every source fails
   const r2 = fetchWith(payload(100, 6), "g6");
   assert.ok(r2.err, "more than 5 % bad: payload rejected");
   assert.ok(/fail the TLE checksum/.test(r2.err.message), r2.err.message);
   assert.ok(r2.urls.length >= 2, "rejection falls through to the next source");
   assert.ok(!files["/cache-b/g6.tle"], "nothing cached");

   // All clean: no console line about checksums
   const r3 = fetchWith(payload(20, 0), "g0");
   assert.strictEqual(r3.res.count, 20);
   assert.ok(consoleLog.every((l) => l.indexOf("checksum") < 0));
}

console.log("net-integrity.test.js: all assertions passed");
