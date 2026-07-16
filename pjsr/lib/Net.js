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

   // Ordered TLE sources tried in turn ({group} placeholder). CelesTrak is the
   // canonical, freshest source; the caelo-works mirror (a scheduled GitHub
   // Action snapshot, served from raw.githubusercontent.com) is the fallback
   // for networks that cannot reach celestrak.org.
   var DEFAULT_SOURCES = [
      "https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=tle",
      "https://raw.githubusercontent.com/caelo-works/tle-mirror/main/tle/{group}.tle"
   ];

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

   function buildUrl( template, group )
   {
      // "catalog" is a mirror-side aggregate of the full GP catalog: it is
      // not a gp.php GROUP, and CelesTrak retired its single-file catalog
      // download. Skip CelesTrak-style sources for it; the mirror template
      // resolves {group} to the real tle/catalog.tle snapshot.
      if ( group == "catalog" && template.indexOf( "gp.php" ) >= 0 )
         return null;
      // A "{group}" template is used as-is; a bare base (legacy) gets the
      // CelesTrak query appended.
      if ( template.indexOf( "{group}" ) >= 0 )
         return template.replace( "{group}", group );
      return template + "?GROUP=" + group + "&FORMAT=tle";
   }

   // One pass over all sources with a given timeout: the first that yields a
   // valid TLE payload wins. Returns { url, text, count } or { error }.
   function fetchPass( sources, group, timeoutSec )
   {
      var lastError = "";
      for ( var i = 0; i < sources.length; ++i )
      {
         var url = buildUrl( sources[ i ], group );
         if ( url == null )
            continue;
         var r = httpGet( url, timeoutSec );
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
         return { url: url, text: r.text, count: count };
      }
      return { error: lastError };
   }

   /*
    * fetchTle( group, cacheDir, maxAgeHours[, baseUrl] )
    * -> { tlePath, count, fetchedUtc, fromCache, stale?, sourceUrl }
    * Tries each source in order (an optional baseUrl is tried first), caches
    * the first valid TLE payload, and falls back to a stale cache if every
    * source fails. Throws only when nothing (fresh, downloaded or stale) works.
    */
   function fetchTle( group, cacheDir, maxAgeHours, baseUrl )
   {
      if ( !group || !group.match( /^[A-Za-z0-9_-]+$/ ) )
         throw new Error( "fetch-tle: invalid group name: " + group );

      var tlePath = cacheDir + "/" + group + ".tle";
      var metaPath = cacheDir + "/" + group + ".meta.json";
      var meta = readMeta( metaPath );

      // Fresh cache wins.
      if ( meta != null && File.exists( tlePath ) )
      {
         var ageHours = ( Date.now() - Date.parse( meta.fetchedUtc ) ) / 3600000;
         if ( isFinite( ageHours ) && ageHours >= 0 && ageHours <= maxAgeHours )
            return { tlePath: tlePath, count: meta.count, fetchedUtc: meta.fetchedUtc,
                     fromCache: true, sourceUrl: meta.sourceUrl };
      }

      var sources = baseUrl ? [ baseUrl ].concat( DEFAULT_SOURCES ) : DEFAULT_SOURCES;

      // Pass 1 is quick (10 s/source) so a blocked host falls through fast to
      // the mirror; pass 2 retries with a longer timeout only if all failed.
      var got = fetchPass( sources, group, 10 );
      if ( got.error )
      {
         pause( 1500 );
         got = fetchPass( sources, group, 25 );
      }
      if ( !got.error )
      {
         if ( !File.directoryExists( cacheDir ) )
            File.createDirectory( cacheDir, true );
         var fetchedUtc = ( new Date ).toISOString();
         File.writeTextFile( tlePath, got.text );
         File.writeTextFile( metaPath, JSON.stringify(
            { fetchedUtc: fetchedUtc, sourceUrl: got.url, count: got.count }, null, 2 ) );
         return { tlePath: tlePath, count: got.count, fetchedUtc: fetchedUtc,
                  fromCache: false, sourceUrl: got.url };
      }
      var lastError = got.error;

      // Every source failed: an expired cache is better than nothing.
      if ( meta != null && File.exists( tlePath ) )
         return { tlePath: tlePath, count: meta.count, fetchedUtc: meta.fetchedUtc,
                  fromCache: true, stale: true, sourceUrl: meta.sourceUrl };

      throw new Error( "fetch-tle: no source reachable and no cache available: " + lastError );
   }

   // SATCAT sources — the catalog CSV whose OWNER field maps every NORAD id
   // to its operating country/organization.
   var SATCAT_SOURCES = [
      "https://celestrak.org/pub/satcat.csv",
      "https://raw.githubusercontent.com/caelo-works/tle-mirror/main/tle/satcat.csv"
   ];

   /*
    * fetchSatcat( cacheDir, maxAgeHours )
    * -> { path, fromCache, stale? } or null when unreachable and uncached.
    * Same cache/two-pass/stale discipline as fetchTle; never throws (country
    * chips are decoration, a failure must not abort an analysis).
    */
   function fetchSatcat( cacheDir, maxAgeHours )
   {
      try
      {
         var path = cacheDir + "/satcat.csv";
         var metaPath = cacheDir + "/satcat.meta.json";
         var meta = readMeta( metaPath );
         if ( meta != null && File.exists( path ) )
         {
            var ageHours = ( Date.now() - Date.parse( meta.fetchedUtc ) ) / 3600000;
            if ( isFinite( ageHours ) && ageHours >= 0 && ageHours <= maxAgeHours )
               return { path: path, fromCache: true };
         }
         for ( var pass = 0; pass < 2; ++pass )
         {
            for ( var i = 0; i < SATCAT_SOURCES.length; ++i )
            {
               var r = httpGet( SATCAT_SOURCES[ i ], pass == 0 ? 15 : 30 );
               if ( r.ok && ( r.code == 0 || r.code == 200 ) &&
                    r.text.indexOf( "NORAD_CAT_ID" ) >= 0 )
               {
                  if ( !File.directoryExists( cacheDir ) )
                     File.createDirectory( cacheDir, true );
                  File.writeTextFile( path, r.text );
                  File.writeTextFile( metaPath, JSON.stringify(
                     { fetchedUtc: ( new Date ).toISOString(),
                       sourceUrl: SATCAT_SOURCES[ i ] }, null, 2 ) );
                  return { path: path, fromCache: false };
               }
            }
            if ( pass == 0 )
               pause( 1500 );
         }
         if ( meta != null && File.exists( path ) )
            return { path: path, fromCache: true, stale: true };
      }
      catch ( e ) {}
      return null;
   }

   function parseSatcatInfo( csvText )
   {
      // NORAD id -> { owner, ops, type } from the SATCAT CSV. Pure string
      // work: locate the columns from the header, split the rows (the fields
      // used never contain quoted commas). ops is the OPS_STATUS_CODE: '+',
      // 'P', 'B', 'S', 'X' are flavors of alive; '-' is out of service; '?'
      // or empty is unknown. type is the OBJECT_TYPE: 'PAY', 'R/B', 'DEB'
      // or 'UNK' — rocket bodies and debris carry no ops status at all.
      var out = {};
      var lines = String( csvText ).split( "\n" );
      if ( lines.length < 2 )
         return out;
      var header = lines[ 0 ].replace( /\r$/, "" ).split( "," );
      var idCol = -1, ownerCol = -1, opsCol = -1, typeCol = -1;
      for ( var i = 0; i < header.length; ++i )
      {
         if ( header[ i ] == "NORAD_CAT_ID" ) idCol = i;
         if ( header[ i ] == "OWNER" ) ownerCol = i;
         if ( header[ i ] == "OPS_STATUS_CODE" ) opsCol = i;
         if ( header[ i ] == "OBJECT_TYPE" ) typeCol = i;
      }
      if ( idCol < 0 || ownerCol < 0 )
         return out;
      for ( var l = 1; l < lines.length; ++l )
      {
         var f = lines[ l ].split( "," );
         if ( f.length <= Math.max( idCol, ownerCol ) )
            continue;
         var id = parseInt( f[ idCol ], 10 );
         if ( isFinite( id ) )
            out[ id ] = { owner: ( f[ ownerCol ] || "" ).replace( /\r$/, "" ).trim(),
                          ops: ( opsCol >= 0 && f[ opsCol ] !== undefined )
                                  ? f[ opsCol ].replace( /\r$/, "" ).trim() : "",
                          type: ( typeCol >= 0 && f[ typeCol ] !== undefined )
                                  ? f[ typeCol ].replace( /\r$/, "" ).trim() : "" };
      }
      return out;
   }

   function parseSatcatOwners( csvText )
   {
      var info = parseSatcatInfo( csvText );
      var out = {};
      for ( var id in info )
         out[ id ] = info[ id ].owner;
      return out;
   }

   return {
      fetchTle: fetchTle,
      fetchSatcat: fetchSatcat,
      parseSatcatInfo: parseSatcatInfo,
      parseSatcatOwners: parseSatcatOwners,
      countTlePairs: countTlePairs,
      DEFAULT_BASE: DEFAULT_BASE,
      DEFAULT_SOURCES: DEFAULT_SOURCES
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
