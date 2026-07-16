/*
 * SkyIntruders.js — entry point.
 *
 * Who crossed your photo last night? Scans a night's light frames for trails,
 * identifies them (TLE cross-match with SGP4, meteor shower heuristics, slow
 * movers) and renders a night-log report with fun stats and a Reddit-ready
 * markdown post. Runs entirely in PixInsight — no external helper.
 */

/* beautify ignore:start */

#engine v8

#feature-id    SkyIntruders : CaeloWorks > Sky Intruders
#feature-icon  @script_icons_dir/SkyIntruders.svg
#feature-info  Detect and identify satellite, meteor and asteroid trails in your light frames.

// Stamped by scripts/build-update-package.sh at packaging time.
#define SKYINTRUDERS_BUILD "__BUILD__"

// NEVER write slash-star inside a comment (preprocessor trap:
// it swallows everything to the next star-slash).
#include "lib/vendor/satellite.js"
#include "lib/Stats.js"
#include "lib/FrameMeta.js"
#include "lib/TrailDetect.js"
#include "lib/Net.js"
#include "lib/SatMatch.js"
#include "lib/Meteors.js"
#include "lib/Report.js"
#include "lib/Cosmology.js"
#include "lib/Catalogs.js"
#include "lib/Treasure.js"
#include "lib/TreasureReport.js"
#include "lib/Render.js"

#define SKYINTRUDERS_TITLE "Sky Intruders"

/* beautify ignore:end */

// ---------------------------------------------------------------------------
// Unlike FrameStyle / StdButton / StdIcon, TextAlign is NOT injected as a
// runtime global under #engine v8 (and pjsr headers do not load). Define it
// from the official pjsr/TextAlign.jsh flag values so label alignment works.
if ( typeof TextAlign == "undefined" )
   TextAlign = { Left: 0x01, Right: 0x02, HorzCenter: 0x04, Justify: 0x08,
                 Top: 0x20, Bottom: 0x40, VertCenter: 0x80,
                 Center: 0x84, Default: 0x21, Unknown: 0x00 };

// ---------------------------------------------------------------------------
// Version gate — fail with a clear message instead of a cryptic v8 error.
function ensureMinimumVersion( maj, min, rel )
{
   var ok = ( CoreApplication.versionMajor > maj ) ||
            ( CoreApplication.versionMajor == maj && ( CoreApplication.versionMinor > min ||
              ( CoreApplication.versionMinor == min && CoreApplication.versionRelease >= rel ) ) );
   if ( !ok )
      throw new Error( SKYINTRUDERS_TITLE + " requires PixInsight " + maj + "." + min + "." + rel +
                       " or newer (this is " + CoreApplication.versionMajor + "." +
                       CoreApplication.versionMinor + "." + CoreApplication.versionRelease + ")." );
}

// ---------------------------------------------------------------------------
// Parameters, persisted as JSON (Settings-free: one less v8 API risk).

// The chart accent color the whole Treasure UI defaults to (params, swatch,
// picker presets, chartField call).
var SI_DEFAULT_ACCENT = "#9FD8D2";

var DEFAULT_PARAMS = {
   kSigma: 5.0,
   // Detection threshold on the registered DIFFERENCE image: the static sky
   // is subtracted there, so a lower k is safe and catches the faint streaks
   // narrowband filters leave (a Starlink loses several magnitudes in Ha).
   diffKSigma: 4.5,
   minLengthFrac: 0.15,
   fillRatioMin: 0.6,
   maxTrails: 10,
   tleGroup: "active",
   // Fresh launches take days to reach the "active" group — without
   // last-30-days they all show up as unidentified. The full GP catalog
   // (a mirror-side aggregate) adds rocket bodies, defunct payloads and
   // debris: the high-orbit population still sunlit deep in the night,
   // which "active" alone would report as uncataloged.
   tleExtraGroups: [ "last-30-days", "catalog" ],
   tleMaxAgeHours: 12,
   tleBaseUrl: null,   // override to use a CelesTrak mirror
   matchMaxSepDeg: 0.2,
   matchMaxAngleDiffDeg: 12,
   stepSec: 1.0,
   detectAsteroids: true,
   // Draw the predicted-but-unmatched sunlit crossers as ghost lines on the
   // result image (with flag and telemetry, in a distinct pale color).
   nightShowPredicted: false,
   nightShowShadow: false,
   maxSources: 600,
   lang: "en",
   observerLatDeg: null,   // fallbacks when FITS headers lack the site
   observerLonDeg: null,
   observerAltM: 0,
   // Mode selector: "night" (trails), "treasure" (hunt).
   mode: "night",
   // Treasure Hunt: cap catalog rows fetched per cone search.
   treasureMaxRows: 400,
   treasureGalaxies: true,
   treasureQuasars: true,
   treasurePne: true,
   treasureAsteroids: true,
   treasureAccent: SI_DEFAULT_ACCENT
};

function configDir()
{
   return File.homeDirectory + "/.caeloworks/sky-intruders";
}

function loadParams()
{
   var p = configDir() + "/settings.json";
   var out = JSON.parse( JSON.stringify( DEFAULT_PARAMS ) );
   try
   {
      if ( File.exists( p ) )
      {
         var saved = JSON.parse( File.readTextFile( p ) );
         for ( var k in out )
            if ( saved[ k ] !== undefined )
               out[ k ] = saved[ k ];
         // tleExtraGroups has no dialog control, so a saved value is a
         // frozen former default, not a user choice: upgrade the old
         // default in place so existing installs gain the full catalog.
         if ( JSON.stringify( out.tleExtraGroups ) === JSON.stringify( [ "last-30-days" ] ) )
            out.tleExtraGroups = DEFAULT_PARAMS.tleExtraGroups.slice();
      }
   }
   catch ( e ) {}
   return out;
}

function saveParams( params )
{
   try
   {
      if ( !File.directoryExists( configDir() ) )
         File.createDirectory( configDir(), true );
      File.writeTextFile( configDir() + "/settings.json", JSON.stringify( params, null, 2 ) );
   }
   catch ( e )
   {
      console.warningln( SKYINTRUDERS_TITLE + ": could not save settings: " + e.message );
   }
}

// ---------------------------------------------------------------------------
// Wall-clock profiler: named accumulators + a sorted report. Timings answer
// "what would hurt on a 124-sub session" — measure first, optimize second.

var SIProf = ( function()
{
   var acc = {};
   var open = {};
   return {
      reset: function() { acc = {}; open = {}; },
      start: function( name ) { open[ name ] = Date.now(); },
      end: function( name )
      {
         if ( open[ name ] !== undefined )
         {
            acc[ name ] = ( acc[ name ] || 0 ) + ( Date.now() - open[ name ] );
            delete open[ name ];
         }
      },
      add: function( name, ms ) { acc[ name ] = ( acc[ name ] || 0 ) + ms; },
      table: function()
      {
         var rows = [];
         for ( var k in acc )
            rows.push( { name: k, ms: acc[ k ] } );
         rows.sort( function( a, b ) { return b.ms - a.ms; } );
         return rows;
      },
      report: function( frameCount )
      {
         var rows = this.table();
         var total = 0;
         for ( var i = 0; i < rows.length; ++i )
            if ( rows[ i ].name.charAt( 0 ) != "." ) // dotted = sub-detail
               total += rows[ i ].ms;
         console.writeln( "<b>Timings</b> (" + ( total/1000 ).toFixed( 1 ) + " s wall for " +
                          frameCount + " frame(s)):" );
         for ( var i = 0; i < rows.length; ++i )
         {
            var r = rows[ i ];
            var per = ( frameCount > 0 ) ? "  (" + ( r.ms/frameCount ).toFixed( 0 ) + " ms/frame)" : "";
            console.writeln( format( "   %6.1f s  %s%s", r.ms/1000, r.name, per ) );
         }
         return rows;
      }
   };
} )();

// ---------------------------------------------------------------------------
// Analysis pipeline.

function analyzeFrame( filePath, params )
{
   var windows = ImageWindow.open( filePath );
   if ( windows.length == 0 )
      throw new Error( "cannot open " + filePath );
   var window = windows[ 0 ];
   try
   {
      for ( var i = 1; i < windows.length; ++i )
         windows[ i ].forceClose();

      var meta = SIFrameMeta.read( window, filePath );
      var det = SITrailDetect.detect( window.mainView.image, params );

      var w = window.mainView.image.width, h = window.mainView.image.height;
      var margin = Math.max( 8, Math.round( 0.03 * Math.max( w, h ) ) );
      function nearEdge( x, y )
      {
         return x <= margin || y <= margin || x >= w - margin || y >= h - margin;
      }
      for ( var t = 0; t < det.trails.length; ++t )
      {
         var tr = det.trails[ t ];
         tr.index = t;
         tr.spansEdgeToEdge = nearEdge( tr.x1, tr.y1 ) && nearEdge( tr.x2, tr.y2 );
         tr.p1 = meta.wcs.imageToCelestial ? meta.wcs.imageToCelestial( tr.x1, tr.y1 ) : null;
         tr.p2 = meta.wcs.imageToCelestial ? meta.wcs.imageToCelestial( tr.x2, tr.y2 ) : null;
      }
      var planeGroups = SIMeteors.groupPlanes( det.trails );
      for ( var g = 0; g < planeGroups.length; ++g )
      {
         var gvars = [];
         for ( var gi = 0; gi < planeGroups[ g ].indices.length; ++gi )
         {
            det.trails[ planeGroups[ g ].indices[ gi ] ].planeGroup = g;
            var gbv = det.trails[ planeGroups[ g ].indices[ gi ] ].brightnessVariation;
            if ( gbv != null )
               gvars.push( gbv );
         }
         gvars.sort( function( a, b ) { return a - b; } );
         planeGroups[ g ].kind = ( gvars.length > 0 && gvars[ gvars.length >> 1 ] > 0.3 )
                                    ? "plane" : "train";
      }

      // Point sources for asteroid tracking — only useful when we can turn
      // pixels into sky coordinates, so gate on a working WCS.
      var blobs = [];
      if ( meta.wcs.imageToCelestial && params.detectAsteroids )
         blobs = extractPointSources( window.mainView.image, meta.wcs, params );

      return { meta: meta, trails: det.trails, stats: det.stats, blobs: blobs,
               planeGroups: planeGroups, srcW: w, srcH: h };
   }
   finally
   {
      window.forceClose();
   }
}

// Extract the brightest compact sources in pixel coordinates. Capped so the
// O(n^2) mover search downstream stays cheap; movers are found among what
// does NOT recur frame to frame, so a generous cap is fine.
function extractPixelSources( image, cap )
{
   var sd = new StarDetector;
   sd.structureLayers = 5;
   sd.applyHotPixelFilter = true;
   sd.upperLimit = 1.0; // keep bright stars too (we filter by motion, not flux)
   var stars = sd.stars( image );

   var list = [];
   for ( var i = 0; i < stars.length; ++i )
   {
      var s = stars[ i ];
      var px = ( s.pos != null ) ? s.pos.x : s.x;
      var py = ( s.pos != null ) ? s.pos.y : s.y;
      list.push( { fluxAdu: ( s.flux || 0 ) * 65535, x: px, y: py } );
   }
   list.sort( function( a, b ) { return b.fluxAdu - a.fluxAdu; } );
   return ( list.length > ( cap || 600 ) ) ? list.slice( 0, cap || 600 ) : list;
}

function extractPointSources( image, wcs, params )
{
   var px = extractPixelSources( image, params.maxSources );
   var list = [];
   for ( var i = 0; i < px.length; ++i )
   {
      var sky = wcs.imageToCelestial( px[ i ].x, px[ i ].y );
      if ( sky != null )
         list.push( { raDeg: sky.raDeg, decDeg: sky.decDeg,
                      fluxAdu: px[ i ].fluxAdu, x: px[ i ].x, y: px[ i ].y } );
   }
   return list;
}

// ---------------------------------------------------------------------------
// Registered-difference night analysis.
//
// With 3+ frames of one field the static sky can be removed before any line
// is looked for: every frame is star-registered onto the first, a per-pixel
// median across the (binned) registered set becomes the static-sky model,
// and trail detection runs on each frame's positive residual. Stars AND
// nebulosity vanish from the detection map — the Veil's filaments can no
// longer outvote a real streak in the Hough accumulator — and every trail
// lands directly in the reference frame's pixel grid, which is exactly what
// the annotated composite needs. Returns null when the set cannot be
// registered (caller falls back to per-frame detection).

function hasUsableWcs( kind )
{
   return kind === "solution" || kind === "tan";
}

function clearDirectory( dir )
{
   try
   {
      if ( !File.directoryExists( dir ) )
         return;
      var ff = new FileFind;
      var victims = [];
      if ( ff.begin( dir + "/*" ) )
         do
         {
            if ( ff.isFile )
               victims.push( dir + "/" + ff.name );
         }
         while ( ff.next() );
      for ( var i = 0; i < victims.length; ++i )
         File.remove( victims[ i ] );
   }
   catch ( e ) {}
}

// The usual sub-quality indicators, for picking the prettiest frame as the
// result-image background: median star FWHM (sharpness), star count, sky
// background. Cheap: profiles of the 40 brightest StarDetector stars.
function frameQuality( image )
{
   try
   {
      var sd = new StarDetector;
      sd.structureLayers = 5;
      sd.applyHotPixelFilter = true;
      var stars = sd.stars( image );
      stars.sort( function( a, b ) { return ( b.flux || 0 ) - ( a.flux || 0 ); } );
      var w = image.width, h = image.height;
      var fwhms = [];
      for ( var i = 0; i < Math.min( 40, stars.length ); ++i )
      {
         var s = stars[ i ];
         var px = Math.round( ( s.pos != null ) ? s.pos.x : s.x );
         var py = Math.round( ( s.pos != null ) ? s.pos.y : s.y );
         if ( px < 5 || py < 5 || px >= w - 5 || py >= h - 5 )
            continue;
         var profX = [], profY = [];
         for ( var o = -4; o <= 4; ++o )
         {
            profX.push( image.sample( px + o, py, 0 ) );
            profY.push( image.sample( px, py + o, 0 ) );
         }
         var fx = SITrailCore.fwhmOfProfile( profX );
         var fy = SITrailCore.fwhmOfProfile( profY );
         if ( fx > 0 && fy > 0 )
            fwhms.push( ( fx + fy )/2 );
      }
      return { starCount: stars.length,
               fwhmPx: ( fwhms.length > 4 ) ? SITrailCore.medianOf( fwhms ) : 0 };
   }
   catch ( e )
   {
      return { starCount: 0, fwhmPx: 0 };
   }
}

// Cheap transparency proxy on the binned frame: local maxima above
// med + 5 MAD. Clouds crush this count; it ranks frames for ~2 ms each so
// the expensive full-resolution FWHM only runs on the finalists.
function countBinnedPeaks( data, width, height )
{
   var mm = SITrailCore.medianMAD( data, 200000 );
   var thresh = mm.median + 5*( mm.mad > 0 ? mm.mad : 1e-6 );
   var n = 0;
   for ( var y = 1; y < height - 1; ++y )
   {
      var row = y*width;
      for ( var x = 1; x < width - 1; ++x )
      {
         var v = data[row + x];
         if ( v > thresh &&
              v >= data[row + x - 1] && v >= data[row + x + 1] &&
              v >= data[row - width + x] && v >= data[row + width + x] )
            ++n;
      }
   }
   return n;
}

