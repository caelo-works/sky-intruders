// Meteor classification + asteroid mover heuristics (pure logic).

var assert = require( "assert" );
var fs = require( "fs" );
var path = require( "path" );
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

// --- constant-velocity fit -------------------------------------------------

( function testFitConstantVelocity()
{
   var t0 = Date.UTC( 2026, 6, 3, 2, 0, 0 );
   function pt( min, xArcsec, yArcsec )
   {
      var cd = Math.cos( 30 * Math.PI / 180 );
      return { t: new Date( t0 + min * 60000 ),
               raDeg: 200 + xArcsec / 3600 / cd, decDeg: 30 + yArcsec / 3600 };
   }
   // Perfect 2 arcsec/min along +x.
   var fit = M.fitConstantVelocity( [ pt( 0, 0, 0 ), pt( 5, 10, 0 ), pt( 10, 20, 0 ), pt( 15, 30, 0 ) ] );
   assert( Math.abs( fit.rateArcsecPerMin - 2 ) < 0.01, "rate recovered" );
   assert( fit.rmsArcsec < 0.01, "perfect line has ~zero rms" );
   assert( fit.monotonic, "steady progression is monotonic" );
   assert( Math.abs( fit.totalArcsec - 30 ) < 0.1, "total motion measured" );

   // Back-and-forth jitter is not monotonic.
   var jit = M.fitConstantVelocity( [ pt( 0, 0, 0 ), pt( 5, 6, 0 ), pt( 10, 2, 0 ), pt( 15, 8, 0 ) ] );
   assert( !jit.monotonic, "jitter around a point is not monotonic" );
} )();

// --- hardened mover gates (issue #5) ---------------------------------------

// Deterministic LCG so the noisy scenarios are reproducible.
function makeRng( seed )
{
   var s = seed >>> 0;
   return function()
   {
      s = ( 1664525 * s + 1013904223 ) >>> 0;
      return s / 4294967296;
   };
}
function gauss( rng )
{
   return Math.sqrt( -2 * Math.log( 1 - rng() ) ) * Math.cos( 2 * Math.PI * rng() );
}

( function testRealStormPool()
{
   // The exact pool that produced the 126-candidate artifact storm on the
   // 13-frame plate-solved reference set. Hardened detector: zero candidates.
   var raw = JSON.parse( fs.readFileSync(
      path.join( __dirname, "fixtures", "movers", "night13-pool.json" ), "utf8" ) );
   function poolFrames()
   {
      return raw.frames.map( function( f )
      {
         return { id: f.id, dateObs: new Date( f.dateObs ),
                  blobs: f.blobs.map( function( b )
                  {
                     return { raDeg: b[ 0 ], decDeg: b[ 1 ], fluxAdu: b[ 2 ] };
                  } ) };
      } );
   }
   var storm = M.findAsteroidCandidates( poolFrames(), null, null );
   assert.strictEqual( storm.length, 0, "real artifact storm fully rejected, got " + storm.length );

   // A synthetic mover injected into the SAME pool (last 7 frames form one
   // session with gaps <= 91 min) must still come out — exactly once.
   var rng = makeRng( 42 );
   var rates = [ 0.5, 1.0, 3.0, 8.0 ];
   for ( var r = 0; r < rates.length; ++r )
   {
      var fr = poolFrames();
      var seg = fr.slice( 6 );
      var t0 = seg[ 0 ].dateObs;
      var ra0 = 312.9, dec0 = 31.6, pa = 30 + 70 * r;
      var cd = Math.cos( dec0 * Math.PI / 180 );
      for ( var s = 0; s < seg.length; ++s )
      {
         var dt = ( seg[ s ].dateObs - t0 ) / 60000;
         var dx = rates[ r ] * dt * Math.sin( pa * Math.PI / 180 ) + gauss( rng );
         var dy = rates[ r ] * dt * Math.cos( pa * Math.PI / 180 ) + gauss( rng );
         seg[ s ].blobs.push( { raDeg: ra0 + dx / 3600 / cd, decDeg: dec0 + dy / 3600, fluxAdu: 500 } );
      }
      var got = M.findAsteroidCandidates( fr, null, null );
      assert.strictEqual( got.length, 1, "injected " + rates[ r ] + " arcsec/min mover found once, got " + got.length );
      assert( got[ 0 ].points.length >= 4, "mover tracked over 4+ frames" );
      assert( Math.abs( got[ 0 ].rateArcsecPerMin - rates[ r ] ) < 0.2 * rates[ r ] + 0.2,
              "rate recovered: " + got[ 0 ].rateArcsecPerMin + " for " + rates[ r ] );
   }
} )();

