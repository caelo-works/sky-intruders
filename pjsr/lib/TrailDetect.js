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

   function segmentCorridorSum( data, width, height, seg, halfW )
   {
      // Integral of data in a corridor of half-width halfW around the
      // SEGMENT (not the full line), plus the pixel count.
      var dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
      var len = Math.sqrt( dx*dx + dy*dy );
      if ( len < 1 )
         return { sum: 0, count: 0 };
      var ux = dx/len, uy = dy/len;
      var sum = 0, count = 0;
      for ( var t = 0; t <= Math.round( len ); ++t )
      {
         var x = seg.x1 + ux*t, y = seg.y1 + uy*t;
         for ( var o = -halfW; o <= halfW; ++o )
         {
            var xi = Math.round( x - uy*o );
            var yi = Math.round( y + ux*o );
            if ( xi >= 0 && xi < width && yi >= 0 && yi < height )
            {
               sum += data[yi*width + xi];
               ++count;
            }
         }
      }
      return { sum: sum, count: count };
   }

   function lineEmptiness( data, width, height, seg )
   {
      // Along-segment occupancy statistics in the CLAMPED residual:
      // zeroFrac — fraction of exactly-empty pixels (clamped Gaussian noise
      // is zero half the time; a continuous trail is not), and meanNonZero —
      // mean of the occupied pixels (noise occupies at ~0.8 sigma; the dashes
      // of a flashing satellite are bright). A chance noise line is BOTH
      // holey and faint; a real trail fails at least one of the two.
      var dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
      var len = Math.sqrt( dx*dx + dy*dy );
      if ( len < 1 )
         return { zeroFrac: 1, meanNonZero: 0 };
      var zeros = 0, n = 0, sum = 0;
      for ( var t = 0; t <= Math.round( len ); ++t )
      {
         var x = Math.round( seg.x1 + dx*t/len );
         var y = Math.round( seg.y1 + dy*t/len );
         if ( x < 0 || y < 0 || x >= width || y >= height )
            continue;
         ++n;
         var v = data[y*width + x];
         if ( v <= 0 )
            ++zeros;
         else
            sum += v;
      }
      if ( n === 0 )
         return { zeroFrac: 1, meanNonZero: 0 };
      var occupied = n - zeros;
      return { zeroFrac: zeros/n, meanNonZero: ( occupied > 0 ) ? sum/occupied : 0 };
   }

   function isNoiseLine( data, width, height, seg, sigma )
   {
      // The combined rule: reject only what is holey AND faint.
      var e = lineEmptiness( data, width, height, seg );
      // Bar at 1.35 sigma: clamped noise occupies at ~1.0-1.15 sigma; the
      // dashes of a faint flasher sit at ~1.5+ and must survive.
      return e.zeroFrac > 0.38 && e.meanNonZero < 1.35*sigma;
   }

   function lineEdgeAffinity( mask, width, height, seg, dist )
   {
      // Fraction of the segment that HUGS invalid territory: a sample
      // counts when a pixel at +-dist across the line is masked or outside
      // the image. Coverage-transition bands (where the frame sets of the
      // two nights meet) leave photometric ridges exactly along the mask
      // border; a real trail may CROSS a border but never runs along it.
      var dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
      var len = Math.sqrt( dx*dx + dy*dy );
      if ( len < 1 )
         return 1;
      var ux = dx/len, uy = dy/len;
      var hug = 0, n = 0;
      for ( var t = 0; t <= Math.round( len ); t += 2 )
      {
         var x = seg.x1 + ux*t, y = seg.y1 + uy*t;
         ++n;
         var bad = false;
         for ( var s = -1; s <= 1 && !bad; s += 2 )
         {
            var xi = Math.round( x - uy*dist*s );
            var yi = Math.round( y + ux*dist*s );
            if ( xi < 0 || yi < 0 || xi >= width || yi >= height ||
                 ( mask && !mask[yi*width + xi] ) )
               bad = true;
         }
         if ( bad )
            ++hug;
      }
      return ( n > 0 ) ? hug/n : 1;
   }

   function corridorConcentration( data, width, height, seg, mu )
   {
      // How much of the excess flux around the segment concentrates in a
      // thin (±1 px) corridor versus a wide (±7 px) one. A real streak is
      // 1-3 px wide -> ratio near 1; diffuse residual structure (nebula
      // mottle after imperfect subtraction) fills the wide corridor too ->
      // ratio near the width ratio (~0.2). Chance lines through blob fields
      // are killed here.
      var thin = segmentCorridorSum( data, width, height, seg, 1 );
      var wide = segmentCorridorSum( data, width, height, seg, 7 );
      var excThin = thin.sum - mu*thin.count;
      var excWide = wide.sum - mu*wide.count;
      if ( excWide <= 0 )
         return 1; // no diffuse background to hide in
      return excThin/excWide;
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

   function detectCore( data, width, height, params, acceptSeg )
   {
      var p = {};
      for ( var k in DEFAULTS )
         p[k] = ( params && params[k] !== undefined ) ? params[k] : DEFAULTS[k];

      // On a zero-clamped residual the median/MAD estimate collapses (half
      // the pixels are exactly zero, so the MAD tends to zero and the
      // adaptive loop silently lands at an ~1.4-sigma effective threshold).
      // Callers working on clamped data pass the noise level explicitly.
      var mm = ( params && params.noiseOverride )
         ? { median: params.noiseOverride.median || 0, mad: params.noiseOverride.sigma }
         : medianMAD( data, 500000 );
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
            if ( run !== null && run.length >= minLen && run.fill >= p.fillRatioMin &&
                 ( acceptSeg === undefined || acceptSeg( run ) ) )
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

   function medianStackMasked( arrays, eps, minCover )
   {
      // Per-pixel median across N same-length arrays IGNORING empty pixels
      // (registration borders are zero-filled, and a zero must never vote:
      // it would drag the model low and let the static sky leak back into
      // the residual). Returns the model plus a validity mask: a pixel needs
      // at least 3 covering frames for its median to be trustworthy.
      var n = arrays.length;
      if ( n === 0 )
         return null;
      if ( !( eps > 0 ) )
         eps = 1e-6;
      var len = arrays[0].length;
      var model = new Float32Array( len );
      var valid = new Uint8Array( len );
      var v = new Float64Array( n );
      for ( var i = 0; i < len; ++i )
      {
         var m = 0;
         for ( var a = 0; a < n; ++a )
         {
            var x = arrays[a][i];
            if ( x > eps )
               v[m++] = x;
         }
         if ( m < ( ( minCover >= 3 ) ? minCover : 3 ) )
            continue;
         // insertion sort — m is at most the frame count (tiny)
         for ( var a2 = 1; a2 < m; ++a2 )
         {
            var x2 = v[a2];
            var b = a2 - 1;
            while ( b >= 0 && v[b] > x2 )
            {
               v[b + 1] = v[b];
               --b;
            }
            v[b + 1] = x2;
         }
         var mid = m >> 1;
         model[i] = ( m % 2 !== 0 ) ? v[mid] : ( v[mid - 1] + v[mid] )/2;
         valid[i] = 1;
      }
      return { model: model, valid: valid };
   }

   function medianStack( arrays )
   {
      var r = medianStackMasked( arrays, 0 );
      return ( r === null ) ? null : r.model;
   }

   function linearFitToModel( data, model, valid, eps )
   {
      // Photometric normalization: least-squares a,b such that a*data + b
      // best matches the model over the commonly-covered pixels, with one
      // 3-sigma rejection pass (transients and bright residues must not
      // steer the fit). Sky transparency varies frame to frame — the nebula
      // is multiplicatively brighter through a clearer sky, and without this
      // the static-sky median leaks structured residuals into the diff.
      if ( !( eps > 0 ) )
         eps = 1e-6;
      var n = data.length;
      var step = ( n > 400000 ) ? Math.ceil( n/400000 ) : 1;

      function pass( rejectA, rejectB, rejectSigma )
      {
         var sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
         for ( var i = 0; i < n; i += step )
         {
            var x = data[i], y = model[i];
            if ( x <= eps || y <= eps || ( valid && !valid[i] ) )
               continue;
            if ( rejectSigma > 0 && Math.abs( rejectA*x + rejectB - y ) > rejectSigma )
               continue;
            sx += x;
            sy += y;
            sxx += x*x;
            sxy += x*y;
            ++m;
         }
         if ( m < 100 )
            return null;
         var det = m*sxx - sx*sx;
         if ( Math.abs( det ) < 1e-20 )
            return null;
         var a = ( m*sxy - sx*sy )/det;
         var b = ( sy*sxx - sx*sxy )/det;
         // residual sigma for the rejection pass
         var rss = 0, m2 = 0;
         for ( var i2 = 0; i2 < n; i2 += step*4 )
         {
            var x2 = data[i2], y2 = model[i2];
            if ( x2 <= eps || y2 <= eps || ( valid && !valid[i2] ) )
               continue;
            var r = a*x2 + b - y2;
            rss += r*r;
            ++m2;
         }
         return { a: a, b: b, sigma: ( m2 > 10 ) ? Math.sqrt( rss/m2 ) : 0 };
      }

      var fit = pass( 0, 0, 0 );
      if ( fit === null )
         return { a: 1, b: 0 };
      if ( fit.sigma > 0 )
      {
         var fit2 = pass( fit.a, fit.b, 3*fit.sigma );
         if ( fit2 !== null )
            fit = fit2;
      }
      return { a: fit.a, b: fit.b };
   }

   function applyLinear( data, a, b, eps )
   {
      // a*data + b on covered pixels; empty (border) pixels stay empty.
      if ( !( eps > 0 ) )
         eps = 1e-6;
      var out = new Float32Array( data.length );
      for ( var i = 0; i < data.length; ++i )
         if ( data[i] > eps )
         {
            var v = a*data[i] + b;
            out[i] = ( v > eps ) ? v : eps*2; // keep covered pixels nonzero
         }
      return out;
   }

   function erodeMask( mask, width, height, radius )
   {
      // Shrink the valid region by `radius` pixels (4-neighborhood passes):
      // binning smears a hard border across a cell and resampling adds its
      // own transition ring, so the last few cells next to any invalid
      // pixel cannot be trusted either.
      var cur = mask;
      for ( var pass = 0; pass < radius; ++pass )
      {
         var next = new Uint8Array( cur.length );
         for ( var y = 0; y < height; ++y )
         {
            var row = y*width;
            for ( var x = 0; x < width; ++x )
            {
               if ( !cur[row + x] )
                  continue;
               if ( x === 0 || y === 0 || x === width - 1 || y === height - 1 )
                  continue;
               if ( cur[row + x - 1] && cur[row + x + 1] &&
                    cur[row + x - width] && cur[row + x + width] )
                  next[row + x] = 1;
            }
         }
         cur = next;
      }
      return cur;
   }

   function subtractSigned( data, model, mask )
   {
      // Signed residual (no clamp): the stage where high-pass flattening is
      // legitimate — noise stays centered, so clamping AFTER the flatten
      // restores the exact half-normal statistics the calibrations assume.
      var out = new Float32Array( data.length );
      for ( var i = 0; i < data.length; ++i )
      {
         if ( mask !== undefined && mask !== null && !mask[i] )
            continue;
         if ( data[i] <= 1e-6 || model[i] <= 1e-6 )
            continue;
         out[i] = data[i] - model[i];
      }
      return out;
   }

   function subtractModel( data, model, mask )
   {
      // Positive residual of a frame against the static-sky model. Pixels
      // outside the frame's own coverage or outside the model's validity
      // mask are neutralized (fake positive edges along registration
      // borders would otherwise be detected as perfectly straight trails).
      var len = data.length;
      var out = new Float32Array( len );
      for ( var i = 0; i < len; ++i )
      {
         if ( mask !== undefined && mask !== null && !mask[i] )
            continue;
         var d = data[i], m = model[i];
         if ( d <= 1e-6 || m <= 1e-6 )
            continue;
         var r = d - m;
         out[i] = ( r > 0 ) ? r : 0;
      }
      return out;
   }

   // ------------------------------------------------------------------------
   // Faint-streak pass: weighted (gray-level) Hough on the difference image.
   //
   // A narrowband satellite trail can sit at ~0.4 sigma per binned pixel —
   // no per-pixel threshold sees it, but integrated along its length it is
   // a 10-20 sigma event. So: z-normalize the residual (capped, so a bright
   // star residue cannot fake a line), accumulate z along every (theta,rho),
   // box-smooth each theta row across rho (an edge-to-edge trail drifts
   // through ~L*sin(0.5 deg) rho bins at 1-degree theta resolution), and
   // accept peaks that beat the noise expectation mu1*L by kLine sigmas of
   // sigma1*sqrt(smooth*L). Endpoints come from the cumulative-sum extrema
   // of the perpendicular-max profile (CUSUM change points — robust for
   // signals far below the pixel noise), validated for uniformity in chunks.

   var FAINT_DEFAULTS = {
      faintKLine: 6.0,      // refined line-integral significance (sigmas);
                            // calibrated (lattice-free RNG): 0 false
                            // positives on pure noise, 100% recovery of
                            // 0.5-sigma-per-pixel trails
      faintZCap: 4,         // z-value ceiling per pixel
      faintZMin: 0.5,       // pixels fainter than this contribute nothing
      faintSmooth: 7,       // rho box-smooth window (odd)
      faintMaxTrails: 8,
      faintChunks: 6,       // uniformity segments along the accepted run
      faintChunkMinFrac: 0.75,
      faintFlattenRadius: 0, // high-pass box radius (0 = caller already flattened)
      minLengthFrac: 0.15,  // shared with the bright pass
      maxPeekCandidates: 30
   };

   function boxBlurSubtract( data, width, height, radius )
   {
      // High-pass: subtract a (2r+1)^2 box mean, clamp at zero. A 1-3 px
      // streak keeps ~93% of its amplitude; diffuse residual structure at
      // the box scale (nebula mottle the median model could not fully
      // remove) is flattened away — otherwise its Hough peaks span tens of
      // degrees and exhaust the faint-pass candidate budget before any real
      // trail is even proposed.
      // Validity-aware box mean: exact zeros are masked/empty pixels and
      // must not vote, or the mean sags near every mask border and
      // data - mean grows a positive halo along all edges — which then
      // exhausts the faint-pass candidate budget on edge-hugging lines.
      var sumH = new Float64Array( data.length );
      var cntH = new Int32Array( data.length );
      for ( var y = 0; y < height; ++y )
      {
         var row = y*width;
         var s = 0, m = 0;
         for ( var x0 = 0; x0 <= Math.min( radius, width - 1 ); ++x0 )
         {
            var v0 = data[row + x0];
            if ( v0 !== 0 ) { s += v0; ++m; }
         }
         for ( var x = 0; x < width; ++x )
         {
            sumH[row + x] = s;
            cntH[row + x] = m;
            var hiN = x + 1 + radius;
            if ( hiN <= width - 1 )
            {
               var vA = data[row + hiN];
               if ( vA !== 0 ) { s += vA; ++m; }
            }
            if ( x - radius >= 0 )
            {
               var vR = data[row + x - radius];
               if ( vR !== 0 ) { s -= vR; --m; }
            }
         }
      }
      var out = new Float32Array( data.length );
      for ( var xc = 0; xc < width; ++xc )
      {
         var s2 = 0, m2 = 0;
         for ( var y0 = 0; y0 <= Math.min( radius, height - 1 ); ++y0 )
         {
            s2 += sumH[y0*width + xc];
            m2 += cntH[y0*width + xc];
         }
         for ( var yy = 0; yy < height; ++yy )
         {
            var d = data[yy*width + xc];
            if ( d !== 0 && m2 > 0 )
            {
               var v = d - s2/m2;
               out[yy*width + xc] = ( v > 0 ) ? v : 0;
            }
            var hiN2 = yy + 1 + radius;
            if ( hiN2 <= height - 1 )
            {
               s2 += sumH[hiN2*width + xc];
               m2 += cntH[hiN2*width + xc];
            }
            if ( yy - radius >= 0 )
            {
               s2 -= sumH[( yy - radius )*width + xc];
               m2 -= cntH[( yy - radius )*width + xc];
            }
         }
      }
      return out;
   }

   function noiseSigmaFromPositives( data )
   {
      // The residual is clamped at zero, so estimate the noise from the
      // positive half-distribution: median(positives) = 0.674 sigma for a
      // half-normal.
      var pos = [];
      for ( var i = 0; i < data.length; i += ( data.length > 500000 ? 2 : 1 ) )
         if ( data[i] > 0 )
            pos.push( data[i] );
      if ( pos.length < 100 )
         return 0;
      return medianOf( pos )/0.674;
   }

   function houghWeighted( z, width, height, zMin )
   {
      var nTheta = 180;
      var diag = Math.ceil( Math.sqrt( width*width + height*height ) );
      var nRho = 2*diag + 1;
      var acc = new Float64Array( nTheta*nRho );
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
         {
            var v = z[row + x];
            if ( v < zMin )
               continue;
            for ( var t2 = 0; t2 < nTheta; ++t2 )
            {
               var r = Math.round( x*cosT[t2] + y*sinT[t2] ) + diag;
               acc[t2*nRho + r] += v;
            }
         }
      }
      return { acc: acc, nTheta: nTheta, nRho: nRho, rhoOffset: diag };
   }

   function lineLengthTable( width, height, nTheta, nRho, rhoOffset )
   {
      // In-image line length per (theta, rho) accumulator bin.
      var L = new Int32Array( nTheta*nRho );
      for ( var t = 0; t < nTheta; ++t )
         for ( var r = 0; r < nRho; ++r )
         {
            var ext = lineExtent( width, height, t, r - rhoOffset );
            L[t*nRho + r] = ( ext !== null ) ? ( ext.t1 - ext.t0 + 1 ) : 0;
         }
      return L;
   }

   function normalizeToSignificance( hough, lengthTable, window, mu1, sigma1, minLen )
   {
      // Convert the smoothed accumulator to per-bin SIGNIFICANCE.
      // Raw sums grow with line length, so peak-by-sum systematically
      // proposes long diagonals of pure noise before a shorter real trail —
      // a streak partially eaten by a nebula shadow never surfaces within
      // the candidate budget. Normalized, the strongest EVIDENCE wins.
      var acc = hough.acc;
      for ( var i = 0; i < acc.length; ++i )
      {
         var L = lengthTable[i];
         if ( L < minLen )
         {
            acc[i] = 0;
            continue;
         }
         var s = ( acc[i] - mu1*L*window )/( sigma1*Math.sqrt( L*window ) );
         acc[i] = ( s > 0 ) ? s : 0;
      }
   }

   function smoothRhoRows( hough, window )
   {
      // Box-smooth each theta row along rho (sliding sum, not average: the
      // significance test expects the summed weight of a `window`-wide
      // corridor).
      var half = window >> 1;
      var out = new Float64Array( hough.acc.length );
      for ( var t = 0; t < hough.nTheta; ++t )
      {
         var base = t*hough.nRho;
         var sum = 0;
         for ( var r = 0; r < hough.nRho; ++r )
         {
            sum += hough.acc[base + r];
            if ( r - window >= 0 )
               sum -= hough.acc[base + r - window];
            if ( r - half >= 0 )
               out[base + r - half] = sum;
         }
      }
      return { acc: out, nTheta: hough.nTheta, nRho: hough.nRho, rhoOffset: hough.rhoOffset };
   }

   function lineExtent( width, height, thetaDeg, rho )
   {
      // Range of the line parameter t inside the image, or null.
      var th = thetaDeg*Math.PI/180;
      var ct = Math.cos( th ), st = Math.sin( th );
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
      return { t0: Math.ceil( tMin ), t1: Math.floor( tMax ), ct: ct, st: st };
   }

   function corridorSum( z, width, height, thetaDeg, rho, halfW )
   {
      // Direct integral of z along the (float) line, corridor width
      // 2*halfW+1, plus the pixel count actually summed.
      var ext = lineExtent( width, height, thetaDeg, rho );
      if ( ext === null )
         return null;
      var sum = 0, count = 0;
      for ( var t = ext.t0; t <= ext.t1; ++t )
      {
         var x = rho*ext.ct - t*ext.st;
         var y = rho*ext.st + t*ext.ct;
         for ( var o = -halfW; o <= halfW; ++o )
         {
            var xi = Math.round( x + o*ext.ct );
            var yi = Math.round( y + o*ext.st );
            if ( xi >= 0 && xi < width && yi >= 0 && yi < height )
            {
               sum += z[yi*width + xi];
               ++count;
            }
         }
      }
      return { sum: sum, count: count, length: ext.t1 - ext.t0 + 1 };
   }

   function refineLine( z, width, height, thetaDeg, rho, mu1, sigma1 )
   {
      // Sub-degree, sub-pixel re-fit around a coarse Hough candidate: a real
      // trail concentrates its flux into a narrow corridor once the line is
      // aligned (drift over an edge-to-edge run at 1-degree theta resolution
      // spans several rho bins), while a noise peak does not refine
      // coherently. Returns the best refined line and its significance over
      // a 3-wide corridor.
      var best = null;
      for ( var dt = -0.9; dt <= 0.901; dt += 0.15 )
         for ( var dr = -3; dr <= 3.01; dr += 0.5 )
         {
            var cs = corridorSum( z, width, height, thetaDeg + dt, rho + dr, 1 );
            if ( cs === null || cs.count < 10 )
               continue;
            var signif = ( cs.sum - mu1*cs.count )/( sigma1*Math.sqrt( cs.count ) );
            if ( best === null || signif > best.signif )
               best = { thetaDeg: thetaDeg + dt, rho: rho + dr, signif: signif,
                        length: cs.length };
         }
      return best;
   }

   function faintProfile( z, width, height, ext, rho, perpTol )
   {
      // Perpendicular-max z profile along the line, one sample per t step.
      var g = [];
      for ( var t = ext.t0; t <= ext.t1; ++t )
      {
         var x = rho*ext.ct - t*ext.st;
         var y = rho*ext.st + t*ext.ct;
         var best = 0;
         for ( var o = -perpTol; o <= perpTol; ++o )
         {
            var xi = Math.round( x + o*ext.ct );
            var yi = Math.round( y + o*ext.st );
            if ( xi >= 0 && xi < width && yi >= 0 && yi < height )
            {
               var v = z[yi*width + xi];
               if ( v > best )
                  best = v;
            }
         }
         g.push( best );
      }
      return g;
   }

   function quantileOf( arr, q )
   {
      if ( arr.length === 0 )
         return 0;
      var s = Array.prototype.slice.call( arr ).sort( function( a, b ) { return a - b; } );
      var i = Math.max( 0, Math.min( s.length - 1, Math.floor( q*s.length ) ) );
      return s[i];
   }

   function cusumEndpoints( g, baseline )
   {
      // Cumulative sum of (g - baseline): the signal run is bracketed by
      // the argmin and argmax of the cumulative series.
      var cs = 0, csMin = 0, csMax = -Infinity;
      var iMin = 0, iMax = 0;
      for ( var i = 0; i < g.length; ++i )
      {
         cs += g[i] - baseline;
         if ( cs < csMin )
         {
            csMin = cs;
            iMin = i + 1;
         }
         if ( cs > csMax )
         {
            csMax = cs;
            iMax = i;
         }
      }
      if ( iMax <= iMin )
         return null;
      return { start: iMin, end: iMax };
   }

   function detectFaintCore( diff, width, height, params )
   {
      var p = {};
      for ( var k in FAINT_DEFAULTS )
         p[k] = ( params && params[k] !== undefined ) ? params[k] : FAINT_DEFAULTS[k];
      // Optional diagnosis channel: every candidate examined and the reason
      // it was rejected land here (params.trace = []).
      var trace = ( params && params.trace ) ? params.trace : null;
      function tr( peak, reason, extra )
      {
         if ( trace )
            trace.push( { thetaDeg: peak.thetaDeg, rho: peak.rho, reason: reason,
                          extra: ( extra === undefined ) ? null : extra } );
      }

      // Flatten diffuse residual structure first (see boxBlurSubtract).
      if ( p.faintFlattenRadius > 0 )
         diff = boxBlurSubtract( diff, width, height, p.faintFlattenRadius );

      var sigma = noiseSigmaFromPositives( diff );
      if ( !( sigma > 0 ) )
         return { trails: [], sigma: 0 };

      // Capped z map + its noise moments over ALL pixels (zeros included),
      // which is what a random line collects per unit length.
      var n = diff.length;
      var z = new Float32Array( n );
      var sum1 = 0, sum2 = 0, sumZ = 0;
      for ( var i = 0; i < n; ++i )
      {
         var v = diff[i]/sigma;
         if ( v > p.faintZCap )
            v = p.faintZCap;
         z[i] = v;
         sumZ += v;
         var c = ( v >= p.faintZMin ) ? v : 0;
         sum1 += c;
         sum2 += c*c;
      }
      var mu1 = sum1/n;
      var muZ = sumZ/n;
      var sigma1 = Math.sqrt( Math.max( 1e-12, sum2/n - mu1*mu1 ) );
      // full-z moments for the refinement stage: corridorSum integrates the
      // RAW z (no zMin cut), so its expectation is muZ, not mu1 — mixing the
      // two adds ~0.1 sigma per pixel and lets refined noise reach 15+ sigma.
      var sumZ2 = 0;
      for ( var i2 = 0; i2 < n; ++i2 )
         sumZ2 += z[i2]*z[i2];
      var sigmaZ = Math.sqrt( Math.max( 1e-12, sumZ2/n - muZ*muZ ) );

      var diag = Math.sqrt( width*width + height*height );
      var minLen = p.minLengthFrac*diag;
      var lengthTable = lineLengthTable( width, height, 180,
                                         2*Math.ceil( diag ) + 1, Math.ceil( diag ) );

      var trails = [];
      for ( var iter = 0; iter < p.faintMaxTrails; ++iter )
      {
         var hough = smoothRhoRows( houghWeighted( z, width, height, p.faintZMin ), p.faintSmooth );
         // Peaks are proposed by SIGNIFICANCE, not raw sum (see
         // normalizeToSignificance) — stage 1 reads the peak value directly.
         normalizeToSignificance( hough, lengthTable, p.faintSmooth, mu1, sigma1, minLen );
         var accepted = null;
         for ( var cand = 0; cand < p.maxPeekCandidates; ++cand )
         {
            var peak = findPeak( hough );
            if ( peak === null || peak.count <= 0 )
               break;
            var ext = lineExtent( width, height, peak.thetaDeg, peak.rho );
            if ( ext === null )
            {
               tr( peak, "off-image" );
               suppressPeak( hough, peak.thetaDeg, peak.rho, 1, p.faintSmooth );
               continue;
            }
            var signif = peak.count;
            if ( signif < Math.max( 3.5, p.faintKLine - 2 ) )
            {
               tr( peak, "stage1-signif", Math.round( signif*100 )/100 );
               suppressPeak( hough, peak.thetaDeg, peak.rho, 1, p.faintSmooth );
               continue;
            }

            // Stage 2: sub-degree refinement must concentrate the flux.
            var refined = refineLine( z, width, height, peak.thetaDeg, peak.rho, muZ, sigmaZ );
            if ( refined === null || refined.signif < p.faintKLine ||
                 refined.length < minLen )
            {
               tr( peak, "stage2-refined", refined ? Math.round( refined.signif*100 )/100 : null );
               suppressPeak( hough, peak.thetaDeg, peak.rho, 1, p.faintSmooth );
               continue;
            }
            ext = lineExtent( width, height, refined.thetaDeg, refined.rho );
            if ( ext === null )
            {
               tr( peak, "refined-off-image" );
               suppressPeak( hough, peak.thetaDeg, peak.rho, 1, p.faintSmooth );
               continue;
            }
            signif = refined.signif;
            // The refined line geometry is sub-degree/sub-pixel (floats);
            // `peak` must stay INTEGER — suppressPeak indexes the
            // accumulator with it, and a fractional index silently writes
            // nowhere, so the rejected peak would be re-proposed forever.
            var refT = refined.thetaDeg, refRho = refined.rho;

            // Endpoints by CUSUM on the perpendicular-max profile; the
            // baseline is the profile's lower quartile (noise level even
            // when the trail covers most of the line).
            var perpTol = 2;
            var g = faintProfile( z, width, height, ext, refRho, perpTol );
            var baseline = quantileOf( g, 0.25 );
            var run = cusumEndpoints( g, baseline );
            if ( run === null || ( run.end - run.start + 1 ) < minLen )
            {
               tr( peak, "cusum-run-short", run ? run.end - run.start + 1 : null );
               suppressPeak( hough, peak.thetaDeg, peak.rho, 1, p.faintSmooth );
               continue;
            }

            // Thin-ness: the excess must concentrate in a narrow corridor,
            // or this is a chance line through diffuse residual structure.
            var tSa = ext.t0 + run.start, tSb = ext.t0 + run.end;
            var runSeg = { x1: refRho*ext.ct - tSa*ext.st, y1: refRho*ext.st + tSa*ext.ct,
                           x2: refRho*ext.ct - tSb*ext.st, y2: refRho*ext.st + tSb*ext.ct };
            if ( params && params.mask )
            {
               var hug = lineEdgeAffinity( params.mask, width, height, runSeg, 8 );
               if ( hug > 0.35 )
               {
                  tr( peak, "edge-line", Math.round( hug*100 )/100 );
                  suppressPeak( hough, peak.thetaDeg, peak.rho, 1, p.faintSmooth );
                  continue;
               }
            }
            var conc = corridorConcentration( z, width, height, runSeg, muZ );
            if ( conc < 0.45 )
            {
               tr( peak, "not-thin", Math.round( conc*100 )/100 );
               suppressPeak( hough, peak.thetaDeg, peak.rho, 1, p.faintSmooth );
               continue;
            }

            // Emptiness: a chance alignment through clamped noise is holey
            // AND faint; a continuous trail is not holey, a flasher's dashes
            // are not faint. Kills the chance lines that survive the
            // integral test on correlated real-world residuals. z is already
            // in sigma units.
            if ( isNoiseLine( z, width, height, runSeg, 1 ) )
            {
               var emp = lineEmptiness( z, width, height, runSeg );
               tr( peak, "noise-line", { zeroFrac: Math.round( emp.zeroFrac*100 )/100,
                                         meanNonZero: Math.round( emp.meanNonZero*100 )/100 } );
               suppressPeak( hough, peak.thetaDeg, peak.rho, 1, p.faintSmooth );
               continue;
            }

            // Uniformity: the excess must be spread along the run, not
            // packed into one bright blob.
            var runLen = run.end - run.start + 1;
            var chunkLen = Math.floor( runLen/p.faintChunks );
            var okChunks = 0;
            for ( var c2 = 0; c2 < p.faintChunks; ++c2 )
            {
               var a = run.start + c2*chunkLen;
               var b = ( c2 === p.faintChunks - 1 ) ? run.end + 1 : a + chunkLen;
               var s = 0;
               for ( var j = a; j < b; ++j )
                  s += g[j] - baseline;
               if ( s > 0 )
                  okChunks++;
            }
            if ( okChunks < Math.ceil( p.faintChunkMinFrac*p.faintChunks ) )
            {
               tr( peak, "not-uniform", okChunks );
               suppressPeak( hough, peak.thetaDeg, peak.rho, 1, p.faintSmooth );
               continue;
            }

            var tA = ext.t0 + run.start, tB = ext.t0 + run.end;
            tr( { thetaDeg: refT, rho: refRho }, "ACCEPTED", Math.round( signif*100 )/100 );
            accepted = {
               x1: refRho*ext.ct - tA*ext.st, y1: refRho*ext.st + tA*ext.ct,
               x2: refRho*ext.ct - tB*ext.st, y2: refRho*ext.st + tB*ext.ct,
               thetaDeg: refT, rho: refRho,
               signif: signif, length: runLen
            };
            break;
         }
         if ( accepted === null )
            break;

         var dx = accepted.x2 - accepted.x1, dy = accepted.y2 - accepted.y1;
         trails.push( {
            x1: accepted.x1, y1: accepted.y1, x2: accepted.x2, y2: accepted.y2,
            lengthPx: Math.sqrt( dx*dx + dy*dy ),
            angleDeg: normalizeAngleDeg( Math.atan2( dy, dx )*180/Math.PI ),
            fill: 1,
            faint: true,
            score: Math.min( 1, accepted.signif/( 4*p.faintKLine ) )
         } );

         // Erase the corridor in the z map and iterate.
         var th = accepted.thetaDeg*Math.PI/180;
         var ct2 = Math.cos( th ), st2 = Math.sin( th );
         var halfW = ( p.faintSmooth >> 1 ) + 1;
         for ( var y2 = 0; y2 < height; ++y2 )
         {
            var row2 = y2*width;
            for ( var x2 = 0; x2 < width; ++x2 )
               if ( z[row2 + x2] > 0 && Math.abs( x2*ct2 + y2*st2 - accepted.rho ) <= halfW )
                  z[row2 + x2] = 0;
         }
      }

      return { trails: trails, sigma: sigma };
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
      medianStack: medianStack,
      medianStackMasked: medianStackMasked,
      erodeMask: erodeMask,
      linearFitToModel: linearFitToModel,
      applyLinear: applyLinear,
      subtractModel: subtractModel,
      subtractSigned: subtractSigned,
      detectFaintCore: detectFaintCore,
      noiseSigmaFromPositives: noiseSigmaFromPositives,
      cusumEndpoints: cusumEndpoints,
      corridorConcentration: corridorConcentration,
      boxBlurSubtract: boxBlurSubtract,
      lineEmptiness: lineEmptiness,
      lineEdgeAffinity: lineEdgeAffinity,
      lineLengthTable: lineLengthTable,
      normalizeToSignificance: normalizeToSignificance,
      isNoiseLine: isNoiseLine,
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

   function binned( image )
   {
      // Binned working copy of an image (channel 0), the shared front end of
      // detect()/detectDiff(). Pulls pixels in horizontal strips and bins in
      // JS; processEvents every 32 strips keeps the GUI alive.
      var width = image.width, height = image.height;
      var binFactor = Math.max( 1, Math.ceil( Math.max( width, height )/MAX_SMALL_SIDE ) );
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
      return { data: small.data, width: small.width, height: small.height,
               binFactor: binFactor, srcW: width, srcH: height };
   }

   function finishDetection( image, core, binFactor )
   {
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

   function detect( image, params )
   {
      var b = binned( image );
      var core = SITrailCore.detectCore( b.data, b.width, b.height, params );
      return finishDetection( image, core, b.binFactor );
   }

   function eraseSegmentBinned( data, width, height, seg, halfW )
   {
      // Zero every pixel within halfW of the segment (binned coordinates),
      // bounding-box limited.
      var x1 = seg.x1, y1 = seg.y1, x2 = seg.x2, y2 = seg.y2;
      var dx = x2 - x1, dy = y2 - y1;
      var len2 = dx*dx + dy*dy;
      var x0 = Math.max( 0, Math.floor( Math.min( x1, x2 ) - halfW ) );
      var xN = Math.min( width - 1, Math.ceil( Math.max( x1, x2 ) + halfW ) );
      var y0 = Math.max( 0, Math.floor( Math.min( y1, y2 ) - halfW ) );
      var yN = Math.min( height - 1, Math.ceil( Math.max( y1, y2 ) + halfW ) );
      for ( var y = y0; y <= yN; ++y )
      {
         var row = y*width;
         for ( var x = x0; x <= xN; ++x )
         {
            var t = ( len2 > 0 ) ? Math.max( 0, Math.min( 1, ( ( x - x1 )*dx + ( y - y1 )*dy )/len2 ) ) : 0;
            var px = x1 + t*dx, py = y1 + t*dy;
            var ddx = x - px, ddy = y - py;
            if ( ddx*ddx + ddy*ddy <= halfW*halfW )
               data[row + x] = 0;
         }
      }
   }

   function detectDiff( image, binnedSelf, model, params, mask )
   {
      // Transient detection: subtract the static-sky model (per-pixel median
      // of the registered frame set, same binning) before thresholding, so
      // nebula and stars never reach the Hough stage. Two passes: the binary
      // pipeline for bright streaks (precise endpoints, fill validation),
      // then the weighted-Hough pass for streaks far below the per-pixel
      // noise. Photometry still runs on the full-resolution image.
      var signed = SITrailCore.subtractSigned( binnedSelf.data, model, mask );
      var diff = SITrailCore.boxBlurSubtract( signed, binnedSelf.width, binnedSelf.height, 7 );
      var muDiff = 0;
      for ( var d = 0; d < diff.length; ++d )
         muDiff += diff[d];
      muDiff /= diff.length;
      var sigmaDiff = SITrailCore.noiseSigmaFromPositives( diff );
      var thinOnly = function( run )
      {
         return SITrailCore.corridorConcentration( diff, binnedSelf.width, binnedSelf.height,
                                                   run, muDiff ) >= 0.45 &&
                !SITrailCore.isNoiseLine( diff, binnedSelf.width, binnedSelf.height,
                                          run, sigmaDiff ) &&
                ( !mask || SITrailCore.lineEdgeAffinity( mask, binnedSelf.width,
                                                         binnedSelf.height, run, 8 ) <= 0.35 );
      };
      params.noiseOverride = { median: 0, sigma: sigmaDiff };
      params.mask = mask;
      var core = SITrailCore.detectCore( diff, binnedSelf.width, binnedSelf.height, params, thinOnly );

      for ( var i = 0; i < core.trails.length; ++i )
         eraseSegmentBinned( diff, binnedSelf.width, binnedSelf.height, core.trails[i], 5 );
      processEvents();
      var faint = SITrailCore.detectFaintCore( diff, binnedSelf.width, binnedSelf.height, params );
      for ( var f = 0; f < faint.trails.length; ++f )
         core.trails.push( faint.trails[f] );

      var out = finishDetection( image, core, binnedSelf.binFactor );
      for ( var t = 0; t < out.trails.length; ++t )
         out.trails[t].faint = !!core.trails[t].faint;
      out.stats.faintSigmaAdu = faint.sigma*65535;
      return out;
   }

   return { detect: detect, binned: binned, detectDiff: detectDiff };
} )();
