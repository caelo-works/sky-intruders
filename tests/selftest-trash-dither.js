/*
 * selftest-trash-dither.js — verify WCS alignment fixes dithered superposition.
 *
 * Builds 3 plate-solved frames that share a sky field but are dithered (their
 * CRPIX is shifted), each carrying a trail at the SAME sky position plus a
 * distinct one. Projecting every trail onto a reference frame's grid via WCS
 * must make the common trail converge (one line) despite the dither; without
 * projection the native pixels are offset by the dither.
 *
 * Writes the choreography PNG + a marker with the aligned-vs-native spread.
 */

/* beautify ignore:start */
#engine v8
#include "../pjsr/lib/Stats.js"
#include "../pjsr/lib/FrameMeta.js"
#include "../pjsr/lib/TrailDetect.js"
#include "../pjsr/lib/Meteors.js"
#include "../pjsr/lib/Report.js"
#include "../pjsr/lib/TrashArt.js"
#include "../pjsr/lib/Render.js"
/* beautify ignore:end */

var W = 1000, H = 800, SCALE = 2.0;         // arcsec/px
var CRVAL1 = 300.0, CRVAL2 = 40.0;
var CD = SCALE/3600;                        // deg/px

function tanFor( dx, dy )
{
   return { crval1: CRVAL1, crval2: CRVAL2, crpix1: W/2 + dx, crpix2: H/2 + dy,
            cd11: -CD, cd12: 0, cd21: 0, cd22: CD };
}

function beginNoSwap( v )
{
   if ( typeof UndoFlag_NoSwapFile !== "undefined" ) v.beginProcess( UndoFlag_NoSwapFile );
   else v.beginProcess();
}

function addBlob( img, cx, cy, peak, sigma )
{
   var r = Math.ceil( 3*sigma );
   for ( var dy = -r; dy <= r; ++dy )
      for ( var dx = -r; dx <= r; ++dx )
      {
         var x = Math.round( cx + dx ), y = Math.round( cy + dy );
         if ( x < 0 || y < 0 || x >= img.width || y >= img.height ) continue;
         var v = peak*Math.exp( -( dx*dx + dy*dy )/( 2*sigma*sigma ) );
         img.setSample( Math.min( 0.97, img.sample( x, y ) + v ), x, y );
      }
}

function injectSeg( img, x1, y1, x2, y2, peak )
{
   var n = Math.ceil( Math.hypot( x2 - x1, y2 - y1 ) );
   var ang = Math.atan2( y2 - y1, x2 - x1 ) + Math.PI/2;
   var cw = Math.cos( ang ), sw = Math.sin( ang );
   for ( var t = 0; t <= n; ++t )
   {
      var f = t/n, x = x1 + ( x2 - x1 )*f, y = y1 + ( y2 - y1 )*f;
      for ( var w = -2; w <= 2; ++w )
      {
         var px = Math.round( x + cw*w ), py = Math.round( y + sw*w );
         if ( px < 0 || py < 0 || px >= img.width || py >= img.height ) continue;
         img.setSample( Math.min( 0.96, img.sample( px, py ) + peak*Math.exp( -( w*w )/2.88 ) ), px, py );
      }
   }
}

function buildFrame( i, dither, dobs )
{
   var tan = tanFor( dither[ 0 ], dither[ 1 ] );
   var win = new ImageWindow( W, H, 1, 32, true, false, "SI_dith_" + i );
   var view = win.mainView;
   beginNoSwap( view );
   var img = view.image;
   img.fill( 0.02 );
   var seed = 100 + i;
   function rnd() { seed = ( seed*1103515245 + 12345 ) & 0x7fffffff; return seed/0x7fffffff; }
   for ( var s = 0; s < 160; ++s )
      addBlob( img, rnd()*W, rnd()*H, 0.15 + rnd()*0.6, 1.0 + rnd()*1.4 );

   // Common trail at a FIXED sky position (same ra/dec in every frame).
   var cA = SIFrameMetaCore.tanCelestialToImage( tan, 299.92, 39.94 );
   var cB = SIFrameMetaCore.tanCelestialToImage( tan, 300.08, 40.06 );
   injectSeg( img, cA.x, cA.y, cB.x, cB.y, 0.6 );

   // A distinct intruder per frame (different sky position each).
   var iA = SIFrameMetaCore.tanCelestialToImage( tan, 299.8 + i*0.05, 40.1 );
   var iB = SIFrameMetaCore.tanCelestialToImage( tan, 300.0 + i*0.05, 39.85 );
   injectSeg( img, iA.x, iA.y, iB.x, iB.y, 0.6 );
   view.endProcess();

   win.keywords = [
      new FITSKeyword( "CTYPE1", "'RA---TAN'", "" ), new FITSKeyword( "CTYPE2", "'DEC--TAN'", "" ),
      new FITSKeyword( "CRVAL1", String( CRVAL1 ), "" ), new FITSKeyword( "CRVAL2", String( CRVAL2 ), "" ),
      new FITSKeyword( "CRPIX1", String( tan.crpix1 ), "" ), new FITSKeyword( "CRPIX2", String( tan.crpix2 ), "" ),
      new FITSKeyword( "CD1_1", String( tan.cd11 ), "" ), new FITSKeyword( "CD1_2", "0", "" ),
      new FITSKeyword( "CD2_1", "0", "" ), new FITSKeyword( "CD2_2", String( tan.cd22 ), "" ),
      new FITSKeyword( "DATE-OBS", "'" + dobs + "'", "" ), new FITSKeyword( "EXPTIME", "120", "" ),
      new FITSKeyword( "OBJECT", "'DITHER TEST'", "" )
   ];
   var path = File.systemTempDirectory + "/si-dith-" + i + ".fit";
   win.saveAs( path, false, false, false, false );
   win.forceClose();
   return path;
}

