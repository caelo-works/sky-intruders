// Cross-match + narrative + standalone HTML assembly (pure logic).

var assert = require( "assert" );
var mod = require( "./build/module.js" );
var Tr = mod.SITreasure;
var Rep = mod.SITreasureReport;

// Stub projector: RA maps to x (scaled), Dec maps to y. Objects off-frame or
// projecting to null are dropped by crossMatch.
function stubProjector( raDeg, decDeg )
{
   if ( decDeg < -89 )
      return null; // simulate "behind the tangent plane"
   return { x: ( raDeg - 187 )*1000, y: ( decDeg - 2 )*1000 };
}

var WIDTH = 200, HEIGHT = 200;

// --- crossMatch drops out-of-bounds objects --------------------------------

( function testCrossMatch()
{
   var objects = {
      quasar: [
         { type: "quasar", name: "3C 273", raDeg: 187.05, decDeg: 2.05, z: 0.158, Rmag: 14.11 }, // x=50,y=50 in
         { type: "quasar", name: "FarQuasar", raDeg: 190.0, decDeg: 2.0, z: 2.3, Rmag: 19.95 }    // x=3000 out
      ],
      galaxy: [
         { type: "galaxy", name: "PGC 1", raDeg: 187.1, decDeg: 2.1, diamArcmin: 6.0 } // x=100,y=100 in
      ],
      pne: [
         { type: "pne", name: "PN behind", raDeg: 187.1, decDeg: -90, majDiamArcsec: 10 } // null projection
      ]
   };
   var t = Tr.crossMatch( objects, stubProjector, WIDTH, HEIGHT );
   assert.strictEqual( t.length, 2, "kept only the 2 in-bounds objects (got " + t.length + ")" );
   for ( var i = 0; i < t.length; ++i )
   {
      assert( t[ i ].x >= 0 && t[ i ].x <= WIDTH - 1, "x in bounds" );
      assert( t[ i ].y >= 0 && t[ i ].y <= HEIGHT - 1, "y in bounds" );
   }
   // Notability: the quasar outranks the galaxy tier.
   assert.strictEqual( t[ 0 ].type, "quasar", "quasar sorted first by notability" );
   assert.strictEqual( t[ 0 ].name, "3C 273", "the in-bounds quasar survived" );
} )();

// --- narrate produces a redshift sentence with a cosmology number ----------

( function testNarrate()
{
   var q = { type: "quasar", name: "SDSS Jxxxx", raDeg: 187, decDeg: 2, z: 2.3, Rmag: 19.9, pxDiam: 4 };
   var s = Tr.narrate( q, "en" );
   assert( s.indexOf( "z = 2.3" ) >= 0, "mentions the redshift" );
   assert( /billion years/.test( s ), "mentions a cosmology time" );
   assert( /10\.8 billion/.test( s ), "uses the computed lookback (~10.8 Gyr): " + s );
   assert( s.indexOf( "4-pixel" ) >= 0, "uses the pixel-size hook when provided" );
   assert( s.indexOf( "before the Sun existed" ) >= 0, "adds an age landmark" );

   // French variant.
   var sf = Tr.narrate( q, "fr" );
   assert( /milliards d'annees/.test( sf ), "French redshift sentence" );

   // Non-redshift object still narrates cleanly.
   var ast = { type: "asteroid", name: "2016 FD13", klass: "Mars-Crosser", magV: 21.4 };
   assert( Tr.narrate( ast, "en" ).indexOf( "2016 FD13" ) >= 0, "asteroid narrated" );
} )();

// --- summarize counts + headline hooks -------------------------------------

( function testSummarize()
{
   var treasures = [
      { type: "galaxy", name: "g1" }, { type: "galaxy", name: "g2" },
      { type: "quasar", name: "q1", z: 2.3 }, { type: "asteroid", name: "a1" }
   ];
   var sum = Tr.summarize( treasures, "en" );
   assert.strictEqual( sum.counts.galaxy, 2, "2 galaxies" );
   assert.strictEqual( sum.counts.quasar, 1, "1 quasar" );
   assert.strictEqual( sum.total, 4, "4 total" );
   var joined = sum.headlines.join( " | " );
   assert( joined.indexOf( "2 galaxies captured without knowing" ) >= 0, "galaxy headline" );
   assert( joined.indexOf( "deepest capture" ) >= 0, "deepest-redshift headline leads" );
} )();

// --- buildHtml returns a self-contained illustrated document ---------------

( function testBuildHtml()
{
   // 1x1 transparent PNG.
   var png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
   var treasures = [
      { id: "t0", type: "quasar", name: "3C 273", x: 50, y: 50 },
      { id: "t1", type: "galaxy", name: "PGC 47404", x: 100, y: 100 }
   ];
   var narratives = [
      "This 4-pixel smudge is the quasar 3C 273 at z = 0.158: its light left about 2.0 billion years ago.",
      "This is the galaxy PGC 47404, about 6.3 arcmin across."
   ];
   var summary = Tr.summarize( [ { type: "quasar", name: "3C 273", z: 0.158 },
                                 { type: "galaxy", name: "PGC 47404" } ], "en" );
   var html = Rep.buildHtml( {
      treasures: treasures, narratives: narratives, summary: summary,
      mapPng: png, thumbs: [ { id: "t0", pngBase64: png }, { id: "t1", pngBase64: png } ],
      fieldInfo: { raDeg: 187.28, decDeg: 2.05, radiusDeg: 0.2, target: "3C 273 field" },
      lang: "en"
   } );

   assert( html.indexOf( "<!doctype html>" ) === 0, "is an HTML document" );
   assert( html.indexOf( "data:image/png;base64," + png ) >= 0, "embeds PNG as data URI" );
   assert( html.indexOf( "<style>" ) >= 0 && html.indexOf( "</style>" ) >= 0, "inline CSS present" );
   assert( html.indexOf( "http://" ) < 0 && html.indexOf( "https://" ) < 0 ||
           html.indexOf( "caelo.works" ) >= 0, "no external asset URLs (only the credit text)" );
   assert( html.indexOf( "4-pixel smudge is the quasar 3C 273" ) >= 0, "narrative rendered" );
   assert( html.indexOf( "3C 273 field" ) >= 0, "field descriptor rendered" );
   assert( html.indexOf( "captured without knowing" ) >= 0, "summary headline rendered" );

   // Empty case still yields a valid document.
   var empty = Rep.buildHtml( { treasures: [], summary: Tr.summarize( [], "en" ),
                                fieldInfo: { raDeg: 10, decDeg: 20, radiusDeg: 0.1 }, lang: "en" } );
   assert( empty.indexOf( "</html>" ) >= 0, "empty report still closes the document" );
} )();

console.log( "treasure.test.js: all assertions passed" );
