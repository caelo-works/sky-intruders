/*
 * TrailDetect.js — SITrailDetect: per-frame trail finder.
 *
 * Pipeline: bin to a small working image, robust median + MAD threshold,
 * Hough transform, contiguity validation (kills chance star alignments),
 * corridor erasure + iterate, then full-resolution photometry.
 *
 * SITrailCore holds all the pure math (plain arrays + width/height, no PI
 * types) and runs under plain Node for testing. SITrailDetect.detect is
 * the thin PixInsight-facing wrapper (getSamples, image.sample,
 * processEvents).
 */

var SITrailCore = ( function()
{
   var DEFAULTS = {
      kSigma: 5,
      minLengthFrac: 0.15,   // of the small-image diagonal
      maxTrails: 10,
      fillRatioMin: 0.6,
      maxAboveFrac: 0.08,    // above this the threshold is raised (clouds)
      gapTol: 2,             // px of misses tolerated inside a run
      perpTol: 1,            // px checked across the line when walking it
      corridorHalfWidth: 3,  // px erased around an accepted line
      maxPeekCandidates: 30  // Hough peaks examined per iteration
   };

   // ------------------------------------------------------------------------
   // Array statistics (local so the core stays self-contained under Node)

   function medianOf( arr )
   {
      if ( arr.length === 0 )
         return 0;
      var s = Array.prototype.slice.call( arr ).sort( function( a, b ) { return a - b; } );
      var mid = Math.floor( s.length/2 );
      return ( s.length % 2 !== 0 ) ? s[mid] : ( s[mid - 1] + s[mid] )/2;
   }

   function madOf( arr )
   {
      // Sigma-equivalent MAD (x1.4826), like SIStats.arrayMAD.
      var med = medianOf( arr );
      var dev = [];
      for ( var i = 0; i < arr.length; ++i )
         dev.push( Math.abs( arr[i] - med ) );
      return medianOf( dev )*1.4826;
   }

   function meanOf( arr )
   {
      if ( arr.length === 0 )
         return 0;
      var s = 0;
      for ( var i = 0; i < arr.length; ++i )
         s += arr[i];
      return s/arr.length;
   }

   function medianMAD( data, maxSamples )
   {
      // Median + sigma-equivalent MAD on a uniform subsample of the array
      // (sorting 2.3 Mpx twice is wasteful; 500k samples are plenty).
      var n = data.length;
      var step = ( maxSamples && n > maxSamples ) ? Math.ceil( n/maxSamples ) : 1;
      var sub = [];
      for ( var i = 0; i < n; i += step )
         sub.push( data[i] );
      return { median: medianOf( sub ), mad: madOf( sub ) };
   }

   // ------------------------------------------------------------------------
   // Binning

   function binImage( width, height, binFactor, getStrip, onStrip )
   {
      // Average n x n blocks into a small float image. getStrip( y0, rows )
      // must return width*rows samples (row-major). onStrip( i, total ) is
      // called after each strip so the caller can keep the GUI alive.
      var bw = Math.floor( width/binFactor );
      var bh = Math.floor( height/binFactor );
      var out = new Float32Array( bw*bh );
      var inv = 1/( binFactor*binFactor );
      for ( var by = 0; by < bh; ++by )
      {
         var strip = getStrip( by*binFactor, binFactor );
         var rowBase = by*bw;
         for ( var bx = 0; bx < bw; ++bx )
         {
            var sum = 0;
            var x0 = bx*binFactor;
            for ( var r = 0; r < binFactor; ++r )
            {
               var base = r*width + x0;
               for ( var c = 0; c < binFactor; ++c )
                  sum += strip[base + c];
            }
            out[rowBase + bx] = sum*inv;
         }
         if ( onStrip )
            onStrip( by, bh );
      }
      return { data: out, width: bw, height: bh };
   }

   // ------------------------------------------------------------------------
   // Thresholding

   function adaptiveThreshold( data, median, mad, kSigma, maxAboveFrac )
   {
      // threshold = median + k*MAD; if too many pixels are above (clouds,
      // gradients), raise k until the above-fraction is sane.
      var sigma = ( mad > 0 ) ? mad : ( 1e-12 + 1e-6*Math.abs( median ) );
      var n = data.length;
      var k = kSigma;
      var threshold = median + k*sigma;
      var frac = 1;
      for ( var iter = 0; iter < 12; ++iter )
      {
         threshold = median + k*sigma;
         var above = 0;
         for ( var i = 0; i < n; ++i )
            if ( data[i] > threshold )
               ++above;
         frac = above/n;
         if ( frac <= maxAboveFrac )
            break;
         k *= 1.4;
      }
      return { threshold: threshold, kUsed: k, aboveFrac: frac };
   }

   function buildBinaryMap( data, threshold )
   {
      var map = new Uint8Array( data.length );
      for ( var i = 0; i < data.length; ++i )
         map[i] = ( data[i] > threshold ) ? 1 : 0;
      return map;
   }

   // ------------------------------------------------------------------------
   // Hough transform: rho = x*cos(theta) + y*sin(theta),
   // theta in [0,180) step 1 degree, rho step 1 px in [-diag, diag].

   function houghTransform( map, width, height )
   {
      var nTheta = 180;
      var diag = Math.ceil( Math.sqrt( width*width + height*height ) );
      var nRho = 2*diag + 1;
      var acc = new Int32Array( nTheta*nRho );
      var cosT = new Float64Array( nTheta );
      var sinT = new Float64Array( nTheta );
      for ( var t = 0; t < nTheta; ++t )
      {
         cosT[t] = Math.cos( t*Math.PI/180 );
         sinT[t] = Math.sin( t*Math.PI/180 );
      }
      for ( var y = 0; y < height; ++y )
      {
         var row = y*width;
         for ( var x = 0; x < width; ++x )
            if ( map[row + x] )
               for ( var t = 0; t < nTheta; ++t )
               {
                  var r = Math.round( x*cosT[t] + y*sinT[t] ) + diag;
                  ++acc[t*nRho + r];
               }
      }
      return { acc: acc, nTheta: nTheta, nRho: nRho, rhoOffset: diag };
   }

   function findPeak( hough )
   {
      var acc = hough.acc;
      var best = 0, bestIdx = -1;
      for ( var i = 0; i < acc.length; ++i )
         if ( acc[i] > best )
         {
            best = acc[i];
            bestIdx = i;
         }
      if ( bestIdx < 0 )
         return null;
      return { thetaDeg: Math.floor( bestIdx/hough.nRho ),
               rho: ( bestIdx % hough.nRho ) - hough.rhoOffset,
               count: best };
   }

   function suppressPeak( hough, thetaDeg, rho, dTheta, dRho )
   {
      // Zero a small accumulator neighborhood around a rejected peak so the
      // next findPeak proposes something else.
      var rhoIdx = rho + hough.rhoOffset;
      for ( var t = Math.max( 0, thetaDeg - dTheta ); t <= Math.min( hough.nTheta - 1, thetaDeg + dTheta ); ++t )
         for ( var r = Math.max( 0, rhoIdx - dRho ); r <= Math.min( hough.nRho - 1, rhoIdx + dRho ); ++r )
            hough.acc[t*hough.nRho + r] = 0;
   }

   // ------------------------------------------------------------------------
   // Line walking + contiguity validation

   function bestRun( hits, gapTol )
   {
      // Longest run of hits allowing gaps of at most gapTol misses inside.
      var best = null;
      var start = -1, lastHit = -1, count = 0;
      for ( var i = 0; i <= hits.length; ++i )
      {
         var h = ( i < hits.length ) && hits[i];
         if ( h )
         {
            if ( start < 0 )
            {
               start = i;
               count = 0;
            }
            lastHit = i;
            ++count;
         }
         else if ( start >= 0 && ( i - lastHit > gapTol || i === hits.length ) )
         {
            var len = lastHit - start + 1;
            if ( best === null || len > best.length )
               best = { start: start, end: lastHit, length: len, hitCount: count, fill: count/len };
            start = -1;
         }
      }
      return best;
   }

   function lineRun( map, width, height, thetaDeg, rho, perpTol, gapTol )
   {
      // Walk the line rho = x*cos + y*sin across the map in 1-px steps,
      // marking a hit when any pixel within perpTol across the line is
      // above threshold; return the best contiguous run with endpoints.
      var th = thetaDeg*Math.PI/180;
      var ct = Math.cos( th ), st = Math.sin( th );
      // Parametric point: p(t) = ( rho*ct - t*st, rho*st + t*ct )
      var tMin = -Infinity, tMax = Infinity;
      if ( Math.abs( st ) > 1e-12 )
      {
         var ta = ( rho*ct - 0 )/st;
         var tb = ( rho*ct - ( width - 1 ) )/st;
         tMin = Math.max( tMin, Math.min( ta, tb ) );
         tMax = Math.min( tMax, Math.max( ta, tb ) );
      }
      else if ( rho*ct < 0 || rho*ct > width - 1 )
         return null;
      if ( Math.abs( ct ) > 1e-12 )
      {
         var tc = ( 0 - rho*st )/ct;
         var td = ( ( height - 1 ) - rho*st )/ct;
         tMin = Math.max( tMin, Math.min( tc, td ) );
         tMax = Math.min( tMax, Math.max( tc, td ) );
      }
      else if ( rho*st < 0 || rho*st > height - 1 )
         return null;
      if ( !( tMax > tMin ) )
         return null;

      var t0 = Math.ceil( tMin ), t1 = Math.floor( tMax );
      var hits = [];
      for ( var t = t0; t <= t1; ++t )
      {
         var x = rho*ct - t*st;
         var y = rho*st + t*ct;
         var hit = false;
         for ( var o = -perpTol; o <= perpTol && !hit; ++o )
         {
            var xi = Math.round( x + o*ct );
            var yi = Math.round( y + o*st );
            if ( xi >= 0 && xi < width && yi >= 0 && yi < height && map[yi*width + xi] )
               hit = true;
         }
         hits.push( hit );
      }

      var run = bestRun( hits, gapTol );
      if ( run === null )
         return null;
      var tA = t0 + run.start, tB = t0 + run.end;
      return { x1: rho*ct - tA*st, y1: rho*st + tA*ct,
               x2: rho*ct - tB*st, y2: rho*st + tB*ct,
               length: run.length, hitCount: run.hitCount, fill: run.fill };
   }

   function eraseCorridor( map, width, height, thetaDeg, rho, halfWidth )
   {
      // Zero every pixel within halfWidth of the accepted line so the next
      // iteration finds the next trail instead of the same one.
      var th = thetaDeg*Math.PI/180;
      var ct = Math.cos( th ), st = Math.sin( th );
      for ( var y = 0; y < height; ++y )
      {
         var row = y*width;
         for ( var x = 0; x < width; ++x )
            if ( map[row + x] && Math.abs( x*ct + y*st - rho ) <= halfWidth )
               map[row + x] = 0;
      }
   }

   // ------------------------------------------------------------------------
   // Detection driver (binned coordinates)

   function normalizeAngleDeg( a )
   {
      a = a % 180;
      if ( a < 0 )
         a += 180;
      return a;
   }

   function detectCore( data, width, height, params )
   {
      var p = {};
      for ( var k in DEFAULTS )
         p[k] = ( params && params[k] !== undefined ) ? params[k] : DEFAULTS[k];

      var mm = medianMAD( data, 500000 );
      var at = adaptiveThreshold( data, mm.median, mm.mad, p.kSigma, p.maxAboveFrac );
      var map = buildBinaryMap( data, at.threshold );

      var diag = Math.sqrt( width*width + height*height );
      var minLen = p.minLengthFrac*diag;
      var peakMin = Math.max( 10, Math.round( minLen*p.fillRatioMin*0.5 ) );

      var trails = [];
      for ( var iter = 0; iter < p.maxTrails; ++iter )
      {
         var hough = houghTransform( map, width, height );
         var accepted = null;
         for ( var c = 0; c < p.maxPeekCandidates; ++c )
         {
            var peak = findPeak( hough );
            if ( peak === null || peak.count < peakMin )
               break;
            var run = lineRun( map, width, height, peak.thetaDeg, peak.rho, p.perpTol, p.gapTol );
            if ( run !== null && run.length >= minLen && run.fill >= p.fillRatioMin )
            {
               accepted = { run: run, thetaDeg: peak.thetaDeg, rho: peak.rho };
               break;
            }
            suppressPeak( hough, peak.thetaDeg, peak.rho, 2, 3 );
         }
         if ( accepted === null )
            break;

         var seg = accepted.run;
         var dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
         trails.push( {
            x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2,
            lengthPx: Math.sqrt( dx*dx + dy*dy ),
            angleDeg: normalizeAngleDeg( Math.atan2( dy, dx )*180/Math.PI ),
            fill: seg.fill,
            // score in (0,1]: fill blended with the run length, saturating
            // at half a diagonal
            score: seg.fill*Math.min( 1, 2*seg.length/diag )
         } );

         eraseCorridor( map, width, height, accepted.thetaDeg, accepted.rho, p.corridorHalfWidth );
      }

      return {
         trails: trails,
         stats: { median: mm.median, mad: mm.mad,
                  threshold: at.threshold, aboveFrac: at.aboveFrac, kUsed: at.kUsed }
      };
   }

   function scaleSegment( seg, binFactor )
   {
      // Binned -> full-resolution pixels, centered on the binned cell.
      var half = binFactor/2;
      return { x1: seg.x1*binFactor + half, y1: seg.y1*binFactor + half,
               x2: seg.x2*binFactor + half, y2: seg.y2*binFactor + half,
               lengthPx: seg.lengthPx*binFactor };
   }

   // ------------------------------------------------------------------------
   // Photometry helpers

   function fwhmOfProfile( profile )
   {
      // FWHM of a 1-px-step perpendicular profile: background from the
      // profile ends, peak from the maximum, half-max crossings by linear
      // interpolation. Returns 0 when there is no peak above background.
      var n = profile.length;
      if ( n < 3 )
         return 0;
      var bg = Math.min( profile[0], profile[n - 1] );
      var peak = profile[0], pi = 0;
      for ( var i = 1; i < n; ++i )
         if ( profile[i] > peak )
         {
            peak = profile[i];
            pi = i;
         }
      if ( !( peak > bg ) )
         return 0;
      var half = bg + ( peak - bg )/2;

      var left = 0;
      for ( var i = pi; i > 0; --i )
         if ( profile[i - 1] < half )
         {
            left = ( i - 1 ) + ( half - profile[i - 1] )/( profile[i] - profile[i - 1] );
            break;
         }
      var right = n - 1;
      for ( var i = pi; i < n - 1; ++i )
         if ( profile[i + 1] < half )
         {
            right = ( i + 1 ) - ( half - profile[i + 1] )/( profile[i] - profile[i + 1] );
            break;
         }
      return right - left;
   }

   return {
      DEFAULTS: DEFAULTS,
      medianOf: medianOf,
      madOf: madOf,
      meanOf: meanOf,
      medianMAD: medianMAD,
      binImage: binImage,
      adaptiveThreshold: adaptiveThreshold,
      buildBinaryMap: buildBinaryMap,
      houghTransform: houghTransform,
      findPeak: findPeak,
      suppressPeak: suppressPeak,
      bestRun: bestRun,
      lineRun: lineRun,
      eraseCorridor: eraseCorridor,
      detectCore: detectCore,
      scaleSegment: scaleSegment,
      fwhmOfProfile: fwhmOfProfile
   };
} )();

