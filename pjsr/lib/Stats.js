/*
 * Stats.js — SIStats: robust statistics for Sky Intruders.
 *
 * Ported from CaeloWorks dark-frame-analyzer. The pure-array helpers
 * (arrayMedian, arrayMAD, histogramMAD) run under plain Node for testing;
 * the image helpers need the PixInsight runtime (Histogram, Rect, range
 * clipping through the C++ engine). ADU values are PI samples x 65535.
 */

var SIStats = ( function()
{
   var SCALE = 65535;

   // ------------------------------------------------------------------------
   // Pure-array statistics (Node-testable)

   function arrayMedian( arr )
   {
      if ( arr.length === 0 )
         return 0;
      var sorted = Array.prototype.slice.call( arr ).sort( function( a, b ) { return a - b; } );
      var mid = Math.floor( sorted.length/2 );
      if ( sorted.length % 2 !== 0 )
         return sorted[mid];
      return ( sorted[mid - 1] + sorted[mid] )/2.0;
   }

   function arrayMAD( arr )
   {
      // MAD normalized x1.4826 (sigma-equivalent, like astropy's mad_std)
      var med = arrayMedian( arr );
      var deviations = [];
      for ( var i = 0; i < arr.length; ++i )
         deviations.push( Math.abs( arr[i] - med ) );
      return arrayMedian( deviations )*1.4826;
   }

   function histogramMAD( histogram, median )
   {
      // Exact median absolute deviation from a histogram: walk outward from
      // the median bin, accumulating pixel counts, until half of the pixels
      // are within the current deviation. That deviation is the MAD.
      // x1.4826 makes it sigma-equivalent (like astropy's mad_std).
      var total = 0;
      for ( var i = 0; i < histogram.length; ++i )
         total += histogram[i];
      if ( total === 0 )
         return 0;

      var m = Math.round( median );
      if ( m < 0 ) m = 0;
      if ( m > histogram.length - 1 ) m = histogram.length - 1;

      var half = total/2;
      var acc = histogram[m];
      var maxDev = Math.max( m, histogram.length - 1 - m );
      for ( var d = 1; d <= maxDev; ++d )
      {
         if ( acc >= half )
            return ( d - 1 )*1.4826;
         var lo = m - d;
         var hi = m + d;
         if ( lo >= 0 ) acc += histogram[lo];
         if ( hi < histogram.length ) acc += histogram[hi];
      }
      return maxDev*1.4826;
   }

   // ------------------------------------------------------------------------
   // Image statistics (PixInsight runtime required)

   function computeHistogramCounts( image )
   {
      // Builds a 16-bit histogram (65536 bins) through PJSR's Histogram class.
      // Returns a JS array where index = ADU value, value = pixel count.
      var resolution = 65536;
      var counts = new Array( resolution );
      for ( var i = 0; i < resolution; ++i )
         counts[i] = 0;

      try
      {
         var H = new Histogram( resolution );
         H.generate( image );
         for ( var i = 0; i < resolution; ++i )
            counts[i] = H.count( i );
      }
      catch ( e )
      {
         // Fallback: rebuild the histogram manually, pixel by pixel, if the
         // Histogram class is not available in this form.
         console.warningln( "Histogram API: " + e.message + " - trying fallback..." );
         try
         {
            for ( var y = 0; y < image.height; ++y )
            {
               for ( var x = 0; x < image.width; ++x )
               {
                  var val = Math.round( image.sample( x, y )*65535 );
                  if ( val >= 0 && val < resolution )
                     counts[val]++;
               }
               // Keep the UI alive every few hundred rows
               if ( y % 500 === 0 )
                  processEvents();
            }
         }
         catch ( e2 )
         {
            console.warningln( "Histogram fallback failed: " + e2.message );
         }
      }

      return counts;
   }

   function patchMedian( image, x0, y0, w, h )
   {
      image.selectedRect = new Rect( x0, y0, x0 + w, y0 + h );
      var med = image.median();
      image.resetSelections();
      return med;
   }

   function iterativeClippedStats( image, seedCenter, seedSigma )
   {
      // Iterative sigma clipping like astropy's sigma_clipped_stats: clip at
      // center +- 3 sigma, recompute median and std on the surviving pixels,
      // tighten the bounds and repeat until convergence (max 5 iterations).
      // Seed values are in ADU; results are in ADU too.
      var result = { mean: 0, median: 0, std: 0 };

      if ( seedSigma <= 0 )
      {
         // Degenerate (constant) distribution: nothing to clip
         result.mean = image.mean()*SCALE;
         result.median = image.median()*SCALE;
         result.std = image.stdDev()*SCALE;
         return result;
      }

      var center = seedCenter;
      var sigma = seedSigma;
      var prevLow = null, prevHigh = null;

      image.rangeClippingEnabled = true;
      try
      {
         for ( var it = 0; it < 5; ++it )
         {
            var clipLow = ( center - 3.0*sigma )/SCALE;
            var clipHigh = ( center + 3.0*sigma )/SCALE;
            if ( clipLow < 0 ) clipLow = 0;
            if ( clipHigh > 1 ) clipHigh = 1;
            if ( clipLow === prevLow && clipHigh === prevHigh )
               break; // bounds stable: converged
            prevLow = clipLow;
            prevHigh = clipHigh;

            image.rangeClipLow = clipLow;
            image.rangeClipHigh = clipHigh;
            result.mean = image.mean()*SCALE;
            result.median = image.median()*SCALE;
            result.std = image.stdDev()*SCALE;

            center = result.median;
            sigma = result.std;
            if ( sigma <= 0 )
               break; // everything identical inside the bounds
         }
      }
      finally
      {
         // Always restore unclipped statistics for the caller
         image.rangeClippingEnabled = false;
      }

      return result;
   }

   return {
      arrayMedian: arrayMedian,
      arrayMAD: arrayMAD,
      histogramMAD: histogramMAD,
      computeHistogramCounts: computeHistogramCounts,
      patchMedian: patchMedian,
      iterativeClippedStats: iterativeClippedStats
   };
} )();
