// SPDX-License-Identifier: GPL-3.0-only
/*
 * Params.js — the dialog parameters: their defaults, and how a saved
 * settings.json is merged over them (siMergeSavedParams). A saved value is
 * taken only when it has the default's type; every key the file lacks —
 * an option added after the file was written, for one — keeps its default.
 * Pure JS (SINet.isHttpsUrl only) — runs under plain Node for testing; the
 * file I/O stays in the entry script (loadParams / saveParams).
 */


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
   treasureAccent: SI_DEFAULT_ACCENT,
   // --- settings.json only (no dialog control) ---------------------------
   // Append the night to the personal records (history.json). Headless test
   // runs switch it off so they never pollute the log.
   saveHistory: true,
   // Build the annotated night composite at all.
   nightResultImage: true,
   // Composite background: "best" = the sharpest/cleanest single frame (every
   // trail of the night is drawn on top anyway); "max" = max-combine of the
   // whole registered set — shows every streak in the pixels, and every
   // frame's hot pixels with them.
   nightResultCombine: "best",
   // Diagnostics: one annotated PNG per registered frame in the temp folder,
   // and per-trail nearest-candidate data in the result's fitInfo.diag.
   debugFrameOverlays: false,
   matchDiagnostics: false,
   // End every report (night log, forum text, HTML) with "Report generated
   // by Sky Intruders for PixInsight" + the product page. Opt-in (CPD rule
   // 6.4): false by default, and a settings.json written before the option
   // existed has no key, so it loads as false too.
   reportAttribution: false
};

// Keys whose default is null: the type a saved value must have to be taken.
var NULLABLE_PARAM_TYPES = {
   tleBaseUrl: "string",
   observerLatDeg: "number",
   observerLonDeg: "number"
};

// A saved value is accepted only when it has the default's type (finite for
// numbers, arrays of strings for arrays); anything else keeps the default.
function isAcceptableParam( key, def, v )
{
   if ( v === undefined )
      return false;
   if ( def === null )
   {
      if ( v === null )
         return true;
      var want = NULLABLE_PARAM_TYPES[ key ];
      if ( want === undefined || typeof v !== want )
         return false;
      return ( want !== "number" ) || isFinite( v );
   }
   if ( Array.isArray( def ) )
   {
      if ( !Array.isArray( v ) )
         return false;
      for ( var i = 0; i < v.length; ++i )
         if ( typeof v[ i ] !== "string" )
            return false;
      return true;
   }
   if ( typeof v !== typeof def )
      return false;
   if ( typeof v === "number" )
      return isFinite( v );
   return true;
}

// The parameters to run with: DEFAULT_PARAMS overlaid with the acceptable
// values of a parsed settings.json (null/undefined = no file). Never throws.
function siMergeSavedParams( saved )
{
   var out = JSON.parse( JSON.stringify( DEFAULT_PARAMS ) );
   if ( saved === null || typeof saved !== "object" )
      return out;
   for ( var k in out )
      if ( isAcceptableParam( k, DEFAULT_PARAMS[ k ], saved[ k ] ) )
         out[ k ] = saved[ k ];
   if ( out.nightResultCombine !== "best" && out.nightResultCombine !== "max" )
      out.nightResultCombine = DEFAULT_PARAMS.nightResultCombine;
   // HTTPS only: a saved mirror URL over any other scheme is dropped.
   if ( out.tleBaseUrl !== null && !SINet.isHttpsUrl( out.tleBaseUrl ) )
      out.tleBaseUrl = null;
   // tleExtraGroups has no dialog control, so a saved value is a
   // frozen former default, not a user choice: upgrade the old
   // default in place so existing installs gain the full catalog.
   if ( JSON.stringify( out.tleExtraGroups ) === JSON.stringify( [ "last-30-days" ] ) )
      out.tleExtraGroups = DEFAULT_PARAMS.tleExtraGroups.slice();
   return out;
}

var SIParams = {
   DEFAULTS: DEFAULT_PARAMS,
   isAcceptable: isAcceptableParam,
   merge: siMergeSavedParams
};
