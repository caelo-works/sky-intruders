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
   SITleNet.resetMirrorManifest();
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
   assert.ok(consoleLog.indexOf("W g6: payload rejected as corrupt: 6 of 100 element sets fail the TLE checksum") >= 0,
      consoleLog.join("|"));
   assert.ok(r2.urls.length >= 2, "rejection falls through to the next source");
   assert.ok(!files["/cache-b/g6.tle"], "nothing cached");

   // All clean: no console line about checksums
   const r3 = fetchWith(payload(20, 0), "g0");
   assert.strictEqual(r3.res.count, 20);
   assert.ok(consoleLog.every((l) => l.indexOf("checksum") < 0));
}

// --- Mirror SHA-256 manifest ---------------------------------------------------
const crypto = require("crypto");
const sha = (t) => crypto.createHash("sha256").update(Buffer.from(t, "latin1")).digest("hex");
const MIRROR = "https://raw.githubusercontent.com/caelo-works/tle-mirror/main/tle/";
assert.strictEqual(SITleNet.MIRROR_MANIFEST_URL, MIRROR + "SHA256SUMS");

// parseSha256Sums: sha256sum text and binary-mode lines, junk ignored
{
   const h1 = sha("a"), h2 = sha("b");
   const m = SITleNet.parseSha256Sums(h1 + "  active.tle\r\n" + h2.toUpperCase() + " *satcat.csv\n" +
                                      "not a line\n" + h1.substring(1) + "  short.tle\n\n");
   assert.deepStrictEqual(m, { "active.tle": h1, "satcat.csv": h2 });
   assert.deepStrictEqual(SITleNet.parseSha256Sums("<html>404</html>"), {});
}

// A scripted network: url -> list of successive responses (last one repeats)
function scriptedNet(script) {
   const calls = [];
   const getText = (url, timeout, opts) => {
      calls.push({ url: url, sha: !!(opts && opts.sha256) });
      const list = script[url];
      if (!list) return { ok: false, code: 0, text: "", error: "unreachable" };
      const n = calls.filter((c) => c.url === url).length;
      const body = list[Math.min(n, list.length) - 1];
      if (body === null) return { ok: false, code: 0, text: "", error: "timeout" };
      if (typeof body === "number") return { ok: true, code: body, text: "", error: "" };
      const r = { ok: true, code: 200, text: body, error: "" };
      if (opts && opts.sha256) r.sha256 = sha(body);
      return r;
   };
   return { getText: getText, calls: calls };
}
function withNet(script, fn) {
   const realGetText = SINet.getText, savedPause = SINet.pause;
   const net = scriptedNet(script);
   SINet.getText = net.getText;
   SINet.pause = () => {};
   consoleLog.length = 0;
   SITleNet.resetMirrorManifest();
   try { return fn(net); }
   finally { SINet.getText = realGetText; SINet.pause = savedPause; }
}
const SUMS = MIRROR + "SHA256SUMS";
const goodTle = "ISS (ZARYA)\n" + I1 + "\n" + I2 + "\n";
const otherTle = "DELTA 1 DEB\n" + D1 + "\n" + D2 + "\n";
const manifestFor = (files) => Object.keys(files).map((k) => sha(files[k]) + "  " + k).join("\n") + "\n";

// Non-mirror URLs bypass the manifest entirely
withNet({ "https://celestrak.org/x": [goodTle] }, (net) => {
   const r = SITleNet.getVerified("https://celestrak.org/x", 10);
   assert.strictEqual(r.ok, true);
   assert.deepStrictEqual(net.calls.map((c) => c.url), ["https://celestrak.org/x"], "no manifest fetch");
});

// Match: file accepted; the manifest is fetched once for several files
withNet({ [SUMS]: [manifestFor({ "active.tle": goodTle, "stations.tle": otherTle })],
          [MIRROR + "active.tle"]: [goodTle], [MIRROR + "stations.tle"]: [otherTle] }, (net) => {
   assert.strictEqual(SITleNet.getVerified(MIRROR + "active.tle", 10).text, goodTle);
   assert.strictEqual(SITleNet.getVerified(MIRROR + "stations.tle", 10).text, otherTle);
   assert.strictEqual(net.calls.filter((c) => c.url === SUMS).length, 1, "manifest memoized");
   assert.ok(net.calls.filter((c) => c.url !== SUMS).every((c) => c.sha), "mirror files hashed");
   assert.strictEqual(consoleLog.length, 0);
});

// Mismatch, then the retry matches (CDN briefly out of step): accepted
withNet({ [SUMS]: [manifestFor({ "active.tle": otherTle }), manifestFor({ "active.tle": otherTle })],
          [MIRROR + "active.tle"]: [goodTle, otherTle] }, (net) => {
   const r = SITleNet.getVerified(MIRROR + "active.tle", 10);
   assert.strictEqual(r.ok, true);
   assert.strictEqual(r.text, otherTle);
   assert.strictEqual(net.calls.length, 4, "manifest, file, manifest again, file again");
});

// Mismatch persists: refused after exactly one retry
withNet({ [SUMS]: [manifestFor({ "active.tle": otherTle })], [MIRROR + "active.tle"]: [goodTle] }, (net) => {
   const r = SITleNet.getVerified(MIRROR + "active.tle", 10);
   assert.strictEqual(r.ok, false);
   assert.strictEqual(net.calls.filter((c) => c.url === MIRROR + "active.tle").length, 2, "one retry");
   assert.strictEqual(net.calls.filter((c) => c.url === SUMS).length, 2);
   assert.deepStrictEqual(consoleLog, ["W mirror file active.tle failed SHA-256 verification — not used"]);
});

