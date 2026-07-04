// Flat LambdaCDM redshift -> lookback / distance (pure logic).

var assert = require( "assert" );
var C = require( "./build/module.js" ).SICosmology;

function approx( actual, expected, tol, msg )
{
   assert( Math.abs( actual - expected ) <= tol,
      msg + " (got " + actual + ", expected " + expected + " +/- " + tol + ")" );
}

// --- lookback-time anchors (pinned within tight tolerance) ----------------

( function testAnchors()
{
   var z1 = C.lookbackGyr( 1 );
   assert( z1 > 7.7 && z1 < 7.9, "z=1 lookback in 7.7-7.9 Gyr (got " + z1 + ")" );
   approx( z1, 7.818, 0.02, "z=1 lookback pinned" );

   var z23 = C.lookbackGyr( 2.3 );
   assert( z23 > 10.7 && z23 < 10.9, "z=2.3 lookback in 10.7-10.9 Gyr (got " + z23 + ")" );
   approx( z23, 10.837, 0.02, "z=2.3 lookback pinned" );

   var z0158 = C.lookbackGyr( 0.158 );
   assert( z0158 > 1.9 && z0158 < 2.0, "z=0.158 lookback in 1.9-2.0 Gyr (got " + z0158 + ")" );
   approx( z0158, 1.991, 0.02, "z=0.158 lookback pinned" );
} )();

// --- hubble time + edge cases ---------------------------------------------

( function testHubbleAndEdges()
{
   approx( C.hubbleTimeGyr(), 14.049, 0.02, "Hubble time ~14.05 Gyr" );
   assert.strictEqual( C.lookbackGyr( 0 ), 0, "z=0 lookback is 0" );
   assert.strictEqual( C.comovingMpc( 0 ), 0, "z=0 comoving is 0" );
   // Monotone increasing lookback.
   assert( C.lookbackGyr( 3 ) > C.lookbackGyr( 1 ), "lookback increases with z" );
   // Bounded below the age of the universe.
   assert( C.lookbackGyr( 1000 ) < C.hubbleTimeGyr(), "lookback stays below Hubble time" );
} )();

// --- light-travel distance + comoving -------------------------------------

( function testDistances()
{
   // Light-travel (lookback) distance in Gly equals lookback time in Gyr.
   approx( C.lightTravelDistanceGly( 2.3 ), C.lookbackGyr( 2.3 ), 1e-9,
      "light-travel Gly == lookback Gyr" );
   // Comoving distance sanity: z=1 ~ 3350 Mpc for this cosmology.
   approx( C.comovingMpc( 1 ), 3350.9, 3, "comoving Mpc at z=1" );
} )();

// --- narrative fact hooks -------------------------------------------------

( function testFactHooks()
{
   var hooks = C.factHooks( 2.3 ).map( function( h ) { return h.en; } );
   assert( hooks.indexOf( "before the Sun existed" ) >= 0, "z=2.3 predates the Sun" );
   assert( hooks.indexOf( "before the Earth formed" ) >= 0, "z=2.3 predates the Earth" );

   var low = C.factHooks( 0.01 );
   assert.strictEqual( low.length, 0, "low-z light crosses no age landmark" );

   // French strings present too.
   assert( C.factHooks( 2.3 )[ 0 ].fr.length > 0, "hooks carry a French string" );
} )();

console.log( "cosmology.test.js: all assertions passed" );