function analyzeNightSet( files, params )
{
   if ( files.length < 3 )
      return null;

   var regDir = File.systemTempDirectory + "/si-night-reg";
   clearDirectory( regDir );
   console.writeln( format( "Registering %d frames on a common grid (StarAlignment)…",
                            files.length ) );
   SIProf.start( "registration (StarAlignment)" );
   var reg = SIRender.registerFramesMapped( files, regDir );
   SIProf.end( "registration (StarAlignment)" );
   if ( reg == null )
      return null;
   var okCount = 0;
   for ( var i = 0; i < reg.paths.length; ++i )
      if ( reg.paths[ i ] != null )
         okCount++;
   if ( okCount < 3 )
   {
      console.warningln( format( "   only %d/%d frames registered — falling back to per-frame detection",
                                 okCount, files.length ) );
      return null;
   }

   // Pass A: metadata + binned copy of every registered frame.
   var entries = [];
   var binLen = -1;
   for ( var i = 0; i < files.length; ++i )
   {
      if ( reg.paths[ i ] == null )
      {
         console.warningln( "   not registered, skipped: " + files[ i ] );
         continue;
      }
      SIProf.start( "pass A: open+bin registered frames" );
      var wins = ImageWindow.open( reg.paths[ i ] );
      if ( wins.length == 0 )
      {
         SIProf.end( "pass A: open+bin registered frames" );
         continue;
      }
      var win = wins[ 0 ];
      for ( var k = 1; k < wins.length; ++k )
         wins[ k ].forceClose();
      var meta = SIFrameMeta.read( win, files[ i ] );
      if ( meta.dateObs == null || meta.exposureSec == null )
      {
         // registration output lost the headers — read them from the source
         var ow = ImageWindow.open( files[ i ] );
         if ( ow.length > 0 )
         {
            meta = SIFrameMeta.read( ow[ 0 ], files[ i ] );
            for ( var k2 = 0; k2 < ow.length; ++k2 )
               ow[ k2 ].forceClose();
         }
      }
      var b = SITrailDetect.binned( win.mainView.image );
      win.forceClose();
      var bgSub = [];
      for ( var bs = 0; bs < b.data.length; bs += 7 )
         if ( b.data[ bs ] > 1e-6 )
            bgSub.push( b.data[ bs ] );
      b.skyBg = SITrailCore.medianOf( bgSub )*65535;
      if ( binLen < 0 )
         binLen = b.data.length;
      if ( b.data.length !== binLen )
      {
         console.warningln( "   geometry mismatch, skipped: " + files[ i ] );
         continue;
      }
      entries.push( { meta: meta, regPath: reg.paths[ i ], binned: b } );
      SIProf.end( "pass A: open+bin registered frames" );
      processEvents();
   }
   if ( entries.length < 3 )
      return null;

   // Static-sky model, two rounds: a first median gives a reference, then
   // each frame is photometrically normalized onto it (linear fit — sky
   // transparency varies with airmass and the nebula would otherwise leak
   // structured residuals into every difference), and the model is rebuilt
   // from the normalized frames.
   // The frames are grouped BY FILTER: the Veil in OIII and the Veil in
   // H-alpha are different objects as far as a median sky model is
   // concerned, and a mixed model leaks whichever structure the linear fit
   // cannot reconcile into every difference (measured on a real mixed
   // session: every OIII frame lost its trails and some H-alpha ones too).
   // Registration and everything downstream stay common — only the model
   // and the detection run per group.
   var groups = {};
   for ( var i = 0; i < entries.length; ++i )
   {
      var filt = String( ( entries[ i ].meta.keywords[ "FILTER" ] || "" ) ).replace( /'/g, "" ).trim() || "?";
      if ( !groups[ filt ] )
         groups[ filt ] = [];
      groups[ filt ].push( i );
   }
   var groupNames = [];
   for ( var gk in groups )
      groupNames.push( gk );
   if ( groupNames.length > 1 )
   {
      var gDesc = [];
      for ( var gi0 = 0; gi0 < groupNames.length; ++gi0 )
         gDesc.push( groupNames[ gi0 ] + ":" + groups[ groupNames[ gi0 ] ].length );
      console.writeln( "Filter groups: " + gDesc.join( ", " ) + " — one sky model per group." );
   }

   var refMeta = entries[ 0 ].meta;
   // A property-based astrometric solution (ImageSolver's spline "solution")
   // projects through the live PixInsight window: makeSolutionProjector closes
   // over `window`. Pass A closed the reference window while binning, so
   // imageToCelestial would return null when the trail endpoints are projected
   // below — killing strict WCS matching for every real plate solve. Re-open
   // the reference and read its metadata from a window kept alive until every
   // projection is done, then close it before returning. Only needed when the
   // reference actually carries a usable solution (the fov() cache is warmed
   // below; ghost overlays use a separate synthetic TAN, and mover blobs are
   // projected in-loop, so nothing past the return still needs this window).
   var refWin = null;
   if ( hasUsableWcs( refMeta.wcs.kind ) )
   {
      try
      {
         var rw = ImageWindow.open( reg.paths[ 0 ] );
         if ( rw.length > 0 )
         {
            refWin = rw[ 0 ];
            for ( var rk = 1; rk < rw.length; ++rk )
               rw[ rk ].forceClose();
            refMeta = SIFrameMeta.read( refWin, files[ 0 ] );
         }
      }
      catch ( e ) { refWin = null; }
   }
   var refW = entries[ 0 ].binned.srcW, refH = entries[ 0 ].binned.srcH;
   var margin = Math.max( 8, Math.round( 0.03 * Math.max( refW, refH ) ) );
   function nearEdge( x, y )
   {
      return x <= margin || y <= margin || x >= refW - margin || y >= refH - margin;
   }

   var results = new Array( entries.length );
   var detProfile = {};

   for ( var gi = 0; gi < groupNames.length; ++gi )
   {
      var idx = groups[ groupNames[ gi ] ];
      if ( idx.length < 3 )
      {
         console.warningln( format( "   filter group '%s' has only %d frame(s) — " +
                                    "3+ are needed for difference detection; skipped.",
                                    groupNames[ gi ], idx.length ) );
         for ( var s0 = 0; s0 < idx.length; ++s0 )
            results[ idx[ s0 ] ] = { trails: [], stats: {}, planeGroups: [] };
         continue;
      }

      var arrays = [];
      for ( var a0 = 0; a0 < idx.length; ++a0 )
         arrays.push( entries[ idx[ a0 ] ].binned.data );
      // 60% of the group: N-1 forced the strict intersection of every
      // pointing — on a multi-night session the one-night border zones
      // (where trails live too) were masked out entirely. At 60% the
      // population seams still involve enough frames for a solid median,
      // and the per-frame ringing masks handle the frame edges.
      var minCover = Math.max( 3, Math.ceil( idx.length*0.6 ) );
      SIProf.start( "model: median + normalize" );
      var stack0 = SITrailCore.medianStackMasked( arrays, 1e-6, minCover );
      for ( var a1 = 0; a1 < idx.length; ++a1 )
      {
         var lf = SITrailCore.linearFitToModel( arrays[ a1 ], stack0.model, stack0.valid );
         SITrailCore.applyLinear( arrays[ a1 ], lf.a, lf.b );
         processEvents();
      }
      var stack = SITrailCore.medianStackMasked( arrays, 1e-6, minCover );
      var model = stack.model;
      // 6 px: past the Lanczos ringing at every resampled frame's coverage
      // boundary, spread a few px by the intra-night dither.
      var mask = SITrailCore.erodeMask( stack.valid, entries[ idx[ 0 ] ].binned.width,
                                        entries[ idx[ 0 ] ].binned.height, 6 );
      SIProf.end( "model: median + normalize" );

      for ( var p0 = 0; p0 < idx.length; ++p0 )
      {
         var e = entries[ idx[ p0 ] ];
         SIProf.start( "pass B: reopen frames" );
         var wins2 = ImageWindow.open( e.regPath );
         SIProf.end( "pass B: reopen frames" );
         if ( wins2.length == 0 )
         {
            results[ idx[ p0 ] ] = { trails: [], stats: {}, planeGroups: [] };
            continue;
         }
         var win2 = wins2[ 0 ];
         for ( var k3 = 1; k3 < wins2.length; ++k3 )
            wins2[ k3 ].forceClose();

         // Per-frame mask: the global coverage mask AND the frame's OWN
         // coverage eroded — Lanczos ringing at a resampled frame's boundary
         // lives a few nonzero pixels INSIDE its coverage, invisible to the
         // global mask and strong enough to pose as an edge-hugging trail.
         var fv = new Uint8Array( e.binned.data.length );
         for ( var m2 = 0; m2 < fv.length; ++m2 )
            fv[ m2 ] = ( e.binned.data[ m2 ] > 1e-6 ) ? 1 : 0;
         fv = SITrailCore.erodeMask( fv, e.binned.width, e.binned.height, 6 );
         var frameMask = new Uint8Array( fv.length );
         for ( var m3 = 0; m3 < fv.length; ++m3 )
            frameMask[ m3 ] = ( mask[ m3 ] && fv[ m3 ] ) ? 1 : 0;

         var diffParams = JSON.parse( JSON.stringify( params ) );
         diffParams.profile = detProfile;
         if ( params.diffKSigma > 0 )
            diffParams.kSigma = params.diffKSigma;
         // A satellite train alone can leave 10+ parallel streaks in one sub —
         // never let a bundle exhaust the slots and mask a lone trail.
         diffParams.maxTrails = Math.max( 25, params.maxTrails || 0 );
         SIProf.start( "pass B: detection (diff)" );
         var det = SITrailDetect.detectDiff( win2.mainView.image, e.binned, model, diffParams, frameMask );
         SIProf.end( "pass B: detection (diff)" );
         SIProf.start( "pass B: frame quality (binned peaks)" );
         e.quality = { peaks: countBinnedPeaks( e.binned.data, e.binned.width, e.binned.height ),
                       skyBgAdu: e.binned.skyBg };
         SIProf.end( "pass B: frame quality (binned peaks)" );

         var trails = [];
         for ( var t = 0; t < det.trails.length; ++t )
         {
            var tr = det.trails[ t ];
            // Width veto: a real streak is a thin line; residual cloud bands
            // and stacking artifacts that survive the median are broad.
            if ( tr.widthPx > 12 )
               continue;
            tr.index = trails.length;
            tr.spansEdgeToEdge = nearEdge( tr.x1, tr.y1 ) && nearEdge( tr.x2, tr.y2 );
            if ( hasUsableWcs( refMeta.wcs.kind ) )
            {
               tr.p1 = refMeta.wcs.imageToCelestial( tr.x1, tr.y1 );
               tr.p2 = refMeta.wcs.imageToCelestial( tr.x2, tr.y2 );
            }
            else
            {
               tr.p1 = null;
               tr.p2 = null;
            }
            trails.push( tr );
         }

         // Movers need trustworthy astrometry — see runAnalysis: registered
         // sets without a real WCS skip the asteroid search entirely.
         var blobs = [];
         if ( params.detectAsteroids && hasUsableWcs( refMeta.wcs.kind ) )
         {
            var pix = extractPixelSources( win2.mainView.image, params.maxSources );
            for ( var s = 0; s < pix.length; ++s )
            {
               var sky = refMeta.wcs.imageToCelestial( pix[ s ].x, pix[ s ].y );
               if ( sky != null )
                  blobs.push( { raDeg: sky.raDeg, decDeg: sky.decDeg,
                                fluxAdu: pix[ s ].fluxAdu, x: pix[ s ].x, y: pix[ s ].y } );
            }
         }

         win2.forceClose();
         e.binned.data = null; // release the big array, keep the metadata

         // Parallel bundles: several near-parallel segments in ONE frame are a
         // single object — an airplane (strobing lights: strong brightness
         // variation along the marks) or a satellite train (fresh launch, not
         // yet cataloged: steady parallel streaks). Grouped before matching so
         // they never get individual satellite names.
         var planeGroups = SIMeteors.groupPlanes( trails );
         for ( var g = 0; g < planeGroups.length; ++g )
         {
            var pg = planeGroups[ g ];
            var vars = [];
            for ( var gi2 = 0; gi2 < pg.indices.length; ++gi2 )
            {
               trails[ pg.indices[ gi2 ] ].planeGroup = g;
               var bv = trails[ pg.indices[ gi2 ] ].brightnessVariation;
               if ( bv != null )
                  vars.push( bv );
            }
            vars.sort( function( a, b ) { return a - b; } );
            var medVar = ( vars.length > 0 ) ? vars[ vars.length >> 1 ] : 0;
            pg.kind = ( medVar > 0.3 ) ? "plane" : "train";
         }

         results[ idx[ p0 ] ] = { trails: trails, stats: det.stats, blobs: blobs,
                                  planeGroups: planeGroups };
         if ( trails.length > 0 )
            console.writeln( format( "   %s: %d transient trail(s)%s", e.meta.id, trails.length,
                                     planeGroups.length > 0
                                        ? format( " — %d bundle(s)", planeGroups.length )
                                        : "" ) );
         processEvents();
         gc();
      }
   }

   var frames = [];
   for ( var fi2 = 0; fi2 < entries.length; ++fi2 )
   {
      var r0 = results[ fi2 ] || { trails: [], stats: {}, planeGroups: [] };
      frames.push( { meta: entries[ fi2 ].meta, trails: r0.trails, stats: r0.stats,
                     blobs: r0.blobs || [], planeGroups: r0.planeGroups,
                     srcW: refW, srcH: refH } );
   }
   var regPaths = [];
   for ( var i = 0; i < entries.length; ++i )
      regPaths.push( entries[ i ].regPath );

   // Best frame, two stages: rank everything by the cheap indicators
   // (peak count = transparency, sky background), then measure the real
   // star FWHM at full resolution on the top 3 only.
   SIProf.start( "best-frame pick (FWHM on top 3)" );
   function medianOfKey( key )
   {
      var v = [];
      for ( var i = 0; i < entries.length; ++i )
         if ( entries[ i ].quality && entries[ i ].quality[ key ] > 0 )
            v.push( entries[ i ].quality[ key ] );
      return ( v.length > 0 ) ? SITrailCore.medianOf( v ) : 0;
   }
   var mPeaks = medianOfKey( "peaks" ), mBg = medianOfKey( "skyBgAdu" );
   var ranked = [];
   for ( var i = 0; i < entries.length; ++i )
   {
      var q = entries[ i ].quality || {};
      ranked.push( { i: i,
                     light: ( ( q.skyBgAdu > 0 && mBg > 0 ) ? 0.5*q.skyBgAdu/mBg : 0.75 )
                          - ( ( q.peaks > 0 && mPeaks > 0 ) ? q.peaks/mPeaks : 0 ) } );
   }
   ranked.sort( function( a, b ) { return a.light - b.light; } );
   var bestIndex = ranked[ 0 ].i, bestFwhm = 0, bestScore = Infinity;
   for ( var r5 = 0; r5 < Math.min( 3, ranked.length ); ++r5 )
   {
      var cand = ranked[ r5 ].i;
      var cw = ImageWindow.open( entries[ cand ].regPath );
      if ( cw.length == 0 )
         continue;
      for ( var k6 = 1; k6 < cw.length; ++k6 )
         cw[ k6 ].forceClose();
      var fq = frameQuality( cw[ 0 ].mainView.image );
      cw[ 0 ].forceClose();
      entries[ cand ].quality.fwhmPx = fq.fwhmPx;
      entries[ cand ].quality.starCount = fq.starCount;
      var score = ( fq.fwhmPx > 0 ? fq.fwhmPx : 9 ) + ranked[ r5 ].light;
      if ( score < bestScore )
      {
         bestScore = score;
         bestIndex = cand;
         bestFwhm = fq.fwhmPx;
      }
      gc();
   }
   SIProf.end( "best-frame pick (FWHM on top 3)" );
   var bq = entries[ bestIndex ].quality || {};
   console.writeln( format( "Best frame for the result image: %s (FWHM %.1f px, %d peaks, sky %.0f ADU)",
                            entries[ bestIndex ].meta.id, bestFwhm,
                            bq.peaks || 0, bq.skyBgAdu || 0 ) );

   // Detector-internal split (dotted names = detail of "pass B: detection").
   if ( detProfile.subtractMs ) SIProf.add( ".detect: subtract+flatten", detProfile.subtractMs );
   if ( detProfile.brightMs ) SIProf.add( ".detect: bright pass", detProfile.brightMs );
   if ( detProfile.faintMs ) SIProf.add( ".detect: faint pass", detProfile.faintMs );
   if ( detProfile.faintHoughMs ) SIProf.add( ".detect: faint hough+normalize", detProfile.faintHoughMs );
   if ( detProfile.faintRefineMs ) SIProf.add( ".detect: faint refine", detProfile.faintRefineMs );
   if ( detProfile.photometryMs ) SIProf.add( ".detect: photometry", detProfile.photometryMs );
   if ( detProfile.faintIters ) SIProf.add( ".detect: faint iterations (count)", detProfile.faintIters );

   // Warm the fov() cache while the reference window is still live (fov is the
   // only refMeta.wcs use left after this return), then release the window.
   if ( refWin != null )
   {
      try { refMeta.wcs.fov(); } catch ( e ) {}
      try { refWin.forceClose(); } catch ( e ) {}
   }
   return { frames: frames, refMeta: refMeta, refW: refW, refH: refH,
            regPaths: regPaths, regDir: regDir, bestIndex: bestIndex };
}

function buildMatchRequest( frames, observer, params, fovOverride )
{
   var req = { observer: observer, frames: [], options: {
      stepSec: params.stepSec,
      matchMaxSepDeg: params.matchMaxSepDeg,
      matchMaxAngleDiffDeg: params.matchMaxAngleDiffDeg } };
   for ( var i = 0; i < frames.length; ++i )
   {
      var f = frames[ i ];
      if ( f.meta.dateObs == null || f.meta.exposureSec == null )
         continue;
      // Registered sets share the reference frame's grid, so every frame's
      // trails live in the REFERENCE field of view.
      var fov = ( fovOverride != null ) ? fovOverride : f.meta.wcs.fov();
      if ( fov == null )
         continue;
      var trails = [];
      for ( var t = 0; t < f.trails.length; ++t )
      {
         if ( f.trails[ t ].planeGroup != null )
            continue; // airplane bundles never get satellite names
         trails.push( { index: f.trails[ t ].index,
                        p1: f.trails[ t ].p1, p2: f.trails[ t ].p2,
                        pixLength: f.trails[ t ].lengthPx,
                        meanFluxAdu: f.trails[ t ].meanFluxAdu,
                        widthPx: f.trails[ t ].widthPx,
                        brightnessVariation: f.trails[ t ].brightnessVariation } );
      }
      req.frames.push( { id: f.meta.id,
                         startUtc: f.meta.dateObs.toISOString(),
                         exposureSec: f.meta.exposureSec,
                         fov: fov, trails: trails } );
   }
   return req;
}

function nightLabel( frames )
{
   var dates = [];
   for ( var i = 0; i < frames.length; ++i )
      if ( frames[ i ].meta.dateObs != null )
         dates.push( frames[ i ].meta.dateObs );
   if ( dates.length == 0 )
      return "(undated)";
   dates.sort( function( a, b ) { return a - b; } );
   function ymd( d )
   {
      return d.getFullYear() + "-" +
             ( d.getMonth() < 9 ? "0" : "" ) + ( d.getMonth() + 1 ) + "-" +
             ( d.getDate() < 10 ? "0" : "" ) + d.getDate();
   }
   var a = ymd( dates[ 0 ] ), b = ymd( dates[ dates.length - 1 ] );
   return ( a == b ) ? a : a + "/" + b.substring( 8 );
}

// Invert the fitted synthetic TAN: sky -> reference-grid pixels (for the
// predicted-crosser ghost overlay).
function tanInvertForOverlay( tan, p )
{
   var DEG = Math.PI/180;
   var ra0 = tan.crval1*DEG, dec0 = tan.crval2*DEG;
   var ra = p.raDeg*DEG, dec = p.decDeg*DEG;
   var dRA = ra - ra0;
   var sinD0 = Math.sin( dec0 ), cosD0 = Math.cos( dec0 );
   var sinD = Math.sin( dec ), cosD = Math.cos( dec );
   var D = sinD*sinD0 + cosD*cosD0*Math.cos( dRA );
   if ( D <= 0 )
      return null;
   var xi = ( cosD*Math.sin( dRA )/D )/DEG;
   var eta = ( ( sinD*cosD0 - cosD*sinD0*Math.cos( dRA ) )/D )/DEG;
   var det = tan.cd11*tan.cd22 - tan.cd12*tan.cd21;
   if ( det === 0 )
      return null;
   return { x: tan.crpix1 + ( tan.cd22*xi - tan.cd12*eta )/det - 1,
            y: tan.crpix2 + ( tan.cd11*eta - tan.cd21*xi )/det - 1 };
}

function runAnalysis( files, params )
{
   SIProf.reset();
   var tRun = Date.now();
   // Registered-difference analysis first (3+ frames of one field); fall
   // back to independent per-frame detection when the set cannot register.
   var set = null;
   try
   {
      set = analyzeNightSet( files, params );
   }
   catch ( e )
   {
      console.warningln( SKYINTRUDERS_TITLE + ": registered analysis failed (" + e.message +
                         ") — falling back to per-frame detection." );
      set = null;
   }

   var frames = [];
   if ( set != null )
      frames = set.frames;
   else
      for ( var i = 0; i < files.length; ++i )
      {
         console.writeln( format( "<b>[%d/%d]</b> ", i + 1, files.length ) + files[ i ] );
         try
         {
            var r = analyzeFrame( files[ i ], params );
            frames.push( r );
            if ( r.trails.length > 0 )
               console.writeln( format( "   %d trail(s), background %.1f ADU, noise %.1f ADU",
                                        r.trails.length, r.stats.medianAdu, r.stats.madAdu ) );
         }
         catch ( e )
         {
            console.warningln( "   skipped: " + e.message );
         }
         processEvents();
      }
   if ( frames.length == 0 )
      throw new Error( "no frame could be analyzed" );

   // Observer site: headers first, dialog fallback second.
   var observer = null;
   for ( var i = 0; i < frames.length; ++i )
      if ( frames[ i ].meta.observer != null )
      {
         observer = frames[ i ].meta.observer;
         break;
      }
   if ( observer == null && params.observerLatDeg != null && params.observerLonDeg != null )
      observer = { latDeg: params.observerLatDeg, lonDeg: params.observerLonDeg,
                   altM: params.observerAltM || 0 };

   // TLE cross-match through the sidecar; degrade gracefully without it.
   var matchResponse = null, tleInfo = null;
   if ( observer == null )
      console.warningln( SKYINTRUDERS_TITLE + ": no observer site (SITELAT/SITELONG headers " +
                         "or dialog fallback) — satellite identification disabled." );
   else
      try
      {
         console.writeln( "Fetching TLE catalog (group: " + params.tleGroup + ")…" );
         SIProf.start( "TLE fetch (+extras)" );
         tleInfo = SITleNet.fetchTle( params.tleGroup, configDir() + "/tle",
                                      params.tleMaxAgeHours, params.tleBaseUrl );
         console.writeln( format( "   %d satellites, %s%s", tleInfo.count,
                                  tleInfo.fromCache ? "from cache" : "fresh download",
                                  tleInfo.stale ? " (STALE — network unreachable)" : "" ) );
         var tleText = File.readTextFile( tleInfo.tlePath );
         if ( params.tleExtraGroups && params.tleExtraGroups.length > 0 )
         {
            for ( var xg = 0; xg < params.tleExtraGroups.length; ++xg )
               try
               {
                  var ext = SITleNet.fetchTle( params.tleExtraGroups[ xg ], configDir() + "/tle",
                                               params.tleMaxAgeHours, params.tleBaseUrl );
                  tleText += "\n" + File.readTextFile( ext.tlePath );
                  console.writeln( format( "   + %s: %d satellites", params.tleExtraGroups[ xg ],
                                           ext.count ) );
               }
               catch ( eg )
               {
                  console.warningln( "   + " + params.tleExtraGroups[ xg ] + ": " + eg.message );
               }
            // Dedup by NORAD id (first occurrence wins — list the primary
            // group first).
            var parsed = SISatMatch.parseTles( tleText );
            var seenIds = {};
            var rebuilt = [];
            for ( var pt = 0; pt < parsed.length; ++pt )
               if ( !seenIds[ parsed[ pt ].noradId ] )
               {
                  seenIds[ parsed[ pt ].noradId ] = true;
                  rebuilt.push( parsed[ pt ].name + "\n" + parsed[ pt ].line1 + "\n" + parsed[ pt ].line2 );
               }
            tleText = rebuilt.join( "\n" );
            tleInfo.count = rebuilt.length;
            console.writeln( format( "   = %d satellites after merge/dedup", rebuilt.length ) );
         }
         SIProf.end( "TLE fetch (+extras)" );
         var fovOverride = ( set != null ) ? set.refMeta.wcs.fov() : null;
         var req = buildMatchRequest( frames, observer, params, fovOverride );
         if ( req.frames.length > 0 )
         {
            console.writeln( "Cross-matching " + req.frames.length + " frame window(s)…" );
            SIProf.start( "SGP4 cross-match" );
            matchResponse = SISatMatch.match( req, tleText );
            SIProf.end( "SGP4 cross-match" );
         }
      }
      catch ( e )
      {
         console.warningln( SKYINTRUDERS_TITLE + ": TLE matching unavailable — " + e.message );
      }

   // Merge crossings + heuristics into events.
   var events = [];
   var crossingsByFrame = {};
   if ( matchResponse != null && !matchResponse.error )
      for ( var i = 0; i < matchResponse.frames.length; ++i )
         crossingsByFrame[ matchResponse.frames[ i ].id ] = matchResponse.frames[ i ].crossings || [];

   // Unsolved registered set: the trails all live in one pixel grid whose
   // center and plate scale are known from the headers — only the rotation
   // and the mirror parity are not. Fit them against the predicted sunlit
   // crossings, then give every trail sky coordinates and run the standard
   // trail <-> crossing assignment.
   var fitInfo = null;
   var fitTanForOverlay = null;
   if ( set != null && !hasUsableWcs( set.refMeta.wcs.kind ) && matchResponse != null &&
        !matchResponse.error )
   {
      var refFov = set.refMeta.wcs.fov();
      if ( refFov != null )
      {
         var fitFrames = [];
         for ( var i = 0; i < frames.length; ++i )
         {
            var fitTrails = [];
            for ( var t2 = 0; t2 < frames[ i ].trails.length; ++t2 )
               if ( frames[ i ].trails[ t2 ].planeGroup == null )
                  fitTrails.push( frames[ i ].trails[ t2 ] );
            fitFrames.push( { crossings: crossingsByFrame[ frames[ i ].meta.id ] || [],
                              trails: fitTrails } );
         }
         var field = { raDeg: refFov.raDeg, decDeg: refFov.decDeg,
                       pixScaleArcsec: set.refMeta.pixScaleArcsec,
                       width: set.refW, height: set.refH };
         SIProf.start( "orientation fit" );
         var fit = SISatMatch.fitOrientation( fitFrames, field, {} );
         SIProf.end( "orientation fit" );
         if ( fit != null && fit.pairs.length < 3 )
         {
            // With one rotation, one parity and a center correction to play
            // with, two pairs can almost always be made to agree — naming
            // satellites on such a fit produces confident nonsense. The
            // predicted-crossers section still tells the user what flew by.
            console.writeln( format( "Field orientation fit found only %d matched pair(s) — " +
                                     "not enough to trust satellite names; crossers are " +
                                     "reported as predictions only.", fit.pairs.length ) );
            fit = null;
         }
         if ( fit != null && fit.pairs.length > 0 )
         {
            fitInfo = { rotationDeg: fit.rotationDeg, parity: fit.parity,
                        pairs: fit.pairs.length, score: fit.score };
            fitTanForOverlay = fit.tan;
            console.writeln( format( "Field orientation fitted from %d trail(s): " +
                                     "rotation %.1f°, %s", fit.pairs.length, fit.rotationDeg,
                                     fit.parity < 0 ? "mirrored" : "direct" ) );
            // TLE predictions err mostly ALONG the track (early/late on
            // the ephemeris); the loose assigner is tight across, generous
            // along.
            var opt = { crossTolDeg: 0.4, alongTolDeg: 1.5,
                        angleTolDeg: params.matchMaxAngleDiffDeg || 12 };
            for ( var i = 0; i < frames.length; ++i )
            {
               var fr = frames[ i ];
               for ( var t = 0; t < fr.trails.length; ++t )
               {
                  fr.trails[ t ].p1 = SISatMatch.core.tanProject(
                     fit.tan, fr.trails[ t ].x1, fr.trails[ t ].y1 );
                  fr.trails[ t ].p2 = SISatMatch.core.tanProject(
                     fit.tan, fr.trails[ t ].x2, fr.trails[ t ].y2 );
               }
               var assignable = [];
               for ( var t3 = 0; t3 < fr.trails.length; ++t3 )
                  if ( fr.trails[ t3 ].planeGroup == null )
                     assignable.push( fr.trails[ t3 ] );
               SISatMatch.core.assignTrailsLoose( crossingsByFrame[ fr.meta.id ] || [],
                                                  { trails: assignable }, opt );

               // Match diagnostics: for every trail, the nearest sunlit
               // crossing and how far it is from the tolerances — the data
               // needed to answer "why is this one unnamed?".
               if ( params.matchDiagnostics )
               {
                  fitInfo.diag = fitInfo.diag || [];
                  var crs = crossingsByFrame[ fr.meta.id ] || [];
                  for ( var t4 = 0; t4 < assignable.length; ++t4 )
                  {
                     var trl = assignable[ t4 ];
                     if ( !trl.p1 || !trl.p2 )
                        continue;
                     var tMid = SISatMatch.core.midpointRaDec( trl.p1, trl.p2 );
                     var tPA = SISatMatch.core.positionAngleDeg( trl.p1, trl.p2 );
                     var tLen = SISatMatch.core.angularSepDeg( trl.p1, trl.p2 );
                     var best = null;
                     for ( var c5 = 0; c5 < crs.length; ++c5 )
                     {
                        var cMid = SISatMatch.core.midpointRaDec( crs[ c5 ].path.p1, crs[ c5 ].path.p2 );
                        var sep = SISatMatch.core.angularSepDeg( tMid, cMid );
                        var ad = SISatMatch.core.orientationDiffDeg(
                           tPA, SISatMatch.core.positionAngleDeg( crs[ c5 ].path.p1, crs[ c5 ].path.p2 ) );
                        var cLen = SISatMatch.core.angularSepDeg( crs[ c5 ].path.p1, crs[ c5 ].path.p2 );
                        if ( best == null || sep < best.sepDeg )
                        {
                           var cPA5 = SISatMatch.core.positionAngleDeg( crs[ c5 ].path.p1, crs[ c5 ].path.p2 );
                           var rel5 = ( SISatMatch.core.positionAngleDeg( cMid, tMid ) - cPA5 )*Math.PI/180;
                           best = { name: crs[ c5 ].name || String( crs[ c5 ].noradId ),
                                    sunlit: !!crs[ c5 ].sunlit,
                                    sepDeg: Math.round( sep*1000 )/1000,
                                    angleDiffDeg: Math.round( ad*10 )/10,
                                    alongDeg: Math.round( Math.abs( sep*Math.cos( rel5 ) )*1000 )/1000,
                                    crossDeg: Math.round( Math.abs( sep*Math.sin( rel5 ) )*1000 )/1000,
                                    lenDeg: Math.round( cLen*100 )/100 };
                        }
                     }
                     fitInfo.diag.push( { frame: fr.meta.id.substring( 0, 19 ),
                                          trail: trl.index,
                                          trailPA: Math.round( tPA*10 )/10,
                                          trailLenDeg: Math.round( tLen*100 )/100,
                                          bestCandidate: best } );
                  }
               }
            }
         }
         else
         {
            console.writeln( "Field orientation could not be fitted — satellites are listed " +
                             "as window crossers only." );
         }
      }
   }

   // Operator country for the flag chip on the result image, from the
   // catalog name. Coarse by design; unknown stays a neutral placeholder.
   function satCountryCode( name )
   {
      var n = ( name || "" ).toUpperCase();
      if ( /STARLINK|IRIDIUM|GLOBALSTAR|NAVSTAR|GPS |FLOCK|SKYSAT|LEMUR|KUIPER|USA |NOSS|LACROSSE|IMAGE|GOES|TERRA|AQUA|LANDSAT/.test( n ) ) return "us";
      if ( /QIANFAN|G60|HULIANWANG|CHUANGXIN|TIANGONG|^CSS|CZ-|YAOGAN|FENGYUN|SHIYAN|JILIN|GAOFEN|BEIDOU|CHINASAT|SHENZHOU/.test( n ) ) return "cn";
      if ( /COSMOS|GLONASS|SOYUZ|PROGRESS|METEOR-|RESURS/.test( n ) ) return "ru";
      if ( /ONEWEB/.test( n ) ) return "gb";
      if ( /GALILEO|SENTINEL|METEOSAT|ARIANE/.test( n ) ) return "eu";
      if ( /HIMAWARI|ALOS|QZS/.test( n ) ) return "jp";
      if ( /IRNSS|CARTOSAT|GSAT|RISAT/.test( n ) ) return "in";
      if ( /SPOT |PLEIADES|ELISA|CERES/.test( n ) ) return "fr";
      return "xx";
   }

   // CelesTrak SATCAT OWNER codes -> ISO flag codes (vendored circle-flags).
   var OWNER_FLAG = {
      US: "us", PRC: "cn", CIS: "ru", UK: "gb", FR: "fr", GER: "de",
      JPN: "jp", IND: "in", ESA: "eu", EUTE: "eu", EUME: "eu", EUSP: "eu",
      IT: "it", CA: "ca", AUS: "au", BRAZ: "br", ISRA: "il", SKOR: "kr",
      TURK: "tr", ARGN: "ar", SAFR: "za", SPN: "es", NETH: "nl", SWED: "se",
      NOR: "no", SWTZ: "ch", POL: "pl", DEN: "dk", SING: "sg", THAI: "th",
      INDO: "id", MEX: "mx", UKR: "ua", KAZ: "kz", SAUD: "sa", UAE: "ae",
      LUXE: "lu", SES: "lu", O3B: "lu", GLOB: "us", IRID: "us", ORB: "us"
   };

   function loadSatcatInfo()
   {
      // NORAD id -> { owner, ops } from the (cached) SATCAT; empty on
      // failure — the name heuristic then covers the flags and the
      // telemetry line simply omits the service status.
      try
      {
         var info = SITleNet.fetchSatcat( configDir() + "/tle", 24*7 );
         if ( info != null )
            return SITleNet.parseSatcatInfo( File.readTextFile( info.path ) );
      }
      catch ( e ) {}
      return {};
   }

   // Second label line on the result image: distance, angular rate, launch
   // year (from the COSPAR designator), service status (SATCAT).
   // What kind of thing is this, per the SATCAT record: a working payload,
   // a dead one, an unknown one (classified objects come out '?'), a rocket
   // body or debris \u2014 the last two have no ops status, the notion does not
   // apply. Returns a language-neutral code, or null without a record (a
   // failed SATCAT fetch must not relabel everything "unknown").
   function satClassCode( rec )
   {
      if ( !rec )
         return null;
      if ( rec.type == "R/B" )
         return "rb";
      if ( rec.type == "DEB" )
         return "debris";
      if ( rec.ops && "+PBSX".indexOf( rec.ops ) >= 0 )
         return "active";
      if ( rec.ops == "-" )
         return "dead";
      return "unknown";
   }

   var SAT_CLASS_LABEL = {
      en: { rb: "rocket body", debris: "debris", active: "in service",
            dead: "out of service", unknown: "unknown" },
      fr: { rb: "\u00e9tage de fus\u00e9e", debris: "d\u00e9bris", active: "en service",
            dead: "hors service", unknown: "inconnu" }
   };

   function satTelemetryLine( crossing, satcat, lang )
   {
      var fr = ( lang == "fr" );
      var parts = [];
      if ( crossing.rangeKm > 0 )
         parts.push( Math.round( crossing.rangeKm ) + "\u2009km" );
      if ( crossing.angularRateDegPerSec > 0 )
      {
         var r = crossing.angularRateDegPerSec.toFixed( 2 );
         parts.push( ( fr ? r.replace( ".", "," ) : r ) + "\u00b0/s" );
      }
      var des = String( crossing.intlDes || "" );
      var m = /^(\d{4})-/.exec( des );
      if ( m )
         parts.push( m[ 1 ] );
      var cls = satClassCode( satcat[ crossing.noradId ] );
      if ( cls != null )
         parts.push( SAT_CLASS_LABEL[ fr ? "fr" : "en" ][ cls ] );
      return parts.join( " \u00b7 " );
   }

   function flagAssetsDir()
   {
      try
      {
         return File.extractDrive( #__FILE__ ) + File.extractDirectory( #__FILE__ ) +
                "/assets/flags";
      }
      catch ( e )
      {
         return null;
      }
   }

   var TRAIL_STYLE = {
      satellite: "#22d3ee",
      "satellite-candidate": "#ffa05f",
      meteor: "#ff5f8f",
      plane: "#a7b34d",
      train: "#8fd18f",
      unknown: "#c9d2dd"
   };
   var FALLBACK_LABEL = {
      en: { "satellite-candidate": "unidentified satellite", meteor: "meteor?",
            plane: "airplane", train: "satellite train", unknown: "intruder?" },
      fr: { "satellite-candidate": "satellite non identifié", meteor: "météore ?",
            plane: "avion", train: "train de satellites", unknown: "intrus ?" }
   };
   var langLabels = FALLBACK_LABEL[ params.lang ] || FALLBACK_LABEL.en;
   var labeledTrails = [];
   SIProf.start( "SATCAT fetch+parse" );
   var satcatInfo = loadSatcatInfo();
   SIProf.end( "SATCAT fetch+parse" );

   var cleanFrames = 0, totalExposureSec = 0;
   var predicted = [];
   for ( var i = 0; i < frames.length; ++i )
   {
      var f = frames[ i ];
      totalExposureSec += f.meta.exposureSec || 0;
      if ( f.trails.length == 0 )
         cleanFrames++;
      var crossings = crossingsByFrame[ f.meta.id ] || [];
      // Sunlit crossers that did not get matched to any trail still belong
      // in the report — the pass happened whether we caught the streak or not.
      for ( var c0 = 0; c0 < crossings.length; ++c0 )
         if ( crossings[ c0 ].matchedTrailIndex == null && crossings[ c0 ].sunlit )
            predicted.push( { name: crossings[ c0 ].name,
                              noradId: crossings[ c0 ].noradId,
                              timeUtc: crossings[ c0 ].entryUtc ? new Date( crossings[ c0 ].entryUtc ) : null,
                              elevationDeg: crossings[ c0 ].elevationDeg,
                              frameId: f.meta.id } );
      var matchedIdx = {};
      for ( var c = 0; c < crossings.length; ++c )
         if ( crossings[ c ].matchedTrailIndex != null )
         {
            matchedIdx[ crossings[ c ].matchedTrailIndex ] = true;
            events.push( { timeUtc: crossings[ c ].entryUtc ? new Date( crossings[ c ].entryUtc ) : f.meta.dateObs,
                           klass: "satellite",
                           name: crossings[ c ].name,
                           noradId: crossings[ c ].noradId,
                           confidence: crossings[ c ].matchConfidence || "high",
                           elevationDeg: crossings[ c ].elevationDeg,
                           angularRateDegPerSec: crossings[ c ].angularRateDegPerSec,
                           satClass: satClassCode( satcatInfo[ crossings[ c ].noradId ] ),
                           frameId: f.meta.id } );
            var tr0 = null;
            for ( var tt = 0; tt < f.trails.length; ++tt )
               if ( f.trails[ tt ].index === crossings[ c ].matchedTrailIndex )
                  tr0 = f.trails[ tt ];
            if ( tr0 != null )
               labeledTrails.push( { frameIndex: i,
                                     x1: tr0.x1, y1: tr0.y1, x2: tr0.x2, y2: tr0.y2,
                                     color: TRAIL_STYLE.satellite,
                                     flag: OWNER_FLAG[ ( satcatInfo[ crossings[ c ].noradId ] || {} ).owner ] ||
                                           satCountryCode( crossings[ c ].name ),
                                     sub: satTelemetryLine( crossings[ c ], satcatInfo, params.lang ),
                                     label: ( crossings[ c ].name || ( "NORAD " + crossings[ c ].noradId ) ) +
                                            ( crossings[ c ].matchConfidence === "medium" ? " ?" : "" ) +
                                            ( crossings[ c ].entryUtc
                                               ? " · " + String( crossings[ c ].entryUtc ).substring( 11, 16 ) + " UT"
                                               : "" ) } );
         }
      // One event (and one drawn line) per bundle — airplane or train.
      for ( var g = 0; g < ( f.planeGroups || [] ).length; ++g )
      {
         var pg = f.planeGroups[ g ];
         var kind = pg.kind || "plane";
         events.push( { timeUtc: f.meta.dateObs,
                        klass: kind,
                        name: null,
                        segments: pg.segments,
                        frameId: f.meta.id } );
         labeledTrails.push( { frameIndex: i,
                               x1: pg.x1, y1: pg.y1, x2: pg.x2, y2: pg.y2,
                               color: TRAIL_STYLE[ kind ],
                               label: langLabels[ kind ] + " (" + pg.segments + ")" } );
      }
      for ( var t = 0; t < f.trails.length; ++t )
         if ( !matchedIdx[ f.trails[ t ].index ] && f.trails[ t ].planeGroup == null )
         {
            var cls = SIMeteors.classifyTrail( f.trails[ t ], f.meta.dateObs );
            events.push( { timeUtc: f.meta.dateObs,
                           klass: cls.klass,
                           name: null,
                           shower: cls.shower ? cls.shower.name : null,
                           confidence: cls.confidence,
                           reason: cls.reason,
                           frameId: f.meta.id } );
            var lb = langLabels[ cls.klass ] || langLabels.unknown;
            if ( cls.klass === "meteor" && cls.shower )
               lb += " (" + cls.shower.name + ")";
            labeledTrails.push( { frameIndex: i,
                                  x1: f.trails[ t ].x1, y1: f.trails[ t ].y1,
                                  x2: f.trails[ t ].x2, y2: f.trails[ t ].y2,
                                  color: TRAIL_STYLE[ cls.klass ] || TRAIL_STYLE.unknown,
                                  label: lb } );
         }
   }

   // Asteroid candidates: slow, coherent movers among the point sources of
   // frames that have sky coordinates. Registered-but-unsolved sets are
   // excluded: sensor-fixed artifacts (hot pixels, column defects) shift
   // with the dither in the reference grid and mimic coherent movers, and
   // the fitted astrometry is only arcminute-accurate — not enough to make
   // an asteroid candidate actionable.
   var movers = [];
   if ( params.detectAsteroids && ( set == null || hasUsableWcs( set.refMeta.wcs.kind ) ) )
   {
      var blobsByFrame = [];
      for ( var i = 0; i < frames.length; ++i )
      {
         var skyBlobs = [];
         for ( var b2 = 0; b2 < ( frames[ i ].blobs || [] ).length; ++b2 )
            if ( frames[ i ].blobs[ b2 ].raDeg != null )
               skyBlobs.push( frames[ i ].blobs[ b2 ] );
         if ( skyBlobs.length > 0 )
            blobsByFrame.push( { id: frames[ i ].meta.id, dateObs: frames[ i ].meta.dateObs,
                                 blobs: skyBlobs } );
      }
      if ( blobsByFrame.length >= 3 )
      {
         console.writeln( "Searching for slow movers across " + blobsByFrame.length + " solved frame(s)…" );
         movers = SIMeteors.findAsteroidCandidates( blobsByFrame, 3, null );
         for ( var m = 0; m < movers.length; ++m )
            events.push( { timeUtc: movers[ m ].points[ 0 ].t,
                           klass: "asteroid",
                           name: null,
                           rateArcsecPerMin: movers[ m ].rateArcsecPerMin,
                           nFrames: movers[ m ].points.length,
                           frameId: movers[ m ].points[ 0 ].frame } );
      }
   }

   var night = { dateLabel: nightLabel( frames ),
                 frames: frames.length,
                 cleanFrames: cleanFrames,
                 totalExposureSec: totalExposureSec,
                 target: frames[ 0 ].meta.keywords[ "OBJECT" ] || null,
                 events: events,
                 predicted: predicted,
                 movers: movers };

   var history = SIReport.loadHistory();
   var report = SIReport.build( night, history, params.lang );
   if ( params.saveHistory !== false ) // headless test runs must not pollute the log
      SIReport.saveHistory( SIReport.appendNight( history, report.summary ) );

   // Night result image: the registered set max-combined (every streak of
   // the night on one star field), stretched, with each trail highlighted
   // and named. Only meaningful when the frames share one pixel grid.
   // Optional ghost layer for the composite: sunlit predicted crossers
   // that matched no trail, with flag and telemetry like the real ones.
   var predictedItems = [];
   if ( ( params.nightShowPredicted || params.nightShowShadow ) && fitTanForOverlay != null )
      for ( var pf = 0; pf < frames.length; ++pf )
      {
         var crsP = crossingsByFrame[ frames[ pf ].meta.id ] || [];
         for ( var pc = 0; pc < crsP.length; ++pc )
         {
            var cp = crsP[ pc ];
            if ( cp.matchedTrailIndex != null )
               continue;
            if ( cp.sunlit ? !params.nightShowPredicted : !params.nightShowShadow )
               continue;
            var g1 = tanInvertForOverlay( fitTanForOverlay, cp.path.p1 );
            var g2 = tanInvertForOverlay( fitTanForOverlay, cp.path.p2 );
            if ( g1 == null || g2 == null )
               continue;
            predictedItems.push( { x1: g1.x, y1: g1.y, x2: g2.x, y2: g2.y,
                                   color: cp.sunlit ? "#e8d44d" : "#9aa0a8",
                                   flag: OWNER_FLAG[ ( satcatInfo[ cp.noradId ] || {} ).owner ] ||
                                         satCountryCode( cp.name ),
                                   label: ( cp.name || ( "NORAD " + cp.noradId ) ) +
                                          ( cp.entryUtc ? " \u00b7 " +
                                            String( cp.entryUtc ).substring( 11, 16 ) + " UT" : "" ) +
                                          ( cp.sunlit ? "" :
                                            ( params.lang == "fr" ? " (ombre)" : " (shadow)" ) ),
                                   sub: satTelemetryLine( cp, satcatInfo, params.lang ) } );
         }
      }

   var resultImagePath = null;
   if ( set != null && params.nightResultImage !== false )
      try
      {
         SIProf.start( "result image (stretch+annotate+save)" );
         var bmp = null;
         if ( params.nightResultCombine === "max" )
         {
            // Stack of everything — shows every streak in the pixels, but a
            // darkless max-combine also stacks every frame's hot pixels.
            console.writeln( "Building the night composite (max-combine of the registered set)…" );
            var comp = SIRender.maxCombine( set.regPaths );
            if ( comp != null )
               bmp = SIRender.stretchedBitmap( comp );
         }
         else
         {
            // Default: the best single frame (sharpest/cleanest) as the
            // background; every trail of the night is drawn on top anyway,
            // all frames sharing the reference grid.
            var bw = ImageWindow.open( set.regPaths[ set.bestIndex ] );
            if ( bw.length > 0 )
            {
               for ( var k5 = 1; k5 < bw.length; ++k5 )
                  bw[ k5 ].forceClose();
               bmp = SIRender.stretchedBitmap( bw[ 0 ].mainView.image );
               bw[ 0 ].forceClose();
            }
         }
         if ( bmp != null )
         {
            bmp = SIRender.annotateTrails( bmp, labeledTrails.concat( predictedItems ),
                                           { flagDir: flagAssetsDir() } );
            resultImagePath = File.systemTempDirectory + "/SkyIntruders-night-result.png";
            bmp.save( resultImagePath );

            try
            {
               SIRender.showBitmap( bmp, "SkyIntruders_night" );
            }
            catch ( e )
            {
               // headless runs have no workspace to show a window in
            }
         }
      }
      catch ( e )
      {
         console.warningln( SKYINTRUDERS_TITLE + ": night composite failed — " + e.message );
      }
   SIProf.end( "result image (stretch+annotate+save)" );
   // Frame-by-frame review aid: one annotated PNG per registered frame,
   // with only that frame's trails drawn.
   if ( set != null && params.debugFrameOverlays )
      try
      {
         SIProf.start( "debug frame overlays" );
         for ( var i = 0; i < frames.length; ++i )
         {
            var wins3 = ImageWindow.open( set.regPaths[ i ] );
            if ( wins3.length == 0 )
               continue;
            for ( var k4 = 1; k4 < wins3.length; ++k4 )
               wins3[ k4 ].forceClose();
            var fbmp = SIRender.stretchedBitmap( wins3[ 0 ].mainView.image );
            var mine = [];
            for ( var lt = 0; lt < labeledTrails.length; ++lt )
               if ( labeledTrails[ lt ].frameIndex === i )
                  mine.push( labeledTrails[ lt ] );
            // Ghost lines: every predicted crossing of this frame's window,
            // projected through the fitted TAN — sunlit in pale yellow,
            // eclipsed in grey. The visual gap between a ghost and a real
            // streak IS the TLE/shadow-model error.
            if ( fitTanForOverlay != null )
            {
               var crsG = crossingsByFrame[ frames[ i ].meta.id ] || [];
               for ( var cg = 0; cg < crsG.length; ++cg )
               {
                  var g1 = SISatMatch.core.tanForOrientation ? null : null;
                  var pA = crsG[ cg ].path.p1, pB = crsG[ cg ].path.p2;
                  var q1 = tanInvertForOverlay( fitTanForOverlay, pA );
                  var q2 = tanInvertForOverlay( fitTanForOverlay, pB );
                  if ( q1 == null || q2 == null )
                     continue;
                  mine.push( { x1: q1.x, y1: q1.y, x2: q2.x, y2: q2.y,
                               color: crsG[ cg ].sunlit ? "#e8d44d" : "#9aa0a8",
                               label: ( crsG[ cg ].name || String( crsG[ cg ].noradId ) ) +
                                      ( crsG[ cg ].sunlit ? "" : " (ombre)" ) } );
               }
            }
            fbmp = SIRender.annotateTrails( fbmp, mine, { flagDir: flagAssetsDir() } );
            fbmp.save( File.systemTempDirectory + "/si-frame-annotated-" + i + ".png" );
            wins3[ 0 ].forceClose();
            gc();
         }
      }
      catch ( e )
      {
         console.warningln( SKYINTRUDERS_TITLE + ": frame overlays failed — " + e.message );
      }
   SIProf.end( "debug frame overlays" );

   if ( set != null )
      clearDirectory( set.regDir );

   SIProf.add( "(untimed rest)", Math.max( 0, ( Date.now() - tRun ) -
      ( function() { var s = 0, t = SIProf.table(); for ( var i = 0; i < t.length; ++i )
        if ( t[ i ].name.charAt( 0 ) != "." && t[ i ].name.indexOf( "(count)" ) < 0 ) s += t[ i ].ms;
        return s; } )() ) );
   var timings = SIProf.report( frames.length );

   return { night: night, report: report, tleInfo: tleInfo, frames: frames,
            resultImagePath: resultImagePath, fitInfo: fitInfo,
            registered: ( set != null ), timings: timings,
            totalMs: Date.now() - tRun };
}

// ---------------------------------------------------------------------------
// Treasure Hunt mode — what you photographed without knowing.

// Per-type overlay marker style (color + glyph) for the annotated map.
/*
 * Locate PixInsight's src/scripts/AdP directory, where the distribution
 * ships NGC-IC.csv and NamedStars.csv — the offline context catalogs for
 * the star chart. Returns null when not found (context is then skipped).
 */
function findAdpDir()
{
   var cands = [];
   try
   {
      if ( typeof CoreApplication !== "undefined" && CoreApplication.dirPath )
         cands.push( CoreApplication.dirPath + "/../src/scripts/AdP" );
   }
   catch ( e ) {}
   cands.push( "C:/Program Files/PixInsight/src/scripts/AdP" );
   for ( var i = 0; i < cands.length; ++i )
      try
      {
         if ( File.exists( cands[ i ] + "/NGC-IC.csv" ) )
            return cands[ i ];
      }
      catch ( e2 ) {}
   return null;
}

/*
 * Context objects for the star chart: the brightest named stars and the
 * largest NGC/IC neighbors that landed in the frame. The local catalogs are
 * static distribution files — parse them once per session.
 */
var siAdpCatalogCache = {};
function loadAdpCatalog( dir, fileName, parse )
{
   var key = dir + "/" + fileName;
   if ( siAdpCatalogCache[ key ] === undefined )
      siAdpCatalogCache[ key ] = parse( File.readTextFile( key ) );
   return siAdpCatalogCache[ key ];
}

function loadChartContext( meta, width, height, maxStars, maxDsos, cone )
{
   var out = { stars: [], dsos: [] };
   var dir = findAdpDir();
   function projectInto( rows )
   {
      // Cheap angular prefilter first: >99% of a full-sky catalog is far
      // outside the field, and spline WCS inversions are not free.
      var maxSep = cone ? cone.radiusDeg*1.15 : null;
      var kept = [];
      for ( var i = 0; i < rows.length; ++i )
      {
         if ( maxSep !== null &&
              SIFrameMetaCore.angularSeparationDeg( cone.raDeg, cone.decDeg,
                                           rows[ i ].raDeg, rows[ i ].decDeg ) > maxSep )
            continue;
         var p = null;
         try { p = meta.wcs.celestialToImage( rows[ i ].raDeg, rows[ i ].decDeg ); }
         catch ( e ) { p = null; }
         if ( p === null || p === undefined )
            continue;
         if ( !( isFinite( p.x ) && isFinite( p.y ) &&
                 p.x >= 0 && p.y >= 0 && p.x <= width - 1 && p.y <= height - 1 ) )
            continue;
         rows[ i ].x = p.x;
         rows[ i ].y = p.y;
         kept.push( rows[ i ] );
      }
      return kept;
   }
   // Stars: the locally shipped named stars (Deneb, 52 Cyg...) merged with
   // the brightest Henry Draper stars of the field (VizieR, cached) — the
   // "principal stars of the image". A star present in both keeps its name.
   var stars = [];
   if ( dir !== null )
      try
      {
         stars = projectInto( loadAdpCatalog( dir, "NamedStars.csv",
                                              SICatalogs.parseNamedStarsCsv ) );
      }
      catch ( e ) {}
   if ( cone )
      try
      {
         var hd = projectInto( SICatalogs.queryBrightStars(
            cone.raDeg, cone.decDeg, cone.radiusDeg, { max: 300 } ) );
         for ( var hi = 0; hi < hd.length; ++hi )
         {
            if ( hd[ hi ].mag === null )
               continue;
            var dup = false;
            for ( var ni = 0; ni < stars.length && !dup; ++ni )
               if ( Math.abs( stars[ ni ].x - hd[ hi ].x ) < 12 &&
                    Math.abs( stars[ ni ].y - hd[ hi ].y ) < 12 )
                  dup = true;
            if ( !dup )
               stars.push( hd[ hi ] );
         }
      }
      catch ( e2 ) {}
   stars.sort( function( a, b ) { return ( a.mag || 99 ) - ( b.mag || 99 ); } );
   out.stars = stars.slice( 0, maxStars );
   if ( dir === null )
      return out;
   try
   {
      var dsos = projectInto( loadAdpCatalog( dir, "NGC-IC.csv",
                                              SICatalogs.parseNgcIcCsv ) );
      dsos.sort( function( a, b )
      {
         return ( ( b.diamArcmin || 0 ) - ( a.diamArcmin || 0 ) ) ||
                ( ( a.mag || 99 ) - ( b.mag || 99 ) );
      } );
      // The CSV can list one object twice (M16 = cluster + nebula rows):
      // keep the largest per display name.
      var seen = {}, unique = [];
      for ( var d2 = 0; d2 < dsos.length && unique.length < maxDsos; ++d2 )
      {
         var keyName = dsos[ d2 ].messier || dsos[ d2 ].name;
         if ( seen[ keyName ] )
            continue;
         seen[ keyName ] = true;
         unique.push( dsos[ d2 ] );
      }
      out.dsos = unique;
   }
   catch ( e ) {}
   return out;
}

/*
 * Sample an aperture + background annulus around a projected catalog
 * position and ask SITreasure.apertureDetection whether there is real
 * signal there. The aperture follows the object's catalog size (bounded);
 * point sources get a small default.
 */
function apertureGeom( apR )
{
   // One source of truth for the aperture/annulus/decoy-ring geometry: the
   // decoy ring must clear the target's own background annulus.
   var annIn = apR + 3;
   var annOut = annIn + Math.max( 4, apR );
   return { annIn: annIn, annOut: annOut, ringR: annOut + apR + 4 };
}

/*
 * Batch pixel access for the capture scoring: one native getSamples read of
 * the whole patch around a position instead of thousands of image.sample
 * calls (target + 12 decoy apertures re-visit the same neighborhood).
 * Falls back to per-pixel sampling if the batch read is unavailable.
 */
function makePatchReader( image, x0, y0, half )
{
   var xa = Math.max( 0, x0 - half ), ya = Math.max( 0, y0 - half );
   var xb = Math.min( image.width - 1, x0 + half );
   var yb = Math.min( image.height - 1, y0 + half );
   var w = xb - xa + 1, h = yb - ya + 1;
   try
   {
      var buf = [];
      image.getSamples( buf, new Rect( xa, ya, xb + 1, yb + 1 ), 0 );
      if ( buf.length !== w*h )
         throw new Error( "short read" );
      return function( x, y )
      {
         return ( x < xa || y < ya || x > xb || y > yb ) ? null : buf[ ( y - ya )*w + ( x - xa ) ];
      };
   }
   catch ( e )
   {
      return function( x, y )
      {
         return ( x < 0 || y < 0 || x >= image.width || y >= image.height )
            ? null : image.sample( x, y, 0 );
      };
   }
}

function measureCaptureAt( readPx, x0, y0, apR )
{
   var geom = apertureGeom( apR );
   var apVals = [], bgVals = [];
   for ( var dy = -geom.annOut; dy <= geom.annOut; ++dy )
      for ( var dx = -geom.annOut; dx <= geom.annOut; ++dx )
      {
         var rr = dx*dx + dy*dy;
         if ( rr > geom.annOut*geom.annOut )
            continue;
         var v = readPx( x0 + dx, y0 + dy );
         if ( v === null )
            continue;
         if ( rr <= apR*apR )
            apVals.push( v );
         else if ( rr >= geom.annIn*geom.annIn )
            bgVals.push( v );
      }
   return SITreasure.apertureDetection( apVals, bgVals );
}

function measureCapture( image, t )
{
   var apR = 4;
   if ( typeof t.pxDiam === "number" && isFinite( t.pxDiam ) && t.pxDiam > 0 )
      apR = Math.max( 3, Math.min( 40, Math.round( t.pxDiam/2 ) ) );
   var x0 = Math.round( t.x ), y0 = Math.round( t.y );
   var geom = apertureGeom( apR );
   var readPx = makePatchReader( image, x0, y0, geom.ringR + geom.annOut );

   var det = measureCaptureAt( readPx, x0, y0, apR );
   det.apR = apR;
   if ( !det.captured )
      return det;

   // The aperture says "signal": make it beat 12 decoy apertures on a ring
   // around the position before claiming a capture (chance field stars set
   // the local false-alarm floor; see SITreasure.captureVerdict). Once the
   // running decoy maxima already sink both verdict conditions, the
   // remaining decoys cannot change the outcome — stop measuring.
   var C = SITreasure.CAPTURE;
   var decoys = [], maxSnr = 0, maxFrac = 0;
   for ( var k = 0; k < 12; ++k )
   {
      var a = 2*Math.PI*k/12;
      var dxk = Math.round( x0 + geom.ringR*Math.cos( a ) );
      var dyk = Math.round( y0 + geom.ringR*Math.sin( a ) );
      if ( dxk < 0 || dyk < 0 || dxk >= image.width || dyk >= image.height )
         continue;
      var d = measureCaptureAt( readPx, dxk, dyk, apR );
      decoys.push( d );
      if ( typeof d.snr === "number" && d.snr > maxSnr )
         maxSnr = d.snr;
      if ( typeof d.fracAbove === "number" && d.fracAbove > maxFrac )
         maxFrac = d.fracAbove;
      if ( decoys.length >= C.MIN_DECOYS &&
           det.snr < C.SNR_MARGIN*maxSnr && det.fracAbove < C.FRAC_MARGIN*maxFrac )
         break;
   }
   det.captured = SITreasure.captureVerdict( det, decoys );
   return det;
}

// --- star-chart formatting helpers (pure) -----------------------------------

function siFmt1( x )
{
   return ( Math.round( x*10 )/10 ).toString();
}

function siStripQuotes( s )
{
   return String( s || "" ).replace( /^'+|'+$/g, "" ).replace( /^\s+|\s+$/g, "" );
}

function siRaHms( ra )
{
   var h = ra/15, hh = Math.floor( h ), mm = Math.round( ( h - hh )*60 );
   if ( mm === 60 ) { hh = ( hh + 1 ) % 24; mm = 0; }
   return hh + "h " + ( ( mm < 10 ) ? "0" : "" ) + mm + "m";
}

function siDecDm( dec )
{
   var sg = ( dec < 0 ) ? "-" : "+";
   var a = Math.abs( dec ), dd = Math.floor( a ), mm = Math.round( ( a - dd )*60 );
   if ( mm === 60 ) { dd += 1; mm = 0; }
   return sg + dd + "\u00b0 " + ( ( mm < 10 ) ? "0" : "" ) + mm + "\u2032";
}

// Data sub-lines under a treasure's chart label.
function treasureSubs( o, dn, fr )
{
   var subs = [];
   if ( dn.sub )
      subs.push( dn.sub );
   if ( o.type === "quasar" && typeof o.Rmag === "number" && isFinite( o.Rmag ) )
      subs.push( "MAG " + siFmt1( o.Rmag ) );
   if ( o.type === "asteroid" )
   {
      if ( typeof o.magV === "number" && isFinite( o.magV ) )
         subs.push( "MAG " + siFmt1( o.magV ) );
      if ( o.klass )
         subs.push( String( o.klass ).toUpperCase() );
   }
   if ( o.type === "galaxy" && typeof o.diamArcmin === "number" && isFinite( o.diamArcmin ) )
      subs.push( "\u00d8 " + siFmt1( o.diamArcmin ) + "\u2032" );
   if ( o.type === "pne" && typeof o.majDiamArcsec === "number" && isFinite( o.majDiamArcsec ) )
      subs.push( "\u00d8 " + Math.round( o.majDiamArcsec ) + "\u2033" );
   if ( o.captured === false )
      subs.push( fr ? "sous le bruit" : "below the noise" );
   return subs;
}

function runTreasureHunt( window, filePath, params, onProgress )
{
   function progress( msg )
   {
      console.writeln( msg );
      if ( typeof onProgress == "function" ) onProgress( msg );
      processEvents();
   }

   var image = window.mainView.image;
   var width = image.width, height = image.height;

   var meta = SIFrameMeta.read( window, filePath );
   if ( !( meta.wcs.kind === "solution" || meta.wcs.kind === "tan" ) )
      return { needsSolve: true, meta: meta };

   var fov = meta.wcs.fov();
   if ( fov == null || !( fov.widthDeg > 0 ) || !( fov.heightDeg > 0 ) )
      return { needsSolve: true, meta: meta };

   var raDeg = fov.raDeg, decDeg = fov.decDeg;
   var radiusDeg = 0.5*Math.sqrt( fov.widthDeg*fov.widthDeg + fov.heightDeg*fov.heightDeg );
   var epochIso = meta.dateObs ? meta.dateObs.toISOString() : ( new Date ).toISOString();
   progress( format( "Field center RA %.4f Dec %.4f, search radius %.3f deg",
                     raDeg, decDeg, radiusDeg ) );

   var maxRows = ( params.treasureMaxRows > 0 ) ? params.treasureMaxRows : 400;
   var qopts = { max: maxRows };

   var queryFailures = [];
   function safeQuery( kind, label, fn )
   {
      try
      {
         var rows = fn();
         if ( rows === null || rows === undefined )
         {
            queryFailures.push( kind );
            return [];
         }
         progress( "   " + label + ": " + rows.length + " row(s)" );
         return rows;
      }
      catch ( e )
      {
         console.warningln( "   " + label + " unavailable: " + e.message );
         queryFailures.push( kind );
         return [];
      }
   }

   progress( "Querying deep catalogs…" );
   var HUNTS = [
      [ "galaxy",   "galaxies",  "treasureGalaxies",  function() { return SICatalogs.queryGalaxies( raDeg, decDeg, radiusDeg, qopts ); } ],
      [ "quasar",   "quasars",   "treasureQuasars",   function() { return SICatalogs.queryQuasars( raDeg, decDeg, radiusDeg, qopts ); } ],
      [ "pne",      "nebulae",   "treasurePne",       function() { return SICatalogs.queryPne( raDeg, decDeg, radiusDeg, qopts ); } ],
      [ "asteroid", "asteroids", "treasureAsteroids", function() { return SICatalogs.queryAsteroids( raDeg, decDeg, radiusDeg, epochIso, qopts ); } ]
   ];
   var flat = [];
   for ( var hq = 0; hq < HUNTS.length; ++hq )
      if ( params[ HUNTS[ hq ][ 2 ] ] !== false )
         flat = flat.concat( safeQuery( HUNTS[ hq ][ 0 ], HUNTS[ hq ][ 1 ], HUNTS[ hq ][ 3 ] ) );

   var treasures = SITreasure.crossMatch( flat, meta.wcs.celestialToImage, width, height );
   progress( treasures.length + " object(s) landed inside the frame." );

   // Attach a pixel size so the narrative can say "this N-pixel smudge".
   if ( meta.pixScaleArcsec > 0 )
      for ( var i = 0; i < treasures.length; ++i )
      {
         var t = treasures[ i ];
         if ( typeof t.diamArcmin === "number" && isFinite( t.diamArcmin ) && t.diamArcmin > 0 )
            t.pxDiam = t.diamArcmin*60/meta.pixScaleArcsec;
      }

   // Measure a local detection at each position: aperture peak/fill vs an
   // annulus background. This is what separates "captured" from "in the
   // field, below your noise" — a mag-20 asteroid lands in every frame but
   // shows in none, and the report must not oversell it.
   for ( var ci = 0; ci < treasures.length; ++ci )
   {
      var ct = treasures[ ci ];
      var det = measureCapture( image, ct );
      ct.captured = det.captured;
      if ( det.snr !== null )
         ct.snr = Math.round( det.snr*10 )/10;
      // A predicted position looser than the aperture cannot attribute the
      // flux to the object (poorly observed asteroids have arcminute errors).
      if ( ct.captured && typeof ct.errArcsec === "number" && meta.pixScaleArcsec > 0 &&
           ct.errArcsec > det.apR*meta.pixScaleArcsec )
         ct.captured = false;
   }
   // Cross-object sanity: an object far fainter than the typical honest
   // non-detection of its own type is a chance star, not a capture.
   SITreasure.applyMagConsistency( treasures );

   // Captured objects lead the list (and the thumbnails); the below-noise
   // ones keep their notability order after them.
   var capturedList = treasures.filter( function( o ) { return o.captured; } );
   treasures = capturedList.concat( treasures.filter( function( o ) { return !o.captured; } ) );
   progress( capturedList.length + " of " + treasures.length + " show signal above the local noise." );

   var summary = SITreasure.summarize( treasures, params.lang );

   // Render: stretched base, annotated overlay window + embedded PNG.
   progress( "Rendering annotated field…" );
   var base = SIRender.stretchedBitmap( image );
   var fr = ( params.lang === "fr" );

   // Star-chart items: every captured treasure, the most notable below-noise
   // ones, plus offline context — bright named stars and NGC/IC neighbors —
   // so the chart reads like a map even when the deep catalogs came home
   // empty. The full inventory lives in the HTML report; past the label cap
   // objects keep their marker but stay unlabeled.
   var items = [];
   var LABEL_CAP = 40;
   var dimBudget = 6;
   for ( var m = 0; m < treasures.length; ++m )
   {
      var o = treasures[ m ];
      if ( o.captured === false && dimBudget-- <= 0 )
         continue;
      if ( items.length >= LABEL_CAP )
      {
         items.push( { x: o.x, y: o.y, kind: o.type } );
         continue;
      }
      var dn = SITreasure.displayName( o, params.lang );
      items.push( { x: o.x, y: o.y, kind: o.type, main: dn.main,
                    subs: treasureSubs( o, dn, fr ) } );
   }

   var context = loadChartContext( meta, width, height, 8, 5,
                                   { raDeg: raDeg, decDeg: decDeg, radiusDeg: radiusDeg } );
   for ( var cs = 0; cs < context.stars.length; ++cs )
   {
      var st = context.stars[ cs ];
      var subs2 = [];
      if ( st.commonName && st.commonName !== st.name )
         subs2.push( st.name );
      if ( typeof st.mag === "number" && isFinite( st.mag ) )
         subs2.push( "MAG " + siFmt1( st.mag ) );
      if ( st.spectral )
         subs2.push( String( st.spectral ).substring( 0, 8 ).toUpperCase() );
      items.push( { x: st.x, y: st.y, kind: "star",
                    main: st.commonName || st.name, subs: subs2 } );
   }
   for ( var cd = 0; cd < context.dsos.length; ++cd )
   {
      var dso = context.dsos[ cd ];
      var subs3 = [];
      if ( dso.commonName )
         subs3.push( dso.commonName );
      if ( typeof dso.mag === "number" && isFinite( dso.mag ) )
         subs3.push( "MAG " + siFmt1( dso.mag ) );
      var radiusPx = null;
      if ( typeof dso.diamArcmin === "number" && isFinite( dso.diamArcmin ) &&
           meta.pixScaleArcsec > 0 )
         radiusPx = Math.min( Math.max( width, height )/3,
                              dso.diamArcmin*60/meta.pixScaleArcsec/2 );
      var dsoName = ( dso.messier || dso.name )
         .replace( /^(NGC|IC|M)(\d)/, "$1 $2" );
      items.push( { x: dso.x, y: dso.y, kind: "dso",
                    main: dsoName, subs: subs3,
                    radiusPx: radiusPx } );
   }

   // Corner cards: title (chart + field), legend (kinds present),
   // observation data from the FITS keywords.
   var target = siStripQuotes( meta.keywords[ "OBJECT" ] );
   var titleLines = [ fr ? "CARTE STELLAIRE" : "STAR CHART" ];
   if ( target )
      titleLines.push( target.toUpperCase() );
   titleLines.push( "RA " + siRaHms( raDeg ) + "  |  DEC " + siDecDm( decDeg ) );

   var LEGEND_LABEL = {
      galaxy: fr ? "GALAXIE" : "GALAXY",
      quasar: "QUASAR",
      pne: fr ? "N\u00c9BULEUSE PLAN\u00c9TAIRE" : "PLANETARY NEBULA",
      asteroid: fr ? "AST\u00c9RO\u00cfDE" : "ASTEROID",
      star: fr ? "\u00c9TOILE" : "STAR",
      dso: fr ? "OBJET DU CIEL PROFOND" : "DEEP-SKY OBJECT"
   };
   var kindsSeen = {};
   var legend = [];
   for ( var ki = 0; ki < items.length; ++ki )
      if ( !kindsSeen[ items[ ki ].kind ] )
      {
         kindsSeen[ items[ ki ].kind ] = true;
         legend.push( { kind: items[ ki ].kind, label: LEGEND_LABEL[ items[ ki ].kind ] || items[ ki ].kind } );
      }

   var dataLines = [ fr ? "DONN\u00c9ES D'OBSERVATION" : "OBSERVATION DATA" ];
   var instrume = siStripQuotes( meta.keywords[ "TELESCOP" ] ) || siStripQuotes( meta.keywords[ "INSTRUME" ] );
   if ( instrume )
      dataLines.push( ( fr ? "INSTRUMENT : " : "INSTRUMENT: " ) + instrume.toUpperCase() );
   var filter = siStripQuotes( meta.keywords[ "FILTER" ] );
   if ( filter )
      dataLines.push( ( fr ? "FILTRE : " : "FILTER: " ) + filter.toUpperCase() );
   if ( meta.exposureSec > 0 )
      dataLines.push( ( fr ? "EXPOSITION : " : "EXPOSURE: " ) + Math.round( meta.exposureSec ) + " s" );
   if ( meta.dateObs )
   {
      var MONTHS = fr
         ? [ "Janvier", "F\u00e9vrier", "Mars", "Avril", "Mai", "Juin", "Juillet",
             "Ao\u00fbt", "Septembre", "Octobre", "Novembre", "D\u00e9cembre" ]
         : [ "January", "February", "March", "April", "May", "June", "July",
             "August", "September", "October", "November", "December" ];
      var dd = meta.dateObs.getUTCDate(), mo = MONTHS[ meta.dateObs.getUTCMonth() ],
          yy = meta.dateObs.getUTCFullYear();
      dataLines.push( fr ? ( "DATE : " + dd + " " + mo + " " + yy )
                         : ( "DATE: " + mo + " " + dd + ", " + yy ) );
   }

   var mapBmp = SIRender.chartField( base, {
      accent: params.treasureAccent || SI_DEFAULT_ACCENT,
      items: items,
      cards: { title: titleLines, legend: legend, data: dataLines }
   } );
   var mapWindow = SIRender.showBitmap( mapBmp, "Sky Intruders Treasure Map" );

   // Embed a downscaled copy in the HTML when the frame is large, so the file
   // stays reasonable; annotations were drawn proportionally so they remain
   // legible after the downscale.
   var mapForHtml = mapBmp;
   var mapLong = Math.max( mapBmp.width, mapBmp.height );
   if ( mapLong > 2400 && typeof mapBmp.scaledTo === "function" )
   {
      var sc = 2400/mapLong;
      try { mapForHtml = mapBmp.scaledTo( Math.round( mapBmp.width*sc ), Math.round( mapBmp.height*sc ) ); }
      catch ( e ) { mapForHtml = mapBmp; }
   }
   var mapPng = SIRender.bitmapToBase64Png( mapForHtml );

   // Thumbnails for the most notable treasures.
   var topN = treasures.slice( 0, Math.min( treasures.length, 8 ) );
   var thumbs = [];
   var boxPx = Math.max( 48, Math.round( 0.08*Math.max( width, height ) ) );
   for ( var k = 0; k < topN.length; ++k )
   {
      var tt = topN[ k ];
      tt.id = "T" + k;
      try
      {
         var crop = SIRender.cropThumbnail( base, tt.x, tt.y, boxPx, 96 );
         thumbs.push( { id: tt.id, pngBase64: SIRender.bitmapToBase64Png( crop ) } );
      }
      catch ( e )
      {
         console.warningln( "   thumbnail failed for " + tt.name + ": " + e.message );
      }
   }

   // Cap the illustrated list so the HTML stays a sane size.
   var displayCount = Math.min( treasures.length, 60 );
   var displayTreasures = treasures.slice( 0, displayCount );
   var narratives = [];
   for ( var n = 0; n < displayTreasures.length; ++n )
      narratives.push( SITreasure.narrate( displayTreasures[ n ], params.lang ) );

   var html = SITreasureReport.buildHtml( {
      treasures: displayTreasures, narratives: narratives, summary: summary,
      mapPng: mapPng, thumbs: thumbs, issues: queryFailures,
      fieldInfo: { raDeg: raDeg, decDeg: decDeg, radiusDeg: radiusDeg,
                   target: meta.keywords[ "OBJECT" ] || null },
      lang: params.lang } );

   return { meta: meta, treasures: treasures, summary: summary,
            html: html, mapWindow: mapWindow, queryFailures: queryFailures };
}


// Align trail endpoints across dithered/rotated frames by projecting their sky
// coordinates onto one reference frame's pixel grid (via its WCS). Without
// registration, dithering leaves every frame on a different pixel grid and the
// superposition is misaligned. Frames lacking sky coordinates keep their own
// pixel coordinates (best effort). Returns { trails, refW, refH, method,
// ---------------------------------------------------------------------------
// UI helpers.

// Icon for a button, via the dialog's DPI-aware resource loader. Returns null
// on any failure so callers can assign unconditionally.
function siIcon( dlg, resourcePath )
{
   try { return dlg.scaledResource( resourcePath ); }
   catch ( e )
   {
      try { return new Bitmap( resourcePath ); } catch ( e2 ) { return null; }
   }
}

// Open a file with the OS default handler (the illustrated report in a browser).
function openInBrowser( path )
{
   var plat = String( CoreApplication.platform );
   var P = new ExternalProcess;
   if ( /win|mswindows/i.test( plat ) )
      P.start( "cmd", [ "/c", "start", "", path ] );
   else if ( /mac|osx/i.test( plat ) )
      P.start( "/usr/bin/open", [ path ] );
   else
      P.start( "xdg-open", [ path ] );
   if ( P.waitForStarted )
      P.waitForStarted();
}

function siEscapeHtml( s )
{
   return String( s ).replace( /&/g, "&amp;" ).replace( /</g, "&lt;" ).replace( />/g, "&gt;" );
}

// Rich-text (Qt subset) summary of a Treasure Hunt result, shown in the result
// dialog instead of the raw HTML source.
function buildTreasureRich( res, lang )
{
   var fr = ( lang === "fr" );
   // c   = chip text (light, sits on a dark chip background)
   // name = treasure name (darker, sits on PixInsight's light-gray dialog bg;
   //        the light blue/gold read fine over the image but wash out here).
   var TYPE = {
      galaxy:   { c: "#9fc3ff", bg: "#25324a", name: "#1e5fb0", n: fr ? "galaxies" : "galaxies" },
      quasar:   { c: "#e39bff", bg: "#3a2540", name: "#e39bff", n: fr ? "quasars" : "quasars" },
      pne:      { c: "#8ff0cf", bg: "#24403a", name: "#8ff0cf", n: fr ? "nébuleuses" : "nebulae" },
      asteroid: { c: "#ffd38f", bg: "#403524", name: "#9a6a00", n: fr ? "astéroïdes" : "asteroids" }
   };
   var s = res.summary || { counts: {}, total: 0, headlines: [] };
   var head = ( s.headlines && s.headlines.length ) ? s.headlines[ 0 ]
              : ( fr ? "Exploration du champ" : "Field explored" );

   var h = "";
   h += "<p><font size=\"5\"><b>" + siEscapeHtml( head ) + "</b></font></p>";

   // Count chips.
   h += "<table cellpadding=\"5\" cellspacing=\"6\"><tr>";
   var order = [ "galaxy", "quasar", "pne", "asteroid" ];
   for ( var i = 0; i < order.length; ++i )
   {
      var k = order[ i ], n = ( s.counts && s.counts[ k ] ) || 0;
      var nc = ( s.captured && s.captured[ k ] !== undefined ) ? s.captured[ k ] : n;
      if ( n > 0 )
         h += "<td bgcolor=\"" + TYPE[ k ].bg + "\"><font color=\"" + TYPE[ k ].c +
              "\">&nbsp;<b>" + nc + "</b> " + TYPE[ k ].n +
              ( ( n > nc ) ? " <i>(+" + ( n - nc ) + ( fr ? " sous le bruit" : " below the noise" ) + ")</i>" : "" ) +
              "&nbsp;</font></td>";
   }
   h += "</tr></table>";

   var field = res.fieldInfo || ( res.meta ? { target: res.meta.keywords ? res.meta.keywords[ "OBJECT" ] : null } : {} );
   if ( field && field.target )
      h += "<p><font color=\"#9fb0c6\">" + siEscapeHtml( field.target ) + "</font></p>";

   // Notable finds with their one-line story.
   var treasures = res.treasures || [];
   var cap = Math.min( treasures.length, 8 );
   if ( cap > 0 )
   {
      h += "<p><b>" + ( fr ? "À la loupe" : "Notable finds" ) + "</b></p><ul>";
      for ( var t = 0; t < cap; ++t )
      {
         var o = treasures[ t ];
         var col = ( TYPE[ o.type ] ? TYPE[ o.type ].name : "#334155" );
         var story = "";
         try { story = SITreasure.narrate( o, lang ); } catch ( e ) { story = ""; }
         var dName = o.name || o.type;
         try { dName = SITreasure.displayName( o, lang ).main; } catch ( e ) {}
         h += "<li><font color=\"" + col + "\"><b>" + siEscapeHtml( dName ) +
              "</b></font> — " + siEscapeHtml( story ) + "</li>";
      }
      h += "</ul>";
      if ( treasures.length > cap )
         h += "<p><i>" + ( fr ? "…et " : "…and " ) + ( treasures.length - cap ) +
              ( fr ? " autres dans le rapport complet." : " more in the full report." ) + "</i></p>";
   }
   else
      h += "<p><i>" + ( fr ? "Aucun objet catalogue n'est tombé dans le champ."
                            : "No catalog object landed inside the frame." ) + "</i></p>";

   return h;
}

var SI_UI = {
   en: {
      tabNight: "Night trails", tabTreasure: "Treasure Hunt",
      tagNight: "\ud83d\udef0  <i>Who crossed your photo last night?</i>",
      tagTreasure: "\ud83d\udc8e  <i>What you photographed without knowing.</i>",
      hintNight: "Identify satellite, meteor and asteroid trails across a night of " +
                 "light frames, then get a night log and a ready-to-post report.",
      hintTreasure: "Point at a <b>plate-solved</b> image (uses the active window if the list " +
                    "is empty) and discover the galaxies, quasars, nebulae and passing " +
                    "asteroids hiding in your field.",
      kSigma: "Detection threshold (\u03c3):",
      kSigmaTip: "Trail pixels must exceed the frame background by this many " +
                 "robust sigmas. Lower catches fainter trails but risks noise.",
      predicted: "Draw predicted crossers on the result image",
      predictedTip: "Satellites the orbit propagation puts inside your field " +
                    "during an exposure but that no detected trail matched — " +
                    "drawn as pale ghost lines with their flag and telemetry.",
      shadow: "Also draw shadow crossers",
      shadowTip: "Crossers the model puts in the Earth's shadow during your " +
                 "exposure — invisible by definition, drawn in grey. Useful to " +
                 "see the full traffic or to spot shadow-model errors.",
      observer: "Observer site — only if FITS headers lack SITELAT / SITELONG",
      lat: "Lat (\u00b0):", lon: "Lon (\u00b0):", alt: "Alt (m):",
      treasureRows: "Max catalog rows / type:",
      treasureRowsTip: "Upper bound on objects fetched per catalog (galaxies, quasars, " +
                       "nebulae, asteroids) around your field.",
      input: "Input",
      addFiles: "Add files\u2026", addFolder: "Add folder\u2026", clear: "Clear",
      language: "Language:", languageTip: "Interface and report language.",
      analyzeNight: "Analyze night", analyzeTreasure: "Hunt treasures",
      close: "Close",
      statusNone: "<i>No frames added yet.</i>",
      statusOne: " frame ready.", statusMany: " frames ready.",
      working: "<i>Working\u2026</i>",
      treeNight: "Light frames",
      treeTreasure: "Plate-solved image — active window used if empty",
      saveReport: "Save report\u2026", saveReportCaption: "Save night report",
      openImage: "Open image", openHtml: "Open HTML",
      openHtmlTip: "Open the illustrated report in your web browser.",
      saveHtml: "Save HTML\u2026", saveHtmlCaption: "Save illustrated report",
      selectFrames: "Select frames", selectFolder: "Select a folder of frames",
      huntFor: "Hunt for:",
      huntForTip: "Which deep-catalog object types to search in the field.",
      huntGalaxies: "Galaxies", huntQuasars: "Quasars",
      huntPne: "Planetary nebulae", huntAsteroids: "Asteroids",
      accentColor: "Overlay color:",
      accentColorTip: "Color of the chart markers, leader lines, labels and cards.",
      needFrames: "Add some light frames first.",
      cannotOpen: "Cannot open",
      needImage: "Add one plate-solved image, or open one in PixInsight first.",
      needSolve: "This image has no astrometric solution (WCS). Plate-solve it first (ImageSolver), then run Treasure Hunt."
   },
   fr: {
      tabNight: "Tra\u00een\u00e9es de nuit", tabTreasure: "Chasse au tr\u00e9sor",
      tagNight: "\ud83d\udef0  <i>Qui a travers\u00e9 ta photo cette nuit ?</i>",
      tagTreasure: "\ud83d\udc8e  <i>Ce que tu as photographi\u00e9 sans le savoir.</i>",
      hintNight: "Identifie les tra\u00een\u00e9es de satellites, m\u00e9t\u00e9ores et ast\u00e9ro\u00efdes sur une " +
                 "nuit de brutes, puis obtiens un journal de nuit et un rapport pr\u00eat \u00e0 publier.",
      hintTreasure: "Pointe une image <b>r\u00e9solue astrom\u00e9triquement</b> (fen\u00eatre active si la " +
                    "liste est vide) et d\u00e9couvre les galaxies, quasars, n\u00e9buleuses et " +
                    "ast\u00e9ro\u00efdes de passage cach\u00e9s dans ton champ.",
      kSigma: "Seuil de d\u00e9tection (\u03c3) :",
      kSigmaTip: "Les pixels d'une tra\u00een\u00e9e doivent d\u00e9passer le fond de ce nombre de " +
                 "sigmas robustes. Plus bas = tra\u00een\u00e9es plus faibles, mais risque de bruit.",
      predicted: "Tracer les passages pr\u00e9dits sur l'image r\u00e9sultat",
      predictedTip: "Satellites que la propagation orbitale place dans le champ pendant une " +
                    "pose mais qu'aucune tra\u00een\u00e9e d\u00e9tect\u00e9e n'a confirm\u00e9s — trac\u00e9s en " +
                    "lignes fant\u00f4mes p\u00e2les avec drapeau et t\u00e9l\u00e9m\u00e9trie.",
      shadow: "Tracer aussi les passages dans l'ombre",
      shadowTip: "Passages que le mod\u00e8le place dans l'ombre de la Terre pendant la pose — " +
                 "invisibles par d\u00e9finition, trac\u00e9s en gris. Utile pour voir tout le trafic " +
                 "ou d\u00e9busquer une erreur du mod\u00e8le d'ombre.",
      observer: "Site d'observation — seulement si les headers FITS n'ont pas SITELAT / SITELONG",
      lat: "Lat (\u00b0) :", lon: "Lon (\u00b0) :", alt: "Alt (m) :",
      treasureRows: "Objets max / type de catalogue :",
      treasureRowsTip: "Plafond d'objets r\u00e9cup\u00e9r\u00e9s par catalogue (galaxies, quasars, " +
                       "n\u00e9buleuses, ast\u00e9ro\u00efdes) autour du champ.",
      input: "Entr\u00e9e",
      addFiles: "Ajouter des fichiers\u2026", addFolder: "Ajouter un dossier\u2026", clear: "Vider",
      language: "Langue :", languageTip: "Langue de l'interface et du rapport.",
      analyzeNight: "Analyser la nuit", analyzeTreasure: "Chasser les tr\u00e9sors",
      close: "Fermer",
      statusNone: "<i>Aucune brute ajout\u00e9e.</i>",
      statusOne: " brute pr\u00eate.", statusMany: " brutes pr\u00eates.",
      working: "<i>Travail en cours\u2026</i>",
      treeNight: "Brutes (lights)",
      treeTreasure: "Image r\u00e9solue — fen\u00eatre active si la liste est vide",
      saveReport: "Enregistrer le rapport\u2026", saveReportCaption: "Enregistrer le journal de nuit",
      openImage: "Ouvrir l'image", openHtml: "Ouvrir le HTML",
      openHtmlTip: "Ouvre le rapport illustr\u00e9 dans ton navigateur.",
      saveHtml: "Enregistrer le HTML\u2026", saveHtmlCaption: "Enregistrer le rapport illustr\u00e9",
      selectFrames: "S\u00e9lectionner des brutes", selectFolder: "S\u00e9lectionner un dossier de brutes",
      huntFor: "Chercher :",
      huntForTip: "Types d'objets \u00e0 chasser dans les catalogues profonds.",
      huntGalaxies: "Galaxies", huntQuasars: "Quasars",
      huntPne: "N\u00e9buleuses plan\u00e9taires", huntAsteroids: "Ast\u00e9ro\u00efdes",
      accentColor: "Couleur du trac\u00e9 :",
      accentColorTip: "Couleur des marqueurs, lignes de renvoi, \u00e9tiquettes et cartouches de la carte.",
      needFrames: "Ajoute d'abord des brutes (lights).",
      cannotOpen: "Impossible d'ouvrir",
      needImage: "Ajoute une image r\u00e9solue (plate-solve), ou ouvre-la d'abord dans PixInsight.",
      needSolve: "Cette image n'a pas de solution astrom\u00e9trique (WCS). R\u00e9sous-la d'abord (ImageSolver), puis relance la chasse au tr\u00e9sor."
   }
};

function uiT( lang, key )
{
   var t = SI_UI[ lang ] || SI_UI.en;
   return ( t[ key ] !== undefined ) ? t[ key ] : SI_UI.en[ key ];
}

/*
 * Color picker for the chart accent. The stock pjsr/SimpleColorDialog.jsh
 * does not load under #engine v8, so this is a native implementation with
 * the usual picker anatomy: a saturation/value pad, a hue strip, preset
 * swatches tuned for the chart, a hex field and a live preview. Result in
 * this.color (AARRGGBB) when execute() returns truthy.
 */
function siHsvToRgb( h, s, v )
{
   h = ( ( h % 360 ) + 360 ) % 360;
   var c2 = v*s, x = c2*( 1 - Math.abs( ( h/60 ) % 2 - 1 ) ), m = v - c2;
   var r = 0, g = 0, b = 0;
   if ( h < 60 )       { r = c2; g = x; }
   else if ( h < 120 ) { r = x;  g = c2; }
   else if ( h < 180 ) { g = c2; b = x; }
   else if ( h < 240 ) { g = x;  b = c2; }
   else if ( h < 300 ) { r = x;  b = c2; }
   else                { r = c2; b = x; }
   return ( 0xff000000 |
            ( Math.round( ( r + m )*255 ) << 16 ) |
            ( Math.round( ( g + m )*255 ) << 8 ) |
            Math.round( ( b + m )*255 ) );
}

function siRgbToHsv( argb )
{
   var r = ( ( argb >> 16 ) & 0xff )/255,
       g = ( ( argb >> 8 ) & 0xff )/255,
       b = ( argb & 0xff )/255;
   var mx = Math.max( r, g, b ), mn = Math.min( r, g, b ), d = mx - mn;
   var h = 0;
   if ( d > 0 )
   {
      if ( mx === r )      h = 60*( ( ( g - b )/d ) % 6 );
      else if ( mx === g ) h = 60*( ( b - r )/d + 2 );
      else                 h = 60*( ( r - g )/d + 4 );
   }
   return { h: ( h + 360 ) % 360, s: ( mx > 0 ) ? d/mx : 0, v: mx };
}

class SIColorDialog extends Dialog
{
   constructor( argb, title )
   {
      super();
      var self = this;
      this.color = argb | 0xff000000;
      var hsv = siRgbToHsv( this.color );
      this.hue = hsv.h;
      this.sat = hsv.s;
      this.val = hsv.v;
      this.windowTitle = title || "Color";

      // The pad bitmap is drawScaledBitmap'ed up to PAD px, so a modest
      // resolution is invisible after scaling and 3x cheaper to rebuild
      // while dragging the hue strip.
      var PAD = 232, STRIP = 22, RES = 64;

      // --- saturation/value pad (bitmap cached per hue) -------------------
      this.svBitmap = new Bitmap( RES, RES );
      this.svBitmapHue = -1;
      this.rebuildSv = function()
      {
         var hq = Math.round( self.hue );
         if ( self.svBitmapHue === hq )
            return;
         for ( var y = 0; y < RES; ++y )
         {
            var v = 1 - y/( RES - 1 );
            for ( var x = 0; x < RES; ++x )
               self.svBitmap.setPixel( x, y, siHsvToRgb( hq, x/( RES - 1 ), v ) );
         }
         self.svBitmapHue = hq;
      };

      // Single entry point for external color changes (presets, hex field).
      this.setColor = function( argb2 )
      {
         self.color = argb2 | 0xff000000;
         var hv = siRgbToHsv( self.color );
         self.hue = hv.h;
         self.sat = hv.s;
         self.val = hv.v;
         syncFromHsv();
      };

      function syncFromHsv()
      {
         self.color = siHsvToRgb( self.hue, self.sat, self.val );
         self.hexEdit.text = SIRender.argbToHex( self.color );
         self.svPad.repaint();
         self.huePad.repaint();
         self.preview.repaint();
      }

      this.svPad = new Control( this );
      this.svPad.setFixedSize( PAD, PAD );
      try { this.svPad.cursor = new Cursor( 13 ); } catch ( e ) {} // cross
      this.svPad.onPaint = function()
      {
         self.rebuildSv();
         var g = new Graphics( this );
         try
         {
            g.drawScaledBitmap( 0, 0, this.width, this.height, self.svBitmap );
            var cx = self.sat*( this.width - 1 );
            var cy = ( 1 - self.val )*( this.height - 1 );
            g.antialiasing = true;
            g.pen = new Pen( 0xff000000, 3 );
            g.strokeCircle( cx, cy, 6 );
            g.pen = new Pen( 0xffffffff, 1.5 );
            g.strokeCircle( cx, cy, 6 );
         }
         finally
         {
            g.end();
         }
      };
      function svFromMouse( x, y )
      {
         self.sat = Math.max( 0, Math.min( 1, x/( PAD - 1 ) ) );
         self.val = Math.max( 0, Math.min( 1, 1 - y/( PAD - 1 ) ) );
         syncFromHsv();
      }
      this.svPad.onMousePress = ( x, y ) => svFromMouse( x, y );
      this.svPad.onMouseMove = ( x, y, buttonState ) =>
      {
         if ( buttonState & 0x01 )
            svFromMouse( x, y );
      };

      // --- hue strip -------------------------------------------------------
      this.hueBitmap = new Bitmap( 1, PAD );
      for ( var hy = 0; hy < PAD; ++hy )
         this.hueBitmap.setPixel( 0, hy, siHsvToRgb( 360*hy/( PAD - 1 ), 1, 1 ) );
      this.huePad = new Control( this );
      this.huePad.setFixedSize( STRIP, PAD );
      this.huePad.onPaint = function()
      {
         var g = new Graphics( this );
         try
         {
            g.drawScaledBitmap( 0, 0, this.width, this.height, self.hueBitmap );
            var my = ( self.hue/360 )*( this.height - 1 );
            g.pen = new Pen( 0xff000000, 3 );
            g.drawLine( 0, my, this.width, my );
            g.pen = new Pen( 0xffffffff, 1.5 );
            g.drawLine( 0, my, this.width, my );
         }
         finally
         {
            g.end();
         }
      };
      function hueFromMouse( y )
      {
         self.hue = Math.max( 0, Math.min( 360, 360*y/( PAD - 1 ) ) );
         syncFromHsv();
      }
      this.huePad.onMousePress = ( x, y ) => hueFromMouse( y );
      this.huePad.onMouseMove = ( x, y, buttonState ) =>
      {
         if ( buttonState & 0x01 )
            hueFromMouse( y );
      };

      // --- preset swatches -------------------------------------------------
      var PRESETS = [ SIRender.hexToArgb( SI_DEFAULT_ACCENT ), 0xff7fd1ff, 0xff8ff0cf, 0xffe8d44d,
                      0xffffb86c, 0xffe39bff, 0xffff6e6e, 0xfff2f2f2 ];
      this.presetSizer = new HorizontalSizer;
      this.presetSizer.spacing = 6;
      this.presetControls = [];
      for ( var p = 0; p < PRESETS.length; ++p )
      {
         var sw = new Control( this );
         sw.setFixedSize( 24, 24 );
         sw.presetColor = PRESETS[ p ];
         sw.onPaint = function()
         {
            var g = new Graphics( this );
            try
            {
               g.fillRect( 0, 0, this.width, this.height, new Brush( 0xff10151a ) );
               g.fillRect( 2, 2, this.width - 2, this.height - 2, new Brush( this.presetColor ) );
            }
            finally
            {
               g.end();
            }
         };
         sw.onMousePress = function()
         {
            self.setColor( this.presetColor );
         };
         this.presetControls.push( sw );
         this.presetSizer.add( sw );
      }
      this.presetSizer.addStretch();

      // --- preview + hex ---------------------------------------------------
      this.preview = new Control( this );
      this.preview.setFixedSize( 96, 30 );
      this.preview.onPaint = function()
      {
         var g = new Graphics( this );
         try
         {
            g.fillRect( 0, 0, this.width, this.height, new Brush( self.color | 0xff000000 ) );
         }
         finally
         {
            g.end();
         }
      };
      this.hexEdit = new Edit( this );
      this.hexEdit.setFixedWidth( 96 );
      this.hexEdit.text = SIRender.argbToHex( this.color );
      this.hexEdit.onEditCompleted = function()
      {
         var m = String( this.text ).replace( /^\s*#?/, "" );
         if ( /^[0-9a-fA-F]{6}$/.test( m ) )
            self.setColor( parseInt( m, 16 ) );
         else
            this.text = SIRender.argbToHex( self.color );
      };
      this.hexSizer = new HorizontalSizer;
      this.hexSizer.spacing = 8;
      this.hexSizer.add( this.preview );
      this.hexSizer.add( this.hexEdit );
      this.hexSizer.addStretch();

      // --- buttons ----------------------------------------------------------
      this.okButton = new PushButton( this );
      this.okButton.text = "OK";
      this.okButton.defaultButton = true;
      this.okButton.onClick = () => this.ok();
      this.cancelButton = new PushButton( this );
      this.cancelButton.text = "Cancel";
      this.cancelButton.onClick = () => this.cancel();
      this.buttons = new HorizontalSizer;
      this.buttons.addStretch();
      this.buttons.add( this.okButton );
      this.buttons.addSpacing( 6 );
      this.buttons.add( this.cancelButton );

      this.padSizer = new HorizontalSizer;
      this.padSizer.spacing = 8;
      this.padSizer.add( this.svPad );
      this.padSizer.add( this.huePad );

      this.sizer = new VerticalSizer;
      this.sizer.margin = 12;
      this.sizer.spacing = 8;
      this.sizer.add( this.padSizer );
      this.sizer.add( this.presetSizer );
      this.sizer.add( this.hexSizer );
      this.sizer.addSpacing( 4 );
      this.sizer.add( this.buttons );
      this.adjustToContents();
      this.setFixedSize();
   }
}

class ReportDialog extends Dialog
{
   constructor( result, params, suggestedDir )
   {
      super();
      this.windowTitle = SKYINTRUDERS_TITLE + " — " + result.night.dateLabel;

      this.titleLabel = new Label( this );
      this.titleLabel.useRichText = true;
      this.titleLabel.text = "<b>" + result.report.redditTitle + "</b>";
      this.titleLabel.wordWrapping = true;
      this.titleLabel.margin = 6;
      this.titleLabel.frameStyle = FrameStyle.Box;

      this.textBox = new TextBox( this );
      this.textBox.readOnly = true;
      this.textBox.text = result.report.markdown;
      this.textBox.setMinSize( 640, 480 );

      var L = ( params && params.lang ) || "en";
      this.saveButton = new PushButton( this );
      this.saveButton.text = uiT( L, "saveReport" );
      this.saveButton.icon = siIcon( this, ":/icons/save.png" );
      this.saveButton.onClick = () =>
      {
         var d = new SaveFileDialog;
         d.caption = uiT( L, "saveReportCaption" );
         d.filters = [ [ "Markdown", "*.md" ], [ "Any file", "*" ] ];
         d.initialPath = ( suggestedDir || File.homeDirectory ) +
                         "/SkyIntruders-" + result.night.dateLabel.replace( "/", "-" ) + ".md";
         if ( d.execute() )
         {
            File.writeTextFile( d.fileName, result.report.markdown + "\n" );
            console.writeln( SKYINTRUDERS_TITLE + ": report saved to " + d.fileName );
         }
      };

      this.closeButton = new PushButton( this );
      this.closeButton.text = uiT( L, "close" );
      this.closeButton.icon = siIcon( this, ":/icons/close.png" );
      this.closeButton.onClick = () => this.ok();

      // Annotated night composite (registered stack + named trails): it is
      // already shown as an image window; this reopens the PNG externally.
      this.imageButton = null;
      if ( result.resultImagePath && File.exists( result.resultImagePath ) )
      {
         this.imageButton = new PushButton( this );
         this.imageButton.text = uiT( L, "openImage" );
         this.imageButton.icon = siIcon( this, ":/icons/picture.png" );
         this.imageButton.onClick = () =>
         {
            openInBrowser( result.resultImagePath );
         };
      }

      this.buttons = new HorizontalSizer;
      this.buttons.addStretch();
      if ( this.imageButton != null )
      {
         this.buttons.add( this.imageButton );
         this.buttons.addSpacing( 6 );
      }
      this.buttons.add( this.saveButton );
      this.buttons.addSpacing( 6 );
      this.buttons.add( this.closeButton );

      this.sizer = new VerticalSizer;
      this.sizer.margin = 8;
      this.sizer.spacing = 8;
      this.sizer.add( this.titleLabel );
      this.sizer.add( this.textBox, 100 );
      this.sizer.add( this.buttons );
      this.adjustToContents();
   }
}

// The illustrated-result dialog (Treasure Hunt): shows a fancy
// rich-text summary of the find (not the raw HTML source), and lets you open the
// standalone .html in a browser or save it.
class HtmlResultDialog extends Dialog
{
   constructor( title, bodyRich, html, suggestedName, suggestedDir, lang )
   {
      super();
      this.windowTitle = title;
      this.html = html;
      this.suggestedName = suggestedName || "SkyIntruders.html";

      this.body = new Label( this );
      this.body.useRichText = true;
      this.body.wordWrapping = true;
      this.body.text = bodyRich || "";
      this.body.margin = 12;
      this.body.frameStyle = FrameStyle.Box;
      this.body.setMinWidth( 560 );

      this.openButton = new PushButton( this );
      var L2 = lang || "en";
      this.openButton.text = uiT( L2, "openHtml" );
      this.openButton.icon = siIcon( this, ":/icons/internet.png" );
      this.openButton.toolTip = uiT( L2, "openHtmlTip" );
      this.openButton.onClick = () =>
      {
         try
         {
            var p = File.systemTempDirectory + "/" + this.suggestedName;
            File.writeTextFile( p, this.html + "\n" );
            openInBrowser( p );
            console.writeln( SKYINTRUDERS_TITLE + ": opened " + p );
         }
         catch ( e )
         {
            ( new MessageBox( "Could not open the report: " + e.message,
                              SKYINTRUDERS_TITLE, StdIcon.Error, StdButton.Ok ) ).execute();
         }
      };

      this.saveButton = new PushButton( this );
      this.saveButton.text = uiT( L2, "saveHtml" );
      this.saveButton.icon = siIcon( this, ":/icons/save.png" );
      this.saveButton.onClick = () =>
      {
         var d = new SaveFileDialog;
         d.caption = uiT( L2, "saveHtmlCaption" );
         d.filters = [ [ "HTML", "*.html" ], [ "Any file", "*" ] ];
         d.initialPath = ( suggestedDir || File.homeDirectory ) + "/" + this.suggestedName;
         if ( d.execute() )
         {
            File.writeTextFile( d.fileName, this.html + "\n" );
            console.writeln( SKYINTRUDERS_TITLE + ": saved to " + d.fileName );
         }
      };

      this.closeButton = new PushButton( this );
      this.closeButton.text = uiT( L2, "close" );
      this.closeButton.icon = siIcon( this, ":/icons/close.png" );
      this.closeButton.onClick = () => this.ok();

      this.buttons = new HorizontalSizer;
      this.buttons.spacing = 6;
      this.buttons.add( this.openButton );
      this.buttons.addStretch();
      this.buttons.add( this.saveButton );
      this.buttons.add( this.closeButton );

      this.sizer = new VerticalSizer;
      this.sizer.margin = 10;
      this.sizer.spacing = 10;
      this.sizer.add( this.body, 100 );
      this.sizer.add( this.buttons );
      this.adjustToContents();
      this.setMinWidth( 600 );
   }
}

class SkyIntrudersDialog extends Dialog
{
   constructor( params )
   {
      super();
      this.params = params;
      this.files = [];
      this.lastResult = null;
      this.windowTitle = SKYINTRUDERS_TITLE;

      var self = this;
      var ACCENT = 0xff22d3ee;

      // --- header: emblem + title + a mode-specific tagline ------------------
      this.emblem = this.makeEmblem();

      this.titleLabel = new Label( this );
      this.titleLabel.text = SKYINTRUDERS_TITLE;
      var tf = this.titleLabel.font;
      tf.bold = true;
      tf.pointSize = Math.round( this.font.pointSize * 1.7 );
      this.titleLabel.font = tf;

      this.buildLabel = new Label( this );
      this.buildLabel.useRichText = true;
      this.buildLabel.text = "by <span style=\"color:#5a8fd0; text-decoration:underline;\">CaeloWorks</span>";
      this.buildLabel.textAlignment = TextAlign.Left | TextAlign.VertCenter;
      this.buildLabel.toolTip = "https://pixinsight-scripts.caelo.works/ — build " + SKYINTRUDERS_BUILD;
      this.buildLabel.onMousePress = function()
      {
         openInBrowser( "https://pixinsight-scripts.caelo.works/" );
      };
      try { this.buildLabel.cursor = new Cursor( StdCursor_PointingHand ); } catch ( e ) {}

      this.taglineLabel = new Label( this );
      this.taglineLabel.useRichText = true;
      this.taglineLabel.wordWrapping = true;

      this.titleColumn = new VerticalSizer;
      this.titleColumn.add( this.titleLabel );
      this.titleColumn.add( this.buildLabel );

      this.headerSizer = new HorizontalSizer;
      this.headerSizer.spacing = 10;
      if ( this.emblem != null )
         this.headerSizer.add( this.emblem );
      this.headerSizer.add( this.titleColumn );
      this.headerSizer.addStretch();

      // --- mode tabs ---------------------------------------------------------
      var MODES = [ "night", "treasure" ];
      if ( MODES.indexOf( params.mode ) < 0 ) // settings may restore a removed mode
         params.mode = "night";

      // Night page: detection threshold + observer site.
      this.kSigmaControl = new NumericControl( this );
      this.kSigmaControl.label.text = "Detection threshold (σ):";
      this.kSigmaControl.setRange( 3, 12 );
      this.kSigmaControl.setPrecision( 1 );
      this.kSigmaControl.setValue( params.kSigma );
      this.kSigmaControl.toolTip = "Trail pixels must exceed the frame background by this many " +
                                   "robust sigmas. Lower catches fainter trails but risks noise.";
      this.kSigmaControl.onValueUpdated = ( v ) => { self.params.kSigma = v; };

      this.latEdit = this.makeCoordEdit( "Lat (°):", params.observerLatDeg,
                                         ( v ) => { self.params.observerLatDeg = v; } );
      this.lonEdit = this.makeCoordEdit( "Lon (°):", params.observerLonDeg,
                                         ( v ) => { self.params.observerLonDeg = v; } );
      this.altEdit = this.makeCoordEdit( "Alt (m):", params.observerAltM,
                                         ( v ) => { self.params.observerAltM = v; } );
      this.observerRow = new HorizontalSizer;
      this.observerRow.spacing = 10;
      this.observerRow.add( this.latEdit.sizer );
      this.observerRow.add( this.lonEdit.sizer );
      this.observerRow.add( this.altEdit.sizer );
      this.observerRow.addStretch();
      this.observerGroup = new GroupBox( this );
      this.observerGroup.title = "Observer site — only if FITS headers lack SITELAT / SITELONG";
      this.observerGroup.sizer = new VerticalSizer;
      this.observerGroup.sizer.margin = 8;
      this.observerGroup.sizer.add( this.observerRow );

      this.predictedCheck = new CheckBox( this );
      this.predictedCheck.text = "Draw predicted crossers on the result image";
      this.predictedCheck.checked = !!params.nightShowPredicted;
      this.predictedCheck.toolTip = "Satellites the orbit propagation puts inside your field " +
                                    "during an exposure but that no detected trail matched — " +
                                    "drawn as pale ghost lines with their flag and telemetry.";
      this.predictedCheck.onCheck = ( checked ) => { self.params.nightShowPredicted = checked; };

      this.shadowCheck = new CheckBox( this );
      this.shadowCheck.text = "Also draw shadow crossers";
      this.shadowCheck.checked = !!params.nightShowShadow;
      this.shadowCheck.toolTip = "Crossers the model puts in the Earth's shadow during your " +
                                 "exposure — invisible by definition, drawn in grey. Useful to " +
                                 "see the full traffic or to spot shadow-model errors.";
      this.shadowCheck.onCheck = ( checked ) => { self.params.nightShowShadow = checked; };

      this.nightHint = this.pageHint( "" );
      this.nightPage = this.makePage( [
         this.nightHint,
         this.kSigmaControl,
         this.predictedCheck,
         this.shadowCheck,
         this.observerGroup
      ] );

      // Treasure page: catalog depth + a plate-solve reminder.
      this.treasureRows = new NumericControl( this );
      this.treasureRows.label.text = "Max catalog rows / type:";
      this.treasureRows.setRange( 50, 2000 );
      this.treasureRows.setPrecision( 0 );
      this.treasureRows.setValue( params.treasureMaxRows || 400 );
      this.treasureRows.toolTip = "Upper bound on objects fetched per catalog (galaxies, quasars, " +
                                  "nebulae, asteroids) around your field.";
      this.treasureRows.onValueUpdated = ( v ) => { self.params.treasureMaxRows = Math.round( v ); };

      // Which catalog types to hunt. All on by default; texts come from
      // applyLanguage.
      this.huntLabel = new Label( this );
      this.huntLabel.textAlignment = TextAlign.Right | TextAlign.VertCenter;
      function huntCheck( paramKey )
      {
         var cb = new CheckBox( self );
         cb.checked = ( params[ paramKey ] !== false );
         cb.onCheck = ( checked ) => { self.params[ paramKey ] = checked; };
         return cb;
      }
      this.huntGalaxiesCheck = huntCheck( "treasureGalaxies" );
      this.huntQuasarsCheck = huntCheck( "treasureQuasars" );
      this.huntPneCheck = huntCheck( "treasurePne" );
      this.huntAsteroidsCheck = huntCheck( "treasureAsteroids" );
      this.huntSizer = new HorizontalSizer;
      this.huntSizer.spacing = 12;
      this.huntSizer.add( this.huntLabel );
      this.huntSizer.add( this.huntGalaxiesCheck );
      this.huntSizer.add( this.huntQuasarsCheck );
      this.huntSizer.add( this.huntPneCheck );
      this.huntSizer.add( this.huntAsteroidsCheck );
      this.huntSizer.addStretch();
      this.huntRow = new Control( this );
      this.huntRow.sizer = this.huntSizer;

      // Overlay accent color: a swatch button opening the native color
      // dialog. The swatch icon is just a bitmap filled with the color.
      function accentToArgb( hex )
      {
         return SIRender.hexToArgb( hex || SI_DEFAULT_ACCENT );
      }
      this.accentLabel = new Label( this );
      this.accentLabel.textAlignment = TextAlign.Right | TextAlign.VertCenter;
      this.accentButton = new ToolButton( this );
      this.updateAccentSwatch = function()
      {
         try
         {
            var sw = new Bitmap( 22, 14 );
            sw.fill( accentToArgb( self.params.treasureAccent ) );
            self.accentButton.icon = sw;
         }
         catch ( e ) {}
      };
      this.updateAccentSwatch();
      this.accentButton.onClick = () =>
      {
         try
         {
            var cd = new SIColorDialog( accentToArgb( self.params.treasureAccent ),
                                        uiT( self.params.lang, "accentColor" ).replace( /\s*:\s*$/, "" ) );
            if ( cd.execute() )
            {
               self.params.treasureAccent = SIRender.argbToHex( cd.color );
               self.updateAccentSwatch();
            }
         }
         catch ( e )
         {
            console.warningln( "Color dialog unavailable: " + e.message );
         }
      };
      this.accentSizer = new HorizontalSizer;
      this.accentSizer.spacing = 6;
      this.accentSizer.add( this.accentLabel );
      this.accentSizer.add( this.accentButton );
      this.accentSizer.addStretch();
      this.accentRow = new Control( this );
      this.accentRow.sizer = this.accentSizer;

      this.treasureHint = this.pageHint( "" );
      this.treasurePage = this.makePage( [
         this.treasureHint,
         this.treasureRows,
         this.huntRow,
         this.accentRow
      ] );

      this.tabBox = new TabBox( this );
      this.tabBox.addPage( this.nightPage, "Night trails" );
      this.tabBox.addPage( this.treasurePage, "Treasure Hunt" );
      var mi = MODES.indexOf( params.mode );
      this.tabBox.currentPageIndex = ( mi >= 0 ) ? mi : 0;
      this.tabBox.onPageSelected = ( i ) =>
      {
         self.params.mode = MODES[ i ] || "night";
         self.updateMode();
      };

      // --- shared input list -------------------------------------------------
      this.fileTree = new TreeBox( this );
      this.fileTree.alternateRowColor = true;
      this.fileTree.multipleSelection = true;
      this.fileTree.numberOfColumns = 1;
      this.fileTree.headerVisible = true;
      this.fileTree.rootDecoration = false;
      this.fileTree.setMinSize( 580, 200 );

      this.addFilesButton = new PushButton( this );
      this.addFilesButton.text = "Add files…";
      this.addFilesButton.icon = siIcon( this, ":/icons/add.png" );
      this.addFilesButton.onClick = () =>
      {
         var d = new OpenFileDialog;
         d.multipleSelections = true;
         d.caption = uiT( self.params.lang, "selectFrames" );
         d.filters = [ [ "FITS / XISF", "*.fits", "*.fit", "*.fts", "*.xisf" ], [ "Any file", "*" ] ];
         if ( d.execute() )
            self.addFiles( d.fileNames );
      };

      this.addDirButton = new PushButton( this );
      this.addDirButton.text = "Add folder…";
      this.addDirButton.icon = siIcon( this, ":/icons/folder.png" );
      this.addDirButton.onClick = () =>
      {
         var d = new GetDirectoryDialog;
         d.caption = uiT( self.params.lang, "selectFolder" );
         if ( d.execute() )
         {
            var found = [];
            var exts = [ ".fits", ".fit", ".fts", ".xisf" ];
            var ff = new FileFind;
            if ( ff.begin( d.directory + "/*" ) )
               do
               {
                  if ( !ff.isDirectory )
                     for ( var e = 0; e < exts.length; ++e )
                        if ( ff.name.toLowerCase().endsWith( exts[ e ] ) )
                        {
                           found.push( d.directory + "/" + ff.name );
                           break;
                        }
               } while ( ff.next() );
            found.sort();
            self.addFiles( found );
         }
      };

      this.clearButton = new PushButton( this );
      this.clearButton.text = "Clear";
      this.clearButton.icon = siIcon( this, ":/icons/clear.png" );
      this.clearButton.onClick = () =>
      {
         self.files = [];
         self.fileTree.clear();
         self.updateStatus();
      };

      this.fileButtons = new HorizontalSizer;
      this.fileButtons.spacing = 6;
      this.fileButtons.add( this.addFilesButton );
      this.fileButtons.add( this.addDirButton );
      this.fileButtons.add( this.clearButton );
      this.fileButtons.addStretch();

      this.inputGroup = new GroupBox( this );
      this.inputGroup.title = "Input";
      this.inputGroup.sizer = new VerticalSizer;
      this.inputGroup.sizer.margin = 8;
      this.inputGroup.sizer.spacing = 6;
      this.inputGroup.sizer.add( this.fileTree, 100 );
      this.inputGroup.sizer.add( this.fileButtons );

      // --- footer: language, status, actions ---------------------------------
      this.langCombo = new ComboBox( this );
      this.langCombo.addItem( "English" );
      this.langCombo.addItem( "Français" );
      this.langCombo.currentItem = ( params.lang == "fr" ) ? 1 : 0;
      this.langCombo.toolTip = uiT( params.lang, "languageTip" );
      this.langCombo.onItemSelected = ( i ) =>
      {
         self.params.lang = ( i == 1 ) ? "fr" : "en";
         self.applyLanguage();
      };
      this.langLabel = new Label( this );
      this.langLabel.text = uiT( params.lang, "language" );
      this.langLabel.textAlignment = TextAlign.Right | TextAlign.VertCenter;

      this.statusLabel = new Label( this );
      this.statusLabel.useRichText = true;
      this.statusLabel.textAlignment = TextAlign.Left | TextAlign.VertCenter;

      this.analyzeButton = new PushButton( this );
      this.analyzeButton.defaultButton = true;
      this.analyzeButton.icon = siIcon( this, ":/icons/play.png" );
      this.analyzeButton.onClick = () => self.runNow();

      this.closeButton = new PushButton( this );
      this.closeButton.text = "Close";
      this.closeButton.icon = siIcon( this, ":/icons/close.png" );
      this.closeButton.onClick = () => self.cancel();

      this.actions = new HorizontalSizer;
      this.actions.spacing = 6;
      this.actions.add( this.langLabel );
      this.actions.add( this.langCombo );
      this.actions.addSpacing( 12 );
      this.actions.add( this.statusLabel, 100 );
      this.actions.add( this.analyzeButton );
      this.actions.add( this.closeButton );

      // --- assemble ----------------------------------------------------------
      this.sizer = new VerticalSizer;
      this.sizer.margin = 10;
      this.sizer.spacing = 8;
      this.sizer.add( this.headerSizer );
      this.sizer.add( this.taglineLabel );
      this.sizer.addSpacing( 2 );
      this.sizer.add( this.tabBox );
      this.sizer.add( this.inputGroup, 100 );
      this.sizer.add( this.actions );

      this.applyLanguage();
      this.setMinWidth( 620 );
      this.adjustToContents();
   }

   // A small emblem control that paints the script icon, or null if the SVG
   // cannot be found/loaded (dev vs installed layouts differ).
   makeEmblem()
   {
      var here = File.extractDrive( #__FILE__ ) + File.extractDirectory( #__FILE__ );
      // Four levels up from src/scripts/CaeloWorks/SkyIntruders/ is the
      // PixInsight installation root (the #feature-icon location).
      var candidates = [ here + "/assets/" + "SkyIntruders.svg",
                         here + "/" + "SkyIntruders.svg",
                         here + "/../../../../rsc/icons/script/SkyIntruders/SkyIntruders.svg" ];
      // Emblem size in physical pixels, so the icon follows the UI scaling
      // of high-density displays like every other control.
      var px = ( typeof this.logicalPixelsToPhysical == "function" ) ?
         this.logicalPixelsToPhysical( 44 ) : 44;
      var bmp = null;
      for ( var i = 0; i < candidates.length && bmp == null; ++i )
      {
         try
         {
            if ( File.exists( candidates[ i ] ) )
            {
               var b = new Bitmap( candidates[ i ] );
               bmp = ( typeof b.scaledTo == "function" ) ? b.scaledTo( px, px ) : b;
            }
         }
         catch ( e ) { bmp = null; }
      }
      if ( bmp == null )
         return null;
      var ctrl = new Control( this );
      ctrl.setScaledFixedSize( 44, 44 );
      ctrl.__bmp = bmp;
      ctrl.onPaint = function()
      {
         var g = new Graphics( this );
         try { g.drawBitmap( 0, 0, this.__bmp ); } catch ( e ) {}
         g.end();
      };
      return ctrl;
   }

   applyLanguage()
   {
      var L = this.params.lang;
      this.langCombo.toolTip = uiT( L, "languageTip" );
      this.langLabel.text = uiT( L, "language" );
      this.nightHint.text = uiT( L, "hintNight" );
      this.treasureHint.text = uiT( L, "hintTreasure" );
      this.kSigmaControl.label.text = uiT( L, "kSigma" );
      this.kSigmaControl.toolTip = uiT( L, "kSigmaTip" );
      this.predictedCheck.text = uiT( L, "predicted" );
      this.predictedCheck.toolTip = uiT( L, "predictedTip" );
      this.shadowCheck.text = uiT( L, "shadow" );
      this.shadowCheck.toolTip = uiT( L, "shadowTip" );
      this.observerGroup.title = uiT( L, "observer" );
      this.latEdit.label.text = uiT( L, "lat" );
      this.lonEdit.label.text = uiT( L, "lon" );
      this.altEdit.label.text = uiT( L, "alt" );
      this.treasureRows.label.text = uiT( L, "treasureRows" );
      this.treasureRows.toolTip = uiT( L, "treasureRowsTip" );
      this.huntLabel.text = uiT( L, "huntFor" );
      this.huntGalaxiesCheck.text = uiT( L, "huntGalaxies" );
      this.huntQuasarsCheck.text = uiT( L, "huntQuasars" );
      this.huntPneCheck.text = uiT( L, "huntPne" );
      this.huntAsteroidsCheck.text = uiT( L, "huntAsteroids" );
      this.huntRow.toolTip = uiT( L, "huntForTip" );
      this.accentLabel.text = uiT( L, "accentColor" );
      this.accentButton.toolTip = uiT( L, "accentColorTip" );
      this.inputGroup.title = uiT( L, "input" );
      this.addFilesButton.text = uiT( L, "addFiles" );
      this.addDirButton.text = uiT( L, "addFolder" );
      this.clearButton.text = uiT( L, "clear" );
      this.closeButton.text = uiT( L, "close" );
      try
      {
         if ( typeof this.tabBox.setPageLabel == "function" )
         {
            this.tabBox.setPageLabel( 0, uiT( L, "tabNight" ) );
            this.tabBox.setPageLabel( 1, uiT( L, "tabTreasure" ) );
         }
      }
      catch ( e ) {}
      this.updateMode();
   }

   pageHint( richText )
   {
      var l = new Label( this );
      l.useRichText = true;
      l.wordWrapping = true;
      l.text = richText;
      return l;
   }

   // Build a tab page Control from a list of widgets/sizers (Sizer.add
   // accepts both, so no per-item branching is needed).
   makePage( items )
   {
      var page = new Control( this );
      page.sizer = new VerticalSizer;
      page.sizer.margin = 10;
      page.sizer.spacing = 8;
      for ( var i = 0; i < items.length; ++i )
         page.sizer.add( items[ i ] );
      page.sizer.addStretch();
      return page;
   }

   // Reflect the active mode: tagline, Run label, input header, status.
   updateMode()
   {
      var mode = this.params.mode;
      var L = this.params.lang;
      var taglines = {
         night: uiT( L, "tagNight" ),
         treasure: uiT( L, "tagTreasure" )
      };
      this.taglineLabel.text = taglines[ mode ] || taglines.night;

      if ( mode === "treasure" )
      {
         this.analyzeButton.text = uiT( L, "analyzeTreasure" );
         this.fileTree.setHeaderText( 0, uiT( L, "treeTreasure" ) );
      }
      else
      {
         this.analyzeButton.text = uiT( L, "analyzeNight" );
         this.fileTree.setHeaderText( 0, uiT( L, "treeNight" ) );
      }
      this.updateStatus();
   }

   updateStatus( msg )
   {
      if ( msg !== undefined )
      {
         this.statusLabel.text = msg;
         return;
      }
      var n = this.files.length;
      this.statusLabel.text = ( n == 0 )
         ? uiT( this.params.lang, "statusNone" )
         : ( n + uiT( this.params.lang, ( n == 1 ) ? "statusOne" : "statusMany" ) );
   }

   makeCoordEdit( label, value, apply )
   {
      var l = new Label( this );
      l.text = label;
      l.textAlignment = TextAlign.Right | TextAlign.VertCenter;
      var e = new Edit( this );
      e.setFixedWidth( this.font.width( "-000.000000" ) + 16 );
      if ( value != null )
         e.text = String( value );
      e.onEditCompleted = () =>
      {
         var v = parseFloat( e.text );
         apply( isNaN( v ) ? null : v );
      };
      var s = new HorizontalSizer;
      s.spacing = 4;
      s.add( l );
      s.add( e );
      return { label: l, edit: e, sizer: s };
   }

   addFiles( paths )
   {
      for ( var i = 0; i < paths.length; ++i )
         if ( this.files.indexOf( paths[ i ] ) < 0 )
         {
            this.files.push( paths[ i ] );
            var node = new TreeBoxNode( this.fileTree );
            node.setText( 0, paths[ i ] );
         }
      this.updateStatus();
   }

   setBusy( busy )
   {
      this.analyzeButton.enabled = !busy;
      this.addFilesButton.enabled = !busy;
      this.addDirButton.enabled = !busy;
      this.clearButton.enabled = !busy;
      this.tabBox.enabled = !busy;
      this.updateStatus( busy ? uiT( this.params.lang, "working" ) : undefined );
      processEvents();
   }

   // Dispatch Run to the active mode.
   runNow()
   {
      if ( this.params.mode === "treasure" )
         this.runTreasure();
      else
         this.runNight();
   }

   runNight()
   {
      if ( this.files.length == 0 )
      {
         ( new MessageBox( uiT( this.params.lang, "needFrames" ), SKYINTRUDERS_TITLE,
                           StdIcon.Information, StdButton.Ok ) ).execute();
         return;
      }
      saveParams( this.params );
      this.setBusy( true );
      console.show();
      console.writeln( "<b>" + SKYINTRUDERS_TITLE + "</b> — analyzing " + this.files.length + " frame(s)…" );
      try
      {
         this.lastResult = runAnalysis( this.files, this.params );
         console.writeln( "" );
         console.writeln( this.lastResult.report.markdown );
         var dir = File.extractDrive( this.files[ 0 ] ) + File.extractDirectory( this.files[ 0 ] );
         ( new ReportDialog( this.lastResult, this.params, dir ) ).execute();
      }
      catch ( e )
      {
         console.criticalln( SKYINTRUDERS_TITLE + ": " + e.message );
         ( new MessageBox( e.message, SKYINTRUDERS_TITLE, StdIcon.Error, StdButton.Ok ) ).execute();
      }
      finally
      {
         this.setBusy( false );
      }
   }

   runTreasure()
   {
      // Input: the first listed image, else the active window.
      var window = null, filePath = null, opened = false;
      if ( this.files.length > 0 )
      {
         var wins = ImageWindow.open( this.files[ 0 ] );
         if ( wins.length == 0 )
         {
            ( new MessageBox( uiT( this.params.lang, "cannotOpen" ) + " " + this.files[ 0 ],
                              SKYINTRUDERS_TITLE, StdIcon.Error, StdButton.Ok ) ).execute();
            return;
         }
         for ( var i = 1; i < wins.length; ++i )
            wins[ i ].forceClose();
         window = wins[ 0 ];
         filePath = this.files[ 0 ];
         opened = true;
      }
      else
      {
         window = ImageWindow.activeWindow;
         if ( window == null || window.isNull )
         {
            ( new MessageBox( uiT( this.params.lang, "needImage" ),
                              SKYINTRUDERS_TITLE, StdIcon.Information, StdButton.Ok ) ).execute();
            return;
         }
         filePath = window.filePath || window.mainView.id;
      }

      saveParams( this.params );
      this.setBusy( true );
      console.show();
      console.writeln( "<b>" + SKYINTRUDERS_TITLE + "</b> — Treasure Hunt on " +
                       ( filePath || "active window" ) + "…" );
      try
      {
         var res = runTreasureHunt( window, filePath, this.params, null );
         if ( res.needsSolve )
         {
            ( new MessageBox( uiT( this.params.lang, "needSolve" ),
                              SKYINTRUDERS_TITLE, StdIcon.Warning, StdButton.Ok ) ).execute();
            return;
         }
         var dir = filePath ? ( File.extractDrive( filePath ) + File.extractDirectory( filePath ) )
                            : File.homeDirectory;
         var name = "SkyIntruders-Treasure-" +
                    ( res.meta.keywords[ "OBJECT" ] || res.meta.id || "field" ).replace( /[^A-Za-z0-9_.-]+/g, "_" ) + ".html";
         var bodyRich = buildTreasureRich( res, this.params.lang );
         ( new HtmlResultDialog( SKYINTRUDERS_TITLE + " — Treasure Hunt", bodyRich,
                                 res.html, name, dir, this.params.lang ) ).execute();
      }
      catch ( e )
      {
         console.criticalln( SKYINTRUDERS_TITLE + ": " + e.message );
         ( new MessageBox( e.message, SKYINTRUDERS_TITLE, StdIcon.Error, StdButton.Ok ) ).execute();
      }
      finally
      {
         if ( opened && window != null )
            try { window.forceClose(); } catch ( e2 ) {}
         this.setBusy( false );
      }
   }

}

// ---------------------------------------------------------------------------
function main()
{
   ensureMinimumVersion( 1, 9, 4 );
   var params = loadParams();
   var dialog = new SkyIntrudersDialog( params );
   dialog.execute();
   saveParams( params );
}

// Headless construction smoke test: build the dialog (exercising all layout
// code) without showing it, so the UI can be validated in --automation-mode.
// Enabled only when SI_CONSTRUCT_TEST=1 is set in the environment.
function siConstructTest()
{
   // No shims here: the smoke test must fail exactly where production would.
   // TextAlign is defined at the top of this file; FrameStyle/StdButton/StdIcon
   // are real runtime globals in every context.
   var out = { ok: true, error: "" };
   try
   {
      var d = new SkyIntrudersDialog( loadParams() );
      out.modes = [ d.tabBox.numberOfPages, d.tabBox.currentPageIndex ];

      // The header emblem must have found and rasterized the script icon
      // (assets/SkyIntruders.svg in the dev/staged layouts).
      out.emblemOk = ( d.emblem != null );

      // Live language switch must relabel the whole UI, both directions.
      // The saved settings may restore any mode, so compare against the key
      // for the mode actually active.
      var modeKey = { night: "analyzeNight", treasure: "analyzeTreasure" }[ d.params.mode ] ||
                    "analyzeNight";
      d.params.lang = "fr";
      d.applyLanguage();
      out.frAnalyze = d.analyzeButton.text;
      d.params.lang = "en";
      d.applyLanguage();
      out.enAnalyze = d.analyzeButton.text;
      out.langSwitchOk = ( out.frAnalyze !== out.enAnalyze ) &&
                         ( out.frAnalyze === uiT( "fr", modeKey ) ) &&
                         ( out.enAnalyze === uiT( "en", modeKey ) );

      // Exercise the result dialogs too (they are built on demand at runtime).
      var res = { summary: { counts: { galaxy: 2, quasar: 1, pne: 0, asteroid: 1 },
                             total: 4, headlines: [ "4 treasures captured" ] },
                  treasures: [ { type: "quasar", name: "QSO J1229", z: 2.3 },
                               { type: "galaxy", name: "PGC 47404", diamArcmin: 10 } ],
                  meta: { keywords: { OBJECT: "M51" } } };
      var rich = buildTreasureRich( res, "en" );
      out.richLen = rich.length;
      var hd = new HtmlResultDialog( "t", rich, "<html></html>", "x.html", File.systemTempDirectory );
      out.htmlDialogOk = ( typeof hd.openButton !== "undefined" );

      var cdlg = new SIColorDialog( SIRender.hexToArgb( SI_DEFAULT_ACCENT ), "t" );
      out.colorDialogOk = ( SIRender.argbToHex( cdlg.color ) === SI_DEFAULT_ACCENT );
   }
   catch ( e )
   {
      out.ok = false;
      out.error = String( e.message || e );
   }
   File.writeTextFile( File.systemTempDirectory + "/skyintruders-construct.json",
                       JSON.stringify( out, null, 2 ) );
}

function siEnvFlag( name )
{
   try
   {
      if ( typeof System != "undefined" && typeof System.getEnvironmentVariable == "function" )
         return System.getEnvironmentVariable( name ) == "1";
      if ( typeof getEnvironmentVariable == "function" )
         return getEnvironmentVariable( name ) == "1";
   }
   catch ( e ) {}
   return false;
}

function siConstructTestRequested()
{
   return siEnvFlag( "SI_CONSTRUCT_TEST" );
}

if ( siConstructTestRequested() )
   siConstructTest();
else if ( !siEnvFlag( "SI_HEADLESS_LIB" ) )
   main();
