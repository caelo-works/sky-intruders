/*
 * debug-frame0.js — step-by-step forensics on ONE frame of the night
 * testset (index FRAME_IDX after name sort), run TWICE with two
 * independent registrations: if the two detections differ, the
 * non-determinism lives in StarAlignment, not in the (pure JS) detector.
 *
 * Dumps every faint-pass candidate with its rejection reason.
 *
 * Results: <system-temp>/si-f0-debug.json, si-f0-diff-A.png
 */

/* beautify ignore:start */
#engine v8
#include "../pjsr/lib/Stats.js"
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

function seg( t )
{
   return { x1: Math.round( t.x1 ), y1: Math.round( t.y1 ),
            x2: Math.round( t.x2 ), y2: Math.round( t.y2 ),
            ang: Math.round( t.angleDeg*10 )/10 };
}

function analyzeSet( files )
{
   var reg = SIRender.registerFramesMapped( files, File.systemTempDirectory + "/si-f0-regA" );
   var binnedList = [];
   for ( var i = 0; i < files.length; ++i )
   {
      if ( reg.paths[ i ] == null )
         return { error: "frame " + i + " not registered" };
      var wins = ImageWindow.open( reg.paths[ i ] );
      var win = wins[ 0 ];
      binnedList.push( SITrailDetect.binned( win.mainView.image ) );
      win.forceClose();
      gc();
   }
   var w = binnedList[ 0 ].width, h = binnedList[ 0 ].height;
   var arrays = [];
   for ( var i = 0; i < binnedList.length; ++i )
      arrays.push( binnedList[ i ].data );
   var stack0 = SITrailCore.medianStackMasked( arrays, 1e-6 );
   var normalized = [];
   for ( var i = 0; i < arrays.length; ++i )
   {
      var lf = SITrailCore.linearFitToModel( arrays[ i ], stack0.model, stack0.valid );
      normalized.push( SITrailCore.applyLinear( arrays[ i ], lf.a, lf.b ) );
   }
   var stack = SITrailCore.medianStackMasked( normalized, 1e-6 );
   var mask = SITrailCore.erodeMask( stack.valid, w, h, 3 );

   var frames = [];
   for ( var fi = 0; fi < files.length; ++fi )
      frames.push( analyzeFrameDiff( files[ fi ], normalized[ fi ], stack, mask, w, h, fi ) );
   return { frames: frames };
}

function analyzeFrameDiff( path, norm, stack, mask, w, h, fi )
{
   var diff = SITrailCore.subtractModel( norm, stack.model, mask );
   var sigma = SITrailCore.noiseSigmaFromPositives( diff );
   var muDiff = 0;
   for ( var d = 0; d < diff.length; ++d )
      muDiff += diff[d];
   muDiff /= diff.length;

   var thinOnly = function( run )
   {
      return SITrailCore.corridorConcentration( diff, w, h, run, muDiff ) >= 0.45 &&
             !SITrailCore.isNoiseLine( diff, w, h, run, sigma );
   };
   var core = SITrailCore.detectCore( diff, w, h,
      { kSigma: 4.5, maxTrails: 25, noiseOverride: { median: 0, sigma: sigma } }, thinOnly );

   var diff2 = new Float32Array( diff );
   for ( var t = 0; t < core.trails.length; ++t )
   {
      var trl = core.trails[ t ];
      var dx = trl.x2 - trl.x1, dy = trl.y2 - trl.y1;
      var len2 = dx*dx + dy*dy;
      for ( var y = 0; y < h; ++y )
         for ( var x = 0; x < w; ++x )
         {
            var tt = ( len2 > 0 ) ? Math.max( 0, Math.min( 1, ( ( x - trl.x1 )*dx + ( y - trl.y1 )*dy )/len2 ) ) : 0;
            var ddx = x - ( trl.x1 + tt*dx ), ddy = y - ( trl.y1 + tt*dy );
            if ( ddx*ddx + ddy*ddy <= 25 )
               diff2[y*w + x] = 0;
         }
   }
   var trace = [];
   var faint = SITrailCore.detectFaintCore( diff2, w, h, { trace: trace } );

   var out = { file: path.split( "/" ).pop(), sigmaAdu: sigma*65535,
               bright: [], faint: [], trace: trace.slice( 0, 40 ) };
   for ( var t = 0; t < core.trails.length; ++t )
      out.bright.push( seg( core.trails[ t ] ) );
   for ( var t = 0; t < faint.trails.length; ++t )
      out.faint.push( seg( faint.trails[ t ] ) );

   if ( false )
   {
      var bmp = new Bitmap( w, h );
      for ( var y = 0; y < h; ++y )
         for ( var x = 0; x < w; ++x )
         {
            var z = ( sigma > 0 ) ? diff[y*w + x]/sigma : 0;
            var v = Math.max( 0, Math.min( 255, Math.round( z/5*255 ) ) );
            bmp.setPixel( x, y, 0xff000000 | ( v << 16 ) | ( v << 8 ) | v );
         }
      bmp = bmp.scaledTo( w*2, h*2 );
      var overlay = [];
      for ( var t = 0; t < core.trails.length; ++t )
         overlay.push( { x1: core.trails[ t ].x1*2, y1: core.trails[ t ].y1*2,
                         x2: core.trails[ t ].x2*2, y2: core.trails[ t ].y2*2, color: "#ff5f5f" } );
      for ( var t = 0; t < faint.trails.length; ++t )
         overlay.push( { x1: faint.trails[ t ].x1*2, y1: faint.trails[ t ].y1*2,
                         x2: faint.trails[ t ].x2*2, y2: faint.trails[ t ].y2*2, color: "#5fff8f" } );
      SIRender.drawTrails( bmp, overlay, { glow: false, lineWidth: 1 } )
              .save( File.systemTempDirectory + "/si-f0-diff-A.png" );
   }
   return out;
}

function main()
{
   var out = { ok: true };
 try {
   var files = listFits( dbgDir() + "/data" );
   var res = analyzeSet( files );
   out.frames = res.frames;
   out.error0 = res.error || null;
 } catch ( e ) {
   out.ok = false;
   out.error = String( e.message || e ) + " @ " + ( e.lineNumber || "?" );
 }
   File.writeTextFile( File.systemTempDirectory + "/si-f0-debug.json",
                       JSON.stringify( out, null, 2 ) );
}

main();
