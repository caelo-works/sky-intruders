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

console.log("net-integrity.test.js: all assertions passed");