// Missing entry: same path as a mismatch
withNet({ [SUMS]: [manifestFor({ "stations.tle": otherTle })], [MIRROR + "active.tle"]: [goodTle] }, (net) => {
   assert.strictEqual(SITleNet.getVerified(MIRROR + "active.tle", 10).ok, false);
   assert.strictEqual(net.calls.length, 4);
   assert.deepStrictEqual(consoleLog, ["W mirror file active.tle failed SHA-256 verification — not used"]);
});

// Hashing unavailable (sha256 null) never matches
withNet({ [SUMS]: [manifestFor({ "active.tle": goodTle })], [MIRROR + "active.tle"]: [goodTle] }, (net) => {
   const g = net.getText;
   SINet.getText = (u, t, o) => { const r = g(u, t, o); if (r.sha256) r.sha256 = null; return r; };
   assert.strictEqual(SITleNet.getVerified(MIRROR + "active.tle", 10).ok, false);
});

// Manifest unreachable (network error, 404, or not a manifest): the mirror is
// not used, the file is not even downloaded, one console line per run
for (const sums of [null, 404, "<html>Not Found</html>"])
   withNet({ [SUMS]: [sums], [MIRROR + "active.tle"]: [goodTle], [MIRROR + "satcat.csv"]: ["NORAD_CAT_ID\n"] },
      (net) => {
         assert.strictEqual(SITleNet.getVerified(MIRROR + "active.tle", 10).ok, false);
         assert.strictEqual(SITleNet.getVerified(MIRROR + "satcat.csv", 10).ok, false);
         assert.deepStrictEqual(net.calls.map((c) => c.url), [SUMS], "manifest asked once, no file download");
         assert.deepStrictEqual(consoleLog, ["W mirror manifest unavailable — mirror not used"]);
      });

// End to end through fetchTle: CelesTrak down, mirror fails verification ->
// stale cache served; mirror verified -> fresh mirror payload cached
{
   files["/cache-c/active.tle"] = otherTle;
   files["/cache-c/active.meta.json"] = JSON.stringify({ fetchedUtc: "2020-01-01T00:00:00Z",
      sourceUrl: "old", count: 1 });
   withNet({ [SUMS]: [manifestFor({ "active.tle": otherTle })], [MIRROR + "active.tle"]: [goodTle] }, () => {
      const r = SITleNet.fetchTle("active", "/cache-c", 12);
      assert.strictEqual(r.stale, true, "tampered mirror file not used, stale cache served");
      assert.strictEqual(files["/cache-c/active.tle"], otherTle, "cache untouched");
   });
   withNet({ [SUMS]: [manifestFor({ "active.tle": goodTle })], [MIRROR + "active.tle"]: [goodTle] }, () => {
      const r = SITleNet.fetchTle("active", "/cache-c", 12);
      assert.strictEqual(r.fromCache, false);
      assert.strictEqual(r.sourceUrl, MIRROR + "active.tle");
      assert.strictEqual(r.count, 1);
   });
}

// fetchSatcat goes through the same verification
{
   const csv = "OBJECT_NAME,NORAD_CAT_ID,OWNER\nISS,25544,ISS\n";
   withNet({ [SUMS]: [manifestFor({ "satcat.csv": "other" })], [MIRROR + "satcat.csv"]: [csv] }, () => {
      assert.strictEqual(SITleNet.fetchSatcat("/cache-d", 24), null, "unverified SATCAT refused");
   });
   withNet({ [SUMS]: [manifestFor({ "satcat.csv": csv })], [MIRROR + "satcat.csv"]: [csv] }, () => {
      assert.deepStrictEqual(SITleNet.fetchSatcat("/cache-d", 24), { path: "/cache-d/satcat.csv", fromCache: false });
   });
}

// getText hashes the raw chunks it receives (incremental native hasher)
{
   const updates = [];
   global.CryptographicHash = function (alg) {
      assert.strictEqual(alg, 256);
      this.initialize = () => {};
      this.update = (data) => updates.push(data);
      this.finalize = () => ({ toHex: () => "ABCDEF" });
   };
   global.CryptographicHash.SHA256 = 256;
   const chunkA = { toString: () => "part1-" }, chunkB = { toString: () => "part2" };
   global.NetworkTransfer = function () {
      this.responseCode = 200;
      this.errorInformation = "";
      this.setURL = () => {};
      this.download = () => { this.onDownloadDataAvailable(chunkA); this.onDownloadDataAvailable(chunkB); return true; };
   };
   const r = SINet.getText("https://example.org/f", 5, { sha256: true });
   assert.strictEqual(r.text, "part1-part2");
   assert.strictEqual(r.sha256, "abcdef", "lowercase hex");
   assert.deepStrictEqual(updates, [chunkA, chunkB], "the received chunk objects themselves are hashed");
   assert.ok(!("sha256" in SINet.getText("https://example.org/f", 5)), "no hash unless asked");
   delete global.CryptographicHash;
   assert.strictEqual(SINet.getText("https://example.org/f", 5, { sha256: true }).sha256, null,
      "no native hasher: null, never a match");
}

console.log("net-integrity.test.js: all assertions passed");
