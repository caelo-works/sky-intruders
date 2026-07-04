/*
 * FrameMeta.js — SIFrameMeta: per-frame FITS/XISF metadata and WCS.
 *
 * SIFrameMetaCore holds the pure math — sexagesimal parsing, DATE-OBS
 * parsing, gnomonic (TAN) projection, FOV geometry — and runs under plain
 * Node for testing. SIFrameMeta.read( window, filePath ) is the
 * PixInsight-facing entry; it probes the window's astrometric solution
 * defensively and falls back to manual TAN, then to an approximate FOV.
 */

var SIFrameMetaCore = ( function()
{
   var DEG = Math.PI/180;

   // ------------------------------------------------------------------------
   // Value parsing

   function parseNumber( s )
   {
      if ( s === null || s === undefined )
         return null;
      var str = String( s ).trim();
      if ( str.length === 0 )
         return null;
      var f = Number( str );
      return isFinite( f ) ? f : null;
   }

   function parseSexagesimal( s )
   {
      // "48 51 24", "-12 30 00", "12:34:56.7", "+48.85", "20 30.5" — returns
      // a value in the unit of the leading field, or null. The sign is read
      // from the string (parseFloat alone loses the sign of "-0 30 00").
      if ( s === null || s === undefined )
         return null;
      var str = String( s ).trim();
      if ( str.length === 0 )
         return null;
      var neg = false;
      var c0 = str.charAt( 0 );
      if ( c0 === '+' || c0 === '-' )
      {
         neg = ( c0 === '-' );
         str = str.substring( 1 ).trim();
      }
      var parts = str.split( /[\s:]+/ );
      if ( parts.length < 1 || parts.length > 3 )
         return null;
      var value = 0;
      var scale = 1;
      for ( var i = 0; i < parts.length; ++i )
      {
         if ( parts[i].length === 0 )
            return null;
         var f = Number( parts[i] );
         if ( !isFinite( f ) || f < 0 )
            return null;
         value += f*scale;
         scale /= 60;
      }
      return neg ? -value : value;
   }

   function parseHoursToDeg( s )
   {
      // Right ascension written in hours (sexagesimal or decimal), e.g.
      // OBJCTRA "20 30 15.5" — returns degrees or null.
      var hours = parseSexagesimal( s );
      return ( hours === null ) ? null : hours*15;
   }

   function parseRaDeg( s )
   {
      // RA keyword: a plain decimal is degrees; a multi-field sexagesimal
      // value is hours (the common amateur convention).
      var dec = parseNumber( s );
      if ( dec !== null )
         return dec;
      return parseHoursToDeg( s );
   }

   function parseDateObs( s )
   {
      // ISO 8601 as found in DATE-OBS: "2026-07-03T02:13:05[.sss][Z]",
      // optional time part. Always interpreted as UTC (never local time —
      // the JS Date parser is not trusted here). Returns Date or null.
      if ( s === null || s === undefined )
         return null;
      var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?\s*Z?$/.exec( String( s ).trim() );
      if ( m === null )
         return null;
      var sec = ( m[6] !== undefined ) ? parseFloat( m[6] ) : 0;
      var ms = Date.UTC( parseInt( m[1], 10 ), parseInt( m[2], 10 ) - 1, parseInt( m[3], 10 ),
                         ( m[4] !== undefined ) ? parseInt( m[4], 10 ) : 0,
                         ( m[5] !== undefined ) ? parseInt( m[5], 10 ) : 0,
                         Math.floor( sec ), Math.round( ( sec - Math.floor( sec ) )*1000 ) );
      return new Date( ms );
   }

   function pixScaleFromKeywords( xpixszUm, focallenMm )
   {
      // Plate scale in arcsec per pixel from pixel size (µm) + focal (mm).
      if ( xpixszUm === null || focallenMm === null || !( focallenMm > 0 ) || !( xpixszUm > 0 ) )
         return null;
      return 206.265*xpixszUm/focallenMm;
   }

   // ------------------------------------------------------------------------
   // TAN (gnomonic) projection from FITS keywords

   function tanParamsFromKeywords( kw )
   {
      // Builds { crval1, crval2, crpix1, crpix2, cd11, cd12, cd21, cd22 }
      // (degrees, FITS 1-based reference pixel) from CRVAL/CRPIX + CD
      // matrix, or CDELT1/2 + CROTA2. Returns null when incomplete or when
      // CTYPE says the projection is not TAN.
      function num( name )
      {
         return parseNumber( kw[name] );
      }

      var ctype1 = kw["CTYPE1"];
      if ( ctype1 !== undefined && String( ctype1 ).indexOf( "TAN" ) < 0 )
         return null;

      var crval1 = num( "CRVAL1" ), crval2 = num( "CRVAL2" );
      var crpix1 = num( "CRPIX1" ), crpix2 = num( "CRPIX2" );
      if ( crval1 === null || crval2 === null || crpix1 === null || crpix2 === null )
         return null;

      var cd11 = num( "CD1_1" ), cd12 = num( "CD1_2" );
      var cd21 = num( "CD2_1" ), cd22 = num( "CD2_2" );
      if ( cd11 === null || cd22 === null )
      {
         var cdelt1 = num( "CDELT1" ), cdelt2 = num( "CDELT2" );
         if ( cdelt1 === null || cdelt2 === null )
            return null;
         var crota2 = num( "CROTA2" );
         var rot = ( ( crota2 === null ) ? 0 : crota2 )*DEG;
         cd11 = cdelt1*Math.cos( rot );
         cd12 = -cdelt2*Math.sin( rot );
         cd21 = cdelt1*Math.sin( rot );
         cd22 = cdelt2*Math.cos( rot );
      }
      else
      {
         if ( cd12 === null ) cd12 = 0;
         if ( cd21 === null ) cd21 = 0;
      }

      if ( cd11*cd22 - cd12*cd21 === 0 )
         return null;

      return { crval1: crval1, crval2: crval2, crpix1: crpix1, crpix2: crpix2,
               cd11: cd11, cd12: cd12, cd21: cd21, cd22: cd22 };
   }

   function tanImageToCelestial( tan, x, y )
   {
      // Gnomonic deprojection. x,y are 0-based image pixel coordinates
      // (FITS pixel = image pixel + 1). Returns { raDeg, decDeg } or null.
      var dp1 = ( x + 1 ) - tan.crpix1;
      var dp2 = ( y + 1 ) - tan.crpix2;
      var xi = ( tan.cd11*dp1 + tan.cd12*dp2 )*DEG;  // radians
      var eta = ( tan.cd21*dp1 + tan.cd22*dp2 )*DEG;

      var ra0 = tan.crval1*DEG;
      var dec0 = tan.crval2*DEG;
      var sinD0 = Math.sin( dec0 ), cosD0 = Math.cos( dec0 );

      var denom = Math.sqrt( 1 + xi*xi + eta*eta );
      var dec = Math.asin( ( sinD0 + eta*cosD0 )/denom );
      var ra = ra0 + Math.atan2( xi, cosD0 - eta*sinD0 );

      var raDeg = ra/DEG;
      raDeg -= 360*Math.floor( raDeg/360 );  // normalize to [0,360)
      return { raDeg: raDeg, decDeg: dec/DEG };
   }

   function tanCelestialToImage( tan, raDeg, decDeg )
   {
      // Forward gnomonic projection + inverse CD matrix. Returns { x, y }
      // in 0-based image pixels, or null (singular matrix, behind plane).
      var ra0 = tan.crval1*DEG;
      var dec0 = tan.crval2*DEG;
      var ra = raDeg*DEG;
      var dec = decDeg*DEG;
      var dRA = ra - ra0;
      var sinD0 = Math.sin( dec0 ), cosD0 = Math.cos( dec0 );
      var sinD = Math.sin( dec ), cosD = Math.cos( dec );

      var D = sinD*sinD0 + cosD*cosD0*Math.cos( dRA );
      if ( D <= 0 )
         return null; // more than 90 degrees from the tangent point

      var xi = ( cosD*Math.sin( dRA )/D )/DEG;                       // degrees
      var eta = ( ( sinD*cosD0 - cosD*sinD0*Math.cos( dRA ) )/D )/DEG;

      var det = tan.cd11*tan.cd22 - tan.cd12*tan.cd21;
      if ( det === 0 )
         return null;
      var dp1 = ( tan.cd22*xi - tan.cd12*eta )/det;
      var dp2 = ( tan.cd11*eta - tan.cd21*xi )/det;
      return { x: tan.crpix1 + dp1 - 1, y: tan.crpix2 + dp2 - 1 };
   }

   // ------------------------------------------------------------------------
   // Spherical geometry + FOV

   function angularSeparationDeg( ra1, dec1, ra2, dec2 )
   {
      // Haversine — stable for both small and large separations.
      var dRA = ( ra2 - ra1 )*DEG;
      var dDec = ( dec2 - dec1 )*DEG;
      var a = Math.sin( dDec/2 )*Math.sin( dDec/2 ) +
              Math.cos( dec1*DEG )*Math.cos( dec2*DEG )*Math.sin( dRA/2 )*Math.sin( dRA/2 );
      return 2*Math.atan2( Math.sqrt( a ), Math.sqrt( 1 - a ) )/DEG;
   }

   function positionAngleDeg( ra1, dec1, ra2, dec2 )
   {
      // Position angle of point 2 as seen from point 1, degrees east of
      // north, normalized to (-180, 180].
      var dRA = ( ra2 - ra1 )*DEG;
      var d1 = dec1*DEG, d2 = dec2*DEG;
      var y = Math.sin( dRA )*Math.cos( d2 );
      var x = Math.cos( d1 )*Math.sin( d2 ) - Math.sin( d1 )*Math.cos( d2 )*Math.cos( dRA );
      var pa = Math.atan2( y, x )/DEG;
      if ( pa <= -180 ) pa += 360;
      if ( pa > 180 ) pa -= 360;
      return pa;
   }

   function fovFromProjector( project, width, height )
   {
      // FOV descriptor from any pixel-to-sky projector: center, angular
      // width/height along the image axes, rotation = position angle of the
      // image "up" direction (decreasing y) east of north.
      if ( !project || !( width > 1 ) || !( height > 1 ) )
         return null;
      var cx = ( width - 1 )/2, cy = ( height - 1 )/2;
      var c = project( cx, cy );
      if ( !c )
         return null;
      var l = project( 0, cy ), r = project( width - 1, cy );
      var t = project( cx, 0 ), b = project( cx, height - 1 );
      var widthDeg = ( l && r ) ? angularSeparationDeg( l.raDeg, l.decDeg, r.raDeg, r.decDeg ) : null;
      var heightDeg = ( t && b ) ? angularSeparationDeg( t.raDeg, t.decDeg, b.raDeg, b.decDeg ) : null;
      var up = project( cx, cy - Math.max( 1, height/4 ) );
      var rotationDeg = up ? positionAngleDeg( c.raDeg, c.decDeg, up.raDeg, up.decDeg ) : null;
      return { raDeg: c.raDeg, decDeg: c.decDeg, widthDeg: widthDeg, heightDeg: heightDeg,
               rotationDeg: rotationDeg, hasWcs: true };
   }

   function approxFov( raDeg, decDeg, pixScaleArcsec, width, height )
   {
      // Approximate FOV: known center, size from the plate scale, unknown
      // rotation. hasWcs false marks this as time-window only for matching.
      if ( raDeg === null || decDeg === null || !( pixScaleArcsec > 0 ) || !( width > 0 ) || !( height > 0 ) )
         return null;
      return { raDeg: raDeg, decDeg: decDeg,
               widthDeg: pixScaleArcsec*width/3600,
               heightDeg: pixScaleArcsec*height/3600,
               rotationDeg: null, hasWcs: false };
   }

   return {
      parseNumber: parseNumber,
      parseSexagesimal: parseSexagesimal,
      parseHoursToDeg: parseHoursToDeg,
      parseRaDeg: parseRaDeg,
      parseDateObs: parseDateObs,
      pixScaleFromKeywords: pixScaleFromKeywords,
      tanParamsFromKeywords: tanParamsFromKeywords,
      tanImageToCelestial: tanImageToCelestial,
      tanCelestialToImage: tanCelestialToImage,
      angularSeparationDeg: angularSeparationDeg,
      positionAngleDeg: positionAngleDeg,
      fovFromProjector: fovFromProjector,
      approxFov: approxFov
   };
} )();

