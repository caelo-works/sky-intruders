/*
 * debug-night-diff.js — dump the registered-difference images the night
 * pipeline actually detects on, with the detections overlaid, so real
 * streaks and false positives can be told apart by eye.
 *
 * Replays analyzeNightSet's steps (register -> bin -> median model -> diff)
 * with the SAME library calls, then saves each frame's diff as a stretched
 * PNG (binned scale x2) with bright-pass (solid) and faint-pass segments.
 *
 * Results: <system-temp>/si-diff-<i>.png + si-diff-debug.json
 */

/* beautify ignore:start */
#engine v8
#include "../pjsr/lib/Stats.js"
#include "../pjsr/lib/FrameMeta.js"
#include "../pjsr/lib/TrailDetect.js"
#include "../pjsr/lib/Render.js"
/* beautify ignore:end */

function dbgDir()
{
   return File.extractDrive( #__FILE__ ) + File.extractDirectory( #__FILE__ );
}

function listFits( dir )
{
   var out = [];
   var ff = new FileFind;
   if ( ff.begin( dir + "/*" ) )
      do
      {
         if ( ff.isFile )
         {
            var l = String( ff.name ).toLowerCase();
            if ( l.length > 4 &&
                 ( l.substring( l.length - 5 ) === ".fits" ||
                   l.substring( l.length - 4 ) === ".fit" ) )
               out.push( dir + "/" + ff.name );
         }
      }
      while ( ff.next() );
   out.sort();
   return out;
}

function diffToBitmap( diff, width, height, sigma )
{
   // Stretch: 0 -> black, 5 sigma -> white, x2 scale.
   var bmp = new Bitmap( width, height );
   for ( var y = 0; y < height; ++y )
      for ( var x = 0; x < width; ++x )
      {
         var z = ( sigma > 0 ) ? diff[y*width + x]/sigma : 0;
         var v = Math.max( 0, Math.min( 255, Math.round( z/5*255 ) ) );
         bmp.setPixel( x, y, 0xff000000 | ( v << 16 ) | ( v << 8 ) | v );
      }
   return bmp.scaledTo( width*2, height*2 );
}

function main()
{
   var out = { ok: true, frames: [] };
   var tmp = File.systemTempDirectory;
 try {
   var files = listFits( dbgDir() + "/data" );
   var regDir = tmp + "/si-diff-reg";
   var reg = SIRender.registerFramesMapped( files, regDir );

   var entries = [];
   for ( var i = 0; i < files.length; ++i )
   {
      if ( reg.paths[ i ] == null )
         continue;
      var wins = ImageWindow.open( reg.paths[ i ] );
      var win = wins[ 0 ];
      var b = SITrailDetect.binned( win.mainView.image );
      win.forceClose();
      entries.push( { path: files[ i ], binned: b } );
   }
   var arrays = [];
   for ( var i = 0; i < entries.length; ++i )
      arrays.push( entries[ i ].binned.data );
   var stack0 = SITrailCore.medianStackMasked( arrays, 1e-6 );
   var normalized = [];
   for ( var i = 0; i < entries.length; ++i )
   {
      var lf = SITrailCore.linearFitToModel( arrays[ i ], stack0.model, stack0.valid );
      normalized.push( SITrailCore.applyLinear( arrays[ i ], lf.a, lf.b ) );
      entries[ i ].binned.data = normalized[ i ];
      entries[ i ].fit = { a: Math.round( lf.a*10000 )/10000, b: Math.round( lf.b*1e7 )/1e7 };
   }
   var stack = SITrailCore.medianStackMasked( normalized, 1e-6 );
   var mask = SITrailCore.erodeMask( stack.valid, entries[ 0 ].binned.width,
                                     entries[ 0 ].binned.height, 3 );

   for ( var i = 0; i < entries.length; ++i )
   {
      var e = entries[ i ];
      var w = e.binned.width, h = e.binned.height;
      var diff = SITrailCore.subtractModel( e.binned.data, stack.model, mask );
      var sigma = SITrailCore.noiseSigmaFromPositives( diff );

      // Bright pass on a COPY (detect erases nothing, but keep parity with
      // production: bright corridors get erased before the faint pass).
      var muDiff = 0;
      for ( var d = 0; d < diff.length; ++d )
         muDiff += diff[d];
      muDiff /= diff.length;
      var thinOnly = function( run )
      {
         return SITrailCore.corridorConcentration( diff, w, h, run, muDiff ) >= 0.45;
      };
      var core = SITrailCore.detectCore( diff, w, h, { kSigma: 3.0 }, thinOnly );
      var bright = core.trails;
      var diff2 = new Float32Array( diff );
      // erase bright corridors like detectDiff does (segment distance <= 5)
      for ( var t = 0; t < bright.length; ++t )
      {
         var tr = bright[ t ];
         var dx = tr.x2 - tr.x1, dy = tr.y2 - tr.y1;
         var len2 = dx*dx + dy*dy;
         for ( var y = 0; y < h; ++y )
            for ( var x = 0; x < w; ++x )
            {
               var tt = ( len2 > 0 ) ? Math.max( 0, Math.min( 1, ( ( x - tr.x1 )*dx + ( y - tr.y1 )*dy )/len2 ) ) : 0;
               var ddx = x - ( tr.x1 + tt*dx ), ddy = y - ( tr.y1 + tt*dy );
               if ( ddx*ddx + ddy*ddy <= 25 )
                  diff2[y*w + x] = 0;
            }
      }
      var faint = SITrailCore.detectFaintCore( diff2, w, h, {} );

      var bmp = diffToBitmap( diff, w, h, sigma );
      var overlay = [];
      for ( var t = 0; t < bright.length; ++t )
         overlay.push( { x1: bright[ t ].x1*2, y1: bright[ t ].y1*2,
                         x2: bright[ t ].x2*2, y2: bright[ t ].y2*2, color: "#ff5f5f" } );
      for ( var t = 0; t < faint.trails.length; ++t )
         overlay.push( { x1: faint.trails[ t ].x1*2, y1: faint.trails[ t ].y1*2,
                         x2: faint.trails[ t ].x2*2, y2: faint.trails[ t ].y2*2, color: "#5fd3ff" } );
      bmp = SIRender.drawTrails( bmp, overlay, { glow: false, lineWidth: 1 } );
      bmp.save( tmp + "/si-diff-" + i + ".png" );

      var rec = { file: e.path, sigmaAdu: sigma*65535, fit: e.fit, bright: [], faint: [] };
      for ( var t = 0; t < bright.length; ++t )
         rec.bright.push( { x1: Math.round( bright[ t ].x1 ), y1: Math.round( bright[ t ].y1 ),
                            x2: Math.round( bright[ t ].x2 ), y2: Math.round( bright[ t ].y2 ),
                            ang: Math.round( bright[ t ].angleDeg*10 )/10 } );
      for ( var t = 0; t < faint.trails.length; ++t )
         rec.faint.push( { x1: Math.round( faint.trails[ t ].x1 ), y1: Math.round( faint.trails[ t ].y1 ),
                           x2: Math.round( faint.trails[ t ].x2 ), y2: Math.round( faint.trails[ t ].y2 ),
                           ang: Math.round( faint.trails[ t ].angleDeg*10 )/10,
                           signif: Math.round( ( faint.trails[ t ].score || 0 )*260 )/10 } );
      out.frames.push( rec );
      gc();
   }
 } catch ( e ) {
   out.ok = false;
   out.error = String( e.message || e ) + " @ " + ( e.lineNumber || "?" );
 }
   File.writeTextFile( tmp + "/si-diff-debug.json", JSON.stringify( out, null, 2 ) );
}

main();
