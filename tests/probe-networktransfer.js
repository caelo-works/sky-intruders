/*
 * probe-networktransfer.js — does NetworkTransfer work under #engine v8?
 *
 * Decides whether Sky Intruders can go 100% PJSR (drop the Go sidecar) by
 * probing, not assuming: inventories the NetworkTransfer API surface, then
 * attempts a real HTTPS GET against CelesTrak (GROUP=stations, a few KB)
 * and validates the payload parses as TLE.
 *
 * Run it in the GUI (Script > Execute Script File) or headless:
 *   <PI-exe> -n --automation-mode --force-exit -r=/abs/path/tests/probe-networktransfer.js
 *
 * Results go to <system-temp>/skyintruders-nt-probe.json (console output is
 * not reliably visible from outside — read the marker file).
 */

/* beautify ignore:start */
#engine v8
/* beautify ignore:end */

function main()
{
   var result = {
      piVersion: CoreApplication.versionMajor + "." +
                 CoreApplication.versionMinor + "." +
                 CoreApplication.versionRelease,
      platform: CoreApplication.platform,
      probedUtc: ( new Date ).toISOString(),
      networkTransferType: typeof NetworkTransfer,
      api: {},
      download: { attempted: false }
   };

   var marker = File.systemTempDirectory + "/skyintruders-nt-probe.json";

   try
   {
      if ( typeof NetworkTransfer != "function" )
         throw new Error( "NetworkTransfer is not a constructor under v8" );

      var T = new NetworkTransfer;

      // API surface inventory — candidate members from the 1.8/1.9 docs.
      var members = [ "setURL", "setSSL", "setConnectionTimeout", "setProxyURL",
                      "setCustomHTTPHeaders", "download", "upload", "post",
                      "closeConnection", "abort",
                      "onDownloadDataAvailable", "onUploadDataRequested",
                      "onTransferProgress",
                      "responseCode", "bytesTransferred", "totalSpeed",
                      "errorInformation", "wasAborted", "ok" ];
      for ( var i = 0; i < members.length; ++i )
         result.api[ members[ i ] ] = typeof T[ members[ i ] ];

      // Real HTTPS GET — small catalog group (a few KB).
      var url = "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle";
      result.download.attempted = true;
      result.download.url = url;

      var chunks = [];
      T.onDownloadDataAvailable = function( data )
      {
         chunks.push( data );
         return true; // keep going
      };
      if ( typeof T.setConnectionTimeout == "function" )
         T.setConnectionTimeout( 30 );
      T.setURL( url );

      var t0 = Date.now();
      var ok = T.download();
      result.download.elapsedMs = Date.now() - t0;
      result.download.returned = ok;
      result.download.responseCode = T.responseCode;
      result.download.bytesTransferred = T.bytesTransferred;
      result.download.errorInformation = String( T.errorInformation || "" );
      result.download.chunkCount = chunks.length;

      // Reassemble and validate: TLE line 1 starts with "1 ", line 2 "2 ".
      var text = "";
      for ( var c = 0; c < chunks.length; ++c )
         text += chunks[ c ].toString();
      result.download.totalChars = text.length;
      result.download.head = text.substring( 0, 200 );

      var lines = text.split( "\n" );
      var pairs = 0;
      for ( var l = 0; l + 2 < lines.length; ++l )
         if ( lines[ l + 1 ].substring( 0, 2 ) == "1 " &&
              lines[ l + 2 ].substring( 0, 2 ) == "2 " )
            ++pairs;
      result.download.tlePairs = pairs;

      result.verdict = ( ok && pairs > 0 ) ? "GREEN" :
                       ( ok ? "YELLOW (downloaded but not TLE)" : "RED (download failed)" );
   }
   catch ( e )
   {
      result.error = e.message;
      result.verdict = "RED (exception)";
   }

   File.writeTextFile( marker, JSON.stringify( result, null, 2 ) );
   console.show();
   console.writeln( "NetworkTransfer probe: " + result.verdict );
   console.writeln( "Details: " + marker );
}

main();
