/*
 * report.test.js — golden-markdown test of the night log (SIReport.build).
 *
 * A synthetic three-night history, rendered in both languages and compared
 * byte for byte with tests/fixtures/report/night-<n>.<lang>.md. The nights
 * are built to exercise the formatting corners fixed in #10:
 *
 *   night 1  a 59.6-minute session ("1h00" — rounded to whole minutes
 *            before the hour split, never "59 min" nor "0h60"),
 *            exactly one satellite, an OBJECT keyword still wrapped in FITS
 *            quotes, a first logged night (records line);
 *   night 2  no detected trail at all, but predicted crossers — the
 *            predicted list must survive the empty-night branch; forum title
 *            says "nothing crossed";
 *   night 3  a 119.6-minute session (7176 s → "2h00", never "1h60"), a busy
 *            chronology straddling midnight UT, one meteor,
 *            operator breakdown with localized keys, new records.
 *
 * Every timestamp is UT with an explicit " UT" suffix; tests/run.sh pins
 * TZ=UTC, and the test also re-renders under a fake offset to prove the
 * output does not depend on the host zone.
 *
 * Regenerate the goldens after an intended wording change:
 *   SI_UPDATE_GOLDEN=1 bash tests/run.sh
 */
"use strict";
var assert = require( "assert" );
var fs = require( "fs" );
var path = require( "path" );
var R = require( "./build/module.js" ).SIReport;

var FIX = path.join( __dirname, "fixtures", "report" );
var UPDATE = !!process.env.SI_UPDATE_GOLDEN;

function d( iso ) { return new Date( iso ); }

var night1 = {
   dateLabel: "2026-07-10/11", frames: 12, cleanFrames: 11,
   totalExposureSec: 3576, // 59.6 min
   target: "'M 57'",       // FITS quotes still on
   events: [
      { timeUtc: d( "2026-07-10T22:41:12Z" ), klass: "satellite", name: "COSMOS 2251 DEB",
        confidence: "high", frameId: "L_0004.fits", elevationDeg: 412.4,
        angularRateDegPerSec: 0.3141, satClass: "debris" }
   ],
   predicted: [],
   movers: []
};

var night2 = {
   dateLabel: "2026-07-11/12", frames: 8, cleanFrames: 8,
   totalExposureSec: 2400,
   target: "M 57",
   events: [],
   predicted: [
      { timeUtc: d( "2026-07-11T23:05:30Z" ), name: "STARLINK-30112", noradId: 57800,
        elevationDeg: 33.2, frameId: "L_0002.fits" },
      { timeUtc: d( "2026-07-12T00:12:00Z" ), name: null, noradId: 12345,
        elevationDeg: null, frameId: "L_0006.fits" }
   ],
   movers: []
};

var night3 = {
   dateLabel: "2026-08-14/15", frames: 24, cleanFrames: 17,
   totalExposureSec: 7176, // 119.6 min
   target: "NGC 7000",
   events: [
      { timeUtc: d( "2026-08-14T23:02:00Z" ), klass: "satellite", name: "STARLINK-5123",
        confidence: "high", frameId: "L_0001.fits", elevationDeg: 550, angularRateDegPerSec: 0.42, satClass: "active" },
      { timeUtc: d( "2026-08-14T23:47:10Z" ), klass: "satellite", name: "STARLINK-5130",
        confidence: "medium", frameId: "L_0007.fits", elevationDeg: 548, angularRateDegPerSec: 0.41, satClass: "active" },
      { timeUtc: d( "2026-08-15T00:15:00Z" ), klass: "satellite", name: "CZ-3B R/B",
        confidence: "high", frameId: "L_0011.fits", elevationDeg: 1200, angularRateDegPerSec: 0.11, satClass: "rb" },
      { timeUtc: d( "2026-08-15T00:40:00Z" ), klass: "satellite", name: "USA 245",
        confidence: "high", frameId: "L_0014.fits", elevationDeg: 800, angularRateDegPerSec: 0.2, satClass: "unknown" },
      { timeUtc: d( "2026-08-15T01:03:00Z" ), klass: "meteor", shower: "Perseids",
        confidence: "medium", frameId: "L_0017.fits" },
      { timeUtc: d( "2026-08-15T01:20:00Z" ), klass: "plane", segments: 4, frameId: "L_0019.fits" },
      { timeUtc: d( "2026-08-15T01:35:00Z" ), klass: "unknown", frameId: "L_0021.fits" }
   ],
   predicted: [
      { timeUtc: d( "2026-08-14T23:30:00Z" ), name: "ONEWEB-0412", noradId: 48000,
        elevationDeg: 1201, frameId: "L_0005.fits" }
   ],
   movers: []
};

function checkGolden( name, text )
{
   var file = path.join( FIX, name );
   if ( UPDATE )
   {
      fs.writeFileSync( file, text + "\n" );
      return;
   }
   assert.ok( fs.existsSync( file ), "missing golden " + file + " (run with SI_UPDATE_GOLDEN=1)" );
   var want = fs.readFileSync( file, "utf8" );
   assert.strictEqual( text + "\n", want, "golden mismatch: " + name );
}

