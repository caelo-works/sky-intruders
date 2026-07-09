/*
 * run-treasure-testset.js — drive the PRODUCTION Treasure Hunt pipeline
 * (runTreasureHunt from SkyIntruders.js) on a folder of master lights,
 * headless. Expects plate-solved masters in <scriptdir>/masters-solved,
 * produced by tests/solve-masters.js (which must run in the DEFAULT engine —
 * the AdP solver stack does not load under #engine v8, hence two stages).
 *
 * Requires SI_HEADLESS_LIB=1 in the environment so including the entry
 * script does not launch the GUI.
 *
 * Results:
 *   <system-temp>/si-treasure-testset.json          (per-master summary)
 *   <system-temp>/si-treasure-<n>-<object>.html     (illustrated report)
 *   <system-temp>/si-treasure-<n>-<object>-map.png  (annotated field)
 *
 * Run:
 *   powershell: $env:SI_HEADLESS_LIB='1'; & <PI-exe> -n --automation-mode
 *               --force-exit -r=<abs>/tests/run-treasure-testset.js
 */

/* beautify ignore:start */
#engine v8
#include "../pjsr/SkyIntruders.js"
/* beautify ignore:end */

function testScriptDir()
{
   return File.extractDrive( #__FILE__ ) + File.extractDirectory( #__FILE__ );
}

function listMasters( dir )
{
   var out = [];
   var ff = new FileFind;
   if ( ff.begin( dir + "/*.xisf" ) )
      do
      {
         if ( ff.isFile )
            out.push( dir + "/" + ff.name );
      }
      while ( ff.next() );
   out.sort();
   return out;
}

function round2( x ) { return ( typeof x === "number" ) ? Math.round( x*100 )/100 : x; }

function runTreasureTestset()
{
   var out = { ok: true, masters: [] };
   var tmp = File.systemTempDirectory;
   try
   {
      var files = listMasters( testScriptDir() + "/masters-solved" );
      out.fileCount = files.length;

      var params = JSON.parse( JSON.stringify( DEFAULT_PARAMS ) );
      params.lang = "fr";
      params.saveHistory = false;

      for ( var i = 0; i < files.length; ++i )
      {
         var entry = { file: File.extractName( files[ i ] ) };
         out.masters.push( entry );
         var window = null, t0 = Date.now();
         try
         {
            console.noteln( "=== " + files[ i ] );
            var wins = ImageWindow.open( files[ i ] );
            if ( !wins || wins.length < 1 )
               throw new Error( "cannot open" );
            window = wins[ 0 ];

            var meta0 = SIFrameMeta.read( window, files[ i ] );
            entry.object = meta0.keywords[ "OBJECT" ] || null;
            entry.wcsBefore = meta0.wcs.kind;
            if ( !hasUsableWcs( meta0.wcs.kind ) )
               throw new Error( "no astrometric solution — run tests/solve-masters.js first" );

            var res = runTreasureHunt( window, files[ i ], params, null );
            if ( res.needsSolve )
               throw new Error( "runTreasureHunt still needsSolve after solving" );

            entry.counts = res.summary ? res.summary.counts : null;
            entry.captured = res.summary ? res.summary.captured : null;
            entry.total = res.summary ? res.summary.total : null;
            entry.headlines = res.summary ? res.summary.headlines : null;
            entry.queryFailures = res.queryFailures || [];
            entry.top = [];
            var topN = Math.min( res.treasures.length, 12 );
            for ( var t = 0; t < topN; ++t )
            {
               var o = res.treasures[ t ];
               entry.top.push( { name: o.name, type: o.type,
                                 x: Math.round( o.x ), y: Math.round( o.y ),
                                 mag: round2( ( o.magV !== undefined && o.magV !== null ) ? o.magV : o.Rmag ),
                                 z: ( o.z !== undefined ) ? o.z : null,
                                 diamArcmin: round2( o.diamArcmin ),
                                 score: round2( o.score ), snr: ( o.snr !== undefined ) ? o.snr : null,
                                 captured: ( o.captured !== undefined ) ? o.captured : null } );
            }

            var tag = i + "-" + String( entry.object || "field" )
                         .replace( /[^A-Za-z0-9]+/g, "_" ).substring( 0, 24 );
            var htmlPath = tmp + "/si-treasure-" + tag + ".html";
            File.writeTextFile( htmlPath, res.html );
            entry.htmlPath = htmlPath;

            if ( res.mapWindow )
            {
               var mapPath = tmp + "/si-treasure-" + tag + "-map.png";
               try
               {
                  res.mapWindow.saveAs( mapPath, false, false, false, false );
                  entry.mapPngPath = mapPath;
               }
               catch ( e )
               {
                  entry.mapSaveError = String( e.message || e );
               }
               try { res.mapWindow.forceClose(); } catch ( e ) {}
            }
            entry.ms = Date.now() - t0;
         }
         catch ( e )
         {
            entry.error = String( e.message || e );
            console.criticalln( entry.file + ": " + entry.error );
         }
         finally
         {
            if ( window )
               try { window.forceClose(); } catch ( e ) {}
            gc();
         }
      }
   }
   catch ( e )
   {
      out.ok = false;
      out.error = String( e.message || e );
   }
   File.writeTextFile( tmp + "/si-treasure-testset.json", JSON.stringify( out, null, 2 ) );
   console.noteln( "Wrote " + tmp + "/si-treasure-testset.json" );
}

runTreasureTestset();
