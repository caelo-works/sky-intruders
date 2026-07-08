/*
 * Meteors.js — meteor-shower heuristics for trails the TLE match left over.
 *
 * Pure JS, no PI types: everything here is unit-testable under Node.
 * Radiants are J2000 at peak, drift ignored (we match within ~8 degrees,
 * far coarser than radiant drift over an activity window).
 */

var SIMeteors = ( function()
{
   // Major annual showers (IAU): activity window (month, day), peak, radiant.
   var SHOWERS = [
      { code: "QUA", name: "Quadrantids",          from: [ 12, 28 ], to: [ 1, 12 ],  peak: [ 1, 3 ],   raDeg: 230, decDeg: 49,  zhr: 110 },
      { code: "LYR", name: "Lyrids",               from: [ 4, 14 ],  to: [ 4, 30 ],  peak: [ 4, 22 ],  raDeg: 271, decDeg: 34,  zhr: 18 },
      { code: "ETA", name: "Eta Aquariids",        from: [ 4, 19 ],  to: [ 5, 28 ],  peak: [ 5, 6 ],   raDeg: 338, decDeg: -1,  zhr: 50 },
      { code: "CAP", name: "Alpha Capricornids",   from: [ 7, 3 ],   to: [ 8, 15 ],  peak: [ 7, 30 ],  raDeg: 307, decDeg: -10, zhr: 5 },
      { code: "SDA", name: "S. Delta Aquariids",   from: [ 7, 12 ],  to: [ 8, 23 ],  peak: [ 7, 30 ],  raDeg: 340, decDeg: -16, zhr: 25 },
      { code: "PER", name: "Perseids",             from: [ 7, 17 ],  to: [ 8, 24 ],  peak: [ 8, 12 ],  raDeg: 48,  decDeg: 58,  zhr: 100 },
      { code: "STA", name: "S. Taurids",           from: [ 9, 10 ],  to: [ 11, 20 ], peak: [ 10, 10 ], raDeg: 32,  decDeg: 9,   zhr: 5 },
      { code: "ORI", name: "Orionids",             from: [ 10, 2 ],  to: [ 11, 7 ],  peak: [ 10, 21 ], raDeg: 95,  decDeg: 16,  zhr: 20 },
      { code: "NTA", name: "N. Taurids",           from: [ 10, 20 ], to: [ 12, 10 ], peak: [ 11, 12 ], raDeg: 58,  decDeg: 22,  zhr: 5 },
      { code: "LEO", name: "Leonids",              from: [ 11, 6 ],  to: [ 11, 30 ], peak: [ 11, 17 ], raDeg: 152, decDeg: 22,  zhr: 15 },
      { code: "GEM", name: "Geminids",             from: [ 12, 4 ],  to: [ 12, 17 ], peak: [ 12, 14 ], raDeg: 112, decDeg: 33,  zhr: 150 },
      { code: "URS", name: "Ursids",               from: [ 12, 17 ], to: [ 12, 26 ], peak: [ 12, 22 ], raDeg: 217, decDeg: 76,  zhr: 10 }
   ];

   var D2R = Math.PI / 180;

   function unitVector( raDeg, decDeg )
   {
      var ra = raDeg * D2R, dec = decDeg * D2R;
      return [ Math.cos( dec ) * Math.cos( ra ),
               Math.cos( dec ) * Math.sin( ra ),
               Math.sin( dec ) ];
   }

   function cross( a, b )
   {
      return [ a[ 1 ] * b[ 2 ] - a[ 2 ] * b[ 1 ],
               a[ 2 ] * b[ 0 ] - a[ 0 ] * b[ 2 ],
               a[ 0 ] * b[ 1 ] - a[ 1 ] * b[ 0 ] ];
   }

   function dot( a, b )
   {
      return a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ];
   }

   function norm( a )
   {
      var n = Math.sqrt( dot( a, a ) );
      return ( n > 0 ) ? [ a[ 0 ] / n, a[ 1 ] / n, a[ 2 ] / n ] : a;
   }

   function sepDeg( aRa, aDec, bRa, bDec )
   {
      var d = dot( unitVector( aRa, aDec ), unitVector( bRa, bDec ) );
      return Math.acos( Math.max( -1, Math.min( 1, d ) ) ) / D2R;
   }

   // Angular distance from a point to the great circle through p1-p2.
   function distanceToGreatCircleDeg( p1, p2, point )
   {
      var pole = norm( cross( unitVector( p1.raDeg, p1.decDeg ),
                              unitVector( p2.raDeg, p2.decDeg ) ) );
      var s = dot( pole, unitVector( point.raDeg, point.decDeg ) );
      return Math.abs( 90 - Math.acos( Math.max( -1, Math.min( 1, s ) ) ) / D2R );
   }

   // A (month, day) window test that survives year wrap (Quadrantids).
   function inWindow( date, from, to )
   {
      var md = ( date.getUTCMonth() + 1 ) * 100 + date.getUTCDate();
      var f = from[ 0 ] * 100 + from[ 1 ];
      var t = to[ 0 ] * 100 + to[ 1 ];
      return ( f <= t ) ? ( md >= f && md <= t ) : ( md >= f || md <= t );
   }

   function activeShowers( date )
   {
      if ( !date )
         return [];
      var out = [];
      for ( var i = 0; i < SHOWERS.length; ++i )
         if ( inWindow( date, SHOWERS[ i ].from, SHOWERS[ i ].to ) )
            out.push( SHOWERS[ i ] );
      return out;
   }

   /*
    * Classify a trail the satellite match could not explain.
    *
    * trail: { p1, p2 ({raDeg,decDeg} or null), brightnessVariation,
    *          spansEdgeToEdge (bool) }
    * date:  frame start (JS Date, UTC) or null.
    *
    * Returns { klass, shower (or null), confidence ("low"|"medium"|"high"),
    *           reason } with klass one of "meteor", "satellite-candidate",
    *           "unknown".
    */
   function classifyTrail( trail, date )
   {
      var showers = activeShowers( date );
      var meteorCues = 0;
      var reasons = [];

      // Satellites in a multi-second sub almost always cross edge to edge;
      // a trail with both endpoints inside the frame burned briefly.
      if ( trail.spansEdgeToEdge === false )
      {
         meteorCues++;
         reasons.push( "trail contained within the frame" );
      }

      // Meteors brighten and fade along the path; satellites are steady
      // (tumbling flashers exist, so this cue alone is never "high").
      if ( trail.brightnessVariation != null && trail.brightnessVariation > 0.35 )
      {
         meteorCues++;
         reasons.push( "strong brightness variation along the trail" );
      }

      // Radiant alignment: the great circle through the trail must pass
      // near an active shower's radiant, and the radiant must sit outside
      // the segment (meteors move away from it).
      var bestShower = null;
      if ( trail.p1 && trail.p2 )
         for ( var i = 0; i < showers.length; ++i )
         {
            var sh = showers[ i ];
            var gc = distanceToGreatCircleDeg( trail.p1, trail.p2, { raDeg: sh.raDeg, decDeg: sh.decDeg } );
            if ( gc <= 8 )
            {
               var toP1 = sepDeg( sh.raDeg, sh.decDeg, trail.p1.raDeg, trail.p1.decDeg );
               var toP2 = sepDeg( sh.raDeg, sh.decDeg, trail.p2.raDeg, trail.p2.decDeg );
               var segLen = sepDeg( trail.p1.raDeg, trail.p1.decDeg, trail.p2.raDeg, trail.p2.decDeg );
               if ( Math.min( toP1, toP2 ) > segLen * 0.5 ) // radiant outside the segment
                  if ( bestShower == null || sh.zhr > bestShower.zhr )
                     bestShower = sh;
            }
         }
      if ( bestShower != null )
      {
         meteorCues++;
         reasons.push( "aligned with the " + bestShower.name + " radiant" );
      }

      if ( bestShower != null && meteorCues >= 2 )
         return { klass: "meteor", shower: bestShower, confidence: "medium",
                  reason: reasons.join( ", " ) };
      if ( meteorCues >= 2 )
         return { klass: "meteor", shower: null, confidence: "low",
                  reason: reasons.join( ", " ) };

      // Steady, edge-to-edge, but no TLE match: likely a satellite missing
      // from the public catalog (classified, debris, fresh launch).
      if ( trail.spansEdgeToEdge === true &&
           ( trail.brightnessVariation == null || trail.brightnessVariation <= 0.35 ) )
         return { klass: "satellite-candidate", shower: null, confidence: "medium",
                  reason: "steady edge-to-edge trail without a catalog match" };

      return { klass: "unknown", shower: null, confidence: "low",
               reason: reasons.length ? reasons.join( ", " ) : "no distinguishing cue" };
   }

   /*
    * Asteroid candidates: compact sources drifting coherently across frames.
    * blobsByFrame: [ { id, dateObs (Date), blobs: [ {raDeg,decDeg,fluxAdu} ] } ]
    * (sky coordinates required — the caller skips frames without WCS).
    * A candidate must appear in >= minFrames frames, move monotonically at a
    * consistent rate in [0.1, 120] arcsec/min, along a consistent direction.
    */
   function findMovers( blobsByFrame, minFrames )
   {
      if ( minFrames == null )
         minFrames = 3;
      var frames = blobsByFrame.filter( function( f ) { return f.dateObs != null; } )
                               .sort( function( a, b ) { return a.dateObs - b.dateObs; } );
      if ( frames.length < minFrames )
         return [];

      var TOL_ARCSEC = 20;   // position tolerance when extrapolating
      var candidates = [];

      // Seed with pairs from the first two usable frames, then extend.
      for ( var i = 0; i + 1 < frames.length; ++i )
      {
         var dtMin = ( frames[ i + 1 ].dateObs - frames[ i ].dateObs ) / 60000;
         if ( dtMin <= 0 )
            continue;
         for ( var a = 0; a < frames[ i ].blobs.length; ++a )
            for ( var b = 0; b < frames[ i + 1 ].blobs.length; ++b )
            {
               var A = frames[ i ].blobs[ a ], B = frames[ i + 1 ].blobs[ b ];
               var rate = sepDeg( A.raDeg, A.decDeg, B.raDeg, B.decDeg ) * 3600 / dtMin;
               if ( rate < 0.1 || rate > 120 )
                  continue;
               var track = { points: [ { frame: frames[ i ].id, t: frames[ i ].dateObs, raDeg: A.raDeg, decDeg: A.decDeg },
                                       { frame: frames[ i + 1 ].id, t: frames[ i + 1 ].dateObs, raDeg: B.raDeg, decDeg: B.decDeg } ],
                             rateArcsecPerMin: rate };
               // Extend through subsequent frames by linear extrapolation.
               for ( var j = i + 2; j < frames.length; ++j )
               {
                  var last = track.points[ track.points.length - 1 ];
                  var prev = track.points[ track.points.length - 2 ];
                  var dt1 = ( frames[ j ].dateObs - last.t ) / 60000;
                  var dt0 = ( last.t - prev.t ) / 60000;
                  if ( dt1 <= 0 || dt0 <= 0 )
                     continue;
                  var predRa = last.raDeg + ( last.raDeg - prev.raDeg ) * dt1 / dt0;
                  var predDec = last.decDeg + ( last.decDeg - prev.decDeg ) * dt1 / dt0;
                  var best = null, bestSep = TOL_ARCSEC;
                  for ( var c = 0; c < frames[ j ].blobs.length; ++c )
                  {
                     var s = sepDeg( predRa, predDec, frames[ j ].blobs[ c ].raDeg, frames[ j ].blobs[ c ].decDeg ) * 3600;
                     if ( s < bestSep )
                     {
                        bestSep = s;
                        best = frames[ j ].blobs[ c ];
                     }
                  }
                  if ( best != null )
                     track.points.push( { frame: frames[ j ].id, t: frames[ j ].dateObs,
                                          raDeg: best.raDeg, decDeg: best.decDeg } );
               }
               if ( track.points.length >= minFrames )
                  candidates.push( track );
            }
      }

      // Deduplicate tracks sharing their first point (keep the longest).
      candidates.sort( function( a, b ) { return b.points.length - a.points.length; } );
      var seen = {}, out = [];
      for ( var k = 0; k < candidates.length; ++k )
      {
         var key = candidates[ k ].points[ 0 ].frame + "@" +
                   candidates[ k ].points[ 0 ].raDeg.toFixed( 4 ) + "," +
                   candidates[ k ].points[ 0 ].decDeg.toFixed( 4 );
         if ( !seen[ key ] )
         {
            seen[ key ] = true;
            out.push( candidates[ k ] );
         }
      }
      return out;
   }

   /*
    * Remove stationary sources (stars) before mover search. A blob is
    * stationary if a blob within tolArcsec sits at the same sky position in
    * at least minRecurrence of the frames. What survives is the pool of
    * candidate movers (asteroids, plus noise the rate test then rejects).
    * Pure: blobsByFrame as in findMovers; returns the same shape, filtered.
    */
   function filterStationary( blobsByFrame, tolArcsec, minRecurrence )
   {
      var frames = blobsByFrame.filter( function( f ) { return f.dateObs != null; } );
      if ( minRecurrence == null )
         minRecurrence = Math.max( 2, Math.ceil( frames.length / 2 ) );
      if ( tolArcsec == null )
         tolArcsec = 5;
      var tolDeg = tolArcsec / 3600;

      // Count, for each blob, how many frames host a near-coincident blob.
      function recurrence( blob, selfFrameIdx )
      {
         var n = 0;
         for ( var i = 0; i < frames.length; ++i )
         {
            if ( i == selfFrameIdx )
            {
               ++n;
               continue;
            }
            for ( var j = 0; j < frames[ i ].blobs.length; ++j )
               if ( sepDeg( blob.raDeg, blob.decDeg,
                            frames[ i ].blobs[ j ].raDeg, frames[ i ].blobs[ j ].decDeg ) <= tolDeg )
               {
                  ++n;
                  break;
               }
         }
         return n;
      }

      var out = [];
      for ( var f = 0; f < frames.length; ++f )
      {
         var kept = [];
         for ( var b = 0; b < frames[ f ].blobs.length; ++b )
            if ( recurrence( frames[ f ].blobs[ b ], f ) < minRecurrence )
               kept.push( frames[ f ].blobs[ b ] );
         out.push( { id: frames[ f ].id, dateObs: frames[ f ].dateObs, blobs: kept } );
      }
      return out;
   }

   // Convenience: strip stars, then track the movers. minFrames default 3.
   function findAsteroidCandidates( blobsByFrame, minFrames, tolArcsec )
   {
      return findMovers( filterStationary( blobsByFrame, tolArcsec, null ), minFrames );
   }

   // ------------------------------------------------------------------------
   // Airplane heuristic. A plane crossing a sub leaves a BUNDLE of straight
   // marks: wingtip/fuselage lights are parallel lines offset by tens to a
   // few hundred pixels, strobes add collinear dashes. Satellites never do
   // that — one pass, one line. So: 3+ segments in one frame, near-parallel
   // (mod 180) and within a shared perpendicular corridor, are one airplane.

   function groupPlanes( trails, opts )
   {
      opts = opts || {};
      var angleTol = ( opts.angleTolDeg > 0 ) ? opts.angleTolDeg : 4;
      var corridor = ( opts.corridorPx > 0 ) ? opts.corridorPx : 500;
      var minSegments = ( opts.minSegments >= 2 ) ? opts.minSegments : 3;

      function angleDiff( a, b )
      {
         var d = Math.abs( a - b ) % 180;
         return ( d > 90 ) ? 180 - d : d;
      }

      var n = trails.length;
      var used = new Array( n );
      var groups = [];
      for ( var i = 0; i < n; ++i )
      {
         if ( used[ i ] )
            continue;
         var th = trails[ i ].angleDeg*Math.PI/180;
         var nx = -Math.sin( th ), ny = Math.cos( th ); // unit normal
         var mi = { x: ( trails[ i ].x1 + trails[ i ].x2 )/2,
                    y: ( trails[ i ].y1 + trails[ i ].y2 )/2 };
         var members = [ i ];
         for ( var j = 0; j < n; ++j )
         {
            if ( j === i || used[ j ] )
               continue;
            if ( angleDiff( trails[ i ].angleDeg, trails[ j ].angleDeg ) > angleTol )
               continue;
            var mj = { x: ( trails[ j ].x1 + trails[ j ].x2 )/2,
                       y: ( trails[ j ].y1 + trails[ j ].y2 )/2 };
            var perp = Math.abs( ( mj.x - mi.x )*nx + ( mj.y - mi.y )*ny );
            if ( perp <= corridor )
               members.push( j );
         }
         if ( members.length < minSegments )
            continue;

         // Overall extent: project every endpoint on the direction axis.
         var ux = Math.cos( th ), uy = Math.sin( th );
         var tMin = Infinity, tMax = -Infinity, pMin = null, pMax = null;
         for ( var k = 0; k < members.length; ++k )
         {
            var tr = trails[ members[ k ] ];
            used[ members[ k ] ] = true;
            var pts = [ { x: tr.x1, y: tr.y1 }, { x: tr.x2, y: tr.y2 } ];
            for ( var p = 0; p < 2; ++p )
            {
               var t = ( pts[ p ].x - mi.x )*ux + ( pts[ p ].y - mi.y )*uy;
               if ( t < tMin ) { tMin = t; pMin = pts[ p ]; }
               if ( t > tMax ) { tMax = t; pMax = pts[ p ]; }
            }
         }
         groups.push( { indices: members,
                        x1: pMin.x, y1: pMin.y, x2: pMax.x, y2: pMax.y,
                        angleDeg: trails[ i ].angleDeg,
                        segments: members.length } );
      }
      return groups;
   }

   return {
      groupPlanes: groupPlanes,
      SHOWERS: SHOWERS,
      activeShowers: activeShowers,
      classifyTrail: classifyTrail,
      findMovers: findMovers,
      filterStationary: filterStationary,
      findAsteroidCandidates: findAsteroidCandidates,
      sepDeg: sepDeg,
      distanceToGreatCircleDeg: distanceToGreatCircleDeg
   };
} )();