function renderAll()
{
   var out = {};
   [ "en", "fr" ].forEach( function( lang )
   {
      var history = { nights: [] };
      var nights = [ night1, night2, night3 ];
      for ( var i = 0; i < nights.length; ++i )
      {
         var r = R.build( nights[ i ], history, lang );
         out[ "night-" + ( i + 1 ) + "." + lang ] = r;
         history = R.appendNight( history, r.summary );
      }
   } );
   return out;
}

var results = renderAll();
Object.keys( results ).forEach( function( key )
{
   var r = results[ key ];
   checkGolden( key + ".md", "<!-- title: " + r.redditTitle + " -->\n" + r.markdown );
} );

// --- targeted assertions, independent of the goldens -----------------------

var n1en = results[ "night-1.en" ], n1fr = results[ "night-1.fr" ];
assert.ok( n1en.markdown.indexOf( "1h00 total exposure" ) >= 0, "59.6 min rounds to 1h00, not 59 min" );
assert.ok( n1en.markdown.indexOf( "M 57 · " ) >= 0 && n1en.markdown.indexOf( "'M 57'" ) < 0,
           "OBJECT quotes stripped" );
assert.ok( n1en.redditTitle.indexOf( "'" ) < 0, "OBJECT quotes stripped from the title" );
assert.ok( n1en.markdown.indexOf( "- 1 satellite\n" ) >= 0, "singular satellite (en)" );
assert.ok( n1fr.markdown.indexOf( "- 1 satellite\n" ) >= 0, "singular satellite (fr)" );
assert.strictEqual( n1en.redditTitle, "Sky Intruders report: one satellite crossed my M 57 session (2026-07-10/11)" );
assert.strictEqual( n1fr.redditTitle, "Rapport Sky Intruders : un satellite a traversé ma session M 57 (2026-07-10/11)" );
assert.ok( n1en.markdown.indexOf( "22:41 UT — COSMOS 2251 DEB" ) >= 0, "event time in UT with suffix" );

var n2en = results[ "night-2.en" ], n2fr = results[ "night-2.fr" ];
assert.ok( n2en.markdown.indexOf( "## Predicted crossers" ) >= 0, "predicted block kept on an empty night (en)" );
assert.ok( n2fr.markdown.indexOf( "## Passages prédits" ) >= 0, "predicted block kept on an empty night (fr)" );
assert.ok( n2en.markdown.indexOf( "00:12 UT — NORAD 12345" ) >= 0, "predicted time in UT" );
assert.ok( n2en.redditTitle.indexOf( "0 satellites" ) < 0 && n2en.redditTitle.indexOf( "last night" ) < 0,
           "no '0 satellites … last night' title" );
assert.strictEqual( n2fr.redditTitle, "Rapport Sky Intruders : rien n'a traversé ma session M 57 (2026-07-11/12)" );
assert.ok( n2en.markdown.indexOf( "\n\n\n" ) < 0, "no double blank line on the empty night" );

var n3en = results[ "night-3.en" ], n3fr = results[ "night-3.fr" ];
assert.ok( n3en.markdown.indexOf( "2h00" ) >= 0 && n3en.markdown.indexOf( "1h60" ) < 0, "7176 s is 2h00" );
assert.ok( n3en.markdown.indexOf( "Rush hour: 01:00–02:00 UT (3 crossings)" ) >= 0, "busiest hour in UT" );
assert.ok( n3fr.markdown.indexOf( "Heure de pointe : 01:00–02:00 UT (3 passages)" ) >= 0, "busiest hour in UT (fr)" );
assert.ok( n3fr.markdown.indexOf( "- étage de fusée : 1" ) >= 0, "operator keys localized (fr)" );
assert.strictEqual( n3en.redditTitle, "Sky Intruders report: 4 satellites and one meteor crossed my NGC 7000 session (2026-08-14/15)" );
assert.ok( n3en.markdown.indexOf( "NEW RECORD" ) >= 0, "records against the two previous nights" );

// A '$&' in OBJECT must not be interpreted as a replacement pattern.
var weird = R.build( { dateLabel: "x", frames: 1, cleanFrames: 1, totalExposureSec: 60,
                       target: "M$& 31", events: [], predicted: [], movers: [] }, { nights: [] }, "en" );
assert.ok( weird.redditTitle.indexOf( "my M$& 31 session" ) >= 0, "fmt inserts arguments verbatim: " + weird.redditTitle );

// --- host time zone must not leak into the log -----------------------------
// Re-render with Date.prototype.getHours/getMinutes replaced by a +5h30
// offset: the markdown must be identical, proving only the UTC accessors
// are used. (process.env.TZ cannot be changed reliably after startup.)
( function()
{
   var proto = Date.prototype;
   var origH = proto.getHours, origM = proto.getMinutes;
   proto.getHours = function() { return ( this.getUTCHours() + 5 ) % 24; };
   proto.getMinutes = function() { return ( this.getUTCMinutes() + 30 ) % 60; };
   try
   {
      var again = renderAll();
      Object.keys( results ).forEach( function( key )
      {
         assert.strictEqual( again[ key ].markdown, results[ key ].markdown, "zone-independent: " + key );
      } );
   }
   finally
   {
      proto.getHours = origH;
      proto.getMinutes = origM;
   }
} )();

console.log( "report.test.js: " + Object.keys( results ).length + " goldens checked" );
