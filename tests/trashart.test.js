// Trash to Art pure composition logic.

var assert = require( "assert" );
var A = require( "./build/module.js" ).SITrashArt;

// --- color schemes --------------------------------------------------------

( function testTypeScheme()
{
   var trails = [ { klass: "satellite" }, { klass: "meteor" }, { klass: "asteroid" } ];
   var colored = A.assignColors( trails, "type" );
   assert.strictEqual( colored[ 0 ].color, A.TYPE_COLORS.satellite );
   assert.strictEqual( colored[ 1 ].color, A.TYPE_COLORS.meteor );
   assert.strictEqual( colored[ 2 ].color, A.TYPE_COLORS.asteroid );
   assert( colored.legend.length == 3, "legend has one entry per used type" );
} )();

( function testOperatorSchemeDeterministic()
{
   var trails = [ { operator: "Starlink" }, { operator: "OneWeb" }, { operator: "Starlink" } ];
   var a = A.assignColors( trails, "operator" );
   var b = A.assignColors( trails, "operator" );
   assert.strictEqual( a[ 0 ].color, b[ 0 ].color, "operator colors are deterministic" );
   assert.strictEqual( a[ 0 ].color, a[ 2 ].color, "same operator -> same color" );
   assert.notStrictEqual( a[ 0 ].color, a[ 1 ].color, "different operators -> different colors" );
} )();

( function testTimeScheme()
{
   var t0 = new Date( "2026-07-03T22:00:00Z" );
   var t1 = new Date( "2026-07-04T02:00:00Z" );
   var t2 = new Date( "2026-07-04T05:00:00Z" );
   var colored = A.assignColors( [ { timeUtc: t0 }, { timeUtc: t1 }, { timeUtc: t2 } ], "time" );
   assert.strictEqual( colored[ 0 ].color, A.lerpHex( "#22d3ee", "#f472b6", 0 ), "earliest = ramp start" );
   assert.strictEqual( colored[ 2 ].color, A.lerpHex( "#22d3ee", "#f472b6", 1 ), "latest = ramp end" );
   assert.notStrictEqual( colored[ 1 ].color, colored[ 0 ].color, "mid differs from ends" );
} )();

// --- canvas normalization -------------------------------------------------

( function testNormalizeEndpoints()
{
   var trails = [ { x1: 0, y1: 0, x2: 100, y2: 50, color: "#fff" } ];
   var n = A.normalizeEndpoints( trails, 200, 100, 400, 200 ); // 2x upscale
   assert.strictEqual( n[ 0 ].x2, 200, "x scaled by 2" );
   assert.strictEqual( n[ 0 ].y2, 100, "y scaled by 2" );
   assert.strictEqual( n[ 0 ].color, "#fff", "color preserved" );
} )();

// --- poster text model ----------------------------------------------------

( function testPosterModel()
{
   var summary = { satellites: 11, starlink: 8, meteors: 2, satCandidates: 1,
                   unknowns: 0, movers: 1, date: "2026-07-03" };
   var m = A.posterModel( summary, { scheme: "operator", frameCount: 47,
                                     dateLabel: "2026-07-03", lang: "en",
                                     legend: [ { label: "Starlink", color: "#22d3ee" } ] } );
   assert.strictEqual( m.intruderCount, 15, "11+2+1+0+1" );
   assert( m.title.indexOf( "15 intruders" ) >= 0, "title counts intruders: " + m.title );
   assert( m.subtitle.indexOf( "47 frames" ) >= 0, "subtitle names frame count" );
   assert( m.legendTitle.indexOf( "by operator" ) >= 0, "legend labelled by scheme" );
   var joined = m.stats.join( " | " );
   assert( joined.indexOf( "Starlink: 8" ) >= 0, "starlink stat present" );

   var one = A.posterModel( { satellites: 1, meteors: 0, movers: 0, unknowns: 0, satCandidates: 0 },
                            { lang: "fr", frameCount: 1 } );
   assert( one.title.indexOf( "unique intrus" ) >= 0, "fr singular title: " + one.title );

   var none = A.posterModel( { satellites: 0, meteors: 0, movers: 0, unknowns: 0, satCandidates: 0 },
                             { lang: "en", frameCount: 3 } );
   assert( none.title.indexOf( "clean night" ) >= 0, "empty-night title: " + none.title );
} )();

// --- poster HTML assembly -------------------------------------------------

( function testBuildPosterHtml()
{
   var summary = { satellites: 11, starlink: 8, meteors: 2, satCandidates: 1,
                   unknowns: 0, movers: 1, date: "2026-07-03" };
   var model = A.posterModel( summary, { scheme: "type", frameCount: 47,
                                         dateLabel: "2026-07-03", lang: "en",
                                         legend: [ { label: "satellite", color: "#22d3ee" },
                                                   { label: "meteor", color: "#f59e0b" } ] } );
   var png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
   var thumbs = [ { pngBase64: png, caption: "STARLINK-4512" } ];
   var html = A.buildPosterHtml( model, png, thumbs, "en" );

   assert( html.indexOf( "<!doctype html>" ) === 0, "starts with a doctype" );
   assert( html.indexOf( "data:image/png;base64," + png ) >= 0, "embeds the choreography PNG inline" );
   assert( html.indexOf( "15 intruders" ) >= 0, "title carried into the poster: " + model.title );
   assert( html.indexOf( "STARLINK-4512" ) >= 0, "thumbnail caption present" );
   assert( html.indexOf( "<style>" ) >= 0, "CSS inlined (self-contained)" );
   assert( html.indexOf( "http://" ) < 0 && html.indexOf( "https://" ) < 0 ||
           html.indexOf( "src=\"http" ) < 0, "no external asset src (CSP-safe)" );
   assert( html.indexOf( "satellite" ) >= 0 && html.indexOf( "#22d3ee" ) >= 0, "legend swatch rendered" );

   // Degrades cleanly with nothing to show.
   var empty = A.buildPosterHtml( A.posterModel(
      { satellites: 0, meteors: 0, movers: 0, unknowns: 0, satCandidates: 0 },
      { lang: "en", frameCount: 0 } ), null, [], "en" );
   assert( empty.indexOf( "clean night" ) >= 0, "empty poster still titles the night" );
   assert( empty.indexOf( "<img" ) < 0, "no image tags when there is nothing to embed" );
} )();

console.log( "trashart.test.js: all assertions passed" );