function spread( pts )
{
   var m = 0;
   for ( var a = 0; a < pts.length; ++a )
      for ( var b = a + 1; b < pts.length; ++b )
         m = Math.max( m, Math.hypot( pts[ a ].x - pts[ b ].x, pts[ a ].y - pts[ b ].y ) );
   return m;
}

function main()
{
   var out = { checks: [], ok: true };
   function ck( name, cond, detail ) { out.checks.push( { name: name, ok: !!cond, detail: detail } ); if ( !cond ) out.ok = false; }
 try {
   var dithers = [ [ 0, 0 ], [ 9, -6 ], [ -7, 11 ] ];
   var paths = [];
   for ( var i = 0; i < 3; ++i )
      paths.push( buildFrame( i, dithers[ i ], "2026-07-03T22:" + ( 10 + i*10 ) + ":00" ) );

   // Detect + read WCS on each frame; gather the common trail's endpoints in
   // native pixels and after projection onto frame 0's grid.
   var ref = null;
   var nativeStarts = [], projStarts = [], allTrails = [];
   for ( var f = 0; f < paths.length; ++f )
   {
      var wins = ImageWindow.open( paths[ f ] );
      var win = wins[ 0 ];
      var meta = SIFrameMeta.read( win, paths[ f ] );
      if ( f === 0 ) { ref = meta.wcs; out.refKind = meta.wcs.kind; }
      var det = SITrailDetect.detect( win.mainView.image, { kSigma: 5, minLengthFrac: 0.12, fillRatioMin: 0.55, maxTrails: 10 } );
      for ( var t = 0; t < det.trails.length; ++t )
      {
         var tr = det.trails[ t ];
         tr.p1 = meta.wcs.imageToCelestial( tr.x1, tr.y1 );
         tr.p2 = meta.wcs.imageToCelestial( tr.x2, tr.y2 );
         if ( tr.p1 == null || tr.p2 == null ) continue;
         var pr1 = ref.celestialToImage( tr.p1.raDeg, tr.p1.decDeg );
         var pr2 = ref.celestialToImage( tr.p2.raDeg, tr.p2.decDeg );
         if ( pr1 == null || pr2 == null ) continue;
         allTrails.push( { x1: pr1.x, y1: pr1.y, x2: pr2.x, y2: pr2.y, klass: "satellite" } );
      }
      // The common trail: nearest to sky point 299.92/39.94. Find its endpoints.
      var target = { ra: 299.92, dec: 39.94 };
      var best = null, bestD = 1e9;
      for ( var t2 = 0; t2 < det.trails.length; ++t2 )
      {
         var d1 = SIMeteors.sepDeg( det.trails[ t2 ].p1.raDeg, det.trails[ t2 ].p1.decDeg, target.ra, target.dec );
         var d2 = SIMeteors.sepDeg( det.trails[ t2 ].p2.raDeg, det.trails[ t2 ].p2.decDeg, target.ra, target.dec );
         var d = Math.min( d1, d2 );
         if ( d < bestD ) { bestD = d; best = det.trails[ t2 ]; }
      }
      if ( best != null && best.p1 != null && best.p2 != null )
      {
         // native start = endpoint nearest the target, in this frame's pixels
         var useP1 = SIMeteors.sepDeg( best.p1.raDeg, best.p1.decDeg, target.ra, target.dec ) <=
                     SIMeteors.sepDeg( best.p2.raDeg, best.p2.decDeg, target.ra, target.dec );
         nativeStarts.push( { x: useP1 ? best.x1 : best.x2, y: useP1 ? best.y1 : best.y2 } );
         var pr = ref.celestialToImage( ( useP1 ? best.p1 : best.p2 ).raDeg, ( useP1 ? best.p1 : best.p2 ).decDeg );
         if ( pr != null )
            projStarts.push( { x: pr.x, y: pr.y } );
      }
      win.forceClose();
   }

   var nativeSpread = spread( nativeStarts );
   var projSpread = spread( projStarts );
   ck( "frames detected common trail", nativeStarts.length === 3, nativeStarts.length + "/3" );
   ck( "native pixels are dithered apart", nativeSpread > 6, "native spread " + nativeSpread.toFixed( 1 ) + " px" );
   ck( "WCS projection converges", projSpread < 4, "projected spread " + projSpread.toFixed( 1 ) + " px" );

   // Render the aligned choreography for visual inspection.
   var colored = SITrashArt.assignColors( allTrails, "type" );
   var norm = SITrashArt.normalizeEndpoints( colored, W, H, W, H );
   var black = new Bitmap( W, H ); black.fill( 0xff05070d );
   var bmp = SIRender.drawTrails( black, norm, { glow: true, lineWidth: 3 } );
   bmp.save( File.systemTempDirectory + "/si-dither-choreography.png" );
 } catch ( e ) {
   out.ok = false;
   out.error = String( e.message || e ) + " @ " + ( e.lineNumber || "?" );
 }
   File.writeTextFile( File.systemTempDirectory + "/si-trash-dither.json", JSON.stringify( out, null, 2 ) );
}

main();
