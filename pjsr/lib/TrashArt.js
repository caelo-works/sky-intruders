/*
 * TrashArt.js — turn rejected frames into art (pure composition logic).
 *
 * The PI-facing compositing (max-combine, drawing onto a Bitmap, PNG export)
 * lives in the entry script; everything here is pure and Node-testable: color
 * assignment, canvas normalization of trail endpoints, and the poster text
 * model. Trails come in carrying { x1,y1,x2,y2, klass, operator, timeUtc }.
 */

var SITrashArt = ( function()
{
   // Distinct, colorblind-friendly hues for the "type" scheme.
   var TYPE_COLORS = {
      "satellite": "#22d3ee",
      "satellite-candidate": "#a78bfa",
      "meteor": "#f59e0b",
      "asteroid": "#34d399",
      "unknown": "#94a3b8"
   };

   // Ordered palette assigned deterministically for the "operator" scheme.
   var OPERATOR_PALETTE = [
      "#22d3ee", "#f59e0b", "#34d399", "#a78bfa", "#f472b6",
      "#60a5fa", "#facc15", "#fb7185", "#4ade80", "#c084fc",
      "#38bdf8", "#fbbf24"
   ];

   // Time-of-night ramp endpoints (early -> late).
   var TIME_RAMP = [ "#22d3ee", "#f472b6" ];

   function clamp01( x )
   {
      return x < 0 ? 0 : ( x > 1 ? 1 : x );
   }

   function hexToRgb( hex )
   {
      var h = hex.replace( "#", "" );
      return [ parseInt( h.substring( 0, 2 ), 16 ),
               parseInt( h.substring( 2, 4 ), 16 ),
               parseInt( h.substring( 4, 6 ), 16 ) ];
   }

   function rgbToHex( r, g, b )
   {
      function p( v )
      {
         var s = Math.round( clamp01( v / 255 ) * 255 ).toString( 16 );
         return s.length < 2 ? "0" + s : s;
      }
      return "#" + p( r ) + p( g ) + p( b );
   }

   function lerpHex( a, b, t )
   {
      var ca = hexToRgb( a ), cb = hexToRgb( b );
      t = clamp01( t );
      return rgbToHex( ca[ 0 ] + ( cb[ 0 ] - ca[ 0 ] ) * t,
                       ca[ 1 ] + ( cb[ 1 ] - ca[ 1 ] ) * t,
                       ca[ 2 ] + ( cb[ 2 ] - ca[ 2 ] ) * t );
   }

   function timeMs( v )
   {
      if ( v == null )
         return null;
      if ( typeof v == "number" )
         return v;
      if ( typeof v.getTime == "function" )
         return v.getTime();
      var t = Date.parse( v );
      return isNaN( t ) ? null : t;
   }

   // Deterministic operator -> color map (operators sorted for stability).
   function operatorColors( trails )
   {
      var names = {};
      for ( var i = 0; i < trails.length; ++i )
      {
         var op = trails[ i ].operator || "other";
         names[ op ] = true;
      }
      var keys = [];
      for ( var k in names )
         keys.push( k );
      keys.sort();
      var map = {};
      for ( var j = 0; j < keys.length; ++j )
         map[ keys[ j ] ] = OPERATOR_PALETTE[ j % OPERATOR_PALETTE.length ];
      return map;
   }

   /*
    * assignColors( trails, scheme ) -> a new array of trails, each with a
    * `color` hex string. Also returns the legend via .legend on the array
    * (entries [{ label, color }]) so the poster can render it.
    * scheme: "type" | "operator" | "time".
    */
   function assignColors( trails, scheme )
   {
      var out = [];
      var legend = [];

      if ( scheme == "operator" )
      {
         var opMap = operatorColors( trails );
         for ( var i = 0; i < trails.length; ++i )
         {
            var op = trails[ i ].operator || "other";
            out.push( shallowWithColor( trails[ i ], opMap[ op ] ) );
         }
         var seen = {};
         for ( var t in opMap )
            if ( !seen[ t ] )
            {
               seen[ t ] = true;
               legend.push( { label: t, color: opMap[ t ] } );
            }
         legend.sort( function( a, b ) { return a.label < b.label ? -1 : 1; } );
      }
      else if ( scheme == "time" )
      {
         var times = [];
         for ( var i2 = 0; i2 < trails.length; ++i2 )
         {
            var ms = timeMs( trails[ i2 ].timeUtc );
            times.push( ms );
         }
         var lo = null, hi = null;
         for ( var i3 = 0; i3 < times.length; ++i3 )
            if ( times[ i3 ] != null )
            {
               if ( lo == null || times[ i3 ] < lo ) lo = times[ i3 ];
               if ( hi == null || times[ i3 ] > hi ) hi = times[ i3 ];
            }
         var span = ( hi != null && hi > lo ) ? ( hi - lo ) : 1;
         for ( var i4 = 0; i4 < trails.length; ++i4 )
         {
            var frac = ( times[ i4 ] == null ) ? 0.5 : ( times[ i4 ] - lo ) / span;
            out.push( shallowWithColor( trails[ i4 ], lerpHex( TIME_RAMP[ 0 ], TIME_RAMP[ 1 ], frac ) ) );
         }
         legend.push( { label: "earlier", color: TIME_RAMP[ 0 ] } );
         legend.push( { label: "later", color: TIME_RAMP[ 1 ] } );
      }
      else // "type"
      {
         var usedTypes = {};
         for ( var i5 = 0; i5 < trails.length; ++i5 )
         {
            var klass = trails[ i5 ].klass || "unknown";
            var col = TYPE_COLORS[ klass ] || TYPE_COLORS.unknown;
            out.push( shallowWithColor( trails[ i5 ], col ) );
            usedTypes[ klass ] = col;
         }
         for ( var ty in usedTypes )
            legend.push( { label: ty, color: usedTypes[ ty ] } );
      }

      out.legend = legend;
      return out;
   }

   function shallowWithColor( trail, color )
   {
      var o = {};
      for ( var k in trail )
         o[ k ] = trail[ k ];
      o.color = color;
      return o;
   }

   /*
    * Map trail endpoints from a source frame's pixel space onto a common
    * canvas. Frames of equal dimensions map 1:1; mixed sizes scale to fit.
    * Returns a new array with x1,y1,x2,y2 in canvas pixels.
    */
   function normalizeEndpoints( trails, srcW, srcH, dstW, dstH )
   {
      var sx = dstW / srcW, sy = dstH / srcH;
      var out = [];
      for ( var i = 0; i < trails.length; ++i )
      {
         var t = shallowWithColor( trails[ i ], trails[ i ].color );
         t.x1 = trails[ i ].x1 * sx; t.y1 = trails[ i ].y1 * sy;
         t.x2 = trails[ i ].x2 * sx; t.y2 = trails[ i ].y2 * sy;
         out.push( t );
      }
      return out;
   }

   var STRINGS = {
      en: { titleN: "The %1 intruders of my night", titleOne: "The lone intruder of my night",
            titleNone: "A clean night — nothing to recycle",
            subtitle: "%1 · %2 frames recycled into art",
            legendTitle: "Legend", byType: "by type", byOperator: "by operator", byTime: "by time",
            stat: "%1: %2" },
      fr: { titleN: "Les %1 intrus de ma nuit", titleOne: "L'unique intrus de ma nuit",
            titleNone: "Une nuit propre — rien à recycler",
            subtitle: "%1 · %2 brutes recyclées en art",
            legendTitle: "Légende", byType: "par type", byOperator: "par opérateur", byTime: "par heure",
            stat: "%1 : %2" }
   };

   function fmt( s )
   {
      for ( var i = 1; i < arguments.length; ++i )
         s = s.replace( "%" + i, String( arguments[ i ] ) );
      return s;
   }

   /*
    * posterModel( summary, opts ) -> the pure text model of the designed
    * poster. summary is SIReport.summarizeNight's output (or compatible);
    * opts = { scheme, frameCount, dateLabel, lang, legend }.
    */
   function posterModel( summary, opts )
   {
      var lang = ( opts && opts.lang == "fr" ) ? "fr" : "en";
      var T = STRINGS[ lang ];
      var n = ( summary.satellites || 0 ) + ( summary.meteors || 0 ) +
              ( summary.satCandidates || 0 ) + ( summary.unknowns || 0 ) +
              ( summary.movers || 0 );
      var title = ( n == 0 ) ? T.titleNone : ( n == 1 ? T.titleOne : fmt( T.titleN, n ) );

      var stats = [];
      function stat( label, value )
      {
         if ( value )
            stats.push( fmt( T.stat, label, value ) );
      }
      stat( lang == "fr" ? "Satellites" : "Satellites", summary.satellites );
      if ( summary.starlink )
         stat( "Starlink", summary.starlink );
      stat( lang == "fr" ? "Météores" : "Meteors", summary.meteors );
      stat( lang == "fr" ? "Astéroïdes" : "Asteroids", summary.movers );
      stat( lang == "fr" ? "Non identifiés" : "Unidentified", summary.unknowns );

      var schemeLabel = ( opts && opts.scheme == "operator" ) ? T.byOperator :
                        ( opts && opts.scheme == "time" ) ? T.byTime : T.byType;

      return {
         title: title,
         subtitle: fmt( T.subtitle, ( opts && opts.dateLabel ) || summary.date || "",
                        ( opts && opts.frameCount ) || 0 ),
         intruderCount: n,
         stats: stats,
         legendTitle: T.legendTitle + " — " + schemeLabel,
         legend: ( opts && opts.legend ) || []
      };
   }

   return {
      TYPE_COLORS: TYPE_COLORS,
      OPERATOR_PALETTE: OPERATOR_PALETTE,
      lerpHex: lerpHex,
      assignColors: assignColors,
      normalizeEndpoints: normalizeEndpoints,
      posterModel: posterModel,
      STRINGS: STRINGS
   };
} )();
