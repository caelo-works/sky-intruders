/*
 * SatMatch.js — SISatMatch: pure-JS orbital matching engine.
 *
 * Port of the Go sidecar "match" command (sidecar/astro.go, match.go,
 * tle.go — the certified reference). SGP4 propagation comes from the
 * vendored satellite.js (satellite-js 5.0.0 UMD, global `satellite`);
 * everything else — TLE validation, Meeus sun direction, cylindrical
 * Earth-shadow test, WGS84 geodetic observer ECI, topocentric directions,
 * gnomonic FOV test, crossing scan and score-ordered trail assignment —
 * is self-contained here. Request and response shapes are inherited
 * verbatim from the Go engine (docs/ARCHITECTURE.md, matching contracts):
 * match() returns either a full response with error: null, or a bare
 * { error: "..." } object; it never throws on bad catalog or request data.
 *
 * Two deliberate departures from the Go reference (its simplifications
 * stacked up to ~0.35-0.9 deg of cross-track error, larger than the
 * default match gate): topocentric directions are rotated from TEME of
 * date to J2000 (IAU76 precession + main nutation terms + equation of
 * the equinoxes) before they are compared with the plate-solved J2000
 * WCS, and the observer sits on the WGS84 ellipsoid at its geodetic
 * latitude instead of on a sphere at geocentric latitude. Validated
 * on-sky: 0.009 deg cross-track residual against an observed trail,
 * vs 0.351 deg with the old spherical-observer TEME model.
 */

