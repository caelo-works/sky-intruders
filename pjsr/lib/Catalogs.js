/*
 * Catalogs.js — SICatalogs: cone-search URL builders and response parsers
 * for the Treasure Hunt deep catalogs, plus a PixInsight query layer over
 * SINet with a per-field disk cache.
 *
 * PURE (Node-testable): vizierUrl, skybotUrl, parseVizierTsv, parseSkybot.
 * PI-only: queryGalaxies/queryQuasars/queryPne/queryAsteroids (SINet + File).
 *
 * Verified sources (see docs/TREASURE-HUNT.md):
 *   Galaxies  VII/237  (HyperLEDA)  cols PGC, logD25
 *   Quasars   VII/294  (Milliquas)  cols Name, z, Rmag
 *   PNe       V/127A/mash1 (MASH-I) cols PNG, Name, MajDiam, MinDiam
 *     V/84 (Acker) has no VizieR-cone-searchable position index and returns
 *     empty; V/127A/mash1 returns rich results along the galactic plane and
 *     carries H-alpha major/minor diameters (arcsec) for the size hook.
 *   Asteroids/comets  SkyBoT (IMCCE) at the capture epoch.
 */

var SICatalogs = ( function()
{
   var VIZIER_BASE = "https://vizier.cds.unistra.fr/viz-bin/asu-tsv";
   var SKYBOT_BASE = "https://ssp.imcce.fr/webservices/skybot/api/conesearch.php";

   var SOURCE = {
      galaxy: { source: "VII/237", cols: [ "PGC", "logD25" ] },
      quasar: { source: "VII/294", cols: [ "Name", "z", "Rmag" ] },
      pne:    { source: "V/127A/mash1", cols: [ "PNG", "Name", "MajDiam", "MinDiam" ] },
      // Henry Draper: the "principal stars" layer of the chart. Ptm is the
      // photovisual magnitude (~V), good enough to rank field stars.
      hdstar: { source: "III/135A/catalog", cols: [ "HD", "Ptm", "SpType" ] }
   };

   // ------------------------------------------------------------------------
   // Pure helpers

   function trimStr( s )
   {
      return ( s === null || s === undefined ) ? "" : String( s ).replace( /^\s+|\s+$/g, "" );
   }

   function toNumber( s )
   {
      var str = trimStr( s );
      if ( str.length === 0 )
         return null;
      var f = Number( str );
      return isFinite( f ) ? f : null;
   }

   function parseSexToValue( s )
   {
      // "13 26 27.7865", "-00 25 49", "+47.19" -> value in the leading
      // field's unit, sign honored. Returns null when unparseable.
      var str = trimStr( s );
      if ( str.length === 0 )
         return null;
      var neg = false;
      var c0 = str.charAt( 0 );
      if ( c0 === '+' || c0 === '-' )
      {
         neg = ( c0 === '-' );
         str = trimStr( str.substring( 1 ) );
      }
      var parts = str.split( /[\s:]+/ );
      if ( parts.length < 1 || parts.length > 3 )
         return null;
      var value = 0, scale = 1;
      for ( var i = 0; i < parts.length; ++i )
      {
         if ( parts[ i ].length === 0 )
            return null;
         var f = Number( parts[ i ] );
         if ( !isFinite( f ) || f < 0 )
            return null;
         value += f*scale;
         scale /= 60;
      }
      return neg ? -value : value;
   }

   function normRa( ra )
   {
      return ra - 360*Math.floor( ra/360 );
   }

   // ------------------------------------------------------------------------
   // URL builders (pure)

   function vizierUrl( source, raDeg, decDeg, radiusDeg, cols, max )
   {
      // VizieR asu-tsv cone search. The `+` between RA and Dec decodes to a
      // space server-side, so a negative Dec keeps its own leading minus.
      var colList = ( cols instanceof Array ) ? cols.join( "," ) : String( cols );
      var ra = normRa( Number( raDeg ) );
      var c = ra + "+" + Number( decDeg );
      return VIZIER_BASE +
         "?-source=" + source +
         "&-c=" + c +
         "&-c.rd=" + Number( radiusDeg ) +
         "&-out.add=_RAJ,_DEJ" +
         "&-out=" + colList +
         "&-out.max=" + ( ( max > 0 ) ? Math.floor( max ) : 1000 );
   }

   function skybotUrl( raDeg, decDeg, radiusDeg, epoch )
   {
      // SkyBoT cone search, text/object output. Epoch is a JD number or an
      // ISO datetime; it is percent-encoded to survive the ':' and 'T'.
      var ra = normRa( Number( raDeg ) );
      return SKYBOT_BASE +
         "?-ra=" + ra +
         "&-dec=" + Number( decDeg ) +
         "&-rd=" + Number( radiusDeg ) +
         "&-ep=" + encodeURIComponent( String( epoch ) ) +
         "&-mime=text&-output=object";
   }

   // ------------------------------------------------------------------------
   // Parsers (pure)

   function parseVizierTsv( text )
   {
      // Returns [ { raDeg, decDeg, <col>: trimmedValue, ... } ]. The header,
      // units and dashes rows and any blank/comment lines are skipped: a row
      // only counts as data when its _RAJ2000 field is a finite number.
      var out = [];
      if ( text === null || text === undefined )
         return out;
      var lines = String( text ).split( /\r?\n/ );
      var header = null, raIdx = -1, decIdx = -1;
      for ( var i = 0; i < lines.length; ++i )
      {
         var line = lines[ i ];
         if ( line.length === 0 || line.charAt( 0 ) === '#' )
            continue;
         if ( trimStr( line ).length === 0 )
            continue;
         var fields = line.split( "\t" );
         if ( header === null )
         {
            // First non-comment line is the column-name header.
            header = [];
            for ( var h = 0; h < fields.length; ++h )
               header.push( trimStr( fields[ h ] ) );
            raIdx = indexOfCol( header, "_RAJ2000", "_RAJ" );
            decIdx = indexOfCol( header, "_DEJ2000", "_DEJ" );
            if ( raIdx < 0 || decIdx < 0 )
               return out;
            continue;
         }
         var raDeg = toNumber( fields[ raIdx ] );
         var decDeg = toNumber( fields[ decIdx ] );
         if ( raDeg === null || decDeg === null )
            continue; // units row, dashes row, or malformed
         var row = { raDeg: normRa( raDeg ), decDeg: decDeg };
         for ( var c = 0; c < header.length; ++c )
         {
            if ( c === raIdx || c === decIdx )
               continue;
            var name = header[ c ];
            if ( name.length === 0 )
               continue;
            row[ name ] = ( c < fields.length ) ? trimStr( fields[ c ] ) : "";
         }
         out.push( row );
      }
      return out;
   }

   function indexOfCol( header, exact, prefix )
   {
      for ( var i = 0; i < header.length; ++i )
         if ( header[ i ] === exact )
            return i;
      for ( var j = 0; j < header.length; ++j )
         if ( header[ j ].indexOf( prefix ) === 0 )
            return j;
      return -1;
   }

   function parseSkybot( text )
   {
      // Returns [ { name, raDeg, decDeg, klass, magV, num, errArcsec,
      // distArcsec } ]. RA is sexagesimal HOURS -> degrees. An error body or
      // one without the '#'-comment header yields [] (never throws).
      var out = [];
      if ( text === null || text === undefined )
         return out;
      var lines = String( text ).split( /\r?\n/ );
      var sawComment = false;
      for ( var i = 0; i < lines.length; ++i )
         if ( lines[ i ].charAt( 0 ) === '#' )
         {
            sawComment = true;
            break;
         }
      if ( !sawComment )
         return out; // no header -> treat as no-data / error response
      for ( var k = 0; k < lines.length; ++k )
      {
         var line = lines[ k ];
         if ( line.length === 0 || line.charAt( 0 ) === '#' )
            continue;
         if ( trimStr( line ).length === 0 )
            continue;
         if ( line.indexOf( "|" ) < 0 )
            continue;
         var f = line.split( "|" );
         for ( var t = 0; t < f.length; ++t )
            f[ t ] = trimStr( f[ t ] );
         if ( f.length < 5 )
            continue;
         var raHours = parseSexToValue( f[ 2 ] );
         var decDeg = parseSexToValue( f[ 3 ] );
         if ( raHours === null || decDeg === null )
            continue;
         var name = ( f[ 1 ].length > 0 ) ? f[ 1 ] : f[ 0 ];
         out.push( {
            num: f[ 0 ],
            name: name,
            raDeg: normRa( raHours*15 ),
            decDeg: decDeg,
            klass: ( f.length > 4 ) ? f[ 4 ] : "",
            magV: ( f.length > 5 ) ? toNumber( f[ 5 ] ) : null,
            errArcsec: ( f.length > 6 ) ? toNumber( f[ 6 ] ) : null,
            distArcsec: ( f.length > 7 ) ? toNumber( f[ 7 ] ) : null
         } );
      }
      return out;
   }

   // ------------------------------------------------------------------------
   // Local context catalogs (PixInsight ships NGC-IC.csv and NamedStars.csv
   // with the AdP scripts; both use RA in HOURS). These give the star chart
   // its context labels — bright named stars and deep-sky neighbors — with
   // no network at all.

   function splitCsvLine( line )
   {
      // The AdP CSVs are plain comma-separated without quoting.
      return String( line ).split( "," );
   }

   function adpAlphaToDeg( raH )
   {
      // NGC-IC.csv mixes units in its alpha column: the machine-imported
      // galaxy rows store HOURS, the hand-added showpieces (Veil, NA
      // nebula...) store DEGREES. Anything above 24 can only be degrees.
      return normRa( ( raH > 24 ) ? raH : raH*15 );
   }

   function parseNgcIcCsv( text )
   {
      // id,alpha,delta,magnitude,diameter,axisRatio,posAngle,Common name,...
      // Returns [ { type:"dso", name, commonName, raDeg, decDeg, mag,
      // diamArcmin, messier } ].
      var out = [];
      if ( text === null || text === undefined )
         return out;
      var lines = String( text ).split( /\r?\n/ );
      for ( var i = 1; i < lines.length; ++i ) // skip header
      {
         var f = splitCsvLine( lines[ i ] );
         if ( f.length < 5 )
            continue;
         var raH = toNumber( f[ 1 ] ), dec = toNumber( f[ 2 ] );
         if ( raH === null || dec === null )
            continue;
         out.push( {
            type: "dso",
            name: trimStr( f[ 0 ] ),
            raDeg: adpAlphaToDeg( raH ),
            decDeg: dec,
            mag: toNumber( f[ 3 ] ),
            diamArcmin: toNumber( f[ 4 ] ),
            commonName: ( f.length > 7 ) ? trimStr( f[ 7 ] ) : "",
            messier: ( f.length > 10 ) ? trimStr( f[ 10 ] ) : ""
         } );
      }
      return out;
   }

   function parseNamedStarsCsv( text )
   {
      // id,alpha,delta,magnitude,Spectral type,HD,HIP,Common name
      // Returns [ { type:"star", name, commonName, raDeg, decDeg, mag,
      // spectral, hd } ].
      var out = [];
      if ( text === null || text === undefined )
         return out;
      var lines = String( text ).split( /\r?\n/ );
      for ( var i = 1; i < lines.length; ++i )
      {
         var f = splitCsvLine( lines[ i ] );
         if ( f.length < 5 )
            continue;
         var raH = toNumber( f[ 1 ] ), dec = toNumber( f[ 2 ] );
         if ( raH === null || dec === null )
            continue;
         out.push( {
            type: "star",
            name: trimStr( f[ 0 ] ),
            raDeg: adpAlphaToDeg( raH ),
            decDeg: dec,
            mag: toNumber( f[ 3 ] ),
            spectral: trimStr( f[ 4 ] ),
            hd: ( f.length > 5 ) ? trimStr( f[ 5 ] ) : "",
            commonName: ( f.length > 7 ) ? trimStr( f[ 7 ] ) : ""
         } );
      }
      return out;
   }

   // ------------------------------------------------------------------------
   // Typed-row coercion shared by the query layer

   function typeGalaxyRow( r )
   {
      var logD25 = toNumber( r.logD25 );
      return { type: "galaxy", name: ( r.PGC ? "PGC " + trimStr( r.PGC ) : "galaxy" ),
               pgc: trimStr( r.PGC ), raDeg: r.raDeg, decDeg: r.decDeg,
               logD25: logD25,
               // apparent major diameter in arcmin from logD25 (0.1 arcmin units)
               diamArcmin: ( logD25 === null ) ? null : Math.pow( 10, logD25 )*0.1 };
   }

   function typeQuasarRow( r )
   {
      return { type: "quasar", name: trimStr( r.Name ) || "quasar",
               raDeg: r.raDeg, decDeg: r.decDeg,
               z: toNumber( r.z ), Rmag: toNumber( r.Rmag ) };
   }

   function typePneRow( r )
   {
      var maj = toNumber( r.MajDiam ), min = toNumber( r.MinDiam );
      return { type: "pne", name: trimStr( r.Name ) || trimStr( r.PNG ) || "PN",
               png: trimStr( r.PNG ), raDeg: r.raDeg, decDeg: r.decDeg,
               majDiamArcsec: maj, minDiamArcsec: min,
               diamArcmin: ( maj === null ) ? null : maj/60 };
   }

   function typeHdStarRow( r )
   {
      var hd = trimStr( r.HD );
      return { type: "star", name: hd ? ( "HD " + hd ) : "star",
               raDeg: r.raDeg, decDeg: r.decDeg,
               mag: toNumber( r.Ptm ), spectral: trimStr( r.SpType ), commonName: "" };
   }

   function typeAsteroidRow( r )
   {
      return { type: "asteroid", name: r.name, raDeg: r.raDeg, decDeg: r.decDeg,
               klass: r.klass, magV: r.magV, num: r.num,
               errArcsec: r.errArcsec };
   }

   // ------------------------------------------------------------------------
   // Query layer (PixInsight runtime only: SINet + File)

   function round3( x )
   {
      return Math.round( Number( x )*1000 )/1000;
   }

   function cacheDir()
   {
      return File.homeDirectory + "/.caeloworks/sky-intruders/treasure-cache";
   }

   function cacheKey( parts )
   {
      var s = parts.join( "_" ).replace( /[^A-Za-z0-9_.+-]/g, "-" );
      return s;
   }

   function readCache( key, maxAgeHours )
   {
      try
      {
         var p = cacheDir() + "/" + key + ".json";
         if ( !File.exists( p ) )
            return null;
         var obj = JSON.parse( File.readTextFile( p ) );
         var ageHours = ( Date.now() - Date.parse( obj.fetchedUtc ) )/3600000;
         if ( isFinite( ageHours ) && ageHours >= 0 && ageHours <= maxAgeHours )
            return obj.rows;
      }
      catch ( e ) {}
      return null;
   }

   function writeCache( key, rows )
   {
      try
      {
         var dir = cacheDir();
         if ( !File.directoryExists( dir ) )
            File.createDirectory( dir, true );
         File.writeTextFile( dir + "/" + key + ".json",
            JSON.stringify( { fetchedUtc: ( new Date ).toISOString(), rows: rows }, null, 2 ) );
      }
      catch ( e ) {}
   }

   function pause( ms )
   {
      if ( typeof msleep == "function" ) { msleep( ms ); return; }
      var until = Date.now() + ms;
      while ( Date.now() < until )
         if ( typeof processEvents == "function" )
            processEvents();
   }

   function warn( msg )
   {
      try { console.warningln( "Treasure/Catalogs: " + msg ); } catch ( e ) {}
   }

   function fetchVizier( kind, raDeg, decDeg, radiusDeg, coerce, opts )
   {
      opts = opts || {};
      var spec = SOURCE[ kind ];
      var max = ( opts.max > 0 ) ? opts.max : 1000;
      var maxAge = ( opts.maxAgeHours > 0 ) ? opts.maxAgeHours : 720;
      var key = cacheKey( [ kind, round3( raDeg ), round3( decDeg ), round3( radiusDeg ), max ] );
      if ( opts.useCache !== false )
      {
         var cached = readCache( key, maxAge );
         if ( cached !== null )
            return cached;
      }
      var url = vizierUrl( spec.source, raDeg, decDeg, radiusDeg, spec.cols, max );
      var rows = [];
      try
      {
         var r = SINet.getText( url, ( opts.timeoutSec > 0 ) ? opts.timeoutSec : 30 );
         if ( !r.ok || ( r.code != 0 && r.code != 200 ) )
         {
            warn( kind + " query failed: " + ( r.error || ( "HTTP " + r.code ) ) );
            return [];
         }
         var parsed = parseVizierTsv( r.text );
         for ( var i = 0; i < parsed.length; ++i )
            rows.push( coerce( parsed[ i ] ) );
      }
      catch ( e )
      {
         warn( kind + " query error: " + e.message );
         return [];
      }
      if ( opts.useCache !== false )
         writeCache( key, rows );
      return rows;
   }

   function queryGalaxies( raDeg, decDeg, radiusDeg, opts )
   {
      return fetchVizier( "galaxy", raDeg, decDeg, radiusDeg, typeGalaxyRow, opts );
   }

   function queryQuasars( raDeg, decDeg, radiusDeg, opts )
   {
      return fetchVizier( "quasar", raDeg, decDeg, radiusDeg, typeQuasarRow, opts );
   }

   function queryPne( raDeg, decDeg, radiusDeg, opts )
   {
      return fetchVizier( "pne", raDeg, decDeg, radiusDeg, typePneRow, opts );
   }

   function queryBrightStars( raDeg, decDeg, radiusDeg, opts )
   {
      return fetchVizier( "hdstar", raDeg, decDeg, radiusDeg, typeHdStarRow, opts );
   }

   function queryAsteroids( raDeg, decDeg, radiusDeg, epochIso, opts )
   {
      // SkyBoT is flaky: up to 3 attempts with 1s/2s backoff. The cache key
      // includes the epoch, so a hit is effectively immutable.
      opts = opts || {};
      var maxAge = ( opts.maxAgeHours > 0 ) ? opts.maxAgeHours : 720;
      var key = cacheKey( [ "asteroid-v2", round3( raDeg ), round3( decDeg ),
                            round3( radiusDeg ), String( epochIso ) ] );
      if ( opts.useCache !== false )
      {
         var cached = readCache( key, maxAge );
         if ( cached !== null )
            return cached;
      }
      var url = skybotUrl( raDeg, decDeg, radiusDeg, epochIso );
      var rows = null;
      var attempts = ( opts.attempts > 0 ) ? opts.attempts : 3;
      for ( var a = 1; a <= attempts; ++a )
      {
         if ( a > 1 )
            pause( 1000*( 1 << ( a - 1 ) ) );
         try
         {
            var r = SINet.getText( url, ( opts.timeoutSec > 0 ) ? opts.timeoutSec : 30 );
            if ( !r.ok || ( r.code != 0 && r.code != 200 ) )
               continue;
            var parsed = parseSkybot( r.text );
            rows = [];
            for ( var i = 0; i < parsed.length; ++i )
               rows.push( typeAsteroidRow( parsed[ i ] ) );
            break;
         }
         catch ( e ) {}
      }
      if ( rows === null )
      {
         warn( "asteroid query failed after retries" );
         return [];
      }
      if ( opts.useCache !== false )
         writeCache( key, rows );
      return rows;
   }

   return {
      SOURCE: SOURCE,
      // pure
      vizierUrl: vizierUrl,
      skybotUrl: skybotUrl,
      parseVizierTsv: parseVizierTsv,
      parseSkybot: parseSkybot,
      parseNgcIcCsv: parseNgcIcCsv,
      parseNamedStarsCsv: parseNamedStarsCsv,
      typeGalaxyRow: typeGalaxyRow,
      typeQuasarRow: typeQuasarRow,
      typePneRow: typePneRow,
      typeHdStarRow: typeHdStarRow,
      typeAsteroidRow: typeAsteroidRow,
      // PI query layer
      queryGalaxies: queryGalaxies,
      queryQuasars: queryQuasars,
      queryPne: queryPne,
      queryBrightStars: queryBrightStars,
      queryAsteroids: queryAsteroids
   };
} )();
