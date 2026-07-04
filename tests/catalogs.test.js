// Cone-search URL builders + TSV/pipe parsers against recorded fixtures.

var assert = require( "assert" );
var fs = require( "fs" );
var path = require( "path" );
var Cat = require( "./build/module.js" ).SICatalogs;

function fixture( name )
{
   return fs.readFileSync( path.join( __dirname, "fixtures", "treasure", name ), "utf8" );
}

function allFinite( rows )
{
   for ( var i = 0; i < rows.length; ++i )
      if ( !isFinite( rows[ i ].raDeg ) || !isFinite( rows[ i ].decDeg ) ||
           rows[ i ].raDeg < 0 || rows[ i ].raDeg >= 360 ||
           rows[ i ].decDeg < -90 || rows[ i ].decDeg > 90 )
         return false;
   return true;
}

// --- URL builders ----------------------------------------------------------

( function testUrls()
{
   var u = Cat.vizierUrl( "VII/237", 202.4696, 47.1952, 0.15, [ "PGC", "logD25" ], 20 );
   assert( u.indexOf( "-source=VII/237" ) >= 0, "source in URL" );
   assert( u.indexOf( "-c=202.4696+47.1952" ) >= 0, "RA+Dec joined with +" );
   assert( u.indexOf( "-out=PGC,logD25" ) >= 0, "columns in URL" );
   assert( u.indexOf( "-out.max=20" ) >= 0, "row cap in URL" );

   // Negative declination keeps its own minus after the + separator.
   var un = Cat.vizierUrl( "V/127A/mash1", 270, -30, 2, [ "PNG", "Name" ], 40 );
   assert( un.indexOf( "-c=270+-30" ) >= 0, "negative Dec after + separator: " + un );

   var s = Cat.skybotUrl( 202.47, 47.2, 0.3, "2026-07-03T02:13:05" );
   assert( s.indexOf( "-ra=202.47" ) >= 0 && s.indexOf( "-dec=47.2" ) >= 0, "skybot ra/dec" );
   assert( s.indexOf( "-ep=2026-07-03T02%3A13%3A05" ) >= 0, "epoch percent-encoded: " + s );
   assert( s.indexOf( "-mime=text&-output=object" ) >= 0, "skybot text/object output" );
} )();

// --- HyperLEDA galaxies (VII/237) around M51 -------------------------------

( function testHyperleda()
{
   var rows = Cat.parseVizierTsv( fixture( "hyperleda-m51.tsv" ) );
   assert.strictEqual( rows.length, 3, "3 HyperLEDA rows" );
   assert( allFinite( rows ), "galaxy positions are finite decimal degrees" );
   assert.strictEqual( rows[ 0 ].PGC, "47404", "first PGC id parsed" );
   assert.strictEqual( rows[ 0 ].logD25, "2.00", "logD25 parsed as trimmed value" );

   var typed = Cat.typeGalaxyRow( rows[ 0 ] );
   assert.strictEqual( typed.type, "galaxy", "typed as galaxy" );
   assert( typed.diamArcmin > 0, "apparent diameter derived from logD25" );
} )();

// --- Milliquas quasars (VII/294) around 3C 273 -----------------------------

( function testMilliquas()
{
   var rows = Cat.parseVizierTsv( fixture( "milliquas-3c273.tsv" ) );
   assert.strictEqual( rows.length, 11, "11 Milliquas rows" );
   assert( allFinite( rows ), "quasar positions are finite decimal degrees" );

   // Tolerate blank redshift fields (photometric candidates).
   var blank = 0;
   for ( var i = 0; i < rows.length; ++i )
      if ( rows[ i ].z === "" )
         ++blank;
   assert( blank >= 1, "some quasars have a blank redshift" );

   // 3C 273 must carry z = 0.158.
   var found = null;
   for ( var j = 0; j < rows.length; ++j )
      if ( rows[ j ].Name === "3C 273" )
         found = rows[ j ];
   assert( found !== null, "3C 273 present" );
   var q = Cat.typeQuasarRow( found );
   assert( Math.abs( q.z - 0.158 ) < 1e-6, "3C 273 z = 0.158 (got " + q.z + ")" );
   assert( Math.abs( q.Rmag - 14.11 ) < 1e-6, "3C 273 Rmag = 14.11" );
} )();

// --- SkyBoT asteroids/comets (RA hours -> degrees) -------------------------

( function testSkybot()
{
   var rows = Cat.parseSkybot( fixture( "skybot-m51.txt" ) );
   assert.strictEqual( rows.length, 2, "2 SkyBoT rows" );

   var a = rows[ 0 ];
   assert.strictEqual( a.name, "2016 FD13", "asteroid name" );
   assert.strictEqual( a.klass, "Mars-Crosser", "asteroid class" );
   assert( Math.abs( a.magV - 21.4 ) < 1e-6, "asteroid Mv parsed" );
   // 13h26m27.79s * 15 ~ 201.6 deg; conversion from hours must have happened.
   assert( a.raDeg > 200 && a.raDeg < 203, "RA converted hours->deg (got " + a.raDeg + ")" );
   assert( Math.abs( a.decDeg - 47.273 ) < 0.01, "Dec parsed (got " + a.decDeg + ")" );

   assert.strictEqual( rows[ 1 ].name, "C/2024 U1", "comet name" );
   assert.strictEqual( rows[ 1 ].klass, "Comet", "comet class" );

   // Error / no-header body degrades to [] rather than throwing.
   assert.deepStrictEqual( Cat.parseSkybot( "some transient 500 error page" ), [],
      "no '#' header -> empty" );
   assert.deepStrictEqual( Cat.parseSkybot( "" ), [], "empty body -> empty" );
} )();

// --- MASH planetary nebulae (V/127A/mash1) around the galactic bulge -------

( function testMash()
{
   var rows = Cat.parseVizierTsv( fixture( "pne-bulge.tsv" ) );
   assert.strictEqual( rows.length, 40, "40 MASH rows" );
   assert( allFinite( rows ), "PN positions are finite decimal degrees" );
   assert( rows[ 0 ].PNG.length > 0 && rows[ 0 ].Name.length > 0, "PNG + Name present" );

   var pn = Cat.typePneRow( rows[ 0 ] );
   assert.strictEqual( pn.type, "pne", "typed as pne" );
   assert( pn.majDiamArcsec > 0, "major diameter (arcsec) parsed" );
   assert( pn.diamArcmin > 0, "diameter converted to arcmin" );
} )();

console.log( "catalogs.test.js: all assertions passed" );
