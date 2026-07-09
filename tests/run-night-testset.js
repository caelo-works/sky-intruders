/*
 * run-night-testset.js — drive the PRODUCTION Night-trails pipeline
 * (runAnalysis from SkyIntruders.js) on a folder of real frames, headless.
 *
 * Requires SI_HEADLESS_LIB=1 in the environment so including the entry
 * script does not launch the GUI. Frames are read from <scriptdir>/data.
 *
 * Results:
 *   <system-temp>/si-night-testset.json      (events, trails, fit, report)
 *   <system-temp>/SkyIntruders-night-result.png  (written by runAnalysis)
 *
 * Run:
 *   powershell: $env:SI_HEADLESS_LIB='1'; & <PI-exe> -n --automation-mode
 *               --force-exit -r=<abs>/tests/run-night-testset.js
 */

/* beautify ignore:start */
#engine v8
#include "../pjsr/SkyIntruders.js"
/* beautify ignore:end */

function testScriptDir()
{
   return File.extractDrive( #__FILE__ ) + File.extractDirectory( #__FILE__ );
}

function listFitsFiles( dir )
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

function round2( x ) { return ( typeof x === "number" ) ? Math.round( x*100 )/100 : x; }

function runNightTestset()
{
   var out = { ok: true };
   var tmp = File.systemTempDirectory;
   try
   {
      var files = listFitsFiles( testScriptDir() + "/data" );
      out.fileCount = files.length;

      var params = JSON.parse( JSON.stringify( DEFAULT_PARAMS ) );
      params.lang = "fr";
      params.saveHistory = false;
      params.debugFrameOverlays = true;
      params.matchDiagnostics = true;
      params.tleExtraGroups = [ "classfd", "last-30-days", "cosmos-2251-debris",
                                "iridium-33-debris", "fengyun-1c-debris",
                                "cosmos-1408-debris" ];

      var res = runAnalysis( files, params );

      out.registered = res.registered;
      out.fitInfo = res.fitInfo;
      out.resultImagePath = res.resultImagePath;
      out.events = [];
      for ( var i = 0; i < res.night.events.length; ++i )
      {
         var e = res.night.events[ i ];
         out.events.push( { klass: e.klass, name: e.name || null,
                            noradId: e.noradId || null,
                            time: e.timeUtc ? e.timeUtc.toISOString() : null,
                            shower: e.shower || null,
                            confidence: e.confidence || null,
                            frameId: e.frameId } );
      }
      out.trailsByFrame = {};
      for ( var f = 0; f < res.frames.length; ++f )
      {
         var lst = [];
         var fr = res.frames[ f ];
         for ( var t = 0; t < fr.trails.length; ++t )
         {
            var tr = fr.trails[ t ];
            lst.push( { x1: Math.round( tr.x1 ), y1: Math.round( tr.y1 ),
                        x2: Math.round( tr.x2 ), y2: Math.round( tr.y2 ),
                        lengthPx: Math.round( tr.lengthPx ),
                        angleDeg: round2( tr.angleDeg ),
                        widthPx: round2( tr.widthPx ),
                        fluxAdu: round2( tr.meanFluxAdu ),
                        faint: !!tr.faint,
                        plane: ( tr.planeGroup != null ),
                        edge: tr.spansEdgeToEdge,
                        p1: tr.p1 ? { ra: round2( tr.p1.raDeg ), dec: round2( tr.p1.decDeg ) } : null } );
         }
         out.trailsByFrame[ fr.meta.id ] = lst;
      }
      out.reportText = res.report.markdown;
      out.movers = res.night.movers.length;
   }
   catch ( e )
   {
      out.ok = false;
      out.error = String( e.message || e ) + " @ " + ( e.lineNumber || "?" );
   }
   File.writeTextFile( tmp + "/si-night-testset.json", JSON.stringify( out, null, 2 ) );
}

runNightTestset();
