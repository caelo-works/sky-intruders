/*
 * SatMatch.js — SISatMatch: pure-JS orbital matching engine.
 *
 * Port of the Go sidecar "match" command (sidecar/astro.go, match.go,
 * tle.go — the certified reference). SGP4 propagation comes from the
 * vendored satellite.js (satellite-js 5.0.0 UMD, global `satellite`);
 * everything else — TLE validation, Meeus sun direction, cylindrical
 * Earth-shadow test, spherical observer ECI, topocentric directions,
 * gnomonic FOV test, crossing scan and score-ordered trail assignment —
 * is self-contained here. Request and response shapes are inherited
 * verbatim from the Go engine (docs/ARCHITECTURE.md, matching contracts):
 * match() returns either a full response with error: null, or a bare
 * { error: "..." } object; it never throws on bad catalog or request data.
 *
 * Directions are TEME of date vs the J2000 frame of plate-solved WCS;
 * the ~0.35 deg precession difference is absorbed by matchMaxSepDeg,
 * exactly as in the Go reference.
 */

var SISatMatch = ( function()
{
   var DEG2RAD = Math.PI/180;
   var RAD2DEG = 180/Math.PI;
   var TWO_PI = 2*Math.PI;
   var EARTH_RADIUS = 6378.137;     // km, equatorial
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
      // east of north (WCS-like rotation).
      var t = tangentOffsets( { raDeg: fov.raDeg, decDeg: fov.decDeg }, p );
      if ( !t.ok )
         return false;
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
   // Observer and look angles (ports of go-satellite's ThetaG_JD, LLAToECI
   // and ECIToLookAngles — spherical Earth, 1992 Astronomical Almanac).

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
      var theta = ( gmstRad( jday ) + lonRad ) % TWO_PI;
      var r = ( EARTH_RADIUS + altKm )*Math.cos( latRad );
      return { x: r*Math.cos( theta ),
               y: r*Math.sin( theta ),
               z: ( EARTH_RADIUS + altKm )*Math.sin( latRad ) };
   }

   function observerEci( obs, jday )
   {
      // Observer position (km) and velocity (km per second) in TEME. The
      // spherical (geocentric) latitude model of the Go reference is kept:
      // at LEO ranges it costs at most ~0.2 deg of parallax, absorbed by
      // the matching tolerance budget.
      var pos = llaToEci( obs.latDeg*DEG2RAD, obs.lonDeg*DEG2RAD, obs.altM/1000, jday );
      var vel = { x: -EARTH_OMEGA*pos.y, y: EARTH_OMEGA*pos.x, z: 0 };
      return { pos: pos, vel: vel };
   }

   function topocentricRaDec( satPos, obsPos )
   {
      // Topocentric equatorial direction: satellite TEME position minus
      // observer ECI position.
      return vecToRaDec( sub3( satPos, obsPos ) );
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
         matchMaxAngleDiffDeg: ( o.matchMaxAngleDiffDeg > 0 ) ? o.matchMaxAngleDiffDeg : 12
      };
   }

   function coarseCandidate( e, fr, obs, opt, startMs )
   {
      // One propagation at the exposure midpoint: keep the satellite only
      // if it could plausibly touch the FOV during the window.
      var tMid = startMs + fr.exposureSec/2*1000;
      var pv = propagateAt( e, tMid );
      if ( pv === null )
         return false;
      var jd = jdayOfMs( tMid );
      var o = observerEci( obs, jd );
      var rho = sub3( pv.pos, o.pos );
      var rhoDot = sub3( pv.vel, o.vel );
      var rhoLen = norm3( rho );
      if ( rhoLen === 0 )
         return false;
      // topocentric angular rate: |rho x rhodot| over |rho| squared
      var rateDeg = norm3( cross3( rho, rhoDot ) )/( rhoLen*rhoLen )*RAD2DEG;
      var reachDeg = rateDeg*fr.exposureSec/2;

      // below the horizon for the whole window -> skip (2 deg slack on top
      // of the angular reach, so risers and setters at the edge are kept)
      var el = elevationDeg( pv.pos, obs, jd );
      if ( el < -( reachDeg + 2 ) )
         return false;

      var sep = angularSepDeg( vecToRaDec( rho ), { raDeg: fr.fov.raDeg, decDeg: fr.fov.decDeg } );
      var halfDiag = 0.5*Math.sqrt( fr.fov.widthDeg*fr.fov.widthDeg + fr.fov.heightDeg*fr.fov.heightDeg );
      return sep <= halfDiag + reachDeg + opt.matchMaxSepDeg;
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
         var dir = vecToRaDec( sub3( pv.pos, o.pos ) );
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
               var on = observerEci( obs, jdayOfMs( tn ) );
               rate = angularSepDeg( entry.dir, vecToRaDec( sub3( pvn.pos, on.pos ) ) )/opt.stepSec;
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

   function assignTrails( crossings, fr, opt )
   {
      // Candidates: sunlit crossings vs trails with sky coordinates,
      // midpoint separation within matchMaxSepDeg and orientation within
      // matchMaxAngleDiffDeg (mod 180). Score blends separation (0.4),
      // orientation (0.3) and path-length agreement (0.3), each normalized
      // to [0,1]. Conflicts are resolved globally by score order: each
      // trail and each crossing is used at most once.
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
            var sep = angularSepDeg( cMid, midpointRaDec( tr.p1, tr.p2 ) );
            if ( sep > opt.matchMaxSepDeg )
               continue;
            var ad = orientationDiffDeg( cPA, positionAngleDeg( tr.p1, tr.p2 ) );
            if ( ad > opt.matchMaxAngleDiffDeg )
               continue;
            // rate agreement compared as path lengths over the same window
            var tLen = angularSepDeg( tr.p1, tr.p2 );
            var rateScore = 0;
            var mx = Math.max( cLen, tLen );
            if ( mx > 0 )
               rateScore = 1 - Math.min( 1, Math.abs( cLen - tLen )/mx );
            var score = 0.4*( 1 - sep/opt.matchMaxSepDeg ) +
                        0.3*( 1 - ad/opt.matchMaxAngleDiffDeg ) +
                        0.3*rateScore;
            cands.push( { ci: ci, ti: ti, score: score, sep: sep, ad: ad } );
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
      useSgp4: function( lib ) { sgp4Lib = lib; },
      core: {
         parseRfc3339Ms: parseRfc3339Ms,
         formatRfc3339Ms: formatRfc3339Ms,
         jdayOfMs: jdayOfMs,
         gmstRad: gmstRad,
         sunDirection: sunDirection,
         isSunlit: isSunlit,
         observerEci: observerEci,
         topocentricRaDec: topocentricRaDec,
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
