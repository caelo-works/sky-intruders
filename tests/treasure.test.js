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

   // French variant — with real accents.
   var sf = Tr.narrate( q, "fr" );
   assert( /milliards d'ann\u00e9es/.test( sf ), "French redshift sentence (accented)" );
   assert( /lumi\u00e8re/.test( sf ), "French uses accented lumi\u00e8re" );

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

// --- displayName: catalog IDs become two-line friendly labels ---------------

( function testDisplayName()
{
   var gaia = { type: "quasar", name: "Gaia 1864903391535776384", z: 2.2 };
   var dn = Tr.displayName( gaia, "fr" );
   assert.strictEqual( dn.main, "Quasar Gaia (z 2.2)", "friendly main line: " + dn.main );
   assert.strictEqual( dn.sub, "Gaia 1864903391535776384", "full catalog name on the sub line" );
   assert.strictEqual( dn.bare, "Gaia", "bare name for typed sentences" );

   var short = Tr.displayName( { type: "quasar", name: "3C 273", z: 0.158 }, "en" );
   assert.strictEqual( short.main, "3C 273 (z 0.16)", "short name keeps one line: " + short.main );
   assert.strictEqual( short.sub, null, "no sub line for short names" );

   var gal = Tr.displayName( { type: "galaxy", name: "PGC 202388" }, "fr" );
   assert.strictEqual( gal.main, "PGC 202388", "galaxy without z suffix" );
   assert.strictEqual( gal.sub, null, "PGC name is not unwieldy" );
} )();

// --- apertureDetection: signal vs below-noise --------------------------------

( function testApertureDetection()
{
   // Deterministic pseudo-noise around 0.1.
   var s = 12345;
   function rnd() { s = ( s*1103515245 + 12345 ) & 0x7fffffff; return s/0x7fffffff; }
   var bg = [], ap = [];
   for ( var i = 0; i < 300; ++i )
      bg.push( 0.1 + 0.01*( rnd() - 0.5 ) );
   for ( var k = 0; k < 60; ++k )
      ap.push( 0.1 + 0.01*( rnd() - 0.5 ) );

   var flat = Tr.apertureDetection( ap, bg );
   assert.strictEqual( flat.captured, false, "flat aperture is not captured (snr " + flat.snr + ")" );

   var bright = ap.slice();
   bright[ 10 ] = 0.2; // strong peak
   assert.strictEqual( Tr.apertureDetection( bright, bg ).captured, true, "bright peak captured" );

   var filled = [];
   for ( var f = 0; f < 60; ++f )
      filled.push( 0.1 + 0.01*( rnd() - 0.5 ) + ( ( f % 3 !== 0 ) ? 0.008 : 0 ) ); // 2/3 above 2 sigma
   assert.strictEqual( Tr.apertureDetection( filled, bg ).captured, true, "filled aperture captured" );

   assert.strictEqual( Tr.apertureDetection( [], bg ).captured, false, "empty aperture never captured" );
   assert.strictEqual( Tr.apertureDetection( ap, [ 0.1, 0.1 ] ).captured, false, "tiny annulus never captured" );
} )();

// --- captureVerdict: decoy apertures set the false-alarm floor ---------------

( function testCaptureVerdict()
{
   var hit = { captured: true, snr: 8, fracAbove: 0.05 };
   var quiet = [], starry = [];
   for ( var i = 0; i < 12; ++i )
   {
      quiet.push( { captured: false, snr: 1.2, fracAbove: 0.02 } );
      starry.push( { captured: true, snr: ( i === 3 ) ? 7.5 : 2.0, fracAbove: 0.03 } );
   }
   assert.strictEqual( Tr.captureVerdict( hit, quiet ), true, "clean field: capture stands" );
   assert.strictEqual( Tr.captureVerdict( hit, starry ), false,
                       "a decoy nearly as strong: chance star, capture withdrawn" );
   assert.strictEqual( Tr.captureVerdict( { captured: false, snr: 2 }, quiet ), false,
                       "no signal never captured" );
   assert.strictEqual( Tr.captureVerdict( hit, [] ), true, "too few decoys: plain verdict stands" );

   var extended = { captured: true, snr: 3, fracAbove: 0.6 };
   assert.strictEqual( Tr.captureVerdict( extended, quiet ), true, "filled aperture beats quiet decoys" );
} )();

// --- applyMagConsistency: impossible faint "detections" are withdrawn --------

( function testMagConsistency()
{
   var ts = [
      { type: "asteroid", name: "bright", magV: 16.9, captured: true },
      { type: "asteroid", name: "ghost", magV: 26.1, captured: true },
      { type: "asteroid", name: "u1", magV: 20.0, captured: false },
      { type: "asteroid", name: "u2", magV: 21.0, captured: false },
      { type: "asteroid", name: "u3", magV: 22.0, captured: false },
      { type: "asteroid", name: "u4", magV: 21.5, captured: false }
   ];
   Tr.applyMagConsistency( ts );
   assert.strictEqual( ts[ 0 ].captured, true, "bright detection survives" );
   assert.strictEqual( ts[ 1 ].captured, false, "mag-26 ghost withdrawn" );

   // Too few objects: no opinion.
   var few = [ { type: "quasar", name: "q", Rmag: 25, captured: true } ];
   Tr.applyMagConsistency( few );
   assert.strictEqual( few[ 0 ].captured, true, "small samples untouched" );
} )();

// --- summarize: captured vs in-field split + French agreement ----------------

( function testSummarizeCaptured()
{
   var ts = [
      { type: "galaxy", name: "g1", captured: true },
      { type: "asteroid", name: "a1", captured: false },
      { type: "asteroid", name: "a2", captured: false },
      { type: "asteroid", name: "a3", captured: true },
      { type: "quasar", name: "Gaia 1864903391535776384", z: 2.2, captured: false }
   ];
   var fr = Tr.summarize( ts, "fr" );
   var jf = fr.headlines.join( " | " );
   assert( jf.indexOf( "1 galaxie captur\u00e9e sans le savoir" ) >= 0, "feminine singular agreement: " + jf );
   assert( jf.indexOf( "1 ast\u00e9ro\u00efde captur\u00e9 sans le savoir (+ 2 sous le bruit)" ) >= 0,
           "below-noise tail: " + jf );
   assert( jf.indexOf( "1 quasar dans le champ, sous le bruit" ) >= 0, "all-below-noise phrasing: " + jf );
   assert( jf.indexOf( "le plus lointain dans le champ (sous le bruit) : Quasar Gaia" ) >= 0,
           "deepest below-noise uses the friendly name: " + jf );
   assert.strictEqual( fr.captured.asteroid, 1, "captured counts per type" );
   assert.strictEqual( fr.counts.asteroid, 3, "total counts per type" );

   var en = Tr.summarize( ts, "en" );
   var je = en.headlines.join( " | " );
   assert( je.indexOf( "1 asteroid captured without knowing (+ 2 below your noise)" ) >= 0, je );
   assert( je.indexOf( "deepest in the field (below your noise): Quasar Gaia" ) >= 0, je );
} )();

// --- buildHtml: sub lines, noise badges, catalog outage note ------------------

( function testBuildHtmlExtras()
{
   var ts = [
      { id: "t0", type: "quasar", name: "Gaia 1864903391535776384", z: 2.2, x: 10, y: 10, captured: false }
   ];
   var html = Rep.buildHtml( {
      treasures: ts, narratives: [ "story" ],
      summary: Tr.summarize( ts, "fr" ),
      issues: [ "galaxy", "asteroid" ],
      fieldInfo: { raDeg: 314, decDeg: 31.4, radiusDeg: 1.0 }, lang: "fr" } );
   assert( html.indexOf( "Quasar Gaia (z 2.2)" ) >= 0, "main label rendered" );
   assert( html.indexOf( "class=\"subname\">Gaia 1864903391535776384" ) >= 0, "sub line rendered" );
   assert( html.indexOf( "b-noise" ) >= 0, "below-noise badge rendered" );
   assert( html.indexOf( "galaxies, ast\u00e9ro\u00efdes" ) >= 0, "outage note lists failed catalogs" );
   assert( html.indexOf( "Chasse au tr\u00e9sor" ) >= 0, "accented French title" );
} )();

console.log( "treasure.test.js: all assertions passed" );
