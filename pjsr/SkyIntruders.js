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

#feature-id    Batch Processing > Sky Intruders
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
#include "lib/TrashArt.js"
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
   // last-30-days they all show up as unidentified.
   tleExtraGroups: [ "last-30-days" ],
   tleMaxAgeHours: 12,
   tleBaseUrl: null,   // override to use a CelesTrak mirror
   matchMaxSepDeg: 0.2,
   matchMaxAngleDiffDeg: 12,
   stepSec: 1.0,
   detectAsteroids: true,
   maxSources: 600,
   lang: "en",
   observerLatDeg: null,   // fallbacks when FITS headers lack the site
   observerLonDeg: null,
   observerAltM: 0,
   // Mode selector: "night" (trails), "treasure" (hunt), "trash" (to art).
   mode: "night",
   // Treasure Hunt: cap catalog rows fetched per cone search.
   treasureMaxRows: 400,
   // Trash to Art options.
   trashScheme: "type",       // "type" | "operator" | "time"
   trashChoreography: true,
   trashStarTrails: true,
   trashPoster: true
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
      var rec = satcat[ crossing.noradId ];
      if ( rec && rec.ops )
      {
         if ( "+PBSX".indexOf( rec.ops ) >= 0 )
            parts.push( fr ? "en service" : "in service" );
         else if ( rec.ops == "-" )
            parts.push( fr ? "hors service" : "out of service" );
      }
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
            bmp = SIRender.annotateTrails( bmp, labeledTrails, { flagDir: flagAssetsDir() } );
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
var TREASURE_STYLE = {
   galaxy:   { color: "#7fd1ff", glyph: "circle" },
   quasar:   { color: "#e39bff", glyph: "diamond" },
   pne:      { color: "#8ff0cf", glyph: "square" },
   asteroid: { color: "#ffd38f", glyph: "circle" }
};

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

   function safeQuery( label, fn )
   {
      try
      {
         var rows = fn();
         progress( "   " + label + ": " + rows.length + " row(s)" );
         return rows || [];
      }
      catch ( e )
      {
         console.warningln( "   " + label + " unavailable: " + e.message );
         return [];
      }
   }

   progress( "Querying deep catalogs…" );
   var galaxies  = safeQuery( "galaxies",  function() { return SICatalogs.queryGalaxies( raDeg, decDeg, radiusDeg, qopts ); } );
   var quasars   = safeQuery( "quasars",   function() { return SICatalogs.queryQuasars( raDeg, decDeg, radiusDeg, qopts ); } );
   var pne       = safeQuery( "nebulae",   function() { return SICatalogs.queryPne( raDeg, decDeg, radiusDeg, qopts ); } );
   var asteroids = safeQuery( "asteroids", function() { return SICatalogs.queryAsteroids( raDeg, decDeg, radiusDeg, epochIso, qopts ); } );

   var flat = galaxies.concat( quasars ).concat( pne ).concat( asteroids );
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

   var summary = SITreasure.summarize( treasures, params.lang );

   // Render: stretched base, annotated overlay window + embedded PNG.
   progress( "Rendering annotated field…" );
   var base = SIRender.stretchedBitmap( image );
   var marks = [];
   var labelCap = Math.min( treasures.length, 40 );
   for ( var m = 0; m < treasures.length; ++m )
   {
      var o = treasures[ m ];
      var style = TREASURE_STYLE[ o.type ] || TREASURE_STYLE.galaxy;
      marks.push( { x: o.x, y: o.y, color: style.color, glyph: style.glyph,
                    label: ( m < labelCap ) ? o.name : null, labelColor: style.color } );
   }
   var mapBmp = SIRender.annotateField( base, marks ); // sizes scale with the image
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
      mapPng: mapPng, thumbs: thumbs,
      fieldInfo: { raDeg: raDeg, decDeg: decDeg, radiusDeg: radiusDeg,
                   target: meta.keywords[ "OBJECT" ] || null },
      lang: params.lang } );

   return { meta: meta, treasures: treasures, summary: summary,
            html: html, mapWindow: mapWindow };
}

// ---------------------------------------------------------------------------
// Trash to Art mode — your rejects have talent.