// ---------------------------------------------------------------------------

var SIFrameMeta = ( function()
{
   var Core = SIFrameMetaCore;

   function basename( path )
   {
      var s = String( path );
      return s.split( "/" ).pop().split( "\\" ).pop();
   }

   function readKeywords( window )
   {
      // Raw name -> strippedValue map. PI extracts the keywords when the
      // file is opened; the first occurrence of a name wins.
      var map = {};
      try
      {
         var keywords = window.keywords;
         for ( var i = 0; i < keywords.length; ++i )
         {
            var name = keywords[i].name.trim();
            if ( map[name] === undefined )
               map[name] = keywords[i].strippedValue.trim();
         }
      }
      catch ( e )
      {
         try { console.warningln( "FrameMeta: cannot read keywords: " + e.message ); } catch ( e2 ) {}
      }
      return map;
   }

   function normalizeSkyPoint( r )
   {
      // window.imageToCelestial may return a Point, an array or an object,
      // depending on the core version — normalize to { raDeg, decDeg }.
      if ( r === null || r === undefined )
         return null;
      var ra = null, dec = null;
      if ( typeof r.x === "number" && typeof r.y === "number" )
      {
         ra = r.x; dec = r.y;
      }
      else if ( typeof r.length === "number" && r.length >= 2 )
      {
         ra = r[0]; dec = r[1];
      }
      if ( ra === null || dec === null || !isFinite( ra ) || !isFinite( dec ) ||
           dec < -90.000001 || dec > 90.000001 )
         return null;
      ra -= 360*Math.floor( ra/360 );
      return { raDeg: ra, decDeg: dec };
   }

   function makeSolutionProjector( window, width, height )
   {
      // Probe the astrometric-solution API defensively: availability and
      // shapes vary across core versions (see PJSR-NOTES). Returns a
      // ( x, y ) -> { raDeg, decDeg } | null function, or null.
      try
      {
         if ( !window || typeof window.imageToCelestial !== "function" )
            return null;

         var hasSolution = false;
         try
         {
            var s = window.astrometricSolution;
            if ( typeof s === "function" )
               s = s.call( window );
            hasSolution = ( s !== null && s !== undefined && s !== false );
         }
         catch ( e ) {}
         if ( !hasSolution )
         {
            try { hasSolution = ( window.hasAstrometricSolution === true ); } catch ( e ) {}
         }
         if ( !hasSolution )
            return null;

         var call = null;
         var projector = function( x, y )
         {
            try
            {
               var r;
               if ( call === "xy" )
                  r = window.imageToCelestial( x, y );
               else if ( call === "point" )
                  r = window.imageToCelestial( new Point( x, y ) );
               else
               {
                  try { r = window.imageToCelestial( x, y ); call = "xy"; }
                  catch ( e ) { r = window.imageToCelestial( new Point( x, y ) ); call = "point"; }
               }
               return normalizeSkyPoint( r );
            }
            catch ( e )
            {
               return null;
            }
         };

         // Probe at the image center: the projector must yield a valid point.
         if ( projector( ( width - 1 )/2, ( height - 1 )/2 ) === null )
            return null;
         return projector;
      }
      catch ( e )
      {
         return null;
      }
   }

   function normalizeImagePoint( r, width, height )
   {
      // window.celestialToImage may return a Point or an [x,y] array. Accept
      // it only when the pixel lands on (or very near) the image.
      if ( r === null || r === undefined )
         return null;
      var x = null, y = null;
      if ( typeof r.x === "number" && typeof r.y === "number" )
      {
         x = r.x; y = r.y;
      }
      else if ( typeof r.length === "number" && r.length >= 2 )
      {
         x = r[0]; y = r[1];
      }
      if ( x === null || y === null || !isFinite( x ) || !isFinite( y ) )
         return null;
      return { x: x, y: y };
   }

   function makeSolutionInverse( window, width, height, forwardProjector )
   {
      // Probe window.celestialToImage defensively, mirroring the
      // makeSolutionProjector style: availability, ( ra, dec ) vs Point
      // argument shape and return shape all vary across core versions.
      // Verified by round-tripping the image center through the forward
      // projector before it is trusted.
      try
      {
         if ( !window || typeof window.celestialToImage !== "function" )
            return null;

         var call = null;
         var inverse = function( raDeg, decDeg )
         {
            try
            {
               var r;
               if ( call === "radec" )
                  r = window.celestialToImage( raDeg, decDeg );
               else if ( call === "point" )
                  r = window.celestialToImage( new Point( raDeg, decDeg ) );
               else
               {
                  try { r = window.celestialToImage( raDeg, decDeg ); call = "radec"; }
                  catch ( e ) { r = window.celestialToImage( new Point( raDeg, decDeg ) ); call = "point"; }
               }
               return normalizeImagePoint( r, width, height );
            }
            catch ( e )
            {
               return null;
            }
         };

         // Round-trip the image center: forward to sky, back to pixels.
         if ( forwardProjector && width > 1 && height > 1 )
         {
            var cx = ( width - 1 )/2, cy = ( height - 1 )/2;
            var sky = forwardProjector( cx, cy );
            if ( !sky )
               return null;
            var back = inverse( sky.raDeg, sky.decDeg );
            if ( back === null ||
                 Math.abs( back.x - cx ) > Math.max( 2, width*0.02 ) ||
                 Math.abs( back.y - cy ) > Math.max( 2, height*0.02 ) )
               return null;
         }
         return inverse;
      }
      catch ( e )
      {
         return null;
      }
   }

   function firstAngle( kw, names )
   {
      for ( var i = 0; i < names.length; ++i )
      {
         var v = Core.parseSexagesimal( kw[names[i]] );
         if ( v !== null )
            return v;
      }
      return null;
   }

   function read( window, filePath )
   {
      var kw = readKeywords( window );

      var width = 0, height = 0;
      try
      {
         var img = window.mainView.image;
         width = img.width;
         height = img.height;
      }
      catch ( e ) {}

      // --- Exposure and epoch ---
      var exposureSec = Core.parseNumber( kw["EXPTIME"] );
      if ( exposureSec === null )
         exposureSec = Core.parseNumber( kw["EXPOSURE"] );
      var dateObs = Core.parseDateObs( kw["DATE-OBS"] );

      // --- Observer site ---
      var latDeg = firstAngle( kw, [ "SITELAT", "OBSGEO-B", "LAT-OBS" ] );
      var lonDeg = firstAngle( kw, [ "SITELONG", "OBSGEO-L", "LONG-OBS" ] );
      var altM = firstAngle( kw, [ "SITEELEV", "OBSGEO-H", "ALT-OBS" ] );
      var observer = ( latDeg !== null && lonDeg !== null )
         ? { latDeg: latDeg, lonDeg: lonDeg, altM: ( altM !== null ) ? altM : 0 }
         : null;

      // --- WCS resolution: solution > manual TAN > approx > none ---
      var kind = "none";
      var projector = makeSolutionProjector( window, width, height );
      var tan = null;
      if ( projector !== null )
         kind = "solution";
      else
      {
         tan = Core.tanParamsFromKeywords( kw );
         if ( tan !== null )
         {
            kind = "tan";
            projector = function( x, y )
            {
               return Core.tanImageToCelestial( tan, x, y );
            };
         }
      }

      // --- Plate scale: XPIXSZ + FOCALLEN, else derive from the WCS ---
      var pixScaleArcsec = Core.pixScaleFromKeywords(
         Core.parseNumber( kw["XPIXSZ"] ), Core.parseNumber( kw["FOCALLEN"] ) );
      if ( pixScaleArcsec === null && projector !== null && width > 1 )
      {
         var cy = ( height - 1 )/2;
         var a = projector( width/2 - 1, cy ), b = projector( width/2, cy );
         if ( a && b )
            pixScaleArcsec = Core.angularSeparationDeg( a.raDeg, a.decDeg, b.raDeg, b.decDeg )*3600;
      }

      // --- Approximate center for the no-WCS fallback ---
      var approxRa = null, approxDec = null;
      if ( kind === "none" )
      {
         approxRa = Core.parseRaDeg( kw["RA"] );
         if ( approxRa === null )
            approxRa = Core.parseHoursToDeg( kw["OBJCTRA"] );  // hours!
         approxDec = Core.parseSexagesimal( kw["DEC"] );
         if ( approxDec === null )
            approxDec = Core.parseSexagesimal( kw["OBJCTDEC"] );
         if ( approxRa !== null && approxDec !== null &&
              Core.approxFov( approxRa, approxDec, pixScaleArcsec, width, height ) !== null )
            kind = "approx";
      }

      // --- Inverse projector: sky -> pixels, for placing catalog objects ---
      var inverse = null;
      if ( kind === "solution" )
         inverse = makeSolutionInverse( window, width, height, projector );
      else if ( kind === "tan" && tan !== null )
         inverse = function( raDeg, decDeg )
         {
            return Core.tanCelestialToImage( tan, raDeg, decDeg );
         };

      var fovCached = null, fovComputed = false;
      var wcs = {
         kind: kind,
         imageToCelestial: ( projector !== null )
            ? projector
            : function( x, y ) { return null; },
         celestialToImage: ( inverse !== null )
            ? inverse
            : function( raDeg, decDeg ) { return null; },
         fov: function()
         {
            if ( !fovComputed )
            {
               fovComputed = true;
               if ( kind === "solution" || kind === "tan" )
                  fovCached = Core.fovFromProjector( projector, width, height );
               else if ( kind === "approx" )
                  fovCached = Core.approxFov( approxRa, approxDec, pixScaleArcsec, width, height );
               else
                  fovCached = null;
            }
            return fovCached;
         }
      };

      return {
         path: String( filePath ),
         id: basename( filePath ),
         dateObs: dateObs,
         exposureSec: exposureSec,
         observer: observer,
         pixScaleArcsec: pixScaleArcsec,
         keywords: kw,
         wcs: wcs
      };
   }

   return { read: read };
} )();
