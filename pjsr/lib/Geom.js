// SPDX-License-Identifier: GPL-3.0-only
/*
 * Geom.js — SIGeom: shared spherical geometry and coordinate parsing.
 *
 * One home for the math that several libraries used to carry their own
 * copy of: great-circle separation, position angle, gnomonic (TAN)
 * projection both ways and the sexagesimal parser. Angles are degrees in
 * and out; RA/Dec arguments are plain numbers so the callers with
 * { raDeg, decDeg } objects unwrap them. Pure JS, no PixInsight types —
 * runs under plain Node for testing. No dependency on any other library.
 */

var SIGeom = ( function()
{
   var DEG2RAD = Math.PI/180;
   var RAD2DEG = 180/Math.PI;

   function unitVector( raDeg, decDeg )
   {
      var ra = raDeg*DEG2RAD, dec = decDeg*DEG2RAD;
      return [ Math.cos( dec )*Math.cos( ra ),
               Math.cos( dec )*Math.sin( ra ),
               Math.sin( dec ) ];
   }

   // ------------------------------------------------------------------------
   // Great-circle separation

   function angularSepDeg( ra1, dec1, ra2, dec2 )
   {
      // Haversine form, stable at small angles (this is the form the
      // matching engine has always used: every trail/crossing gate feeds
      // on it).
      var r1 = ra1*DEG2RAD, d1 = dec1*DEG2RAD;
      var r2 = ra2*DEG2RAD, d2 = dec2*DEG2RAD;
      var sd = Math.sin( ( d2 - d1 )/2 );
      var sr = Math.sin( ( r2 - r1 )/2 );
      var h = sd*sd + Math.cos( d1 )*Math.cos( d2 )*sr*sr;
      return 2*Math.asin( Math.min( 1, Math.sqrt( h ) ) )*RAD2DEG;
   }

   function angularSepDotDeg( ra1, dec1, ra2, dec2 )
   {
      // Dot-product / arccos form. Kept ONLY for the slow-mover tracker
      // (SIMeteors), whose arcsecond-scale gates were tuned on it: at 1
      // arcsec it differs from the haversine form by up to ~2e-5 arcsec,
      // which is above the tolerance a behaviour-preserving swap allows.
      // New code must use angularSepDeg.
      var a = unitVector( ra1, dec1 ), b = unitVector( ra2, dec2 );
      var d = a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
      return Math.acos( Math.max( -1, Math.min( 1, d ) ) )/DEG2RAD;
   }

   // ------------------------------------------------------------------------
   // Position angle of point 2 as seen from point 1, east of north

   function positionAngleRawDeg( ra1, dec1, ra2, dec2 )
   {
      // atan2 result as is: (-180, 180]. The two public normalizations
      // below are applied directly to this value, so neither pays a
      // 360-degree round trip that could move the last bits.
      var r1 = ra1*DEG2RAD, d1 = dec1*DEG2RAD;
      var r2 = ra2*DEG2RAD, d2 = dec2*DEG2RAD;
      var dra = r2 - r1;
      var y = Math.sin( dra )*Math.cos( d2 );
      var x = Math.cos( d1 )*Math.sin( d2 ) - Math.sin( d1 )*Math.cos( d2 )*Math.cos( dra );
      return Math.atan2( y, x )*RAD2DEG;
   }

   function positionAngleDeg( ra1, dec1, ra2, dec2 )
   {
      // [0, 360)
      var pa = positionAngleRawDeg( ra1, dec1, ra2, dec2 );
      if ( pa < 0 )
         pa += 360;
      return pa;
   }

   function positionAngleSignedDeg( ra1, dec1, ra2, dec2 )
   {
      // (-180, 180]
      var pa = positionAngleRawDeg( ra1, dec1, ra2, dec2 );
      if ( pa <= -180 ) pa += 360;
      if ( pa > 180 ) pa -= 360;
      return pa;
   }

   // ------------------------------------------------------------------------
   // Gnomonic (TAN) projection. tan = { crval1, crval2, crpix1, crpix2,
   // cd11, cd12, cd21, cd22 } in degrees with a FITS 1-based reference
   // pixel; x, y are 0-based image pixels (FITS pixel = image pixel + 1).

   function tanImageToCelestial( tan, x, y )
   {
      // Deprojection: pixel -> { raDeg, decDeg }, RA normalized to [0, 360).
      var dp1 = ( x + 1 ) - tan.crpix1;
      var dp2 = ( y + 1 ) - tan.crpix2;
      var xi = ( tan.cd11*dp1 + tan.cd12*dp2 )*DEG2RAD;
      var eta = ( tan.cd21*dp1 + tan.cd22*dp2 )*DEG2RAD;
      var ra0 = tan.crval1*DEG2RAD, dec0 = tan.crval2*DEG2RAD;
      var sinD0 = Math.sin( dec0 ), cosD0 = Math.cos( dec0 );
      var denom = Math.sqrt( 1 + xi*xi + eta*eta );
      var dec = Math.asin( ( sinD0 + eta*cosD0 )/denom );
      var ra = ra0 + Math.atan2( xi, cosD0 - eta*sinD0 );
      var raDeg = ra*RAD2DEG;
      raDeg -= 360*Math.floor( raDeg/360 );
      return { raDeg: raDeg, decDeg: dec*RAD2DEG };
   }

   function tanCelestialToImage( tan, raDeg, decDeg )
   {
      // Forward projection + inverse CD matrix: sky -> { x, y } in 0-based
      // image pixels, or null (singular matrix, point behind the tangent
      // plane).
      var ra0 = tan.crval1*DEG2RAD;
      var dec0 = tan.crval2*DEG2RAD;
      var ra = raDeg*DEG2RAD;
      var dec = decDeg*DEG2RAD;
      var dRA = ra - ra0;
      var sinD0 = Math.sin( dec0 ), cosD0 = Math.cos( dec0 );
      var sinD = Math.sin( dec ), cosD = Math.cos( dec );

      var D = sinD*sinD0 + cosD*cosD0*Math.cos( dRA );
      if ( D <= 0 )
         return null; // more than 90 degrees from the tangent point

      var xi = ( cosD*Math.sin( dRA )/D )/DEG2RAD;                       // degrees
      var eta = ( ( sinD*cosD0 - cosD*sinD0*Math.cos( dRA ) )/D )/DEG2RAD;

      var det = tan.cd11*tan.cd22 - tan.cd12*tan.cd21;
      if ( det === 0 )
         return null;
      var dp1 = ( tan.cd22*xi - tan.cd12*eta )/det;
      var dp2 = ( tan.cd11*eta - tan.cd21*xi )/det;
      return { x: tan.crpix1 + dp1 - 1, y: tan.crpix2 + dp2 - 1 };
   }

   // ------------------------------------------------------------------------
   // Sexagesimal parsing

   function parseSexagesimal( s )
   {
      // "48 51 24", "-12 30 00", "12:34:56.7", "+48.85", "20 30.5" — returns
      // a value in the unit of the leading field, or null. The sign is read
      // from the string (parseFloat alone loses the sign of "-0 30 00").
      if ( s === null || s === undefined )
         return null;
      var str = String( s ).trim();
      if ( str.length === 0 )
         return null;
      var neg = false;
      var c0 = str.charAt( 0 );
      if ( c0 === '+' || c0 === '-' )
      {
         neg = ( c0 === '-' );
         str = str.substring( 1 ).trim();
      }
      var parts = str.split( /[\s:]+/ );
      if ( parts.length < 1 || parts.length > 3 )
         return null;
      var value = 0;
      var scale = 1;
      for ( var i = 0; i < parts.length; ++i )
      {
         if ( parts[i].length === 0 )
            return null;
         var f = Number( parts[i] );
         if ( !isFinite( f ) || f < 0 )
            return null;
         value += f*scale;
         scale /= 60;
      }
      return neg ? -value : value;
   }

   return {
      angularSepDeg: angularSepDeg,
      angularSepDotDeg: angularSepDotDeg,
      unitVector: unitVector,
      positionAngleDeg: positionAngleDeg,
      positionAngleSignedDeg: positionAngleSignedDeg,
      tanImageToCelestial: tanImageToCelestial,
      tanCelestialToImage: tanCelestialToImage,
      parseSexagesimal: parseSexagesimal
   };
} )();