// Detect trails on one reject frame and pull a couple of intruder thumbnails
// while the frame is still open. Returns the shape the art pipeline consumes.
function analyzeTrashFrame( filePath, params )
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
      var image = window.mainView.image;
      var det = SITrailDetect.detect( image, params );

      var w = image.width, h = image.height;
      var margin = Math.max( 8, Math.round( 0.03*Math.max( w, h ) ) );
      function nearEdge( x, y )
      {
         return x <= margin || y <= margin || x >= w - margin || y >= h - margin;
      }

      var base = null, thumbs = [];
      for ( var t = 0; t < det.trails.length; ++t )
      {
         var tr = det.trails[ t ];
         tr.spansEdgeToEdge = nearEdge( tr.x1, tr.y1 ) && nearEdge( tr.x2, tr.y2 );
         tr.p1 = meta.wcs.imageToCelestial ? meta.wcs.imageToCelestial( tr.x1, tr.y1 ) : null;
         tr.p2 = meta.wcs.imageToCelestial ? meta.wcs.imageToCelestial( tr.x2, tr.y2 ) : null;
         var cls = SIMeteors.classifyTrail( tr, meta.dateObs );
         tr.klass = cls.klass;
         // One thumbnail per frame, centered on its first trail's midpoint.
         if ( t === 0 )
            try
            {
               if ( base === null )
                  base = SIRender.stretchedBitmap( image );
               var cx = 0.5*( tr.x1 + tr.x2 ), cy = 0.5*( tr.y1 + tr.y2 );
               var boxPx = Math.max( 48, Math.round( 0.10*Math.max( w, h ) ) );
               var crop = SIRender.cropThumbnail( base, cx, cy, boxPx, 120 );
               thumbs.push( { pngBase64: SIRender.bitmapToBase64Png( crop ),
                              caption: meta.id } );
            }
            catch ( e ) {}
      }

      return { meta: meta, trails: det.trails, srcW: w, srcH: h, thumbs: thumbs };
   }
   finally
   {
      window.forceClose();
   }
}

// Turn a set of analyzed frames (session rejects or freshly detected folder
// frames) into the trail list the art pipeline draws.
function collectTrashTrails( frames )
{
   var trails = [];
   for ( var i = 0; i < frames.length; ++i )
   {
      var f = frames[ i ];
      var timeUtc = f.meta && f.meta.dateObs ? f.meta.dateObs : null;
      for ( var t = 0; t < f.trails.length; ++t )
      {
         var tr = f.trails[ t ];
         var klass = tr.klass;
         if ( klass == null )
         {
            // Session-reuse frames carry raw trails: classify them now.
            try { klass = SIMeteors.classifyTrail( tr, timeUtc ).klass; }
            catch ( e ) { klass = "unknown"; }
         }
         var operator = tr.operator || ( tr.name ? SIReport.classifyOperator( tr.name ) : null );
         trails.push( { x1: tr.x1, y1: tr.y1, x2: tr.x2, y2: tr.y2,
                        p1: tr.p1 || null, p2: tr.p2 || null,
                        frameIndex: i, klass: klass, operator: operator, timeUtc: timeUtc } );
      }
   }
   return trails;
}

function trashSummaryFromTrails( trails, dateLabel )
{
   var s = { date: dateLabel, satellites: 0, starlink: 0, meteors: 0,
             satCandidates: 0, unknowns: 0, movers: 0 };
   for ( var i = 0; i < trails.length; ++i )
   {
      var k = trails[ i ].klass;
      if ( k === "satellite" )
      {
         s.satellites++;
         if ( trails[ i ].operator === "Starlink" )
            s.starlink++;
      }
      else if ( k === "satellite-candidate" ) s.satCandidates++;
      else if ( k === "meteor" ) s.meteors++;
      else if ( k === "asteroid" ) s.movers++;
      else s.unknowns++;
   }
   return s;
}