// ---------------------------------------------------------------------------

var SITrailDetect = ( function()
{
   var SCALE = 65535;
   var MAX_SMALL_SIDE = 1500;

   function samplePerpMax( image, x, y, px, py, perpTol, width, height )
   {
      // Max sample within perpTol px across the trail — robust to the
      // trail not being perfectly straight at full resolution.
      var v = -1;
      for ( var o = -perpTol; o <= perpTol; ++o )
      {
         var xi = Math.round( x + px*o );
         var yi = Math.round( y + py*o );
         if ( xi >= 0 && xi < width && yi >= 0 && yi < height )
         {
            var s = image.sample( xi, yi, 0 );
            if ( s > v )
               v = s;
         }
      }
      return v;
   }

   function measureTrail( image, seg )
   {
      // Full-resolution photometry along the accepted segment.
      var width = image.width, height = image.height;
      var dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
      var len = Math.sqrt( dx*dx + dy*dy );
      if ( len <= 0 )
         return { meanFluxAdu: 0, brightnessVariation: 0, widthPx: 0 };
      var ux = dx/len, uy = dy/len;
      var px = -uy, py = ux; // unit perpendicular

      // 64 stations along the trail; per station keep the max of a 3-px
      // perpendicular probe.
      var samples = [];
      var nStations = 64;
      for ( var i = 0; i < nStations; ++i )
      {
         var t = ( i + 0.5 )/nStations;
         var v = samplePerpMax( image, seg.x1 + dx*t, seg.y1 + dy*t, px, py, 1, width, height );
         if ( v >= 0 )
            samples.push( v );
      }
      var med = SITrailCore.medianOf( samples );
      var meanFluxAdu = SITrailCore.meanOf( samples )*SCALE;
      var brightnessVariation = ( med > 0 ) ? SITrailCore.madOf( samples )/med : 0;

      // Width: mean FWHM of a 7-px perpendicular profile at 8 stations.
      var widths = [];
      for ( var s = 0; s < 8; ++s )
      {
         var ts = ( s + 0.5 )/8;
         var cx = seg.x1 + dx*ts, cy = seg.y1 + dy*ts;
         var profile = [];
         for ( var o = -3; o <= 3; ++o )
         {
            var xi = Math.round( cx + px*o );
            var yi = Math.round( cy + py*o );
            if ( xi >= 0 && xi < width && yi >= 0 && yi < height )
               profile.push( image.sample( xi, yi, 0 ) );
         }
         var f = SITrailCore.fwhmOfProfile( profile );
         if ( f > 0 )
            widths.push( f );
      }
      var widthPx = ( widths.length > 0 ) ? SITrailCore.meanOf( widths ) : 0;

      return { meanFluxAdu: meanFluxAdu, brightnessVariation: brightnessVariation, widthPx: widthPx };
   }

   function detect( image, params )
   {
      var width = image.width, height = image.height;
      var binFactor = Math.max( 1, Math.ceil( Math.max( width, height )/MAX_SMALL_SIDE ) );

      // Pull pixels in horizontal strips (channel 0) and bin in JS;
      // processEvents every 32 strips keeps the GUI alive.
      var stripCount = 0;
      var getStrip = function( y0, rows )
      {
         var a = [];
         image.getSamples( a, new Rect( 0, y0, width, y0 + rows ), 0 );
         if ( ( ++stripCount & 31 ) === 0 )
            processEvents();
         return a;
      };

      var small = SITrailCore.binImage( width, height, binFactor, getStrip, null );
      var core = SITrailCore.detectCore( small.data, small.width, small.height, params );

      var trails = [];
      for ( var i = 0; i < core.trails.length; ++i )
      {
         var t = core.trails[i];
         var seg = SITrailCore.scaleSegment( t, binFactor );
         var phot = measureTrail( image, seg );
         trails.push( {
            x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2,
            lengthPx: seg.lengthPx,
            angleDeg: t.angleDeg,
            meanFluxAdu: phot.meanFluxAdu,
            widthPx: phot.widthPx,
            brightnessVariation: phot.brightnessVariation,
            score: t.score
         } );
         processEvents();
      }

      return {
         trails: trails,
         stats: {
            medianAdu: core.stats.median*SCALE,
            madAdu: core.stats.mad*SCALE,
            binFactor: binFactor,
            thresholdAdu: core.stats.threshold*SCALE
         }
      };
   }

   return { detect: detect };
} )();
