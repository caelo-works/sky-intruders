// SPDX-License-Identifier: GPL-3.0-only
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
 *
 * Integrity: HTTPS only (SINet.getText refuses anything else), the TLE
 * modulo-10 checksum on every element set from every source, and for the
 * CaeloWorks mirror the SHA-256 of each downloaded file checked against the
 * mirror's tle/SHA256SUMS manifest (native CryptographicHash over the raw
 * downloaded bytes).
 */

var SITleNet = ( function()
{
   var DEFAULT_BASE = "https://celestrak.org/NORAD/elements/gp.php";

   // Ordered TLE sources tried in turn ({group} placeholder). CelesTrak is the
   // canonical, freshest source; the caelo-works mirror (a scheduled GitHub
   // Action snapshot, served from raw.githubusercontent.com) is the fallback
   // for networks that cannot reach celestrak.org.
   var MIRROR_BASE = "https://raw.githubusercontent.com/caelo-works/tle-mirror/main/tle/";
   var MIRROR_MANIFEST_URL = MIRROR_BASE + "SHA256SUMS";

   var DEFAULT_SOURCES = [
      "https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=tle",
      MIRROR_BASE + "{group}.tle"
   ];

   // --- CaeloWorks mirror SHA-256 manifest ----------------------------------
   // tle/SHA256SUMS is standard sha256sum output ("<64 hex>  <name>" per
   // line, names relative to tle/), regenerated at every mirror snapshot.

   // -> { name: lowercase hex } (malformed lines ignored).
   function parseSha256Sums( text )
   {
      var out = {};
      var lines = String( text == null ? "" : text ).split( "\n" );
      for ( var i = 0; i < lines.length; ++i )
      {
         var m = lines[ i ].replace( /\r$/, "" ).match( /^([0-9a-fA-F]{64}) [ *](\S.*)$/ );
         if ( m )
            out[ m[ 2 ].trim() ] = m[ 1 ].toLowerCase();
      }
      return out;
   }

   // The manifest is fetched at most once per run (memoized here, reset by
   // resetMirrorManifest at the start of a run). undefined: not fetched yet;
   // null: unavailable, the mirror is not used for the rest of the run.
   var manifestMemo = undefined;

   function resetMirrorManifest()
   {
      manifestMemo = undefined;
   }

   function fetchManifestMap()
   {
      var r = SINet.getText( MIRROR_MANIFEST_URL, 20 );
      if ( !r.ok || ( r.code != 0 && r.code != 200 ) )
         return null;
      var map = parseSha256Sums( r.text );
      for ( var k in map )
         return map;
      return null; // no entry at all: not a manifest
   }

   function loadMirrorManifest()
   {
      if ( manifestMemo === undefined )
      {
         manifestMemo = fetchManifestMap();
         if ( manifestMemo == null )
            console.warningln( "mirror manifest unavailable \u2014 mirror not used" );
      }
      return manifestMemo;
   }

   // File name relative to tle/ of a CaeloWorks mirror URL, or null.
   function mirrorFileName( url )
   {
      url = String( url );
      return ( url.indexOf( MIRROR_BASE ) == 0 && url.length > MIRROR_BASE.length )
             ? url.substring( MIRROR_BASE.length ) : null;
   }

   function httpOk( r )
   {
      return r.ok && ( r.code == 0 || r.code == 200 );
   }

   /*
    * getVerified( url, timeoutSec ) -> SINet.getText result.
    * Any URL outside the CaeloWorks mirror is fetched as is. A mirror file
    * must hash to its manifest entry; on a mismatch or a missing entry the
    * manifest and the file are fetched once more (the CDN may briefly serve
    * files from different commits), then the file is refused.
    */
   function getVerified( url, timeoutSec )
   {
      var name = mirrorFileName( url );
      if ( name == null )
         return SINet.getText( url, timeoutSec );
      var manifest = loadMirrorManifest();
      if ( manifest == null )
         return { ok: false, code: 0, text: "", error: "mirror manifest unavailable" };
      var r = SINet.getText( url, timeoutSec, { sha256: true } );
      if ( !httpOk( r ) )
         return r;
      if ( manifest[ name ] !== undefined && r.sha256 === manifest[ name ] )
         return r;
      var fresh = fetchManifestMap();
      if ( fresh != null )
      {
         manifestMemo = fresh;
         r = SINet.getText( url, timeoutSec, { sha256: true } );
         if ( !httpOk( r ) )
            return r;
         if ( fresh[ name ] !== undefined && r.sha256 === fresh[ name ] )
            return r;
      }
      console.warningln( "mirror file " + name + " failed SHA-256 verification \u2014 not used" );
      return { ok: false, code: 0, text: "",
               error: "mirror file " + name + " failed SHA-256 verification" };
   }

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

   // Standard TLE modulo-10 checksum of one element line: the digits of
   // columns 1-68 summed, each minus sign counting 1, everything else 0;
   // the sum mod 10 must equal the digit in column 69.
   function tleLineChecksumOk( line )
   {
      var l = String( line == null ? "" : line ).replace( /\r$/, "" );
      if ( l.length < 69 )
         return false;
      var want = l.charCodeAt( 68 ) - 48;
      if ( want < 0 || want > 9 )
         return false;
      var sum = 0;
      for ( var i = 0; i < 68; ++i )
      {
         var c = l.charCodeAt( i );
         if ( c >= 48 && c <= 57 )
            sum += c - 48;
         else if ( c == 45 ) // '-'
            sum += 1;
      }
      return ( sum % 10 ) == want;
   }

   // Drop every element set (name line + line 1 + line 2) whose line 1 or
   // line 2 fails the checksum. Lines outside a 3-line set pass through.
   // -> { text, kept, dropped } (text with LF line ends).
   function filterTleByChecksum( text )
   {
      var lines = String( text ).split( "\n" );
      var out = [];
      var kept = 0, dropped = 0;
      for ( var i = 0; i < lines.length; )
      {
         var l0 = lines[ i ].replace( /\r$/, "" );
         if ( i + 2 < lines.length &&
              lines[ i + 1 ].substring( 0, 2 ) == "1 " &&
              lines[ i + 2 ].substring( 0, 2 ) == "2 " )
         {
            var l1 = lines[ i + 1 ].replace( /\r$/, "" );
            var l2 = lines[ i + 2 ].replace( /\r$/, "" );
            if ( tleLineChecksumOk( l1 ) && tleLineChecksumOk( l2 ) )
            {
               out.push( l0, l1, l2 );
               ++kept;
            }
            else
               ++dropped;
            i += 3;
         }
         else
         {
            out.push( l0 );
            ++i;
         }
      }
      return { text: out.join( "\n" ), kept: kept, dropped: dropped };
   }

   // Above this fraction of failing element sets the whole payload is
   // treated as corrupt rather than trimmed.
   var TLE_CHECKSUM_MAX_BAD_FRACTION = 0.05;

   // Checksum gate of a downloaded TLE payload. -> { text, count } with the
   // bad sets dropped, or { error } when the payload as a whole is rejected.
   function screenTlePayload( group, text )
   {
      var f = filterTleByChecksum( text );
      var total = f.kept + f.dropped;
      if ( f.dropped > 0 && f.dropped > TLE_CHECKSUM_MAX_BAD_FRACTION*total )
      {
         var why = "payload rejected as corrupt: " + f.dropped + " of " + total +
                   " element sets fail the TLE checksum";
         console.warningln( group + ": " + why );
         return { error: why };
      }
      if ( f.kept < 1 )
         return { error: "payload is not TLE data (0 valid records)" };
      if ( f.dropped > 0 )
         console.warningln( group + ": " + f.dropped + " element set(s) dropped (bad TLE checksum)" );
      return { text: f.text, count: f.kept };
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
         var r = getVerified( url, timeoutSec );
         if ( !r.ok || ( r.code != 0 && r.code != 200 ) )
         {
            lastError = r.error || ( "HTTP " + r.code );
            continue;
         }
         var screened = screenTlePayload( group, r.text );
         if ( screened.error )
         {
            lastError = screened.error;
            continue;
         }
         return { url: url, text: screened.text, count: screened.count };
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

      if ( baseUrl && !SINet.isHttpsUrl( baseUrl ) )
      {
         console.warningln( "custom mirror URL ignored: not https://" );
         baseUrl = null;
      }
      var sources = baseUrl ? [ baseUrl ].concat( DEFAULT_SOURCES ) : DEFAULT_SOURCES;

      // Pass 1 is quick (10 s/source) so a blocked host falls through fast to
      // the mirror; pass 2 retries with a longer timeout only if all failed.
      var got = fetchPass( sources, group, 10 );
      if ( got.error )
      {
         SINet.pause( 1500 );
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
      MIRROR_BASE + "satcat.csv"
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
               var r = getVerified( SATCAT_SOURCES[ i ], pass == 0 ? 15 : 30 );
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
               SINet.pause( 1500 );
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

   // Dedup a concatenated TLE text by NORAD id — first occurrence wins, so
   // list the primary group first. Returns { text, count }. Pure (parses
   // through SISatMatch.parseTles, resolved at call time).
   function mergeTleTexts( text )
   {
      var parsed = SISatMatch.parseTles( text );
      var seenIds = {};
      var rebuilt = [];
      for ( var pt = 0; pt < parsed.length; ++pt )
         if ( !seenIds[ parsed[ pt ].noradId ] )
         {
            seenIds[ parsed[ pt ].noradId ] = true;
            rebuilt.push( parsed[ pt ].name + "\n" + parsed[ pt ].line1 + "\n" + parsed[ pt ].line2 );
         }
      return { text: rebuilt.join( "\n" ), count: rebuilt.length };
   }

   // The catalog a run matches against: the primary group, then every extra
   // group appended (a failing extra is reported and skipped), then — only
   // when extras were requested — one dedup by NORAD id, with info.count
   // updated to the merged size. Console lines are the run log the user
   // reads. Returns { info, text }; throws when the primary fetch fails.
   // onInfo( info ), when given, is called as soon as the primary fetch
   // has succeeded, so a caller keeps the catalog descriptor even when a
   // later step throws.
   function fetchMergedTleText( group, extraGroups, cacheDir, maxAgeHours, baseUrl, onInfo )
   {
      // A new run: the mirror manifest is fetched again (once) if needed.
      resetMirrorManifest();
      var info = fetchTle( group, cacheDir, maxAgeHours, baseUrl );
      if ( onInfo )
         onInfo( info );
      console.writeln( format( "   %d satellites, %s%s", info.count,
                               info.fromCache ? "from cache" : "fresh download",
                               info.stale ? " (STALE \u2014 network unreachable)" : "" ) );
      var text = File.readTextFile( info.tlePath );
      if ( extraGroups && extraGroups.length > 0 )
      {
         for ( var xg = 0; xg < extraGroups.length; ++xg )
            try
            {
               var ext = fetchTle( extraGroups[ xg ], cacheDir, maxAgeHours, baseUrl );
               text += "\n" + File.readTextFile( ext.tlePath );
               console.writeln( format( "   + %s: %d satellites", extraGroups[ xg ], ext.count ) );
            }
            catch ( eg )
            {
               console.warningln( "   + " + extraGroups[ xg ] + ": " + eg.message );
            }
         var merged = mergeTleTexts( text );
         text = merged.text;
         info.count = merged.count;
         console.writeln( format( "   = %d satellites after merge/dedup", merged.count ) );
      }
      return { info: info, text: text };
   }

   return {
      fetchTle: fetchTle,
      fetchMergedTleText: fetchMergedTleText,
      mergeTleTexts: mergeTleTexts,
      fetchSatcat: fetchSatcat,
      parseSatcatInfo: parseSatcatInfo,
      parseSatcatOwners: parseSatcatOwners,
      countTlePairs: countTlePairs,
      tleLineChecksumOk: tleLineChecksumOk,
      filterTleByChecksum: filterTleByChecksum,
      TLE_CHECKSUM_MAX_BAD_FRACTION: TLE_CHECKSUM_MAX_BAD_FRACTION,
      buildUrl: buildUrl,
      parseSha256Sums: parseSha256Sums,
      getVerified: getVerified,
      resetMirrorManifest: resetMirrorManifest,
      MIRROR_MANIFEST_URL: MIRROR_MANIFEST_URL,
      DEFAULT_BASE: DEFAULT_BASE,
      DEFAULT_SOURCES: DEFAULT_SOURCES
   };
} )();

// ---------------------------------------------------------------------------

/*
 * SINet — the one HTTP text getter over NetworkTransfer (TLE/SATCAT fetches
 * above, Treasure Hunt catalog queries) plus the GUI-friendly pause the
 * retry loops sleep with. Callers own retry/backoff and payload validation.
 * Defined after SITleNet in this file; SITleNet only calls it at run time.
 */
var SINet = ( function()
{
   // Every network access of the script goes over TLS: a URL that does not
   // start with https:// (case-insensitive) is refused before any transfer.
   function isHttpsUrl( url )
   {
      return typeof url == "string" && url.substring( 0, 8 ).toLowerCase() === "https://";
   }

   // A native SHA-256 accumulator (PJSR CryptographicHash, probed on
   // PixInsight 1.9.x under the v8 engine), or null when unavailable. The
   // CryptographicHash_* header constants are not defined at run time; the
   // static CryptographicHash.SHA256 is.
   function newSha256()
   {
      if ( typeof CryptographicHash != "function" )
         return null;
      var alg = ( CryptographicHash.SHA256 !== undefined ) ? CryptographicHash.SHA256 : 256;
      var h = new CryptographicHash( alg );
      h.initialize();
      return h;
   }

   function getText( url, timeoutSec, opts )
   {
      // -> { ok, code, text, error[, sha256] }. code 0 is the NetworkTransfer
      // "no HTTP status" value (e.g. non-HTTP transfer); treat 0 or 200 as
      // success. opts.sha256: also hash the raw downloaded bytes (lowercase
      // hex, null when hashing is unavailable) — the bytes as received, not
      // the decoded text.
      if ( !isHttpsUrl( url ) )
         return { ok: false, code: 0, text: "", error: "refused: not an https:// URL" };
      var hasher = ( opts && opts.sha256 ) ? newSha256() : null;
      var T = new NetworkTransfer;
      var chunks = [];
      T.onDownloadDataAvailable = function( data )
      {
         chunks.push( data );
         if ( hasher != null )
            hasher.update( data );
         return true;
      };
      if ( typeof T.setConnectionTimeout == "function" )
         T.setConnectionTimeout( ( timeoutSec > 0 ) ? timeoutSec : 30 );
      T.setURL( url );
      var ok = T.download();
      var text = "";
      for ( var i = 0; i < chunks.length; ++i )
         text += chunks[ i ].toString();
      var out = { ok: ok, code: T.responseCode, text: text,
                  error: String( T.errorInformation || "" ) };
      if ( opts && opts.sha256 )
         out.sha256 = ( hasher != null ) ? String( hasher.finalize().toHex() ).toLowerCase() : null;
      return out;
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

   return { getText: getText, isHttpsUrl: isHttpsUrl, pause: pause };
} )();
