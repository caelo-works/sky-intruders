/*
 * Cosmology.js — SICosmology: redshift to lookback time, light-travel
 * distance and comoving distance for a flat LambdaCDM universe.
 *
 * Pure JS (Node-testable). Constants: H0 = 69.6 km/s/Mpc, Omega_m = 0.286,
 * Omega_Lambda = 0.714 (radiation neglected). The integrals are evaluated
 * with composite Simpson over a fixed step count, which is ample for the
 * smooth integrands here.
 */

var SICosmology = ( function()
{
   var H0 = 69.6;        // km/s/Mpc
   var OMEGA_M = 0.286;
   var OMEGA_L = 0.714;
   var C_KM_S = 299792.458;

   // 1/H0 expressed in Gyr: 977.792... Gyr per (km/s/Mpc)^-1.
   var HUBBLE_TIME_GYR = 977.792221 / H0;
   // Hubble distance c/H0 in Mpc.
   var HUBBLE_DIST_MPC = C_KM_S / H0;

   var STEPS = 1000;

   function eOfZ( z )
   {
      // Dimensionless expansion rate E(z) = H(z)/H0 for flat LambdaCDM.
      var zp1 = 1 + z;
      return Math.sqrt( OMEGA_M*zp1*zp1*zp1 + OMEGA_L );
   }

   function simpson( f, a, b, n )
   {
      // Composite Simpson rule; n is forced even.
      if ( n % 2 !== 0 )
         ++n;
      if ( b <= a )
         return 0;
      var h = ( b - a )/n;
      var s = f( a ) + f( b );
      for ( var i = 1; i < n; ++i )
         s += ( ( i % 2 === 0 ) ? 2 : 4 )*f( a + i*h );
      return s*h/3;
   }

   function lookbackGyr( z )
   {
      // Lookback time t(z) = tH * integral_0^z dz' / [ (1+z') E(z') ].
      if ( !( z > 0 ) )
         return 0;
      var integrand = function( zp )
      {
         return 1/( ( 1 + zp )*eOfZ( zp ) );
      };
      return HUBBLE_TIME_GYR*simpson( integrand, 0, z, STEPS );
   }

   function lightTravelDistanceGly( z )
   {
      // Light-travel (lookback) distance = c * lookback time. With c = 1
      // light-year per year, one Gyr of lookback is one Gly of distance.
      return lookbackGyr( z );
   }

   function comovingMpc( z )
   {
      // Line-of-sight comoving distance Dc = (c/H0) * integral_0^z dz'/E(z').
      if ( !( z > 0 ) )
         return 0;
      var integrand = function( zp )
      {
         return 1/eOfZ( zp );
      };
      return HUBBLE_DIST_MPC*simpson( integrand, 0, z, STEPS );
   }

   function comovingGly( z )
   {
      // Convenience: comoving distance in Gly (1 Mpc = 3.2616156e-3 Gly).
      return comovingMpc( z )*3.2615637e-3;
   }

   function hubbleTimeGyr()
   {
      return HUBBLE_TIME_GYR;
   }

   // Age landmarks (Gyr ago) with short human strings, most dramatic first.
   var HOOKS = [
      { gyr: 13.3, en: "from the cosmic dawn, before most galaxies had formed",
                   fr: "de l'aube cosmique, avant la plupart des galaxies" },
      { gyr: 4.6,  en: "before the Sun existed",
                   fr: "avant que le Soleil n'existe" },
      { gyr: 4.54, en: "before the Earth formed",
                   fr: "avant la formation de la Terre" },
      { gyr: 2.0,  en: "before complex life appeared on Earth",
                   fr: "avant l'apparition de la vie complexe sur Terre" },
      { gyr: 0.541, en: "before the Cambrian explosion",
                    fr: "avant l'explosion cambrienne" }
   ];

   function factHooks( z )
   {
      // Every landmark the object's light predates, most dramatic first.
      var t = lookbackGyr( z );
      var out = [];
      for ( var i = 0; i < HOOKS.length; ++i )
         if ( t >= HOOKS[ i ].gyr )
            out.push( { gyr: HOOKS[ i ].gyr, en: HOOKS[ i ].en, fr: HOOKS[ i ].fr } );
      return out;
   }

   return {
      H0: H0,
      OMEGA_M: OMEGA_M,
      OMEGA_L: OMEGA_L,
      eOfZ: eOfZ,
      lookbackGyr: lookbackGyr,
      lightTravelDistanceGly: lightTravelDistanceGly,
      comovingMpc: comovingMpc,
      comovingGly: comovingGly,
      hubbleTimeGyr: hubbleTimeGyr,
      factHooks: factHooks
   };
} )();
