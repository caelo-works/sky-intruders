/*
 * gen-testdata.js — generate a synthetic night of light frames for hand-testing
 * Night trails without hunting for real data.
 *
 * Writes ~8 FITS frames (starfield + injected trails) with full headers
 * (DATE-OBS, EXPTIME, SITELAT/SITELONG/SITEELEV, a TAN WCS, OBJECT) into
 * <home>/SkyIntruders-testdata/. Reports the folder + per-frame trail count.
 *
 *   <PI-exe> -n --automation-mode --force-exit -r=/abs/tests/gen-testdata.js
 *
 * Note: the injected trails are synthetic, so Night trails will classify them
 * as meteor / uncataloged-satellite candidates (they cannot match a real
 * satellite pass). Detection, classification and the night report work fully.
 */

/* beautify ignore:start */
#engine v8
#include "../pjsr/lib/Stats.js"
#include "../pjsr/lib/TrailDetect.js"
/* beautify ignore:end */

function beginNoSwap( v )
{
   if ( typeof UndoFlag_NoSwapFile !== "undefined" )
      v.beginProcess( UndoFlag_NoSwapFile );
   else
      v.beginProcess();
}

function lcg( seed )
{
   var s = seed >>> 0;
   return function()
   {
      s = ( s*1103515245 + 12345 ) & 0x7fffffff;
      return s/0x7fffffff;
   };
}

function addBlob( img, cx, cy, peak, sigma )
{
   var r = Math.ceil( 3*sigma );
   for ( var dy = -r; dy <= r; ++dy )
      for ( var dx = -r; dx <= r; ++dx )
      {
         var x = Math.round( cx + dx ), y = Math.round( cy + dy );
         if ( x < 0 || y < 0 || x >= img.width || y >= img.height )
            continue;
         var v = peak*Math.exp( -( dx*dx + dy*dy )/( 2*sigma*sigma ) );
         var cur = img.sample( x, y );
         img.setSample( Math.min( 0.98, cur + v ), x, y );
      }
}

function injectTrail( img, x1, y1, x2, y2, peak, steady )
{
   var len = Math.hypot( x2 - x1, y2 - y1 );
   var n = Math.ceil( len );
   var ang = Math.atan2( y2 - y1, x2 - x1 ) + Math.PI/2;
   var cw = Math.cos( ang ), sw = Math.sin( ang );
   for ( var t = 0; t <= n; ++t )
   {
      var f = t/n;
      var x = x1 + ( x2 - x1 )*f, y = y1 + ( y2 - y1 )*f;
      // Satellites are steady; meteors brighten toward the middle and fade but
      // stay above the detection floor so the whole streak is contiguous.
      var b = steady ? peak : peak*( 0.62 + 0.55*Math.exp( -Math.pow( ( f - 0.55 )*2.2, 2 ) ) );
      for ( var w = -2; w <= 2; ++w )
      {
         var px = Math.round( x + cw*w ), py = Math.round( y + sw*w );
         if ( px < 0 || py < 0 || px >= img.width || py >= img.height )
            continue;
         var g = b*Math.exp( -( w*w )/( 2*1.2*1.2 ) );
         var cur = img.sample( px, py );
         img.setSample( Math.min( 0.96, cur + g ), px, py );
      }
   }
}

function pad2( n ) { return ( n < 10 ? "0" : "" ) + n; }

