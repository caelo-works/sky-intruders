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

   // Capture-scoring contract, shared by apertureDetection, captureVerdict
   // and the entry script's decoy sampler: base thresholds, the margins a
   // target must keep over the best decoy, and the minimum decoy count for
   // the verdict to mean anything.
   var CAPTURE = { SNR_MIN: 4, FRAC_MIN: 0.30, SNR_MARGIN: 1.3, FRAC_MARGIN: 2,
                   MIN_DECOYS: 6 };

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

   function medianOf( a )
   {
      if ( !a || a.length === 0 )
         return null;
      return SIStats.arrayMedian( a );
   }

   /*
    * apertureDetection( apVals, bgVals ) -> { bg, sigma, peak, snr,
    * fracAbove, captured }. Decides whether there is actual signal at a
    * catalog position: robust background + MAD sigma from the annulus, then
    * either a strong single-pixel peak (>= 4 sigma) or a filled aperture
    * (>= 30% of pixels above 2 sigma) counts as captured. Pure, testable.
    */
   function apertureDetection( apVals, bgVals )
   {
      var out = { bg: null, sigma: null, peak: null, snr: null,
                  fracAbove: null, captured: false };
      if ( !apVals || apVals.length === 0 || !bgVals || bgVals.length < 8 )
         return out;
      // One sort serves both the median and the upper percentile.
      var srt = bgVals.slice().sort( function( a, b ) { return a - b; } );
      var m = srt.length >> 1;
      var bg = ( srt.length & 1 ) ? srt[ m ] : ( srt[ m - 1 ] + srt[ m ] )/2;
      var dev = [];
      for ( var i = 0; i < bgVals.length; ++i )
         dev.push( Math.abs( bgVals[ i ] - bg ) );
      var sigma = 1.4826*medianOf( dev );
      // Structured backgrounds (nebular rims, gradients, star wings) are not
      // Gaussian: the MAD underestimates how high innocent pixels reach, and
      // every rim pixel becomes a fake 10-sigma "detection". Widen sigma to
      // the upper-percentile spread of the annulus, so the aperture peak has
      // to beat what the LOCAL structure already does on its own.
      var p90 = srt[ Math.min( srt.length - 1, Math.floor( srt.length*0.90 ) ) ];
      var structSigma = ( p90 - bg )/1.2816; // z(0.90) for a Gaussian
      if ( structSigma > sigma )
         sigma = structSigma;
      out.bg = bg;
      out.sigma = sigma;
      var peak = -Infinity, above = 0;
      for ( var k = 0; k < apVals.length; ++k )
      {
         if ( apVals[ k ] > peak )
            peak = apVals[ k ];
         if ( sigma > 0 && apVals[ k ] > bg + 2*sigma )
            above++;
      }
      out.peak = peak;
      if ( !( sigma > 0 ) )
         return out; // flat/clipped annulus: cannot claim a detection
      out.snr = ( peak - bg )/sigma;
      out.fracAbove = above/apVals.length;
      out.captured = ( out.snr >= CAPTURE.SNR_MIN ) || ( out.fracAbove >= CAPTURE.FRAC_MIN );
      return out;
   }

   /*
    * captureVerdict( target, decoys ) -> boolean. In a rich star field a
    * blind aperture holds a chance star ~1 time in 3, so "signal above the
    * local noise" is not enough to claim a capture. The object must also
    * clearly beat the SAME measurement made at decoy positions around it:
    * whatever score innocent sky achieves there is the local false-alarm
    * floor. With too few decoys (frame edge) the plain verdict stands.
    */
   function captureVerdict( target, decoys )
   {
      if ( !target || !target.captured )
         return false;
      if ( !decoys || decoys.length < CAPTURE.MIN_DECOYS )
         return true;
      var maxSnr = 0, maxFrac = 0;
      for ( var i = 0; i < decoys.length; ++i )
      {
         var d = decoys[ i ];
         if ( !d )
            continue;
         if ( typeof d.snr === "number" && d.snr > maxSnr )
            maxSnr = d.snr;
         if ( typeof d.fracAbove === "number" && d.fracAbove > maxFrac )
            maxFrac = d.fracAbove;
      }
      var snrOk = ( typeof target.snr === "number" ) &&
                  target.snr >= Math.max( CAPTURE.SNR_MIN, CAPTURE.SNR_MARGIN*maxSnr );
      var fracOk = ( typeof target.fracAbove === "number" ) &&
                   target.fracAbove >= Math.max( CAPTURE.FRAC_MIN, CAPTURE.FRAC_MARGIN*maxFrac );
      return snrOk || fracOk;
   }

   /*
    * applyMagConsistency( treasures ) — withdraw "captured" from objects that
    * are DRASTICALLY fainter than what the image demonstrably does not show.
    * If most mag-20 asteroids are honest non-detections, a "detected" mag-26
    * one is a chance field star under the aperture, not the asteroid. Per
    * type, with at least 5 magnitude-bearing objects and at least one
    * non-detection: captured objects fainter than (median mag of the
    * non-detections + 1) are demoted. Mutates the .captured flags in place.
    */
   function applyMagConsistency( treasures )
   {
      var byType = {};
      for ( var i = 0; i < treasures.length; ++i )
      {
         var t = treasures[ i ];
         var mag = ( typeof t.magV === "number" && isFinite( t.magV ) ) ? t.magV
                 : ( typeof t.Rmag === "number" && isFinite( t.Rmag ) ) ? t.Rmag : null;
         if ( mag === null || t.captured === undefined )
            continue;
         if ( !byType[ t.type ] )
            byType[ t.type ] = [];
         byType[ t.type ].push( { t: t, mag: mag } );
      }
      for ( var k in byType )
      {
         if ( !byType.hasOwnProperty( k ) )
            continue;
         var rows = byType[ k ];
         if ( rows.length < 5 )
            continue;
         var undet = [];
         for ( var u = 0; u < rows.length; ++u )
            if ( rows[ u ].t.captured === false )
               undet.push( rows[ u ].mag );
         if ( undet.length === 0 )
            continue;
         var limit = medianOf( undet ) + 1;
         for ( var c2 = 0; c2 < rows.length; ++c2 )
            if ( rows[ c2 ].t.captured === true && rows[ c2 ].mag > limit )
               rows[ c2 ].t.captured = false;
      }
   }

   // ------------------------------------------------------------------------
   // Display names

   var TYPE_WORD = {
      en: { galaxy: "Galaxy", quasar: "Quasar", pne: "Nebula", asteroid: "Asteroid" },
      fr: { galaxy: "Galaxie", quasar: "Quasar", pne: "N\u00e9buleuse", asteroid: "Ast\u00e9ro\u00efde" }
   };

   function zShort( z )
   {
      if ( typeof z !== "number" || !isFinite( z ) )
         return null;
      var r = Math.round( z*100 )/100;
      return String( r );
   }

   function unwieldyName( name )
   {
      var s = String( name || "" );
      if ( s.length > 18 )
         return true;
      var digits = s.replace( /[^0-9]/g, "" ).length;
      return s.length > 12 && digits >= 8;
   }

   /*
    * displayName( t, lang ) -> { main, sub, friendly }. Catalog-ID names
    * ("Gaia 1864903391535776384") become a friendly two-line label:
    * main "Quasar Gaia (z 2.2)", sub = the full catalog name. Short names
    * stay on one line (sub null), quasars still get their "(z ...)".
    */
   function displayName( t, lang )
   {
      lang = ( lang === "fr" ) ? "fr" : "en";
      var name = String( t.name || TYPE_WORD[ lang ][ t.type ] || "?" );
      var zTag = ( t.type === "quasar" ) ? zShort( t.z ) : null;
      var suffix = zTag ? " (z " + zTag + ")" : "";
      if ( !unwieldyName( name ) )
         return { main: name + suffix, sub: null, friendly: name, bare: name };
      var first = name.split( /\s+/ )[ 0 ];
      var word = TYPE_WORD[ lang ][ t.type ] || TYPE_WORD[ lang ].galaxy;
      var friendly = word + " " + first;
      // "friendly" stands alone ("Quasar Gaia"); "bare" follows a typed
      // sentence ("est le quasar Gaia") without doubling the type word.
      return { main: friendly + suffix, sub: name, friendly: friendly, bare: first };
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
         var frC = "sa lumi\u00e8re est partie il y a environ " + gyr.toFixed( 1 ) + " milliards d'ann\u00e9es";
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
      // "this 4-pixel smudge" when the entry script attached a pixel size —
      // but never for an object we know sits below the noise: there is no
      // smudge to point at.
      if ( t.captured !== false &&
           typeof t.pxDiam === "number" && isFinite( t.pxDiam ) && t.pxDiam >= 1 )
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
      var friendly = displayName( t, lang ).bare;
      var noise = "";
      if ( t.captured === false )
         noise = ( lang === "fr" )
            ? " Il est dans le champ, mais sous le bruit de cette image."
            : " It sits in the field, below the noise of this image.";

      if ( t.type === "quasar" )
      {
         var zTxt = ( typeof t.z === "number" && isFinite( t.z ) ) ? ( "z = " + t.z ) : null;
         var rc = ( typeof t.z === "number" ) ? redshiftClause( t.z, lang ) : null;
         if ( lang === "fr" )
         {
            var s = lead + " est le quasar " + friendly;
            if ( zTxt ) s += " \u00e0 " + zTxt;
            s += ( rc ? " : " + rc : "" ) + ".";
            return capitalize( s ) + noise;
         }
         var e = lead + " is the quasar " + friendly;
         if ( zTxt ) e += " at " + zTxt;
         e += ( rc ? ": " + rc : "" ) + ".";
         return capitalize( e ) + noise;
      }
      if ( t.type === "galaxy" )
      {
         var sizeTxt = ( typeof t.diamArcmin === "number" && isFinite( t.diamArcmin ) )
            ? round1( t.diamArcmin ) : null;
         if ( lang === "fr" )
            return capitalize( lead + " est la galaxie " + friendly +
               ( sizeTxt ? ", environ " + sizeTxt.toFixed( 1 ) + " arcmin de diam\u00e8tre apparent" : "" ) + "." ) + noise;
         return capitalize( lead + " is the galaxy " + friendly +
            ( sizeTxt ? ", about " + sizeTxt.toFixed( 1 ) + " arcmin across" : "" ) + "." ) + noise;
      }
      if ( t.type === "pne" )
      {
         var d = ( typeof t.majDiamArcsec === "number" && isFinite( t.majDiamArcsec ) )
            ? Math.round( t.majDiamArcsec ) : null;
         if ( lang === "fr" )
            return capitalize( lead + " est la n\u00e9buleuse plan\u00e9taire " + friendly +
               ( d ? ", environ " + d + " arcsec de diam\u00e8tre" : "" ) + "." ) + noise;
         return capitalize( lead + " is the planetary nebula " + friendly +
            ( d ? ", about " + d + " arcsec across" : "" ) + "." ) + noise;
      }
      if ( t.type === "asteroid" )
      {
         var mv = ( typeof t.magV === "number" && isFinite( t.magV ) ) ? t.magV : null;
         var astNoise = "";
         if ( t.captured === false )
            astNoise = ( lang === "fr" )
               ? " Trop faible pour laisser une trace visible ici."
               : " Too faint to leave a visible trace here.";
         if ( lang === "fr" )
            return capitalize( "l'ast\u00e9ro\u00efde " + t.name +
               ( t.klass ? " (" + t.klass + ")" : "" ) +
               " a travers\u00e9 le champ" + ( mv !== null ? " \u00e0 la magnitude " + mv : "" ) + "." ) + astNoise;
         return capitalize( "the asteroid " + t.name +
            ( t.klass ? " (" + t.klass + ")" : "" ) +
            " drifted through the field" + ( mv !== null ? " at magnitude " + mv : "" ) + "." ) + astNoise;
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
      var captured = { galaxy: 0, quasar: 0, pne: 0, asteroid: 0 };
      for ( var i = 0; i < treasures.length; ++i )
      {
         var ty = treasures[ i ].type;
         if ( counts[ ty ] === undefined )
         {
            counts[ ty ] = 0;
            captured[ ty ] = 0;
         }
         counts[ ty ]++;
         // An object with no measurement (captured undefined) counts as
         // captured: only a measured "false" demotes it below the noise.
         if ( treasures[ i ].captured !== false )
            captured[ ty ]++;
      }

      // Nouns with number and (for French agreement) gender.
      var NOUN = {
         en: { galaxy: [ "galaxy", "galaxies" ], quasar: [ "quasar", "quasars" ],
               pne: [ "planetary nebula", "planetary nebulae" ],
               asteroid: [ "asteroid", "asteroids" ] },
         fr: { galaxy: [ "galaxie", "galaxies", true ],
               quasar: [ "quasar", "quasars", false ],
               pne: [ "n\u00e9buleuse plan\u00e9taire", "n\u00e9buleuses plan\u00e9taires", true ],
               asteroid: [ "ast\u00e9ro\u00efde", "ast\u00e9ro\u00efdes", false ] }
      }[ lang ];

      function noun( k, n )
      {
         return NOUN[ k ][ ( n > 1 ) ? 1 : 0 ];
      }

      function participle( k, n )
      {
         if ( lang !== "fr" )
            return "captured";
         return "captur\u00e9" + ( NOUN[ k ][ 2 ] ? "e" : "" ) + ( ( n > 1 ) ? "s" : "" );
      }

      var headlines = [];
      for ( var t = 0; t < TYPES.length; ++t )
      {
         var k = TYPES[ t ];
         var total = counts[ k ], cap = captured[ k ];
         if ( total === 0 )
            continue;
         if ( cap > 0 )
         {
            var line = ( lang === "fr" )
               ? cap + " " + noun( k, cap ) + " " + participle( k, cap ) + " sans le savoir"
               : cap + " " + noun( k, cap ) + " captured without knowing";
            if ( total > cap )
               line += ( lang === "fr" )
                  ? " (+ " + ( total - cap ) + " sous le bruit)"
                  : " (+ " + ( total - cap ) + " below your noise)";
            headlines.push( line );
         }
         else
            headlines.push( ( lang === "fr" )
               ? total + " " + noun( k, total ) + " dans le champ, sous le bruit de cette image"
               : total + " " + noun( k, total ) + " in the field, below your noise" );
      }

      // Lead with the most dramatic redshift — preferring an object that is
      // actually captured over one that only sits in the field.
      var deepest = null, deepestCaptured = null;
      for ( var j = 0; j < treasures.length; ++j )
      {
         var o = treasures[ j ];
         var z = o.z;
         if ( typeof z !== "number" || !isFinite( z ) )
            continue;
         if ( deepest === null || z > deepest.z )
            deepest = o;
         if ( o.captured !== false && ( deepestCaptured === null || z > deepestCaptured.z ) )
            deepestCaptured = o;
      }
      var lead = deepestCaptured || deepest;
      if ( lead !== null && Cosmo !== null )
      {
         var gyr = round1( Cosmo.lookbackGyr( lead.z ) );
         var name = displayName( lead, lang ).friendly;
         var below = ( deepestCaptured === null );
         headlines.unshift( ( lang === "fr" )
            ? ( "le plus lointain" + ( below ? " dans le champ (sous le bruit)" : "" ) +
                " : " + name + " \u00e0 z = " + lead.z +
                ", lumi\u00e8re vieille de " + gyr.toFixed( 1 ) + " milliards d'ann\u00e9es" )
            : ( "deepest " + ( below ? "in the field (below your noise)" : "capture" ) +
                ": " + name + " at z = " + lead.z +
                ", light " + gyr.toFixed( 1 ) + " billion years old" ) );
      }
      return { counts: counts, captured: captured, total: treasures.length,
               headlines: headlines, deepest: lead };
   }

   return {
      CAPTURE: CAPTURE,
      notability: notability,
      crossMatch: crossMatch,
      narrate: narrate,
      summarize: summarize,
      apertureDetection: apertureDetection,
      captureVerdict: captureVerdict,
      applyMagConsistency: applyMagConsistency,
      displayName: displayName
   };
} )();
