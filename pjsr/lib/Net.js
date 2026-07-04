/*
 * Net.js — TLE catalog download through PixInsight's NetworkTransfer.
 *
 * Replaces the former Go sidecar's fetch-tle command with the same
 * semantics: disk cache (<cacheDir>/<group>.tle + <group>.meta.json),
 * serve-from-cache under max age, 3 attempts with backoff, payload
 * validated as TLE before it may overwrite a good cache, and stale-cache
 * fallback when the network is unreachable.
 *
 * NetworkTransfer was probed on PixInsight 1.9.4 under #engine v8
 * (tests/probe-networktransfer.js): setURL/download/onDownloadDataAvailable
 * and setConnectionTimeout all work.
 */

var SITleNet = ( function()
{
   var DEFAULT_BASE = "https://celestrak.org/NORAD/elements/gp.php";

   function countTlePairs( text )
   {
      var lines = text.split( "\n" );
      var pairs = 0;
      for ( var i = 0; i + 2 < lines.length; ++i )
         if ( lines[ i + 1 ].substring( 0, 2 ) == "1 " &&
              lines[ i + 2 ].substring( 0, 2 ) == "2 " )
            ++pairs;
      return pairs;
   }

   function pause( ms )
   {
      if ( typeof msleep == "function" )
      {
         msleep( ms );
         return;
      }
      var until = Date.now() + ms;
      while ( Date.now() < until )
         if ( typeof processEvents == "function" )
            processEvents();
   }

   function httpGet( url, timeoutSec )
   {
      var T = new NetworkTransfer;
      var chunks = [];
      T.onDownloadDataAvailable = function( data )
      {
         chunks.push( data );
         return true;
      };
      if ( typeof T.setConnectionTimeout == "function" )
         T.setConnectionTimeout( timeoutSec );
      T.setURL( url );
      var ok = T.download();
      var text = "";
      for ( var i = 0; i < chunks.length; ++i )
         text += chunks[ i ].toString();
      return { ok: ok, code: T.responseCode, text: text,
               error: String( T.errorInformation || "" ) };
   }

   function readMeta( path )
   {
      try
      {
         if ( File.exists( path ) )
            return JSON.parse( File.readTextFile( path ) );
      }
      catch ( e ) {}
      return null;
   }

   /*
    * fetchTle( group, cacheDir, maxAgeHours[, baseUrl] )
    * -> { tlePath, count, fetchedUtc, fromCache, stale?, sourceUrl }
    * Throws when the download fails and no cache (fresh or stale) exists.
    */
   function fetchTle( group, cacheDir, maxAgeHours, baseUrl )
   {
      if ( !group || !group.match( /^[A-Za-z0-9_-]+$/ ) )
         throw new Error( "fetch-tle: invalid group name: " + group );
      var url = ( baseUrl || DEFAULT_BASE ) + "?GROUP=" + group + "&FORMAT=tle";
      var tlePath = cacheDir + "/" + group + ".tle";
      var metaPath = cacheDir + "/" + group + ".meta.json";
      var meta = readMeta( metaPath );

      // Fresh cache wins.
      if ( meta != null && File.exists( tlePath ) )
      {
         var ageHours = ( Date.now() - Date.parse( meta.fetchedUtc ) ) / 3600000;
         if ( isFinite( ageHours ) && ageHours >= 0 && ageHours <= maxAgeHours )
            return { tlePath: tlePath, count: meta.count, fetchedUtc: meta.fetchedUtc,
                     fromCache: true, sourceUrl: meta.sourceUrl || url };
      }

      // Download: 3 attempts, 2 s / 4 s backoff. CelesTrak serves error pages
      // with status 200, so the payload must actually parse as TLE.
      var lastError = "";
      for ( var attempt = 1; attempt <= 3; ++attempt )
      {
         if ( attempt > 1 )
            pause( 1000 * ( 1 << ( attempt - 1 ) ) );
         var r = httpGet( url, 30 );
         if ( !r.ok || ( r.code != 0 && r.code != 200 ) )
         {
            lastError = r.error || ( "HTTP " + r.code );
            continue;
         }
         var count = countTlePairs( r.text );
         if ( count < 1 )
         {
            lastError = "payload is not TLE data (0 valid records)";
            continue;
         }
         if ( !File.directoryExists( cacheDir ) )
            File.createDirectory( cacheDir, true );
         var fetchedUtc = ( new Date ).toISOString();
         File.writeTextFile( tlePath, r.text );
         File.writeTextFile( metaPath, JSON.stringify(
            { fetchedUtc: fetchedUtc, sourceUrl: url, count: count }, null, 2 ) );
         return { tlePath: tlePath, count: count, fetchedUtc: fetchedUtc,
                  fromCache: false, sourceUrl: url };
      }

      // Network dead: an expired cache is better than nothing.
      if ( meta != null && File.exists( tlePath ) )
         return { tlePath: tlePath, count: meta.count, fetchedUtc: meta.fetchedUtc,
                  fromCache: true, stale: true, sourceUrl: meta.sourceUrl || url };

      throw new Error( "fetch-tle: download failed and no cache available: " + lastError );
   }

   return {
      fetchTle: fetchTle,
      countTlePairs: countTlePairs,
      DEFAULT_BASE: DEFAULT_BASE
   };
} )();

// ---------------------------------------------------------------------------

/*
 * SINet — a generic text getter over NetworkTransfer, shared by the Treasure
 * Hunt catalog queries. Same chunk-accumulate pattern as SITleNet's private
 * httpGet, exposed as a public one-shot call. Callers own retry/backoff and
 * payload validation.
 */
var SINet = ( function()
{
   function getText( url, timeoutSec )
   {
      // -> { ok, code, text, error }. code 0 is the NetworkTransfer "no HTTP
      // status" value (e.g. non-HTTP transfer); treat 0 or 200 as success.
      var T = new NetworkTransfer;
      var chunks = [];
      T.onDownloadDataAvailable = function( data )
      {
         chunks.push( data );
         return true;
      };
      if ( typeof T.setConnectionTimeout == "function" )
         T.setConnectionTimeout( ( timeoutSec > 0 ) ? timeoutSec : 30 );
      T.setURL( url );
      var ok = T.download();
      var text = "";
      for ( var i = 0; i < chunks.length; ++i )
         text += chunks[ i ].toString();
      return { ok: ok, code: T.responseCode, text: text,
               error: String( T.errorInformation || "" ) };
   }

   return { getText: getText };
} )();