function main()
{
   var W = 1200, H = 900;
   var outDir = File.homeDirectory + "/SkyIntruders-testdata";
   if ( !File.directoryExists( outDir ) )
      File.createDirectory( outDir, true );

   var PIXSCALE = 2.0;                 // arcsec/px
   var cd = PIXSCALE/3600;             // deg/px
   var CRVAL1 = 300.0, CRVAL2 = 40.0;  // field center (Cygnus-ish)

   // One trail spec per frame (null = clean). Endpoints in pixels; steady=true
   // for satellite-like, false for a meteor-like brightness profile.
   var specs = [
      { x1: 20,  y1: 120, x2: 1180, y2: 500, steady: true },   // satellite
      null,                                                     // clean
      { x1: 60,  y1: 860, x2: 1140, y2: 80,  steady: true },   // satellite
      { x1: 1150, y1: 200, x2: 40,  y2: 780, steady: true },   // satellite
      { x1: 300, y1: 250, x2: 780, y2: 560, steady: false, peak: 0.8 }, // meteor (contained)
      { x1: 30,  y1: 460, x2: 1170, y2: 430, steady: true },   // satellite
      { x1: 200, y1: 60,  x2: 1000, y2: 840, steady: true },   // satellite
      null                                                      // clean
   ];

   var report = { outDir: outDir, frames: [] };
   var t0 = Date.UTC( 2026, 6, 3, 22, 0, 0 ); // 2026-07-03 22:00 UTC

   for ( var i = 0; i < specs.length; ++i )
   {
      var rnd = lcg( 1000 + i*7 );
      var win = new ImageWindow( W, H, 1, 32, true, false, "SI_testframe_" + i );
      var view = win.mainView;
      beginNoSwap( view );
      var img = view.image;
      img.fill( 0.02 );
      // faint gradient
      for ( var y = 0; y < H; y += 2 )
         for ( var x = 0; x < W; x += 2 )
            img.setSample( 0.02 + 0.008*( x/W ) + 0.005*( y/H ), x, y );
      // stars
      for ( var s = 0; s < 220; ++s )
         addBlob( img, rnd()*W, rnd()*H, 0.12 + rnd()*0.7, 0.9 + rnd()*1.6 );
      // trail
      if ( specs[ i ] != null )
         injectTrail( img, specs[ i ].x1, specs[ i ].y1, specs[ i ].x2, specs[ i ].y2,
                      specs[ i ].peak || 0.55, specs[ i ].steady );
      view.endProcess();

      var ms = t0 + i*20*60*1000;
      var d = new Date( ms );
      var dobs = d.getUTCFullYear() + "-" + pad2( d.getUTCMonth() + 1 ) + "-" + pad2( d.getUTCDate() ) +
                 "T" + pad2( d.getUTCHours() ) + ":" + pad2( d.getUTCMinutes() ) + ":" + pad2( d.getUTCSeconds() );

      win.keywords = [
         new FITSKeyword( "CTYPE1", "'RA---TAN'", "" ),
         new FITSKeyword( "CTYPE2", "'DEC--TAN'", "" ),
         new FITSKeyword( "CRVAL1", String( CRVAL1 ), "" ),
         new FITSKeyword( "CRVAL2", String( CRVAL2 ), "" ),
         new FITSKeyword( "CRPIX1", String( W/2 ), "" ),
         new FITSKeyword( "CRPIX2", String( H/2 ), "" ),
         new FITSKeyword( "CD1_1", String( -cd ), "" ),
         new FITSKeyword( "CD1_2", "0", "" ),
         new FITSKeyword( "CD2_1", "0", "" ),
         new FITSKeyword( "CD2_2", String( cd ), "" ),
         new FITSKeyword( "DATE-OBS", "'" + dobs + "'", "" ),
         new FITSKeyword( "EXPTIME", "120", "" ),
         new FITSKeyword( "SITELAT", "48.8566", "" ),
         new FITSKeyword( "SITELONG", "2.3522", "" ),
         new FITSKeyword( "SITEELEV", "100", "" ),
         new FITSKeyword( "OBJECT", "'NGC 7000 (test)'", "" ),
         new FITSKeyword( "IMAGETYP", "'Light Frame'", "" )
      ];

      var path = outDir + "/light_" + pad2( i ) + ".fit";
      win.saveAs( path, false, false, false, false );
      view = null;

      // Sanity: how many trails does the detector find?
      var det = SITrailDetect.detect( win.mainView.image, { kSigma: 5, minLengthFrac: 0.15,
                                                             fillRatioMin: 0.6, maxTrails: 10 } );
      report.frames.push( { file: "light_" + pad2( i ) + ".fit", dateObs: dobs,
                            injected: ( specs[ i ] != null ), trailsFound: det.trails.length } );
      win.forceClose();
   }

   File.writeTextFile( outDir + "/README.txt",
      "Sky Intruders — synthetic test frames.\n" +
      "Load these in Night trails.\n" +
      "Trails are synthetic (no real satellite match): expect meteor / uncataloged\n" +
      "satellite candidates. Detection, classification, report and art all work.\n" );

   File.writeTextFile( File.systemTempDirectory + "/si-gen-testdata.json", JSON.stringify( report, null, 2 ) );
   console.writeln( "Sky Intruders test data written to " + outDir );
}

main();
