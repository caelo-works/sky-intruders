/*
 * debug-night-model.js — where do the parallel ridge families come from?
 * Dumps, for the night testset: the static-sky MODEL, each frame's
 * normalized binned image, and the SIGNED difference (mid-gray = 0), plus
 * zero-fraction statistics along the strongest detected lines. Together
 * these tell apart: real flux in the frame / dark imprint in the model /
 * clamped-noise variance artifacts / resampling moire.
 *
 * Results: <system-temp>/si-model.png, si-norm-<i>.png, si-sdiff-<i>.png,
 *          si-model-debug.json
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

function robustStats( data )
{
   var sub = [];
   for ( var i = 0; i < data.length; i += 4 )
      if ( data[i] > 1e-6 )
         sub.push( data[i] );
   var med = SITrailCore.medianOf( sub );
   var dev = [];
   for ( var i = 0; i < sub.length; ++i )
      dev.push( Math.abs( sub[i] - med ) );
   return { med: med, mad: SITrailCore.medianOf( dev )*1.4826 };
}

function grayPng( data, width, height, lo, hi, path )
{
   var bmp = new Bitmap( width, height );
   var span = Math.max( 1e-12, hi - lo );
   for ( var y = 0; y < height; ++y )
      for ( var x = 0; x < width; ++x )
      {
         var v = Math.max( 0, Math.min( 255, Math.round( ( data[y*width + x] - lo )/span*255 ) ) );
         bmp.setPixel( x, y, 0xff000000 | ( v << 16 ) | ( v << 8 ) | v );
      }
   bmp.scaledTo( width*2, height*2 ).save( path );
}

function lineStats( clamped, signed, width, height, seg, sigma )
{
   // Walk the segment: zero fraction in the clamped diff + mean signed diff.
   var dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
   var len = Math.sqrt( dx*dx + dy*dy );
   var zeros = 0, n = 0, sum = 0;
   for ( var t = 0; t <= Math.round( len ); ++t )
   {
      var x = Math.round( seg.x1 + dx*t/len );
      var y = Math.round( seg.y1 + dy*t/len );
      if ( x < 0 || y < 0 || x >= width || y >= height )
         continue;
      ++n;
      if ( clamped[y*width + x] <= 0 )
         ++zeros;
      sum += signed[y*width + x];
   }
   return { zeroFrac: ( n > 0 ) ? zeros/n : 0,
            meanSignedSigma: ( n > 0 && sigma > 0 ) ? ( sum/n )/sigma : 0, n: n };
}

function main()
{
   var out = { ok: true, frames: [] };
   var tmp = File.systemTempDirectory;
 try {
   var files = listFits( dbgDir() + "/data" );
   var regDir = tmp + "/si-diff-reg2";
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
      gc();
   }
   var w = entries[0].binned.width, h = entries[0].binned.height;

   var arrays = [];
   for ( var i = 0; i < entries.length; ++i )
      arrays.push( entries[ i ].binned.data );
   var stack0 = SITrailCore.medianStackMasked( arrays, 1e-6 );
   var normalized = [];
   for ( var i = 0; i < entries.length; ++i )
   {
      var lf = SITrailCore.linearFitToModel( arrays[ i ], stack0.model, stack0.valid );
      normalized.push( SITrailCore.applyLinear( arrays[ i ], lf.a, lf.b ) );
   }
   var stack = SITrailCore.medianStackMasked( normalized, 1e-6 );
   var mask = SITrailCore.erodeMask( stack.valid, w, h, 3 );

   var ms = robustStats( stack.model );
   out.model = { med: ms.med, mad: ms.mad };
   grayPng( stack.model, w, h, ms.med - 5*ms.mad, ms.med + 5*ms.mad, tmp + "/si-model.png" );

   for ( var i = 0; i < entries.length; ++i )
   {
      var norm = normalized[ i ];
      var clamped = SITrailCore.subtractModel( norm, stack.model, mask );
      var sigma = SITrailCore.noiseSigmaFromPositives( clamped );

      // signed difference (no clamp, masked like the clamped one)
      var signed = new Float32Array( norm.length );
      for ( var k = 0; k < norm.length; ++k )
         signed[k] = ( mask[k] && norm[k] > 1e-6 && stack.model[k] > 1e-6 )
                        ? norm[k] - stack.model[k] : 0;

      var fs = robustStats( norm );
      grayPng( norm, w, h, fs.med - 5*fs.mad, fs.med + 5*fs.mad, tmp + "/si-norm-" + i + ".png" );
      grayPng( signed, w, h, -5*sigma, 5*sigma, tmp + "/si-sdiff-" + i + ".png" );

      // detect exactly like production, then measure line statistics
      var muDiff = 0;
      for ( var d = 0; d < clamped.length; ++d )
         muDiff += clamped[d];
      muDiff /= clamped.length;
      var thinOnly = function( run )
      {
         return SITrailCore.corridorConcentration( clamped, w, h, run, muDiff ) >= 0.45;
      };
      var core = SITrailCore.detectCore( clamped, w, h, { kSigma: 3.0, maxTrails: 25 }, thinOnly );
      var rec = { file: entries[ i ].path, sigmaAdu: sigma*65535, lines: [] };
      for ( var t = 0; t < Math.min( 4, core.trails.length ); ++t )
      {
         var tr = core.trails[ t ];
         var st = lineStats( clamped, signed, w, h, tr, sigma );
         rec.lines.push( { x1: Math.round( tr.x1 ), y1: Math.round( tr.y1 ),
                           x2: Math.round( tr.x2 ), y2: Math.round( tr.y2 ),
                           ang: Math.round( tr.angleDeg*10 )/10,
                           zeroFrac: Math.round( st.zeroFrac*100 )/100,
                           meanSignedSigma: Math.round( st.meanSignedSigma*100 )/100 } );
      }
      out.frames.push( rec );
      gc();
   }
 } catch ( e ) {
   out.ok = false;
   out.error = String( e.message || e ) + " @ " + ( e.lineNumber || "?" );
 }
   File.writeTextFile( tmp + "/si-model-debug.json", JSON.stringify( out, null, 2 ) );
}

main();