( function testDriftArtifactFamily()
{
   // Registration drift makes sensor-fixed hot pixels move LINEARLY at one
   // shared velocity — track statistics alone cannot reject them. The
   // shared-velocity veto must drop the family and keep a lone real mover.
   var rng = makeRng( 7 );
   var t0 = Date.UTC( 2026, 6, 3, 1, 0, 0 );
   function buildFrames( withMover )
   {
      var frames = [];
      for ( var k = 0; k < 6; ++k )
      {
         var blobs = [];
         // 8 sensor-fixed artifacts drifting +6/+2 arcsec per 25-min frame.
         for ( var a = 0; a < 8; ++a )
         {
            var ra0 = 312.5 + a * 0.03, dec0 = 31.3 + ( a % 3 ) * 0.05;
            var cd0 = Math.cos( dec0 * Math.PI / 180 );
            blobs.push( { raDeg: ra0 + ( 6 * k + 0.6 * gauss( rng ) ) / 3600 / cd0,
                          decDeg: dec0 + ( 2 * k + 0.6 * gauss( rng ) ) / 3600, fluxAdu: 900 } );
         }
         // Random noise detections.
         for ( var n = 0; n < 40; ++n )
            blobs.push( { raDeg: 312.3 + rng() * 0.9, decDeg: 31.1 + rng() * 0.7, fluxAdu: 300 } );
         if ( withMover )
         {
            var cdm = Math.cos( 31.5 * Math.PI / 180 );
            blobs.push( { raDeg: 312.7 - ( 1.4 * 25 * k + 0.8 * gauss( rng ) ) / 3600 / cdm,
                          decDeg: 31.5 + ( 0.9 * 25 * k + 0.8 * gauss( rng ) ) / 3600, fluxAdu: 500 } );
         }
         frames.push( { id: "d" + k, dateObs: new Date( t0 + 25 * k * 60000 ), blobs: blobs } );
      }
      return frames;
   }
   var storm = M.findAsteroidCandidates( buildFrames( false ), null, null );
   assert.strictEqual( storm.length, 0, "drifting artifact family vetoed, got " + storm.length );

   var withReal = M.findAsteroidCandidates( buildFrames( true ), null, null );
   assert.strictEqual( withReal.length, 1, "real mover survives among the drift family, got " + withReal.length );
   var expect = Math.sqrt( 1.4 * 1.4 + 0.9 * 0.9 );
   assert( Math.abs( withReal[ 0 ].rateArcsecPerMin - expect ) < 0.3,
           "mover rate recovered: " + withReal[ 0 ].rateArcsecPerMin );
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


// ---------------------------------------------------------------------------
// groupPlanes: a bundle of near-parallel segments is one airplane; a lone
// satellite trail at another angle stays out.

( function()
{
   var mk = function( x1, y1, x2, y2 )
   {
      var ang = Math.atan2( y2 - y1, x2 - x1 )*180/Math.PI;
      ang %= 180; if ( ang < 0 ) ang += 180;
      return { x1: x1, y1: y1, x2: x2, y2: y2, angleDeg: ang };
   };
   var trails = [
      mk( 100, 500, 1500, 1200 ),   // plane mark 1 (angle ~26.6)
      mk( 400, 780, 1700, 1430 ),   // plane mark 2, parallel, offset ~140
      mk( 900, 1000, 2100, 1600 ),  // plane mark 3
      mk( 2000, 100, 2100, 1900 )   // steep satellite trail (~86.8 deg)
   ];
   var groups = M.groupPlanes( trails );
   assert.strictEqual( groups.length, 1, "one bundle" );
   assert.strictEqual( groups[ 0 ].segments, 3, "three marks in the bundle" );
   assert.ok( groups[ 0 ].indices.indexOf( 3 ) < 0, "satellite trail left out" );
   // extent spans from the first mark's start to the last mark's end
   assert.ok( groups[ 0 ].x1 <= 100 + 1 && groups[ 0 ].x2 >= 2100 - 1, "full extent" );

   // two parallel segments only: NOT a plane (could be a Starlink pair)
   assert.strictEqual( M.groupPlanes( [ trails[ 0 ], trails[ 1 ] ] ).length, 0,
      "two segments are not a bundle" );
} )();

console.log( "meteors.test.js: all assertions passed" );