// Align trail endpoints across dithered/rotated frames by projecting their sky
// coordinates onto one reference frame's pixel grid (via its WCS). Without
// registration, dithering leaves every frame on a different pixel grid and the
// superposition is misaligned. Frames lacking sky coordinates keep their own
// pixel coordinates (best effort). Returns { trails, refW, refH, method,
// projected, total }.
function alignTrailsByWcs( trails, frames )
{
   var refIdx = -1;
   for ( var i = 0; i < frames.length; ++i )
   {
      var wcs = frames[ i ].meta ? frames[ i ].meta.wcs : null;
      if ( wcs && ( wcs.kind === "solution" || wcs.kind === "tan" ) &&
           typeof wcs.celestialToImage === "function" )
      {
         refIdx = i;
         break;
      }
   }
   if ( refIdx < 0 )
      return { trails: trails, refW: frames[ 0 ].srcW || 1600, refH: frames[ 0 ].srcH || 1600,
               method: "none", projected: 0, total: trails.length };

   var ref = frames[ refIdx ].meta.wcs;
   var refW = frames[ refIdx ].srcW, refH = frames[ refIdx ].srcH;
   var out = [], projected = 0;
   for ( var t = 0; t < trails.length; ++t )
   {
      var tr = trails[ t ];
      var a = tr.p1 ? ref.celestialToImage( tr.p1.raDeg, tr.p1.decDeg ) : null;
      var b = tr.p2 ? ref.celestialToImage( tr.p2.raDeg, tr.p2.decDeg ) : null;
      var o = {};
      for ( var k in tr ) o[ k ] = tr[ k ];
      if ( a != null && b != null )
      {
         o.x1 = a.x; o.y1 = a.y; o.x2 = b.x; o.y2 = b.y;
         ++projected;
      }
      out.push( o );
   }
   return { trails: out, refW: refW, refH: refH, method: "wcs",
            projected: projected, total: trails.length };
}

function runTrashToArt( frames, framePaths, params, onProgress )
{
   function progress( msg )
   {
      console.writeln( msg );
      if ( typeof onProgress == "function" ) onProgress( msg );
      processEvents();
   }

   var rawTrails = collectTrashTrails( frames );
   progress( rawTrails.length + " trail(s) across " + frames.length + " frame(s)." );

   // Register trails onto a common grid so dithering/rotation don't scatter the
   // superposition.
   var aligned = alignTrailsByWcs( rawTrails, frames );
   var trails = aligned.trails;
   if ( aligned.method === "wcs" )
      progress( "Aligned " + aligned.projected + "/" + aligned.total +
                " trail(s) via WCS onto a common grid." );
   else
      progress( "No astrometric solution found — trails drawn in native pixels " +
                "(dithering may misalign the superposition)." );

   // Canvas: reference frame dimensions, capped to a 1600px long side.
   var srcW = aligned.refW || 1600, srcH = aligned.refH || 1600;
   var longSide = Math.max( srcW, srcH );
   var scale = ( longSide > 1600 ) ? 1600/longSide : 1;
   var dstW = Math.max( 1, Math.round( srcW*scale ) );
   var dstH = Math.max( 1, Math.round( srcH*scale ) );

   var dateLabel = nightLabel( frames );
   var summary = trashSummaryFromTrails( trails, dateLabel );

   var result = { choreographyWindow: null, starTrailsWindow: null,
                  posterHtml: null, choreographyPng: null, summary: summary };

   var colored = SITrashArt.assignColors( trails, params.trashScheme );
   var choreographyPng = null;
   var posterThumbs = [];

   // (a) Intruder choreography.
   if ( params.trashChoreography || params.trashPoster )
   {
      progress( "Composing the intruder choreography…" );
      var normalized = SITrashArt.normalizeEndpoints( colored, srcW, srcH, dstW, dstH );
      var black = new Bitmap( dstW, dstH );
      black.fill( 0xff05070d );
      var choreoBmp = SIRender.drawTrails( black, normalized, { glow: true, lineWidth: 2 } );
      choreographyPng = SIRender.bitmapToBase64Png( choreoBmp );
      result.choreographyPng = choreographyPng;
      if ( params.trashChoreography )
         result.choreographyWindow = SIRender.showBitmap( choreoBmp, "Sky Intruders Choreography" );
   }

   // (b) Star-trail composite (max-combine).
   if ( params.trashStarTrails )
   {
      if ( framePaths && framePaths.length > 0 )
      {
         if ( framePaths.length < 8 )
            console.warningln( "Only " + framePaths.length +
               " frame(s): the star-trail composite will be sparse." );
         // Register first so dithering/rotation don't smear the max-combine.
         progress( "Registering " + framePaths.length + " frame(s)…" );
         var regDir = File.systemTempDirectory + "/si-trash-reg-" + ( new Date ).getTime();
         var aligned = SIRender.registerFrames( framePaths, regDir );
         if ( aligned == null || aligned.length < framePaths.length )
            console.warningln( "Registration " + ( aligned == null ? "unavailable" :
               "aligned " + aligned.length + "/" + framePaths.length ) +
               " — combining what is available." );
         var combineList = ( aligned != null && aligned.length > 0 ) ? aligned : framePaths;
         progress( "Max-combining " + combineList.length + " frame(s) into a composite…" );
         var composite = SIRender.maxCombine( combineList );
         if ( composite !== null )
         {
            var compBmp = SIRender.stretchedBitmap( composite );
            result.starTrailsWindow = SIRender.showBitmap( compBmp, "Sky Intruders Star Trails" );
         }
         else
            console.warningln( "Star-trail composite produced no image." );

         // Drop the registered temp frames.
         try
         {
            if ( File.directoryExists( regDir ) )
            {
               var ff = new FileFind;
               if ( ff.begin( regDir + "/*" ) )
                  do { if ( !ff.isDirectory ) File.remove( regDir + "/" + ff.name ); } while ( ff.next() );
               File.removeDirectory( regDir );
            }
         }
         catch ( e ) {}
      }
      else
         console.warningln( "Star-trail composite needs the frame files (session " +
            "rejects are already closed) — skipped." );
   }

   // (c) Designed poster.
   if ( params.trashPoster )
   {
      progress( "Laying out the poster…" );
      for ( var i = 0; i < frames.length && posterThumbs.length < 6; ++i )
         if ( frames[ i ].thumbs )
            for ( var j = 0; j < frames[ i ].thumbs.length && posterThumbs.length < 6; ++j )
               posterThumbs.push( frames[ i ].thumbs[ j ] );

      var model = SITrashArt.posterModel( summary, {
         scheme: params.trashScheme, frameCount: frames.length,
         dateLabel: dateLabel, lang: params.lang, legend: colored.legend } );
      result.posterHtml = SITrashArt.buildPosterHtml( model, choreographyPng, posterThumbs, params.lang );
   }

   return result;
}

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
      if ( n > 0 )
         h += "<td bgcolor=\"" + TYPE[ k ].bg + "\"><font color=\"" + TYPE[ k ].c +
              "\">&nbsp;<b>" + n + "</b> " + TYPE[ k ].n + "&nbsp;</font></td>";
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
         h += "<li><font color=\"" + col + "\"><b>" + siEscapeHtml( o.name || o.type ) +
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

