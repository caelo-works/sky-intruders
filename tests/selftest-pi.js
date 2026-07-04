/*
 * selftest-pi.js — headless smoke test of the REAL PixInsight v8 runtime.
 *
 * The Node harness (tests/run.sh) covers pure math only. This exercises what
 * Node can't: the #include chain resolving, satellite.js's UMD landing on the
 * v8 global, SGP4 running under PixInsight's engine, and NetworkTransfer in
 * context. It needs no images and no GUI.
 *
 * Run:
 *   <PI-exe> -n --automation-mode --force-exit -r=/abs/path/tests/selftest-pi.js
 * Results (console is not reliably visible) -> <system-temp>/skyintruders-selftest.json
 */

/* beautify ignore:start */
#engine v8
#include "../pjsr/lib/vendor/satellite.js"
#include "../pjsr/lib/Stats.js"
#include "../pjsr/lib/FrameMeta.js"
#include "../pjsr/lib/TrailDetect.js"
#include "../pjsr/lib/Net.js"
#include "../pjsr/lib/SatMatch.js"
#include "../pjsr/lib/Meteors.js"
#include "../pjsr/lib/Report.js"
/* beautify ignore:end */

function selftestDir()
{
   return File.extractDrive( #__FILE__ ) + File.extractDirectory( #__FILE__ );
}

function main()
{
   var out = { probedUtc: ( new Date ).toISOString(), checks: [], ok: true };
   var marker = File.systemTempDirectory + "/skyintruders-selftest.json";

   function check( name, fn )
   {
      try
      {
         var detail = fn();
         out.checks.push( { name: name, ok: true, detail: detail === undefined ? "" : detail } );
      }
      catch ( e )
      {
         out.ok = false;
         out.checks.push( { name: name, ok: false, detail: String( e.message || e ) } );
      }
   }

   // 1) All namespaces exist -> the include chain and IIFEs ran.
   check( "namespaces loaded", function()
   {
      var need = [ "SIStats", "SIFrameMeta", "SITrailDetect", "SITleNet",
                   "SISatMatch", "SIMeteors", "SIReport" ];
      for ( var i = 0; i < need.length; ++i )
         if ( typeof eval( need[ i ] ) != "object" && typeof eval( need[ i ] ) != "function" )
            throw new Error( need[ i ] + " missing" );
      return need.length + " namespaces";
   } );

   // 2) satellite.js UMD landed on the v8 global.
   check( "satellite.js global", function()
   {
      if ( typeof satellite == "undefined" || typeof satellite.twoline2satrec != "function" )
         throw new Error( "satellite global or twoline2satrec missing" );
      return "twoline2satrec present";
   } );

   // 3) Robust stats math sanity (pure, but under the PI engine now).
   check( "SIStats.arrayMAD", function()
   {
      var m = SIStats.arrayMAD( [ 1, 2, 3, 4, 5, 100 ] );
      if ( !( m > 0 ) )
         throw new Error( "MAD not positive: " + m );
      return "MAD=" + m.toFixed( 3 );
   } );

   // 4) The whole match engine, on the committed reference fixture.
   check( "SISatMatch vs fixture", function()
   {
      var dir = selftestDir() + "/fixtures/match";
      var tle = File.readTextFile( dir + "/delta.tle" );
      var req = JSON.parse( File.readTextFile( dir + "/request.json" ) );
      var expected = JSON.parse( File.readTextFile( dir + "/response.json" ) );
      var got = SISatMatch.match( req, tle, expected.tle.source );
      if ( got.error )
         throw new Error( "match returned error: " + got.error );
      var c = got.frames[ 0 ].crossings[ 0 ];
      var ec = expected.frames[ 0 ].crossings[ 0 ];
      if ( c.noradId != ec.noradId )
         throw new Error( "noradId " + c.noradId + " != " + ec.noradId );
      if ( c.matchedTrailIndex !== 0 )
         throw new Error( "trail not matched: " + c.matchedTrailIndex );
      var dRate = Math.abs( c.angularRateDegPerSec - ec.angularRateDegPerSec );
      if ( dRate > 1e-3 )
         throw new Error( "angular rate drift " + dRate );
      return ec.name + " matched, score " + c.matchScore.toFixed( 4 );
   } );

   // 5) NetworkTransfer reachable (non-fatal: network may be down).
   check( "NetworkTransfer live", function()
   {
      var T = new NetworkTransfer;
      var chunks = [];
      T.onDownloadDataAvailable = function( d ) { chunks.push( d ); return true; };
      if ( typeof T.setConnectionTimeout == "function" )
         T.setConnectionTimeout( 20 );
      T.setURL( "https://pixinsight-scripts.caelo.works/update/updates.xri" );
      var ok = T.download();
      if ( !ok )
         return "SKIP (network unreachable: " + String( T.errorInformation ) + ")";
      var n = 0;
      for ( var i = 0; i < chunks.length; ++i )
         n += chunks[ i ].toString().length;
      return "downloaded " + n + " chars, HTTP " + T.responseCode;
   } );

   // 6) Report builder produces markdown + a Reddit title.
   check( "SIReport.build", function()
   {
      var night = { dateLabel: "2026-07-03", frames: 3, cleanFrames: 1,
                    totalExposureSec: 360, target: "NGC 7000",
                    events: [ { timeUtc: new Date( "2026-07-03T02:13:05Z" ),
                                klass: "satellite", name: "STARLINK-4512",
                                elevationDeg: 42, angularRateDegPerSec: 0.31,
                                frameId: "L_0001.fits" } ],
                    movers: [] };
      var r = SIReport.build( night, { nights: [] }, "en" );
      if ( r.markdown.indexOf( "STARLINK-4512" ) < 0 )
         throw new Error( "event missing from report" );
      if ( !r.redditTitle )
         throw new Error( "no reddit title" );
      return "markdown " + r.markdown.length + " chars";
   } );

   File.writeTextFile( marker, JSON.stringify( out, null, 2 ) );
   console.show();
   console.writeln( "Sky Intruders self-test: " + ( out.ok ? "PASS" : "FAIL" ) );
   for ( var i = 0; i < out.checks.length; ++i )
      console.writeln( "  " + ( out.checks[ i ].ok ? "OK  " : "FAIL" ) + " " +
                       out.checks[ i ].name + " — " + out.checks[ i ].detail );
   console.writeln( "Details: " + marker );
}

main();
