// Meteor classification + asteroid mover heuristics (pure logic).

var assert = require( "assert" );
var M = require( "./build/module.js" ).SIMeteors;
var R = require( "./build/module.js" ).SIReport;

// --- active showers -------------------------------------------------------

( function testActiveShowers()
{
   var aug12 = new Date( Date.UTC( 2026, 7, 12 ) ); // Perseids peak
   var codes = M.activeShowers( aug12 ).map( function( s ) { return s.code; } );
   assert( codes.indexOf( "PER" ) >= 0, "Perseids active on Aug 12" );

   var jan3 = new Date( Date.UTC( 2026, 0, 3 ) ); // Quadrantids (year-wrap window)
   var codes2 = M.activeShowers( jan3 ).map( function( s ) { return s.code; } );
   assert( codes2.indexOf( "QUA" ) >= 0, "Quadrantids active on Jan 3 (window wraps year)" );

   var jun1 = new Date( Date.UTC( 2026, 5, 1 ) ); // quiet
   assert.strictEqual( M.activeShowers( jun1 ).length, 0, "no major shower on Jun 1" );
} )();

// --- trail classification -------------------------------------------------

( function testMeteorAlignment()
{
   // A trail lying on a great circle through the Perseid radiant (RA 48, Dec 58),
   // moving away from it, during the Perseids, with brightness variation.
   var aug12 = new Date( Date.UTC( 2026, 7, 12, 2, 0, 0 ) );
   var trail = { p1: { raDeg: 60, decDeg: 40 }, p2: { raDeg: 66, decDeg: 30 },
                 brightnessVariation: 0.5, spansEdgeToEdge: false };
   var r = M.classifyTrail( trail, aug12 );
   assert.strictEqual( r.klass, "meteor", "aligned + variable + contained => meteor" );
   assert( r.shower && r.shower.code == "PER", "attributed to Perseids" );
} )();

( function testSteadyEdgeToEdgeIsSatelliteCandidate()
{
   var trail = { p1: { raDeg: 10, decDeg: 10 }, p2: { raDeg: 12, decDeg: 12 },
                 brightnessVariation: 0.05, spansEdgeToEdge: true };
   var r = M.classifyTrail( trail, new Date( Date.UTC( 2026, 5, 1 ) ) );
   assert.strictEqual( r.klass, "satellite-candidate", "steady edge-to-edge, no match" );
} )();

// --- stationary filtering (star rejection) --------------------------------

( function testFilterStationary()
{
   // Three frames: two fixed stars everywhere, plus one source that moves.
   function frame( id, min, moverRa )
   {
      return { id: id, dateObs: new Date( Date.UTC( 2026, 6, 3, 2, min, 0 ) ),
               blobs: [ { raDeg: 100.0, decDeg: 20.0, fluxAdu: 5000 },
                        { raDeg: 100.5, decDeg: 20.5, fluxAdu: 4000 },
                        { raDeg: moverRa, decDeg: 21.0, fluxAdu: 300 } ] };
   }
   var frames = [ frame( "a", 0, 101.00 ), frame( "b", 10, 101.02 ), frame( "c", 20, 101.04 ) ];
   var pruned = M.filterStationary( frames, 5, null );
   var total = pruned.reduce( function( n, f ) { return n + f.blobs.length; }, 0 );
   assert.strictEqual( total, 3, "two fixed stars removed from each frame, mover kept" );
   for ( var i = 0; i < pruned.length; ++i )
      assert.strictEqual( pruned[ i ].blobs.length, 1, "one mover survives per frame" );
} )();

( function testFindAsteroidCandidates()
{
   // A source drifting ~1 arcsec/min across 3 frames, amid fixed stars.
   function frame( id, min, moverRa )
   {
      return { id: id, dateObs: new Date( Date.UTC( 2026, 6, 3, 2, min, 0 ) ),
               blobs: [ { raDeg: 100.0, decDeg: 20.0, fluxAdu: 9000 },
                        { raDeg: 100.5, decDeg: 20.5, fluxAdu: 8000 },
                        { raDeg: moverRa, decDeg: 21.0, fluxAdu: 300 } ] };
   }
   // 0.0003 deg/10min ~ 1.8 arcsec over 10 min -> within [0.1,120] arcsec/min.
   var frames = [ frame( "a", 0, 101.000 ), frame( "b", 10, 101.010 ), frame( "c", 20, 101.020 ) ];
   var movers = M.findAsteroidCandidates( frames, 3, null );
   assert( movers.length >= 1, "one coherent mover found" );
   assert.strictEqual( movers[ 0 ].points.length, 3, "tracked across all three frames" );
   assert( movers[ 0 ].rateArcsecPerMin > 0.1 && movers[ 0 ].rateArcsecPerMin < 120,
           "plausible asteroid rate" );
} )();

// --- report renders the new asteroid class --------------------------------

( function testReportWithAsteroid()
{
   var night = { dateLabel: "2026-07-03", frames: 5, cleanFrames: 3,
                 totalExposureSec: 600, target: "M31",
                 events: [ { timeUtc: new Date( "2026-07-03T02:15:00Z" ), klass: "asteroid",
                             rateArcsecPerMin: 1.4, nFrames: 3, frameId: "L_0003.fits" } ],
                 movers: [ { rateArcsecPerMin: 1.4, points: [ { frame: "L_0003.fits" },
                             { frame: "L_0004.fits" }, { frame: "L_0005.fits" } ] } ] };
   var r = R.build( night, { nights: [] }, "en" );
   assert( r.markdown.indexOf( "asteroid candidate" ) >= 0, "asteroid appears in chronology" );
   assert( r.markdown.indexOf( "asteroid candidates (slow movers)" ) >= 0, "movers section present" );
   assert.strictEqual( r.summary.unknowns, 0, "asteroid not miscounted as unknown" );
} )();

console.log( "meteors.test.js: all assertions passed" );