// ---------------------------------------------------------------------------
// UI.

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

      this.saveButton = new PushButton( this );
      this.saveButton.text = "Save report…";
      this.saveButton.icon = siIcon( this, ":/icons/save.png" );
      this.saveButton.onClick = () =>
      {
         var d = new SaveFileDialog;
         d.caption = "Save night report";
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
      this.closeButton.text = "Close";
      this.closeButton.icon = siIcon( this, ":/icons/close.png" );
      this.closeButton.onClick = () => this.ok();

      // Annotated night composite (registered stack + named trails): it is
      // already shown as an image window; this reopens the PNG externally.
      this.imageButton = null;
      if ( result.resultImagePath && File.exists( result.resultImagePath ) )
      {
         this.imageButton = new PushButton( this );
         this.imageButton.text = "Open image";
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

// The illustrated-result dialog (Treasure Hunt and Trash-to-Art): shows a fancy
// rich-text summary of the find (not the raw HTML source), and lets you open the
// standalone .html in a browser or save it.
class HtmlResultDialog extends Dialog
{
   constructor( title, bodyRich, html, suggestedName, suggestedDir )
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
      this.openButton.text = "Open HTML";
      this.openButton.icon = siIcon( this, ":/icons/internet.png" );
      this.openButton.toolTip = "Open the illustrated report in your web browser.";
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
      this.saveButton.text = "Save HTML…";
      this.saveButton.icon = siIcon( this, ":/icons/save.png" );
      this.saveButton.onClick = () =>
      {
         var d = new SaveFileDialog;
         d.caption = "Save illustrated report";
         d.filters = [ [ "HTML", "*.html" ], [ "Any file", "*" ] ];
         d.initialPath = ( suggestedDir || File.homeDirectory ) + "/" + this.suggestedName;
         if ( d.execute() )
         {
            File.writeTextFile( d.fileName, this.html + "\n" );
            console.writeln( SKYINTRUDERS_TITLE + ": saved to " + d.fileName );
         }
      };

      this.closeButton = new PushButton( this );
      this.closeButton.text = "Close";
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
      this.sessionFrames = null;   // raw frames of the last Night-trails run
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
      this.buildLabel.text = "build " + SKYINTRUDERS_BUILD;
      this.buildLabel.textAlignment = TextAlign.Left | TextAlign.VertCenter;

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
      var MODES = [ "night", "treasure", "trash" ];

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

      this.nightPage = this.makePage( [
         this.pageHint( "Identify satellite, meteor and asteroid trails across a night of " +
                        "light frames, then get a night log and a ready-to-post report." ),
         this.kSigmaControl,
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

      this.treasurePage = this.makePage( [
         this.pageHint( "Point at a <b>plate-solved</b> image (uses the active window if the list " +
                        "is empty) and discover the galaxies, quasars, nebulae and passing " +
                        "asteroids hiding in your field." ),
         this.treasureRows
      ] );

      // Trash page: color scheme + output toggles.
      var SCHEMES = [ "type", "operator", "time" ];
      this.schemeLabel = new Label( this );
      this.schemeLabel.text = "Color by:";
      this.schemeLabel.textAlignment = TextAlign.Right | TextAlign.VertCenter;
      this.schemeCombo = new ComboBox( this );
      this.schemeCombo.addItem( "type (satellite / meteor / …)" );
      this.schemeCombo.addItem( "operator (Starlink / OneWeb / …)" );
      this.schemeCombo.addItem( "time (dusk → dawn gradient)" );
      var si = SCHEMES.indexOf( params.trashScheme );
      this.schemeCombo.currentItem = ( si >= 0 ) ? si : 0;
      this.schemeCombo.onItemSelected = ( i ) => { self.params.trashScheme = SCHEMES[ i ] || "type"; };
      this.schemeSizer = new HorizontalSizer;
      this.schemeSizer.spacing = 6;
      this.schemeSizer.add( this.schemeLabel );
      this.schemeSizer.add( this.schemeCombo, 100 );

      this.choreoCheck = new CheckBox( this );
      this.choreoCheck.text = "Intruder choreography";
      this.choreoCheck.toolTip = "Every detected trail drawn on one canvas, color-coded.";
      this.choreoCheck.checked = params.trashChoreography;
      this.choreoCheck.onCheck = ( c ) => { self.params.trashChoreography = c; };

      this.starTrailsCheck = new CheckBox( this );
      this.starTrailsCheck.text = "Star-trail composite";
      this.starTrailsCheck.toolTip = "Classic lighten/maximum combine of the frames.";
      this.starTrailsCheck.checked = params.trashStarTrails;
      this.starTrailsCheck.onCheck = ( c ) => { self.params.trashStarTrails = c; };

      this.posterCheck = new CheckBox( this );
      this.posterCheck.text = "Designed poster (HTML)";
      this.posterCheck.toolTip = "A shareable poster: choreography + thumbnails + stats.";
      this.posterCheck.checked = params.trashPoster;
      this.posterCheck.onCheck = ( c ) => { self.params.trashPoster = c; };

      this.outputsSizer = new VerticalSizer;
      this.outputsSizer.spacing = 4;
      this.outputsSizer.add( this.choreoCheck );
      this.outputsSizer.add( this.starTrailsCheck );
      this.outputsSizer.add( this.posterCheck );
      this.outputsGroup = new GroupBox( this );
      this.outputsGroup.title = "Outputs";
      this.outputsGroup.sizer = new VerticalSizer;
      this.outputsGroup.sizer.margin = 8;
      this.outputsGroup.sizer.add( this.outputsSizer );

      this.trashPage = this.makePage( [
         this.pageHint( "Recycle rejected frames into art — from this session's rejects or any " +
                        "folder of discards." ),
         this.schemeSizer,
         this.outputsGroup
      ] );

      this.tabBox = new TabBox( this );
      this.tabBox.addPage( this.nightPage, "Night trails" );
      this.tabBox.addPage( this.treasurePage, "Treasure Hunt" );
      this.tabBox.addPage( this.trashPage, "Trash to Art" );
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
         d.caption = "Select frames";
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
         d.caption = "Select a folder of frames";
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
      this.langCombo.toolTip = "Report language.";
      this.langCombo.onItemSelected = ( i ) => { self.params.lang = ( i == 1 ) ? "fr" : "en"; };
      this.langLabel = new Label( this );
      this.langLabel.text = "Report:";
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

      this.updateMode();
      this.setMinWidth( 620 );
      this.adjustToContents();
   }

   // A small emblem control that paints the script icon, or null if the SVG
   // cannot be found/loaded (dev vs installed layouts differ).
   makeEmblem()
   {
      var here = File.extractDrive( #__FILE__ ) + File.extractDirectory( #__FILE__ );
      var candidates = [ here + "/assets/" + "SkyIntruders.svg",
                         here + "/" + "SkyIntruders.svg",
                         here + "/../../../rsc/icons/script/SkyIntruders/SkyIntruders.svg" ];
      var bmp = null;
      for ( var i = 0; i < candidates.length && bmp == null; ++i )
      {
         try
         {
            if ( File.exists( candidates[ i ] ) )
            {
               var b = new Bitmap( candidates[ i ] );
               bmp = ( typeof b.scaledTo == "function" ) ? b.scaledTo( 44, 44 ) : b;
            }
         }
         catch ( e ) { bmp = null; }
      }
      if ( bmp == null )
         return null;
      var ctrl = new Control( this );
      ctrl.setFixedSize( 44, 44 );
      ctrl.__bmp = bmp;
      ctrl.onPaint = function()
      {
         var g = new Graphics( this );
         try { g.drawBitmap( 0, 0, this.__bmp ); } catch ( e ) {}
         g.end();
      };
      return ctrl;
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
      var taglines = {
         night:    "🛰  <i>Who crossed your photo last night?</i>",
         treasure: "💎  <i>What you photographed without knowing.</i>",
         trash:    "🎨  <i>Your rejects have talent.</i>"
      };
      this.taglineLabel.text = taglines[ mode ] || taglines.night;

      if ( mode === "treasure" )
      {
         this.analyzeButton.text = "Hunt treasures";
         this.fileTree.setHeaderText( 0, "Plate-solved image — active window used if empty" );
      }
      else if ( mode === "trash" )
      {
         this.analyzeButton.text = "Make art";
         this.fileTree.setHeaderText( 0, "Reject frames — or add a folder of rejects" );
      }
      else
      {
         this.analyzeButton.text = "Analyze night";
         this.fileTree.setHeaderText( 0, "Light frames" );
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
         ? "<i>No frames added yet.</i>"
         : ( n + ( n == 1 ? " frame ready." : " frames ready." ) );
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
      this.updateStatus( busy ? "<i>Working…</i>" : undefined );
      processEvents();
   }

   // Dispatch Run to the active mode.
   runNow()
   {
      if ( this.params.mode === "treasure" )
         this.runTreasure();
      else if ( this.params.mode === "trash" )
         this.runTrash();
      else
         this.runNight();
   }

   runNight()
   {
      if ( this.files.length == 0 )
      {
         ( new MessageBox( "Add some light frames first.", SKYINTRUDERS_TITLE,
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
         this.sessionFrames = this.lastResult.frames;
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
            ( new MessageBox( "Cannot open " + this.files[ 0 ], SKYINTRUDERS_TITLE,
                              StdIcon.Error, StdButton.Ok ) ).execute();
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
            ( new MessageBox( "Add one plate-solved image, or open one in PixInsight first.",
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
            ( new MessageBox( "This image has no astrometric solution (WCS). " +
                              "Plate-solve it first (ImageSolver), then run Treasure Hunt.",
                              SKYINTRUDERS_TITLE, StdIcon.Warning, StdButton.Ok ) ).execute();
            return;
         }
         var dir = filePath ? ( File.extractDrive( filePath ) + File.extractDirectory( filePath ) )
                            : File.homeDirectory;
         var name = "SkyIntruders-Treasure-" +
                    ( res.meta.keywords[ "OBJECT" ] || res.meta.id || "field" ).replace( /[^A-Za-z0-9_.-]+/g, "_" ) + ".html";
         var bodyRich = buildTreasureRich( res, this.params.lang );
         ( new HtmlResultDialog( SKYINTRUDERS_TITLE + " — Treasure Hunt", bodyRich,
                                 res.html, name, dir ) ).execute();
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

   runTrash()
   {
      var reuse = false;
      if ( this.sessionFrames != null && this.sessionFrames.length > 0 )
      {
         var mb = new MessageBox(
            "Reuse the " + this.sessionFrames.length + " frame(s) from this session's " +
            "Night-trails run?\n\nYes — recycle the frames just analyzed.\n" +
            "No — use the frames in the list instead.",
            SKYINTRUDERS_TITLE, StdIcon.Question, StdButton.Yes, StdButton.No );
         reuse = ( mb.execute() == StdButton.Yes );
      }

      if ( !reuse && this.files.length == 0 )
      {
         ( new MessageBox( "Add reject frames (or a folder of rejects) first.",
                           SKYINTRUDERS_TITLE, StdIcon.Information, StdButton.Ok ) ).execute();
         return;
      }

      saveParams( this.params );
      this.setBusy( true );
      console.show();
      console.writeln( "<b>" + SKYINTRUDERS_TITLE + "</b> — Trash to Art…" );
      try
      {
         var frames = [], framePaths = null;
         if ( reuse )
         {
            // Session frames carry meta + raw trails + srcW/srcH; they were
            // already closed, so re-collect their paths for the star-trail
            // composite (thumbnails are regenerated from those files there).
            frames = this.sessionFrames;
            framePaths = [];
            for ( var p = 0; p < frames.length; ++p )
               if ( frames[ p ].meta && frames[ p ].meta.path )
                  framePaths.push( frames[ p ].meta.path );
         }
         else
         {
            for ( var f = 0; f < this.files.length; ++f )
            {
               console.writeln( format( "<b>[%d/%d]</b> ", f + 1, this.files.length ) + this.files[ f ] );
               try
               {
                  frames.push( analyzeTrashFrame( this.files[ f ], this.params ) );
               }
               catch ( e )
               {
                  console.warningln( "   skipped: " + e.message );
               }
               processEvents();
            }
            framePaths = this.files.slice();
         }
         if ( frames.length == 0 )
            throw new Error( "no frame could be analyzed" );

         var res = runTrashToArt( frames, framePaths, this.params, null );
         if ( res.posterHtml != null )
         {
            var dir = ( framePaths && framePaths.length > 0 )
               ? ( File.extractDrive( framePaths[ 0 ] ) + File.extractDirectory( framePaths[ 0 ] ) )
               : File.homeDirectory;
            var fr = ( this.params.lang === "fr" );
            var bodyRich =
               "<p><font size=\"5\"><b>" + siEscapeHtml( res.summary.date ) + "</b></font></p>" +
               "<table cellpadding=\"5\" cellspacing=\"6\"><tr>" +
               "<td bgcolor=\"#25324a\"><font color=\"#9fc3ff\">&nbsp;<b>" + res.summary.satellites +
                  "</b> " + ( fr ? "satellites" : "satellites" ) + "&nbsp;</font></td>" +
               ( res.summary.starlink ? "<td bgcolor=\"#1f2b3d\"><font color=\"#7fd1ff\">&nbsp;<b>" +
                  res.summary.starlink + "</b> Starlink&nbsp;</font></td>" : "" ) +
               "<td bgcolor=\"#3a2a18\"><font color=\"#ffd38f\">&nbsp;<b>" + res.summary.meteors +
                  "</b> " + ( fr ? "météores" : "meteors" ) + "&nbsp;</font></td>" +
               "<td bgcolor=\"#2a2233\"><font color=\"#c9b8ff\">&nbsp;<b>" + res.summary.unknowns +
                  "</b> " + ( fr ? "non identifiés" : "unidentified" ) + "&nbsp;</font></td>" +
               "</tr></table>" +
               "<p><font color=\"#9fb0c6\">" +
               ( fr ? "Œuvres générées — ouvre le poster pour la version complète."
                    : "Artwork generated — open the poster for the full version." ) + "</font></p>";
            ( new HtmlResultDialog( SKYINTRUDERS_TITLE + " — Trash to Art",
                                    bodyRich,
                                    res.posterHtml, "SkyIntruders-Poster.html", dir ) ).execute();
         }
         else
            console.writeln( SKYINTRUDERS_TITLE + ": image windows produced (no poster requested)." );
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
