/*
 * selftest-trash-register.js — verify StarAlignment registration fixes the
 * dithered star-trail composite.
 *
 * Builds 3 plate-solved frames sharing ONE star field (stars at fixed sky
 * positions) but dithered (shifted CRPIX). Registers them with StarAlignment
 * and max-combines; also max-combines the raw (unregistered) frames. Saves both
 * composites: the registered one must have sharp single stars, the naive one
 * shows each star tripled by the dither.
 */

/* beautify ignore:start */
#engine v8
#include "../pjsr/lib/Stats.js"
#include "../pjsr/lib/Render.js"
/* beautify ignore:end */

var W = 900, H = 700, SCALE = 2.0, CD = SCALE/3600;
var CRVAL1 = 300.0, CRVAL2 = 40.0;

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
         img.setSample( Math.min( 0.98, img.sample( x, y ) + peak*Math.exp( -( dx*dx + dy*dy )/( 2*sigma*sigma ) ) ), x, y );
      }
}

// A fixed set of stars in sky coordinates (ra offset, dec offset from center).
function skyStars()
{
   var seed = 7;
   function rnd() { seed = ( seed*1103515245 + 12345 ) & 0x7fffffff; return seed/0x7fffffff; }
   var stars = [];
   for ( var i = 0; i < 70; ++i )
      stars.push( { ra: CRVAL1 + ( rnd() - 0.5 )*0.9, dec: CRVAL2 + ( rnd() - 0.5 )*0.7,
                    peak: 0.35 + rnd()*0.6, sigma: 1.1 + rnd()*1.2 } );
   return stars;
}

function buildFrame( i, dither, stars )
{
   var tan = tanFor( dither[ 0 ], dither[ 1 ] );
   var win = new ImageWindow( W, H, 1, 32, true, false, "SI_reg_" + i );
   var view = win.mainView;
   beginNoSwap( view );
   var img = view.image;
   img.fill( 0.02 );
   for ( var s = 0; s < stars.length; ++s )
   {
      var p = SIFrameMetaCoreProject( tan, stars[ s ].ra, stars[ s ].dec );
      if ( p != null )
         addBlob( img, p.x, p.y, stars[ s ].peak, stars[ s ].sigma );
   }
   view.endProcess();
   win.keywords = [
      new FITSKeyword( "CTYPE1", "'RA---TAN'", "" ), new FITSKeyword( "CTYPE2", "'DEC--TAN'", "" ),
      new FITSKeyword( "CRVAL1", String( CRVAL1 ), "" ), new FITSKeyword( "CRVAL2", String( CRVAL2 ), "" ),
      new FITSKeyword( "CRPIX1", String( tan.crpix1 ), "" ), new FITSKeyword( "CRPIX2", String( tan.crpix2 ), "" ),
      new FITSKeyword( "CD1_1", String( tan.cd11 ), "" ), new FITSKeyword( "CD1_2", "0", "" ),
      new FITSKeyword( "CD2_1", "0", "" ), new FITSKeyword( "CD2_2", String( tan.cd22 ), "" ),
      new FITSKeyword( "OBJECT", "'REG TEST'", "" )
   ];
   var path = File.systemTempDirectory + "/si-reg-" + i + ".fit";
   win.saveAs( path, false, false, false, false );
   win.forceClose();
   return path;
}

// Inline TAN forward projection (avoids depending on FrameMeta here).
function SIFrameMetaCoreProject( tan, raDeg, decDeg )
{
   var DEG = Math.PI/180;
   var ra0 = tan.crval1*DEG, dec0 = tan.crval2*DEG, ra = raDeg*DEG, dec = decDeg*DEG;
   var dRA = ra - ra0, sinD0 = Math.sin( dec0 ), cosD0 = Math.cos( dec0 ), sinD = Math.sin( dec ), cosD = Math.cos( dec );
   var D = sinD*sinD0 + cosD*cosD0*Math.cos( dRA );
   if ( D <= 0 ) return null;
   var xi = ( cosD*Math.sin( dRA )/D )/DEG, eta = ( ( sinD*cosD0 - cosD*sinD0*Math.cos( dRA ) )/D )/DEG;
   var det = tan.cd11*tan.cd22 - tan.cd12*tan.cd21;
   var dp1 = ( tan.cd22*xi - tan.cd12*eta )/det, dp2 = ( tan.cd11*eta - tan.cd21*xi )/det;
   return { x: tan.crpix1 + dp1 - 1, y: tan.crpix2 + dp2 - 1 };
}

function main()
{
   var out = { checks: [], ok: true };
   function ck( n, c, d ) { out.checks.push( { name: n, ok: !!c, detail: d } ); if ( !c ) out.ok = false; }
 try {
   var stars = skyStars();
   var dithers = [ [ 0, 0 ], [ 12, -8 ], [ -9, 14 ] ];
   var paths = [];
   for ( var i = 0; i < 3; ++i )
      paths.push( buildFrame( i, dithers[ i ], stars ) );

   var regDir = File.systemTempDirectory + "/si-reg-out";
   var aligned = SIRender.registerFrames( paths, regDir );
   ck( "registration produced frames", aligned != null && aligned.length >= 2,
       "aligned " + ( aligned ? aligned.length : 0 ) + "/" + paths.length );
   out.aligned = aligned ? aligned.length : 0;

   var comp = SIRender.maxCombine( aligned != null ? aligned : paths );
   ck( "registered composite built", comp != null, comp ? ( comp.width + "x" + comp.height ) : "null" );
   if ( comp != null )
      SIRender.stretchedBitmap( comp ).save( File.systemTempDirectory + "/si-reg-composite.png" );

   var naive = SIRender.maxCombine( paths );
   if ( naive != null )
      SIRender.stretchedBitmap( naive ).save( File.systemTempDirectory + "/si-naive-composite.png" );
 } catch ( e ) {
   out.ok = false; out.error = String( e.message || e );
 }
   File.writeTextFile( File.systemTempDirectory + "/si-trash-register.json", JSON.stringify( out, null, 2 ) );
}

main();