var SISatMatch = ( function()
{
   var DEG2RAD = Math.PI/180;
   var RAD2DEG = 180/Math.PI;
   var TWO_PI = 2*Math.PI;
   var EARTH_RADIUS = 6378.137;     // km, WGS84 equatorial (semi-major axis)
   var EARTH_F = 1/298.257223563;   // WGS84 flattening
   var EARTH_E2 = EARTH_F*( 2 - EARTH_F ); // first eccentricity squared
   var EARTH_OMEGA = 7.29211585e-5; // rad per second, Earth rotation rate
   var JD_UNIX_EPOCH = 2440587.5;   // Julian date of 1970-01-01T00:00:00Z
   var MS_PER_DAY = 86400000;

   // ------------------------------------------------------------------------
   // SGP4 library resolver: the vendored satellite.js defines the global
   // `satellite` (PixInsight and browser alike); a test harness may inject
   // its own instance through useSgp4().

   var sgp4Lib = null;

   function resolveSgp4()
   {
      if ( sgp4Lib !== null )
         return sgp4Lib;
      if ( typeof satellite != "undefined" )
         return satellite;
      throw new Error( "SISatMatch: SGP4 library (satellite.js) is not loaded" );
   }

   // ------------------------------------------------------------------------
   // Time: UTC instants are carried as milliseconds since the Unix epoch in
   // a double (sub-microsecond resolution — RFC3339 fractional seconds from
   // the request survive intact, matching the Go engine's nanosecond times).

   var RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

   function parseRfc3339Ms( s )
   {
      // Same surface as Go time.Parse(time.RFC3339): "T" separator, "Z" or
      // a numeric offset, optional fractional seconds. Returns null when
      // unparsable.
      if ( typeof s != "string" )
         return null;
      var m = RFC3339_RE.exec( s );
      if ( m === null )
         return null;
      var year = parseInt( m[1], 10 );
      var mon = parseInt( m[2], 10 );
      var day = parseInt( m[3], 10 );
      var hr = parseInt( m[4], 10 );
      var min = parseInt( m[5], 10 );
      var sec = parseInt( m[6], 10 );
      if ( mon < 1 || mon > 12 || day < 1 || day > 31 ||
           hr > 23 || min > 59 || sec > 59 )
         return null;
      var ms = Date.UTC( year, mon - 1, day, hr, min, sec );
      if ( m[7] )
         ms += parseFloat( "0" + m[7] )*1000;
      if ( m[8] !== "Z" )
      {
         var sign = ( m[8].charAt( 0 ) === '-' ) ? -1 : 1;
         var oh = parseInt( m[8].substring( 1, 3 ), 10 );
         var om = parseInt( m[8].substring( 4, 6 ), 10 );
         ms -= sign*( oh*60 + om )*60000;
      }
      return ms;
   }

   function formatRfc3339Ms( ms )
   {
      // Go time.Format(time.RFC3339) on a UTC time: fractional seconds are
      // dropped (floor), suffix "Z".
      var d = new Date( Math.floor( ms/1000 )*1000 );
      return d.toISOString().substring( 0, 19 ) + "Z";
   }

   function jdayOfMs( ms )
   {
      // Julian date (UT) with sub-second precision. Equivalent to the Go
      // engine's jdayOf (calendar formula + fraction) to within 1 ulp.
      return ms/MS_PER_DAY + JD_UNIX_EPOCH;
   }

   // ------------------------------------------------------------------------
   // Vectors are plain { x, y, z } in km (same shape satellite.js returns).

   function sub3( a, b )
   {
      return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
   }

   function norm3( a )
   {
      return Math.sqrt( a.x*a.x + a.y*a.y + a.z*a.z );
   }

   function dot3( a, b )
   {
      return a.x*b.x + a.y*b.y + a.z*b.z;
   }

   function cross3( a, b )
   {
      return { x: a.y*b.z - a.z*b.y,
               y: a.z*b.x - a.x*b.z,
               z: a.x*b.y - a.y*b.x };
   }

   // ------------------------------------------------------------------------
   // Spherical geometry on RA/Dec directions ({ raDeg, decDeg }, degrees).

   function vecToRaDec( v )
   {
      var ra = Math.atan2( v.y, v.x )*RAD2DEG;
      if ( ra < 0 )
         ra += 360;
      return { raDeg: ra, decDeg: Math.asin( v.z/norm3( v ) )*RAD2DEG };
   }

   function raDecToVec( p )
   {
      var ra = p.raDeg*DEG2RAD, de = p.decDeg*DEG2RAD;
      return { x: Math.cos( de )*Math.cos( ra ),
               y: Math.cos( de )*Math.sin( ra ),
               z: Math.sin( de ) };
   }

   function angularSepDeg( a, b )
   {
      // Great-circle separation, haversine form (stable at small angles).
      var ra1 = a.raDeg*DEG2RAD, de1 = a.decDeg*DEG2RAD;
      var ra2 = b.raDeg*DEG2RAD, de2 = b.decDeg*DEG2RAD;
      var sd = Math.sin( ( de2 - de1 )/2 );
      var sr = Math.sin( ( ra2 - ra1 )/2 );
      var h = sd*sd + Math.cos( de1 )*Math.cos( de2 )*sr*sr;
      return 2*Math.asin( Math.min( 1, Math.sqrt( h ) ) )*RAD2DEG;
   }

   function positionAngleDeg( a, b )
   {
      // Bearing of b as seen from a, east of north, in [0, 360).
      var ra1 = a.raDeg*DEG2RAD, de1 = a.decDeg*DEG2RAD;
      var ra2 = b.raDeg*DEG2RAD, de2 = b.decDeg*DEG2RAD;
      var dra = ra2 - ra1;
      var y = Math.sin( dra )*Math.cos( de2 );
      var x = Math.cos( de1 )*Math.sin( de2 ) - Math.sin( de1 )*Math.cos( de2 )*Math.cos( dra );
      var pa = Math.atan2( y, x )*RAD2DEG;
      if ( pa < 0 )
         pa += 360;
      return pa;
   }

   function orientationDiffDeg( pa1, pa2 )
   {
      // Segment orientations compare modulo 180; result in [0, 90].
      var d = Math.abs( pa1 - pa2 ) % 180;
      if ( d > 90 )
         d = 180 - d;
      return d;
   }

   function midpointRaDec( a, b )
   {
      // Direction halfway along the great circle (unit-vector average;
      // fine for short arcs).
      var av = raDecToVec( a );
      var bv = raDecToVec( b );
      return vecToRaDec( { x: av.x + bv.x, y: av.y + bv.y, z: av.z + bv.z } );
   }

   // ------------------------------------------------------------------------
   // FOV test: rectangle on the gnomonic tangent plane at the FOV center
   // (documented v1 simplification, good for fields up to a few degrees).

   function tangentOffsets( center, p )
   {
      // Gnomonic (TAN) standard coordinates of p, degrees, x toward east
      // (+RA), y toward north (+Dec). ok is false when p is 90 deg or more
      // away (behind the tangent plane).
      var ra0 = center.raDeg*DEG2RAD, de0 = center.decDeg*DEG2RAD;
      var ra = p.raDeg*DEG2RAD, de = p.decDeg*DEG2RAD;
      var dra = ra - ra0;
      var d = Math.sin( de0 )*Math.sin( de ) + Math.cos( de0 )*Math.cos( de )*Math.cos( dra );
      if ( d <= 1e-6 )
         return { x: 0, y: 0, ok: false };
      return {
         x: Math.cos( de )*Math.sin( dra )/d*RAD2DEG,
         y: ( Math.cos( de0 )*Math.sin( de ) - Math.sin( de0 )*Math.cos( de )*Math.cos( dra ) )/d*RAD2DEG,
         ok: true
      };
   }

   function fovContains( fov, p )
   {
      // rotationDeg is the position angle of the frame's +y (height) axis,
      // east of north (WCS-like rotation). When the rotation is unknown
      // (frame not plate-solved: approximate FOV from the pointing header),
      // fall back to the bounding circle — every satellite that could have
      // crossed at ANY rotation is kept, and the ambiguity is resolved
      // later by the field-orientation fit.
      var t = tangentOffsets( { raDeg: fov.raDeg, decDeg: fov.decDeg }, p );
      if ( !t.ok )
         return false;
      if ( fov.rotationDeg === null || fov.rotationDeg === undefined ||
           !isFinite( fov.rotationDeg ) )
      {
         var r2 = ( fov.widthDeg*fov.widthDeg + fov.heightDeg*fov.heightDeg )/4;
         return t.x*t.x + t.y*t.y <= r2;
      }
      var th = fov.rotationDeg*DEG2RAD;
      var fx = t.x*Math.cos( th ) - t.y*Math.sin( th );
      var fy = t.x*Math.sin( th ) + t.y*Math.cos( th );
      return Math.abs( fx ) <= fov.widthDeg/2 && Math.abs( fy ) <= fov.heightDeg/2;
   }

   // ------------------------------------------------------------------------
   // Sun and Earth shadow.

   function sunDirection( jday )
   {
      // Unit vector toward the Sun, true-of-date equatorial frame. Meeus,
      // Astronomical Algorithms ch. 25, low-precision form (~0.01 deg).
      var tj = ( jday - 2451545.0 )/36525.0;
      var l0 = ( ( 280.46646 + 36000.76983*tj ) % 360 )*DEG2RAD; // mean longitude
      var m = ( ( 357.52911 + 35999.05029*tj ) % 360 )*DEG2RAD;  // mean anomaly
      var c = ( 1.914602 - 0.004817*tj )*Math.sin( m ) +
              0.019993*Math.sin( 2*m ) +
              0.000289*Math.sin( 3*m );                          // equation of center, deg
      var lam = l0 + c*DEG2RAD;                                  // true ecliptic longitude
      var eps = ( 23.4392911 - 0.0130042*tj )*DEG2RAD;           // mean obliquity
      return { x: Math.cos( lam ),
               y: Math.cos( eps )*Math.sin( lam ),
               z: Math.sin( eps )*Math.sin( lam ) };
   }

   function isSunlit( r, sunDir )
   {
      // Cylindrical Earth-shadow model: eclipsed iff on the night side and
      // within one Earth radius of the shadow axis. Penumbra ignored.
      var along = dot3( r, sunDir );
      if ( along >= 0 )
         return true;
      var perp2 = dot3( r, r ) - along*along;
      return perp2 > EARTH_RADIUS*EARTH_RADIUS;
   }

   // ------------------------------------------------------------------------
   // TEME -> J2000 frame rotation. SGP4 states are TEME of date, while the
   // plate-solved WCS the crossings are compared with is J2000; skipping
   // the rotation displaces every prediction by the accumulated precession
   // since J2000 (~50 arcsec per year — ~0.35 deg by 2026, more than the
   // default match gate). The rotation is
   //    r_J2000 = Pt * Nt * Rz(-eqeq) * r_TEME
   // with P the IAU76 precession matrix (J2000 -> mean of date; zeta, z,
   // theta polynomials), N the nutation matrix (mean -> true of date, main
   // terms of the IAU 1980 series), eqeq = dpsi*cos(epsBar) the equation
   // of the equinoxes, and Pt, Nt the transposes. Truncating the nutation
   // series costs a few arcseconds — three orders of magnitude below the
   // match gates.

   function mat3T( m )
   {
      return [ [ m[0][0], m[1][0], m[2][0] ],
               [ m[0][1], m[1][1], m[2][1] ],
               [ m[0][2], m[1][2], m[2][2] ] ];
   }

   function mat3Mul( a, b )
   {
      var m = [ [ 0, 0, 0 ], [ 0, 0, 0 ], [ 0, 0, 0 ] ];
      for ( var i = 0; i < 3; ++i )
         for ( var j = 0; j < 3; ++j )
            m[i][j] = a[i][0]*b[0][j] + a[i][1]*b[1][j] + a[i][2]*b[2][j];
      return m;
   }

   function mat3Vec( m, v )
   {
      return { x: m[0][0]*v.x + m[0][1]*v.y + m[0][2]*v.z,
               y: m[1][0]*v.x + m[1][1]*v.y + m[1][2]*v.z,
               z: m[2][0]*v.x + m[2][1]*v.y + m[2][2]*v.z };
   }

   function nutationAngles( jday )
   {
      // Main terms of the IAU 1980 nutation series, radians.
      var tj = ( jday - 2451545.0 )/36525.0;
      var s = DEG2RAD/3600;
      var om = ( 125.04452 - 1934.136261*tj )*DEG2RAD; // lunar ascending node
      var ls = ( 280.4665 + 36000.7698*tj )*DEG2RAD;   // mean solar longitude
      var lm = ( 218.3165 + 481267.8813*tj )*DEG2RAD;  // mean lunar longitude
      return {
         dpsi: ( -17.20*Math.sin( om ) - 1.32*Math.sin( 2*ls )
                 - 0.23*Math.sin( 2*lm ) + 0.21*Math.sin( 2*om ) )*s,
         deps: ( 9.20*Math.cos( om ) + 0.57*Math.cos( 2*ls )
                 + 0.10*Math.cos( 2*lm ) - 0.09*Math.cos( 2*om ) )*s,
         epsBar: ( 23.439291 - 0.0130042*tj )*DEG2RAD  // mean obliquity
      };
   }

   function temeToJ2000Matrix( jday )
   {
      var tj = ( jday - 2451545.0 )/36525.0;
      var s = DEG2RAD/3600;
      // IAU76 precession angles
      var zeta = ( 2306.2181 + ( 0.30188 + 0.017998*tj )*tj )*tj*s;
      var z = ( 2306.2181 + ( 1.09468 + 0.018203*tj )*tj )*tj*s;
      var th = ( 2004.3109 - ( 0.42665 + 0.041833*tj )*tj )*tj*s;
      var cz = Math.cos( zeta ), sz = Math.sin( zeta );
      var cZ = Math.cos( z ), sZ = Math.sin( z );
      var ct = Math.cos( th ), st = Math.sin( th );
      // P = Rz(-z) Ry(theta) Rz(-zeta), J2000 -> mean of date
      var P = [ [ cZ*ct*cz - sZ*sz, -cZ*ct*sz - sZ*cz, -cZ*st ],
                [ sZ*ct*cz + cZ*sz, -sZ*ct*sz + cZ*cz, -sZ*st ],
                [ st*cz,            -st*sz,             ct    ] ];
      var nut = nutationAngles( jday );
      var eps = nut.epsBar + nut.deps;
      var cp = Math.cos( nut.dpsi ), sp = Math.sin( nut.dpsi );
      var ce = Math.cos( nut.epsBar ), se = Math.sin( nut.epsBar );
      var cE = Math.cos( eps ), sE = Math.sin( eps );
      // N = Rx(-eps) Rz(-dpsi) Rx(epsBar), mean -> true of date
      var N = [ [ cp,    -sp*ce,            -sp*se            ],
                [ cE*sp,  cE*cp*ce + sE*se,  cE*cp*se - sE*ce ],
                [ sE*sp,  sE*cp*ce - cE*se,  sE*cp*se + cE*ce ] ];
      // TEME -> true of date: rotate by minus the equation of the equinoxes
      var q = nut.dpsi*Math.cos( nut.epsBar );
      var cq = Math.cos( q ), sq = Math.sin( q );
      var R = [ [ cq, -sq, 0 ], [ sq, cq, 0 ], [ 0, 0, 1 ] ];
      return mat3Mul( mat3T( P ), mat3Mul( mat3T( N ), R ) );
   }

   // One-entry cache: the matrix drifts by well under 0.01 arcsec over 15
   // minutes, so one matrix serves every sample of an exposure. Without it
   // the trig above would run once per 1 s fine-scan sample per satellite
   // — the hot path over a 16k-record catalog.
   var temeMatJday = null;
   var temeMat = null;

   function temeToJ2000( v, jday )
   {
      // Recomputation is the fail-open path: a non-finite jday never passes
      // the <= test, so it cannot poison the cache for later valid calls.
      if ( temeMatJday === null || !( Math.abs( jday - temeMatJday ) <= 0.01 ) )
      {
         temeMat = temeToJ2000Matrix( jday );
         temeMatJday = jday;
      }
      return mat3Vec( temeMat, v );
   }

   // ------------------------------------------------------------------------
   // Observer and look angles. gmstRad ports go-satellite's ThetaG_JD (1992
   // Astronomical Almanac); the observer itself is WGS84 geodetic, NOT the
   // Go reference's spherical-geocentric model, whose misplacement (23.7 km
   // at latitude 43.6 deg) leaks 0.2-2 deg into topocentric directions at
   // LEO ranges — far beyond the matching tolerance budget.

   function gmstRad( jday )
   {
      // Greenwich mean sidereal time, radians.
      var ut = ( jday + 0.5 ) - Math.floor( jday + 0.5 );
      var jd0 = jday - ut;
      var tu = ( jd0 - 2451545.0 )/36525.0;
      var gmst = 24110.54841 + tu*( 8640184.812866 + tu*( 0.093104 - tu*6.2e-6 ) );
      gmst = ( gmst + 86400.0*1.00273790934*ut ) % 86400.0;
      return TWO_PI*gmst/86400.0;
   }

   function llaToEci( latRad, lonRad, altKm, jday )
   {
      // WGS84 geodetic coordinates -> ECI position in the true-equator
      // frame rotated by GMST (TEME-compatible, so satellite-minus-observer
      // differencing stays frame-consistent). N is the prime-vertical
      // radius of curvature of the ellipsoid.
      var theta = ( gmstRad( jday ) + lonRad ) % TWO_PI;
      var sinLat = Math.sin( latRad );
      var N = EARTH_RADIUS/Math.sqrt( 1 - EARTH_E2*sinLat*sinLat );
      var r = ( N + altKm )*Math.cos( latRad );
      return { x: r*Math.cos( theta ),
               y: r*Math.sin( theta ),
               z: ( N*( 1 - EARTH_E2 ) + altKm )*sinLat };
   }

   function observerEci( obs, jday )
   {
      // Observer position (km) and velocity (km per second) in TEME, from
      // WGS84 geodetic latitude/longitude/altitude. (The Go reference used
      // a spherical-geocentric observer, misplaced by up to ~24 km at
      // mid-latitudes — 0.2-2 deg of topocentric error at LEO ranges.)
      var pos = llaToEci( obs.latDeg*DEG2RAD, obs.lonDeg*DEG2RAD, obs.altM/1000, jday );
      var vel = { x: -EARTH_OMEGA*pos.y, y: EARTH_OMEGA*pos.x, z: 0 };
      return { pos: pos, vel: vel };
   }

   function topocentricRaDec( satPos, obsPos, jday )
   {
      // Topocentric equatorial direction in J2000: satellite TEME position
      // minus observer ECI position, rotated TEME -> J2000 so the result
      // can be compared with plate-solved WCS coordinates. Every sky-facing
      // direction the pipeline produces flows through here.
      return vecToRaDec( temeToJ2000( sub3( satPos, obsPos ), jday ) );
   }

   function elevationDeg( satPos, obs, jday )
   {
      // Elevation above the observer's horizon (SEZ transform).
      var latRad = obs.latDeg*DEG2RAD;
      var theta = ( gmstRad( jday ) + obs.lonDeg*DEG2RAD ) % TWO_PI;
      var obsPos = llaToEci( latRad, obs.lonDeg*DEG2RAD, obs.altM/1000, jday );
      var rx = satPos.x - obsPos.x;
      var ry = satPos.y - obsPos.y;
      var rz = satPos.z - obsPos.z;
      var topZ = Math.cos( latRad )*Math.cos( theta )*rx +
                 Math.cos( latRad )*Math.sin( theta )*ry +
                 Math.sin( latRad )*rz;
      var rg = Math.sqrt( rx*rx + ry*ry + rz*rz );
      return Math.asin( topZ/rg )*RAD2DEG;
   }

   // ------------------------------------------------------------------------
   // TLE parsing and validation (port of tle.go). The validation mirrors,
   // field by field, the substrings the SGP4 code will parse, so a record
   // that passes can never blow up the propagator; bad records (including
   // Alpha-5 satnums and HTML error pages) are silently skipped.

   function trimRightWs( s )
   {
      return s.replace( /[ \t\r]+$/, "" );
   }

   function intOK( s )
   {
      // Same acceptance as Go strconv.ParseInt(s, 10, 64): optional sign,
      // decimal digits, nothing else.
      return /^[+-]?\d+$/.test( s );
   }

   function floatOK( s )
   {
      // Decimal grammar of Go strconv.ParseFloat: optional sign, digits
      // with optional dot (or leading dot), optional exponent. (Go also
      // accepts inf, nan and hex floats — irrelevant to TLE fields.)
      return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test( s );
   }

   function stripSpaces2( s )
   {
      // Go strings.Replace(s, " ", "", 2): remove at most two spaces.
      return s.replace( " ", "" ).replace( " ", "" );
   }

   function validTlePair( l1, l2 )
   {
      if ( l1.length < 69 || l2.length < 69 )
         return false;
      if ( l1.charAt( 0 ) !== '1' || l2.charAt( 0 ) !== '2' )
         return false;
      if ( l1.substring( 2, 7 ).trim() !== l2.substring( 2, 7 ).trim() )
         return false;
      if ( !intOK( l1.substring( 2, 7 ).trim() ) ) // rejects Alpha-5 satnums
         return false;
      // line 1 numeric fields, exactly as the SGP4 parser slices them
      if ( !intOK( l1.substring( 18, 20 ) ) ||
           !floatOK( l1.substring( 20, 32 ) ) ||
           !floatOK( stripSpaces2( l1.substring( 33, 43 ) ) ) ||
           !floatOK( stripSpaces2( l1.substring( 44, 45 ) + "." + l1.substring( 45, 50 ) + "e" + l1.substring( 50, 52 ) ) ) ||
           !floatOK( stripSpaces2( l1.substring( 53, 54 ) + "." + l1.substring( 54, 59 ) + "e" + l1.substring( 59, 61 ) ) ) )
         return false;
      // line 2 numeric fields
      if ( !floatOK( stripSpaces2( l2.substring( 8, 16 ) ) ) ||
           !floatOK( stripSpaces2( l2.substring( 17, 25 ) ) ) ||
           !floatOK( "." + l2.substring( 26, 33 ) ) ||
           !floatOK( stripSpaces2( l2.substring( 34, 42 ) ) ) ||
           !floatOK( stripSpaces2( l2.substring( 43, 51 ) ) ) ||
           !floatOK( stripSpaces2( l2.substring( 52, 63 ) ) ) )
         return false;
      return true;
   }

   function intlDesignator( l1 )
   {
      // COSPAR field of line 1 ("98067A  ") formatted as "1998-067A".
      // Years 57-99 are 19xx, 00-56 are 20xx (TLE convention).
      var raw = l1.substring( 9, 17 );
      var yy = raw.substring( 0, 2 ).trim();
      var launch = raw.substring( 2, 5 ).trim();
      var piece = raw.substring( 5 ).trim();
      if ( yy === "" || launch === "" )
         return "";
      if ( !intOK( yy ) )
         return "";
      var y = parseInt( yy, 10 );
      y += ( y < 57 ) ? 2000 : 1900;
      return y + "-" + launch + piece;
   }

   function parseTles( text )
   {
      var lines = String( text ).replace( /\r\n/g, "\n" ).split( "\n" );
      var out = [];
      var name = "";
      for ( var i = 0; i < lines.length; ++i )
      {
         var l = trimRightWs( lines[i] );
         if ( l.substring( 0, 2 ) === "1 " && i + 1 < lines.length )
         {
            var l2 = trimRightWs( lines[i + 1] );
            if ( validTlePair( l, l2 ) )
            {
               out.push( {
                  name: name,
                  noradId: parseInt( l.substring( 2, 7 ).trim(), 10 ),
                  intlDes: intlDesignator( l ),
                  line1: l,
                  line2: l2
               } );
               name = "";
               ++i; // consume line 2
               continue;
            }
         }
         var t = l.trim();
         if ( t !== "" )
            name = t;
      }
      return out;
   }

   // ------------------------------------------------------------------------
   // Propagation. satellite.js parses the TLE epoch at full precision
   // (unlike go-satellite, whose truncation the Go engine had to cancel),
   // and sgp4() accepts a fractional minute offset directly — so no epoch
   // correction and no integer-second interpolation are needed here.

   function newSatEntry( t )
   {
      // twoline2satrec initializes with WGS72 constants — the standard
      // gravity model for TLE mean elements.
      return { tle: t, rec: resolveSgp4().twoline2satrec( t.line1, t.line2 ) };
   }

   function plausibleState( p )
   {
      // Guards against decayed or degenerate records: sgp4 may flag an
      // error, and even unflagged garbage must never poison the matching.
      var n = norm3( p );
      return isFinite( n ) && n > 6400 && n < 500000;
   }

   function propagateAt( e, tMs )
   {
      // TEME position (km) and velocity (km per second) at tMs, or null on
      // a non-physical state.
      var tsinceMin = ( jdayOfMs( tMs ) - e.rec.jdsatepoch )*1440.0;
      var pv = resolveSgp4().sgp4( e.rec, tsinceMin );
      if ( !pv || !pv.position || !pv.velocity )
         return null;
      if ( !plausibleState( pv.position ) )
         return null;
      return { pos: pv.position, vel: pv.velocity };
   }

   // ------------------------------------------------------------------------
   // Matching pipeline (port of match.go).

   function normalizedOptions( o )
   {
      o = o || {};
      return {
         stepSec: ( o.stepSec > 0 ) ? o.stepSec : 1.0,
         matchMaxSepDeg: ( o.matchMaxSepDeg > 0 ) ? o.matchMaxSepDeg : 0.2,
         alongTolDeg: ( o.alongTolDeg > 0 ) ? o.alongTolDeg : 0.6,
         matchMaxAngleDiffDeg: ( o.matchMaxAngleDiffDeg > 0 ) ? o.matchMaxAngleDiffDeg : 12
      };
   }

   function coarseCandidate( e, fr, obs, opt, startMs )
   {
      // Sample the window at start, middle and end: keep the satellite if
      // ANY sample makes the FOV plausibly reachable within the exposure.
      // A single midpoint sample is not enough for a fast, low crossing:
      // an object that cuts the field in the first seconds of a long
      // exposure can be tens of degrees away — with a grossly
      // underestimated angular rate — by mid-exposure, and gets culled
      // before the fine sampler ever sees it.
      var halfDiag = 0.5*Math.sqrt( fr.fov.widthDeg*fr.fov.widthDeg + fr.fov.heightDeg*fr.fov.heightDeg );
      var tSamples = [ startMs,
                       startMs + fr.exposureSec/2*1000,
                       startMs + fr.exposureSec*1000 ];
      for ( var s = 0; s < tSamples.length; ++s )
      {
         var pv = propagateAt( e, tSamples[ s ] );
         if ( pv === null )
            continue;
         var jd = jdayOfMs( tSamples[ s ] );
         var o = observerEci( obs, jd );
         var rho = sub3( pv.pos, o.pos );
         var rhoDot = sub3( pv.vel, o.vel );
         var rhoLen = norm3( rho );
         if ( rhoLen === 0 )
            continue;
         // topocentric angular rate: |rho x rhodot| over |rho| squared;
         // from any sample the object can move rate x the full exposure
         // within the window, so that is the reach budget.
         var rateDeg = norm3( cross3( rho, rhoDot ) )/( rhoLen*rhoLen )*RAD2DEG;
         var reachDeg = rateDeg*fr.exposureSec;

         // below the horizon beyond reach at this sample -> try the others
         // (2 deg slack on top, so risers and setters at the edge are kept)
         var el = elevationDeg( pv.pos, obs, jd );
         if ( el < -( reachDeg + 2 ) )
            continue;

         var sep = angularSepDeg( topocentricRaDec( pv.pos, o.pos, jd ),
                                  { raDeg: fr.fov.raDeg, decDeg: fr.fov.decDeg } );
         if ( sep <= halfDiag + reachDeg + opt.matchMaxSepDeg )
            return true;
      }
      return false;
   }

   function fineCrossings( e, fr, obs, opt, startMs )
   {
      // Step through the exposure window; every contiguous in-FOV (and
      // above-horizon) run becomes a crossing.
      var nSteps = Math.ceil( fr.exposureSec/opt.stepSec ) + 1;
      var samples = [];
      for ( var i = 0; i < nSteps; ++i )
      {
         var dt = Math.min( i*opt.stepSec, fr.exposureSec );
         var t = startMs + dt*1000;
         var pv = propagateAt( e, t );
         if ( pv === null )
            return [];
         var jd = jdayOfMs( t );
         var o = observerEci( obs, jd );
         var dir = topocentricRaDec( pv.pos, o.pos, jd );
         var inFov = fovContains( fr.fov, dir ) && elevationDeg( pv.pos, obs, jd ) > 0;
         samples.push( { tMs: t, dir: dir, inFov: inFov } );
      }

      var out = [];
      for ( var i = 0; i < samples.length; )
      {
         if ( !samples[i].inFov )
         {
            ++i;
            continue;
         }
         var j = i;
         while ( j + 1 < samples.length && samples[j + 1].inFov )
            ++j;
         var entry = samples[i], exit = samples[j];

         // mean angular rate over the run; single-sample runs fall back to
         // the instantaneous rate over one step
         var rate = 0;
         var dur = ( exit.tMs - entry.tMs )/1000;
         if ( dur > 0 )
            rate = angularSepDeg( entry.dir, exit.dir )/dur;
         else
         {
            var tn = entry.tMs + opt.stepSec*1000;
            var pvn = propagateAt( e, tn );
            if ( pvn !== null )
            {
               var jdn = jdayOfMs( tn );
               var on = observerEci( obs, jdn );
               rate = angularSepDeg( entry.dir, topocentricRaDec( pvn.pos, on.pos, jdn ) )/opt.stepSec;
            }
         }

         var tMid = entry.tMs + ( exit.tMs - entry.tMs )/2;
         var jdMid = jdayOfMs( tMid );
         var pvMid = propagateAt( e, tMid );
         if ( pvMid === null )
         {
            i = j + 1;
            continue;
         }
         var oMid = observerEci( obs, jdMid );
         out.push( {
            noradId: e.tle.noradId,
            name: e.tle.name,
            intlDes: e.tle.intlDes,
            entryUtc: formatRfc3339Ms( entry.tMs ),
            exitUtc: formatRfc3339Ms( exit.tMs ),
            path: { p1: entry.dir, p2: exit.dir },
            angularRateDegPerSec: rate,
            rangeKm: norm3( sub3( pvMid.pos, oMid.pos ) ),
            elevationDeg: elevationDeg( pvMid.pos, obs, jdMid ),
            sunlit: isSunlit( pvMid.pos, sunDirection( jdMid ) ),
            matchedTrailIndex: null
         } );
         i = j + 1;
      }
      return out;
   }

   function crossAlongDeg( cMid, cPA, tMid )
   {
      // Offset of a trail midpoint from a crossing midpoint, decomposed
      // against the crossing's track direction: cross-track (sideways) and
      // along-track (early or late on the ephemeris) components, degrees.
      // Planar split of the great-circle separation — exact enough at the
      // sub-degree gates it feeds. Mirrors assignTrailsLoose.
      var sep = angularSepDeg( cMid, tMid );
      var rel = ( positionAngleDeg( cMid, tMid ) - cPA )*DEG2RAD;
      return { sep: sep,
               cross: Math.abs( sep*Math.sin( rel ) ),
               along: Math.abs( sep*Math.cos( rel ) ) };
   }

   function assignTrails( crossings, fr, opt )
   {
      // Candidates: sunlit crossings vs trails with sky coordinates. The
      // midpoint offset is decomposed against the predicted track
      // (crossAlongDeg): TLE error is dominantly ALONG-track — ordinary
      // epoch staleness makes the satellite run early or late on an
      // otherwise accurate ground track — so the gate is tight sideways
      // (cross-track within matchMaxSepDeg) and looser lengthwise
      // (along-track within alongTolDeg); orientation must agree within
      // matchMaxAngleDiffDeg (mod 180). Score blends cross-track (0.4),
      // orientation (0.3), path-length agreement (0.2) and along-track
      // (0.1), each normalized to [0,1] by its own gate — the geometry
      // that discriminates hardest carries the most weight. Conflicts are
      // resolved globally by score order: each trail and each crossing is
      // used at most once.
      var alongTol = ( opt.alongTolDeg > 0 ) ? opt.alongTolDeg : 0.6;
      var trails = fr.trails || [];
      var cands = [];
      for ( var ci = 0; ci < crossings.length; ++ci )
      {
         var c = crossings[ci];
         if ( !c.sunlit )
            continue; // eclipsed crossers explain nothing visible
         var cPA = positionAngleDeg( c.path.p1, c.path.p2 );
         var cMid = midpointRaDec( c.path.p1, c.path.p2 );
         var cLen = angularSepDeg( c.path.p1, c.path.p2 );
         for ( var ti = 0; ti < trails.length; ++ti )
         {
            var tr = trails[ti];
            if ( !tr.p1 || !tr.p2 )
               continue;
            var ad = orientationDiffDeg( cPA, positionAngleDeg( tr.p1, tr.p2 ) );
            if ( ad > opt.matchMaxAngleDiffDeg )
               continue;
            var off = crossAlongDeg( cMid, cPA, midpointRaDec( tr.p1, tr.p2 ) );
            if ( off.cross > opt.matchMaxSepDeg || off.along > alongTol )
               continue;
            // rate agreement compared as path lengths over the same window
            var tLen = angularSepDeg( tr.p1, tr.p2 );
            var rateScore = 0;
            var mx = Math.max( cLen, tLen );
            if ( mx > 0 )
               rateScore = 1 - Math.min( 1, Math.abs( cLen - tLen )/mx );
            var score = 0.4*( 1 - off.cross/opt.matchMaxSepDeg ) +
                        0.3*( 1 - ad/opt.matchMaxAngleDiffDeg ) +
                        0.2*rateScore +
                        0.1*( 1 - off.along/alongTol );
            cands.push( { ci: ci, ti: ti, score: score, sep: off.sep, ad: ad } );
         }
      }
      cands.sort( function( a, b ) { return b.score - a.score; } );

      var usedCross = {};
      var usedTrail = {};
      for ( var k = 0; k < cands.length; ++k )
      {
         var cd = cands[k];
         if ( usedCross[cd.ci] || usedTrail[cd.ti] )
            continue;
         usedCross[cd.ci] = true;
         usedTrail[cd.ti] = true;
         crossings[cd.ci].matchedTrailIndex = trails[cd.ti].index;
         crossings[cd.ci].matchScore = cd.score;
         crossings[cd.ci].sepDeg = cd.sep;
         crossings[cd.ci].angleDiffDeg = cd.ad;
      }
   }

   // ------------------------------------------------------------------------
   // Field-orientation fit for frames WITHOUT a plate solution.
   //
   // Inputs: per-frame crossings (from a circular-FOV match pass) and trails
   // in a COMMON pixel grid (registered frames), plus the approximate field
   // center, plate scale and image size. The sky rotation and the parity
   // (mirror flip) of the grid are unknown; everything else is known. Both
   // are recovered by brute force: for each candidate (rotation, parity) a
   // synthetic TAN projection is built, every trail is projected to the sky
   // and scored against the sunlit crossings; the best-scoring orientation
   // wins, then the field-center error is corrected from the median offset
   // of the matched pairs and the fit is refined once around the winner.
   //
   // Returns { tan, rotationDeg, parity, score, pairs } or null when there
   // is nothing to fit (no trails or no sunlit crossings).

   function tanForOrientation( center, pixScaleArcsec, width, height, rotDeg, parity )
   {
      var s = pixScaleArcsec/3600;
      var th = rotDeg*DEG2RAD;
      return { crval1: center.raDeg, crval2: center.decDeg,
               crpix1: ( width + 1 )/2, crpix2: ( height + 1 )/2,
               cd11: parity*s*Math.cos( th ), cd12: -s*Math.sin( th ),
               cd21: parity*s*Math.sin( th ), cd22: s*Math.cos( th ) };
   }

   function tanProject( tan, x, y )
   {
      // Gnomonic deprojection, 0-based pixels (mirror of FrameMeta's math,
      // local so SatMatch stays self-contained under Node).
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

   function scoreOrientation( tan, frames, sepTol, angTol )
   {
      // Sum of best-candidate scores, one per trail, plus the pair list.
      // One-to-one assignment is NOT enforced here (assignTrails does that
      // afterwards); for a global orientation search per-trail-best is a
      // smooth enough objective and much cheaper.
      var total = 0;
      var pairs = [];
      for ( var f = 0; f < frames.length; ++f )
      {
         var fr = frames[f];
         var trails = fr.trails || [];
         var cands = [];
         for ( var c = 0; c < fr.crossings.length; ++c )
         {
            var cr = fr.crossings[c];
            if ( !cr.sunlit )
               continue;
            var len = angularSepDeg( cr.path.p1, cr.path.p2 );
            if ( len <= 0 )
               continue;
            cands.push( { c: cr,
                          mid: midpointRaDec( cr.path.p1, cr.path.p2 ),
                          pa: positionAngleDeg( cr.path.p1, cr.path.p2 ),
                          len: len } );
         }
         if ( cands.length === 0 )
            continue;
         for ( var t = 0; t < trails.length; ++t )
         {
            var tr = trails[t];
            var p1 = tanProject( tan, tr.x1, tr.y1 );
            var p2 = tanProject( tan, tr.x2, tr.y2 );
            var mid = midpointRaDec( p1, p2 );
            var pa = positionAngleDeg( p1, p2 );
            var tLen = angularSepDeg( p1, p2 );
            var best = null;
            for ( var k = 0; k < cands.length; ++k )
            {
               var sep = angularSepDeg( mid, cands[k].mid );
               if ( sep > sepTol )
                  continue;
               var ad = orientationDiffDeg( pa, cands[k].pa );
               if ( ad > angTol )
                  continue;
               var mx = Math.max( tLen, cands[k].len );
               var lenScore = ( mx > 0 ) ? 1 - Math.min( 1, Math.abs( tLen - cands[k].len )/mx ) : 0;
               var score = 0.5*( 1 - sep/sepTol ) + 0.3*( 1 - ad/angTol ) + 0.2*lenScore;
               if ( best === null || score > best.score )
                  best = { score: score, sep: sep, ad: ad, cand: cands[k],
                           frame: f, trail: t, mid: mid };
            }
            if ( best !== null )
            {
               total += best.score;
               pairs.push( best );
            }
         }
      }
      return { total: total, pairs: pairs };
   }

   function medianOfArray( a )
   {
      if ( a.length === 0 )
         return 0;
      var s = a.slice().sort( function( x, y ) { return x - y; } );
      var m = Math.floor( s.length/2 );
      return ( s.length % 2 !== 0 ) ? s[m] : ( s[m - 1] + s[m] )/2;
   }

   function fitOrientation( frames, field, options )
   {
      var o = options || {};
      var sepTol = ( o.fitMaxSepDeg > 0 ) ? o.fitMaxSepDeg : 0.6;
      var angTol = ( o.fitMaxAngleDiffDeg > 0 ) ? o.fitMaxAngleDiffDeg : 15;
      var center = { raDeg: field.raDeg, decDeg: field.decDeg };

      var hasWork = false;
      for ( var f = 0; f < frames.length && !hasWork; ++f )
         if ( ( frames[f].trails || [] ).length > 0 )
            for ( var c = 0; c < frames[f].crossings.length; ++c )
               if ( frames[f].crossings[c].sunlit )
               {
                  hasWork = true;
                  break;
               }
      if ( !hasWork )
         return null;

      function evaluate( rotDeg, parity, ctr )
      {
         var tan = tanForOrientation( ctr, field.pixScaleArcsec, field.width, field.height,
                                      rotDeg, parity );
         var s = scoreOrientation( tan, frames, sepTol, angTol );
         return { tan: tan, rotationDeg: rotDeg, parity: parity, center: ctr,
                  score: s.total, pairs: s.pairs };
      }

      // Coarse scan: 1-degree steps, both parities.
      var best = null;
      for ( var p = -1; p <= 1; p += 2 )
         for ( var r = 0; r < 360; ++r )
         {
            var e = evaluate( r, p, center );
            if ( best === null || e.score > best.score )
               best = e;
         }
      if ( best === null || best.score <= 0 || best.pairs.length === 0 )
         return null;

      // Field-center correction: median tangent-plane offset of the matched
      // pairs (mount pointing is only good to arcminutes), then a fine
      // rotation scan around the winner with the corrected center.
      for ( var iter = 0; iter < 2; ++iter )
      {
         var base = best.center;
         var dxs = [], dys = [];
         for ( var i = 0; i < best.pairs.length; ++i )
         {
            var pr = best.pairs[i];
            var tTr = tangentOffsets( base, pr.mid );
            var tCr = tangentOffsets( base, pr.cand.mid );
            if ( tTr.ok && tCr.ok )
            {
               dxs.push( tCr.x - tTr.x );
               dys.push( tCr.y - tTr.y );
            }
         }
         var ctr = base;
         if ( dxs.length > 0 )
         {
            var cosD = Math.cos( base.decDeg*DEG2RAD );
            ctr = { raDeg: base.raDeg + ( cosD !== 0 ? medianOfArray( dxs )/cosD : 0 ),
                    decDeg: base.decDeg + medianOfArray( dys ) };
         }
         var refined = best;
         for ( var r2 = -20; r2 <= 20; ++r2 )
         {
            var e2 = evaluate( best.rotationDeg + r2*0.1, best.parity, ctr );
            if ( e2.score > refined.score )
               refined = e2;
         }
         if ( refined === best )
            break;
         best = refined;
      }
      return best;
   }

   function assignTrailsLoose( crossings, fr, opt )
   {
      // Trail assignment for fields WITHOUT a plate solution, tuned to the
      // real error budget of a TLE prediction: the dominant error is
      // ALONG-track (the satellite runs early or late on its ephemeris —
      // easily half a degree a few days from epoch), while the cross-track
      // error stays small. So the midpoint separation is decomposed against
      // the crossing's direction: tight across (crossTolDeg), generous
      // along (alongTolDeg). Orientation still must agree. One-to-one by
      // score, like the strict assigner.
      var o = opt || {};
      var crossTol = ( o.crossTolDeg > 0 ) ? o.crossTolDeg : 0.4;
      var alongTol = ( o.alongTolDeg > 0 ) ? o.alongTolDeg : 1.5;
      var angleTol = ( o.angleTolDeg > 0 ) ? o.angleTolDeg : 12;

      var trails = fr.trails || [];
      var cands = [];
      for ( var ci = 0; ci < crossings.length; ++ci )
      {
         var c = crossings[ci];
         if ( !c.sunlit )
            continue;
         var cMid = midpointRaDec( c.path.p1, c.path.p2 );
         var cPA = positionAngleDeg( c.path.p1, c.path.p2 );
         var cLen = angularSepDeg( c.path.p1, c.path.p2 );
         for ( var ti = 0; ti < trails.length; ++ti )
         {
            var tr = trails[ti];
            if ( !tr.p1 || !tr.p2 )
               continue;
            var tMid = midpointRaDec( tr.p1, tr.p2 );
            var sep = angularSepDeg( cMid, tMid );
            var ad = orientationDiffDeg( cPA, positionAngleDeg( tr.p1, tr.p2 ) );
            if ( ad > angleTol )
               continue;
            // Decompose the midpoint offset against the crossing direction.
            var bearing = positionAngleDeg( cMid, tMid );
            var rel = ( bearing - cPA )*DEG2RAD;
            var along = Math.abs( sep*Math.cos( rel ) );
            var cross = Math.abs( sep*Math.sin( rel ) );
            if ( cross > crossTol || along > alongTol )
               continue;
            var tLen = angularSepDeg( tr.p1, tr.p2 );
            var mx = Math.max( cLen, tLen );
            var lenScore = ( mx > 0 ) ? 1 - Math.min( 1, Math.abs( cLen - tLen )/mx ) : 0;
            var score = 0.5*( 1 - cross/crossTol ) +
                        0.3*( 1 - ad/angleTol ) +
                        0.1*( 1 - along/alongTol ) +
                        0.1*lenScore;
            cands.push( { ci: ci, ti: ti, score: score, sep: sep, ad: ad,
                          cross: cross, along: along } );
         }
      }
      cands.sort( function( a, b ) { return b.score - a.score; } );

      var usedCross = {};
      var usedTrail = {};
      for ( var k = 0; k < cands.length; ++k )
      {
         var cd = cands[k];
         if ( usedCross[cd.ci] || usedTrail[cd.ti] )
            continue;
         usedCross[cd.ci] = true;
         usedTrail[cd.ti] = true;
         crossings[cd.ci].matchedTrailIndex = trails[cd.ti].index;
         crossings[cd.ci].matchScore = cd.score;
         crossings[cd.ci].sepDeg = cd.sep;
         crossings[cd.ci].angleDiffDeg = cd.ad;
         crossings[cd.ci].matchConfidence = "high";
      }

      // Rescue pass: maneuvering constellations fly with stale published
      // elements — the prediction lands up to ~0.8 degree SIDEWAYS of the
      // observed streak while the orientation stays right. When exactly one
      // unmatched sunlit crossing and exactly one unmatched trail point at
      // each other (near-perfect angle, nothing else in the window), that
      // is an identification a human would make — recorded at reduced
      // confidence.
      var rescue = [];
      for ( var ci2 = 0; ci2 < crossings.length; ++ci2 )
      {
         var c2 = crossings[ci2];
         if ( !c2.sunlit || usedCross[ci2] )
            continue;
         var cMid2 = midpointRaDec( c2.path.p1, c2.path.p2 );
         var cPA2 = positionAngleDeg( c2.path.p1, c2.path.p2 );
         for ( var ti2 = 0; ti2 < trails.length; ++ti2 )
         {
            var tr2 = trails[ti2];
            if ( usedTrail[ti2] || !tr2.p1 || !tr2.p2 )
               continue;
            var ad2 = orientationDiffDeg( cPA2, positionAngleDeg( tr2.p1, tr2.p2 ) );
            if ( ad2 > 6 )
               continue;
            var tMid2 = midpointRaDec( tr2.p1, tr2.p2 );
            var sep2 = angularSepDeg( cMid2, tMid2 );
            var rel2 = ( positionAngleDeg( cMid2, tMid2 ) - cPA2 )*DEG2RAD;
            var cross2 = Math.abs( sep2*Math.sin( rel2 ) );
            // Maneuvering constellations (G60...) publish elements that land
            // more than a degree SIDEWAYS: with a near-exact orientation the
            // sideways gate opens further.
            var crossGate = ( ad2 <= 1.5 ) ? 1.6 : 0.8;
            if ( cross2 > crossGate ||
                 Math.abs( sep2*Math.cos( rel2 ) ) > alongTol )
               continue;
            rescue.push( { ci: ci2, ti: ti2, sep: sep2, ad: ad2 } );
         }
      }
      // keep pairs that are unambiguous — or whose orientation DOMINATES
      // every competitor (angle 5x closer, competitors above 8 degrees)
      for ( var r = 0; r < rescue.length; ++r )
      {
         var unique = true;
         for ( var r2 = 0; r2 < rescue.length; ++r2 )
            if ( r2 !== r && ( rescue[r2].ci === rescue[r].ci || rescue[r2].ti === rescue[r].ti ) )
               if ( !( rescue[r2].ad > 8 && rescue[r2].ad >= 5*Math.max( 0.5, rescue[r].ad ) ) )
                  unique = false;
         if ( !unique )
            continue;
         var rc = rescue[r];
         crossings[rc.ci].matchedTrailIndex = trails[rc.ti].index;
         crossings[rc.ci].matchScore = 0.5;
         crossings[rc.ci].sepDeg = rc.sep;
         crossings[rc.ci].angleDiffDeg = rc.ad;
         crossings[rc.ci].matchConfidence = "medium";
      }
   }

   function matchFrame( fr, obs, opt, sats )
   {
      var startMs = parseRfc3339Ms( fr.startUtc );
      if ( startMs === null )
         return { error: "bad startUtc " + JSON.stringify( fr.startUtc ) };
      if ( !( fr.exposureSec > 0 ) )
         return { error: "bad exposureSec " + fr.exposureSec };

      var crossings = [];
      for ( var i = 0; i < sats.length; ++i )
      {
         if ( !coarseCandidate( sats[i], fr, obs, opt, startMs ) )
            continue;
         var runs = fineCrossings( sats[i], fr, obs, opt, startMs );
         for ( var k = 0; k < runs.length; ++k )
            crossings.push( runs[k] );
      }
      crossings.sort( function( a, b )
      {
         if ( a.entryUtc < b.entryUtc ) return -1;
         if ( a.entryUtc > b.entryUtc ) return 1;
         return 0;
      } );

      assignTrails( crossings, fr, opt );
      return { id: fr.id, crossings: crossings };
   }

   function match( request, tleText, source )
   {
      // Entry point: same contract as the Go sidecar's match command.
      // Returns a response object with error: null on success, or a bare
      // { error: "..." } on failure — it never throws on bad data.
      var tles = parseTles( tleText );
      if ( tles.length === 0 )
         return { error: "match: catalog contains no valid TLE records" };
      if ( !request || !request.observer || !request.frames )
         return { error: "match: request must have observer and frames" };

      var opt = normalizedOptions( request.options );
      var sats = [];
      for ( var i = 0; i < tles.length; ++i )
         sats.push( newSatEntry( tles[i] ) );

      var res = {
         tle: { count: tles.length, source: ( source === undefined || source === null ) ? "" : String( source ) },
         frames: [],
         error: null
      };
      for ( var f = 0; f < request.frames.length; ++f )
      {
         var fres = matchFrame( request.frames[f], request.observer, opt, sats );
         if ( fres.error )
            return { error: "match: frame " + JSON.stringify( request.frames[f].id ) + ": " + fres.error };
         res.frames.push( fres );
      }
      return res;
   }

   return {
      parseTles: parseTles,
      match: match,
      fitOrientation: fitOrientation,
      useSgp4: function( lib ) { sgp4Lib = lib; },
      core: {
         assignTrails: assignTrails,
         assignTrailsLoose: assignTrailsLoose,
         normalizedOptions: normalizedOptions,
         tanForOrientation: tanForOrientation,
         tanProject: tanProject,
         parseRfc3339Ms: parseRfc3339Ms,
         formatRfc3339Ms: formatRfc3339Ms,
         jdayOfMs: jdayOfMs,
         gmstRad: gmstRad,
         sunDirection: sunDirection,
         isSunlit: isSunlit,
         observerEci: observerEci,
         temeToJ2000: temeToJ2000,
         topocentricRaDec: topocentricRaDec,
         crossAlongDeg: crossAlongDeg,
         elevationDeg: elevationDeg,
         vecToRaDec: vecToRaDec,
         raDecToVec: raDecToVec,
         angularSepDeg: angularSepDeg,
         positionAngleDeg: positionAngleDeg,
         orientationDiffDeg: orientationDiffDeg,
         midpointRaDec: midpointRaDec,
         tangentOffsets: tangentOffsets,
         fovContains: fovContains,
         newSatEntry: newSatEntry,
         propagateAt: propagateAt
      }
   };
} )();
