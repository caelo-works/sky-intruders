/*
 * Treasure.js — SITreasure: pure orchestration and narrative for the
 * Treasure Hunt mode. Cross-matches catalog objects against the frame,
 * scores them by notability, and turns redshifts into vivid sentences via
 * SICosmology. All Node-testable with a stub celestialToImage.
 *
 * The PixInsight-facing pieces (running the queries, drawing the overlay,
 * cropping thumbnails) live in the entry script; this module only touches
 * plain data.
 */

var SITreasure = ( function()
{
   var Cosmo = ( typeof SICosmology !== "undefined" ) ? SICosmology : null;

   function toList( objectsByType )
   {
      // Accept either a flat array of typed rows or a { type: rows[] } map.
      if ( objectsByType instanceof Array )
         return objectsByType.slice();
      var out = [];
      for ( var k in objectsByType )
         if ( objectsByType.hasOwnProperty( k ) )
         {
            var arr = objectsByType[ k ];
            if ( arr instanceof Array )
               for ( var i = 0; i < arr.length; ++i )
                  out.push( arr[ i ] );
         }
      return out;
   }

   function notability( o )
   {
      // Coarse cross-type tier plus a within-type ordering key. Higher wins.
      var z = ( typeof o.z === "number" && isFinite( o.z ) ) ? o.z : 0;
      var rmag = ( typeof o.Rmag === "number" && isFinite( o.Rmag ) ) ? o.Rmag : 24;
      var diamArcmin = ( typeof o.diamArcmin === "number" && isFinite( o.diamArcmin ) ) ? o.diamArcmin : 0;
      var magV = ( typeof o.magV === "number" && isFinite( o.magV ) ) ? o.magV : 22;
      switch ( o.type )
      {
      case "quasar": return 300 + z*20 + ( 24 - rmag );
      case "galaxy": return 200 + Math.min( 90, diamArcmin*6 );
      case "pne":    return 150 + Math.min( 90, diamArcmin*30 );
      case "asteroid": return 100 + ( 22 - magV );
      default: return 0;
      }
   }

   function inBounds( x, y, w, h )
   {
      return isFinite( x ) && isFinite( y ) && x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1;
   }

   function crossMatch( objectsByType, celestialToImage, imageWidth, imageHeight )
   {
      // Project every object to pixels, keep those inside the frame, attach
      // { x, y, score } and sort by notability (descending, name tie-break).
      var list = toList( objectsByType );
      var kept = [];
      for ( var i = 0; i < list.length; ++i )
      {
         var o = list[ i ];
         if ( o === null || typeof o.raDeg !== "number" || typeof o.decDeg !== "number" )
            continue;
         var p = null;
         try { p = celestialToImage( o.raDeg, o.decDeg ); }
         catch ( e ) { p = null; }
         if ( p === null || p === undefined )
            continue;
         if ( !inBounds( p.x, p.y, imageWidth, imageHeight ) )
            continue;
         var t = {};
         for ( var key in o )
            if ( o.hasOwnProperty( key ) )
               t[ key ] = o[ key ];
         t.x = p.x;
         t.y = p.y;
         t.score = notability( o );
         kept.push( t );
      }
      kept.sort( function( a, b )
      {
         if ( b.score !== a.score )
            return b.score - a.score;
         return String( a.name ).localeCompare( String( b.name ) );
      } );
      return kept;
   }

   // ------------------------------------------------------------------------
   // Narrative

   function round1( x )
   {
      return Math.round( x*10 )/10;
   }

   function redshiftClause( z, lang )
   {
      // "its light left about 10.8 billion years ago, before the Sun existed"
      if ( Cosmo === null || !( z > 0 ) )
         return null;
      var gyr = round1( Cosmo.lookbackGyr( z ) );
      var hooks = Cosmo.factHooks( z );
      var hook = ( hooks.length > 0 ) ? hooks[ 0 ] : null;
      if ( lang === "fr" )
      {
         var frC = "sa lumiere est partie il y a environ " + gyr.toFixed( 1 ) + " milliards d'annees";
         if ( hook )
            frC += ", " + hook.fr;
         return frC;
      }
      var enC = "its light left about " + gyr.toFixed( 1 ) + " billion years ago";
      if ( hook )
         enC += ", " + hook.en;
      return enC;
   }

   function pixelPhrase( t, lang )
   {
      // "this 4-pixel smudge" when the entry script attached a pixel size.
      if ( typeof t.pxDiam === "number" && isFinite( t.pxDiam ) && t.pxDiam >= 1 )
      {
         var n = Math.max( 1, Math.round( t.pxDiam ) );
         return ( lang === "fr" ) ? ( "cette tache de " + n + " pixels" )
                                  : ( "this " + n + "-pixel smudge" );
      }
      return null;
   }

   function narrate( treasure, lang )
   {
      lang = ( lang === "fr" ) ? "fr" : "en";
      var t = treasure;
      var px = pixelPhrase( t, lang );
      var lead = px ? px : ( ( lang === "fr" ) ? "cet objet" : "this object" );

      if ( t.type === "quasar" )
      {
         var zTxt = ( typeof t.z === "number" && isFinite( t.z ) ) ? ( "z = " + t.z ) : null;
         var rc = ( typeof t.z === "number" ) ? redshiftClause( t.z, lang ) : null;
         if ( lang === "fr" )
         {
            var s = lead + " est le quasar " + t.name;
            if ( zTxt ) s += " a " + zTxt;
            s += ( rc ? " : " + rc : "" ) + ".";
            return capitalize( s );
         }
         var e = lead + " is the quasar " + t.name;
         if ( zTxt ) e += " at " + zTxt;
         e += ( rc ? ": " + rc : "" ) + ".";
         return capitalize( e );
      }
      if ( t.type === "galaxy" )
      {
         var sizeTxt = ( typeof t.diamArcmin === "number" && isFinite( t.diamArcmin ) )
            ? round1( t.diamArcmin ) : null;
         if ( lang === "fr" )
            return capitalize( lead + " est la galaxie " + t.name +
               ( sizeTxt ? ", environ " + sizeTxt.toFixed( 1 ) + " arcmin de diametre apparent" : "" ) + "." );
         return capitalize( lead + " is the galaxy " + t.name +
            ( sizeTxt ? ", about " + sizeTxt.toFixed( 1 ) + " arcmin across" : "" ) + "." );
      }
      if ( t.type === "pne" )
      {
         var d = ( typeof t.majDiamArcsec === "number" && isFinite( t.majDiamArcsec ) )
            ? Math.round( t.majDiamArcsec ) : null;
         if ( lang === "fr" )
            return capitalize( lead + " est la nebuleuse planetaire " + t.name +
               ( d ? ", environ " + d + " arcsec de diametre" : "" ) + "." );
         return capitalize( lead + " is the planetary nebula " + t.name +
            ( d ? ", about " + d + " arcsec across" : "" ) + "." );
      }
      if ( t.type === "asteroid" )
      {
         var mv = ( typeof t.magV === "number" && isFinite( t.magV ) ) ? t.magV : null;
         if ( lang === "fr" )
            return capitalize( "l'asteroide " + t.name +
               ( t.klass ? " (" + t.klass + ")" : "" ) +
               " a traverse le champ" + ( mv !== null ? " a la magnitude " + mv : "" ) + "." );
         return capitalize( "the asteroid " + t.name +
            ( t.klass ? " (" + t.klass + ")" : "" ) +
            " drifted through the field" + ( mv !== null ? " at magnitude " + mv : "" ) + "." );
      }
      return capitalize( lead + " (" + String( t.type ) + ") " + String( t.name || "" ) + "." );
   }

   function capitalize( s )
   {
      return ( s.length > 0 ) ? s.charAt( 0 ).toUpperCase() + s.substring( 1 ) : s;
   }

   // ------------------------------------------------------------------------
   // Summary

   var TYPES = [ "galaxy", "quasar", "pne", "asteroid" ];

   function summarize( treasures, lang )
   {
      lang = ( lang === "fr" ) ? "fr" : "en";
      var counts = { galaxy: 0, quasar: 0, pne: 0, asteroid: 0 };
      for ( var i = 0; i < treasures.length; ++i )
      {
         var ty = treasures[ i ].type;
         if ( counts[ ty ] === undefined )
            counts[ ty ] = 0;
         counts[ ty ]++;
      }
      var headlines = [];
      var noun = {
         en: { galaxy: "galaxies", quasar: "quasars", pne: "planetary nebulae", asteroid: "asteroids" },
         fr: { galaxy: "galaxies", quasar: "quasars", pne: "nebuleuses planetaires", asteroid: "asteroides" }
      }[ lang ];
      var tail = ( lang === "fr" ) ? " capturees sans le savoir" : " captured without knowing";
      for ( var t = 0; t < TYPES.length; ++t )
      {
         var k = TYPES[ t ];
         if ( counts[ k ] > 0 )
            headlines.push( counts[ k ] + " " + noun[ k ] + tail );
      }
      // Lead with the most dramatic redshift, if any.
      var deepest = null;
      for ( var j = 0; j < treasures.length; ++j )
      {
         var z = treasures[ j ].z;
         if ( typeof z === "number" && isFinite( z ) && ( deepest === null || z > deepest.z ) )
            deepest = treasures[ j ];
      }
      if ( deepest !== null && Cosmo !== null )
      {
         var gyr = round1( Cosmo.lookbackGyr( deepest.z ) );
         headlines.unshift( ( lang === "fr" )
            ? ( "le plus lointain : " + deepest.name + " a z = " + deepest.z +
                ", lumiere vieille de " + gyr.toFixed( 1 ) + " milliards d'annees" )
            : ( "deepest capture: " + deepest.name + " at z = " + deepest.z +
                ", light " + gyr.toFixed( 1 ) + " billion years old" ) );
      }
      return { counts: counts, total: treasures.length, headlines: headlines,
               deepest: deepest };
   }

   return {
      notability: notability,
      crossMatch: crossMatch,
      narrate: narrate,
      summarize: summarize
   };
} )();
