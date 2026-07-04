/*
 * Render.js — SIRender: the shared PixInsight rendering library for the
 * Treasure Hunt and Trash-to-Art modes (and any future consumer).
 *
 * This is PI-facing (Bitmap, Graphics, Image, ImageWindow, File) and is NOT
 * exercised by the Node harness. The single pure helper, hexToArgb, is kept
 * separable so it could be unit-tested in isolation. Everything is defensive
 * (typeof guards, try/catch) like the rest of the codebase: a rendering
 * hiccup degrades to a warning, never a crash of the whole run.
 *
 * NEVER write slash-star inside a comment (preprocessor trap).
 */

var SIRender = ( function()
{
   var tmpCounter = 0;

   // ------------------------------------------------------------------------
   // Pure helper: "#rrggbb" (or "#rgb") -> opaque uint32 ARGB. Separable and
   // side-effect free so it can be reasoned about and tested on its own.

   function hexToArgb( hex, alpha )
   {
      var a = ( typeof alpha === "number" ) ? ( alpha & 0xff ) : 0xff;
      if ( typeof hex !== "string" )
         return ( ( a << 24 ) | 0x000000 ) >>> 0;
      var h = hex.replace( "#", "" );
      if ( h.length === 3 )
         h = h.charAt( 0 ) + h.charAt( 0 ) + h.charAt( 1 ) + h.charAt( 1 ) +
             h.charAt( 2 ) + h.charAt( 2 );
      var r = parseInt( h.substring( 0, 2 ), 16 );
      var g = parseInt( h.substring( 2, 4 ), 16 );
      var b = parseInt( h.substring( 4, 6 ), 16 );
      if ( !isFinite( r ) ) r = 255;
      if ( !isFinite( g ) ) g = 255;
      if ( !isFinite( b ) ) b = 255;
      return ( ( a << 24 ) | ( r << 16 ) | ( g << 8 ) | b ) >>> 0;
   }

   function withAlpha( argb, alpha )
   {
      return ( ( ( alpha & 0xff ) << 24 ) | ( argb & 0x00ffffff ) ) >>> 0;
   }

   function clamp01( x )
   {
      return x < 0 ? 0 : ( x > 1 ? 1 : x );
   }

   function beginNoSwap( view )
   {
      // UndoFlag_NoSwapFile is a runtime global under the GUI but is not
      // injected under --automation-mode; fall back to the default flags.
      if ( typeof UndoFlag_NoSwapFile !== "undefined" )
         view.beginProcess( UndoFlag_NoSwapFile );
      else
         view.beginProcess();
   }

   function safeId( id )
   {
      // A view id must be a valid identifier: letters, digits, underscores,
      // not starting with a digit. Window "titles" with spaces/dashes are
      // sanitized to that form and uniquified so two results never clash.
      var s = String( id || "SI_Result" ).replace( /[^A-Za-z0-9_]+/g, "_" );
      if ( s.length === 0 || /^[0-9]/.test( s ) )
         s = "SI_" + s;
      return s + "_" + ( ++tmpCounter );
   }

   // ------------------------------------------------------------------------
   // Display autostretch. Astro frames are linear and render near-black; a
   // robust shadows-clip + linear rescale (staying inside the C++ engine via
   // Image.apply) makes the field visible. A display aid, not science.

   function normalizedMAD( image )
   {
      try
      {
         if ( typeof SIStats === "undefined" )
            return 0;
         var counts = SIStats.computeHistogramCounts( image );
         var medAdu = image.median()*65535;
         var madAdu = SIStats.histogramMAD( counts, medAdu );
         return madAdu/65535;
      }
      catch ( e )
      {
         return 0;
      }
   }

   function stretchedBitmap( image )
   {
      // Work on a writable copy (view images are read-only) and rescale the
      // interesting tonal range [med - 2 sigma, med + 8 sigma] into [0,1].
      var w;
      try { w = new Image( image ); }
      catch ( e ) { return image.render(); }

      var medN;
      try { medN = image.median(); }
      catch ( e ) { medN = 0.1; }
      var madN = normalizedMAD( image );
      if ( !( madN > 0 ) )
         madN = 0.02;

      var lo = clamp01( medN - 2.0*madN );
      var hi = clamp01( medN + 8.0*madN );
      if ( hi <= lo )
         hi = clamp01( lo + 0.05 );

      try
      {
         if ( typeof ImageOp !== "undefined" && lo > 0 )
            w.apply( lo, ImageOp.Sub );
         if ( typeof ImageOp !== "undefined" && ( hi - lo ) > 0 )
            w.apply( 1.0/( hi - lo ), ImageOp.Mul );
         if ( typeof w.truncate === "function" )
            w.truncate( 0, 1 );
         else if ( typeof w.rescale === "function" )
            w.rescale();
      }
      catch ( e )
      {
         try { console.warningln( "SIRender.stretchedBitmap: " + e.message ); } catch ( e2 ) {}
      }
      return w.render();
   }

   // ------------------------------------------------------------------------
   // PNG -> base64 (no "data:" prefix): save the bitmap to a temp PNG, read
   // it back as a ByteArray, base64-encode, delete the temp file.

   function bitmapToBase64Png( bitmap )
   {
      var tmp = File.systemTempDirectory + "/si-render-" +
                ( new Date ).getTime() + "-" + ( ++tmpCounter ) + ".png";
      try
      {
         bitmap.save( tmp );
         var ba = File.readFile( tmp );
         var b64 = ba.toBase64();
         return b64;
      }
      finally
      {
         try { if ( File.exists( tmp ) ) File.remove( tmp ); } catch ( e ) {}
      }
   }

   // ------------------------------------------------------------------------
   // Glyph drawing (Graphics has no strokeRect; squares/diamonds are lines).

   function drawGlyph( g, glyph, x, y, r )
   {
      if ( glyph === "square" )
      {
         g.drawLine( x - r, y - r, x + r, y - r );
         g.drawLine( x + r, y - r, x + r, y + r );
         g.drawLine( x + r, y + r, x - r, y + r );
         g.drawLine( x - r, y + r, x - r, y - r );
      }
      else if ( glyph === "diamond" )
      {
         g.drawLine( x, y - r, x + r, y );
         g.drawLine( x + r, y, x, y + r );
         g.drawLine( x, y + r, x - r, y );
         g.drawLine( x - r, y, x, y - r );
      }
      else // circle (default)
         g.strokeCircle( x, y, r );
   }

   /*
    * annotateField( baseBitmap, marks, opts ) -> a NEW Bitmap with markers
    * drawn on a copy of the base. marks: [ { x, y, color, glyph, label,
    * labelColor } ]. opts: { radius, penWidth, fontSize, labelDx, labelDy }.
    */
   function annotateField( baseBitmap, marks, opts )
   {
      opts = opts || {};
      var bmp = new Bitmap( baseBitmap );
      var g = new Graphics( bmp );
      try
      {
         g.antialiasing = true;
         var r = ( opts.radius > 0 ) ? opts.radius : 10;
         var pw = ( opts.penWidth > 0 ) ? opts.penWidth : 2;
         var fontSize = ( opts.fontSize > 0 ) ? opts.fontSize : 11;
         var ldx = ( typeof opts.labelDx === "number" ) ? opts.labelDx : ( r + 3 );
         var ldy = ( typeof opts.labelDy === "number" ) ? opts.labelDy : -( r + 1 );
         try { g.font = new Font( "SansSerif", fontSize ); } catch ( e ) {}

         marks = marks || [];
         for ( var i = 0; i < marks.length; ++i )
         {
            var m = marks[ i ];
            if ( m === null || m === undefined )
               continue;
            var col = hexToArgb( m.color || "#ffffff" );
            g.pen = new Pen( col, pw );
            drawGlyph( g, m.glyph, m.x, m.y, r );
            if ( m.label )
            {
               g.pen = new Pen( hexToArgb( m.labelColor || m.color || "#e6ebf2" ), 1 );
               g.drawText( m.x + ldx, m.y + ldy, String( m.label ) );
            }
         }
      }
      finally
      {
         g.end();
      }
      return bmp;
   }

   /*
    * drawTrails( baseBitmap, trails, opts ) -> a NEW Bitmap with each trail's
    * line segment drawn (trails carry x1,y1,x2,y2,color). opts.glow draws a
    * thick faint underlay then a thin bright line for a choreography look.
    */
   function drawTrails( baseBitmap, trails, opts )
   {
      opts = opts || {};
      var bmp = new Bitmap( baseBitmap );
      var g = new Graphics( bmp );
      try
      {
         g.antialiasing = true;
         var lw = ( opts.lineWidth > 0 ) ? opts.lineWidth : 2;
         var glow = ( opts.glow !== false );
         trails = trails || [];
         for ( var i = 0; i < trails.length; ++i )
         {
            var t = trails[ i ];
            if ( t === null || t === undefined )
               continue;
            var col = hexToArgb( t.color || "#22d3ee" );
            if ( glow )
            {
               g.pen = new Pen( withAlpha( col, 0x40 ), lw*3 + 2 );
               g.drawLine( t.x1, t.y1, t.x2, t.y2 );
            }
            g.pen = new Pen( col, lw );
            g.drawLine( t.x1, t.y1, t.x2, t.y2 );
         }
      }
      finally
      {
         g.end();
      }
      return bmp;
   }

   // ------------------------------------------------------------------------
   // Bitmap scaling with several fallbacks across core versions.

   function scaleBitmap( bmp, outW, outH )
   {
      try
      {
         if ( typeof bmp.scaledTo === "function" )
            return bmp.scaledTo( outW, outH );
      }
      catch ( e ) {}
      try
      {
         if ( typeof bmp.scaled === "function" )
            return bmp.scaled( outW/bmp.width, outH/bmp.height );
      }
      catch ( e ) {}
      var out = new Bitmap( outW, outH );
      out.fill( 0xff000000 );
      var g = new Graphics( out );
      try
      {
         g.antialiasing = true;
         if ( typeof g.drawScaledBitmap === "function" )
            g.drawScaledBitmap( new Rect( 0, 0, outW, outH ), bmp );
         else if ( typeof g.drawBitmap === "function" )
            g.drawBitmap( 0, 0, bmp );
      }
      finally
      {
         g.end();
      }
      return out;
   }

   /*
    * cropThumbnail( bitmap, cx, cy, boxPx, outPx ) -> a NEW Bitmap: a
    * boxPx-wide crop centered on (cx,cy), clamped to the source, scaled to
    * outPx x outPx.
    */
   function cropThumbnail( bitmap, cx, cy, boxPx, outPx )
   {
      var W = bitmap.width, H = bitmap.height;
      var half = Math.max( 4, Math.round( boxPx/2 ) );
      var x0 = Math.round( cx ) - half, y0 = Math.round( cy ) - half;
      var bw = half*2, bh = half*2;
      if ( x0 < 0 ) { bw += x0; x0 = 0; }
      if ( y0 < 0 ) { bh += y0; y0 = 0; }
      if ( x0 + bw > W ) bw = W - x0;
      if ( y0 + bh > H ) bh = H - y0;
      if ( bw < 1 || bh < 1 )
      {
         x0 = 0; y0 = 0;
         bw = Math.min( W, boxPx ); bh = Math.min( H, boxPx );
      }
      var sub = bitmap.subimage( x0, y0, bw, bh );
      return scaleBitmap( sub, outPx, outPx );
   }

   // ------------------------------------------------------------------------
   // Max-combine (lighten) star-trail composite. Accepts file paths, Images
   // or ImageWindows; opens paths one at a time and forceCloses them.

   function imageFromItem( item, opened )
   {
      if ( typeof item === "string" )
      {
         var wins = ImageWindow.open( item );
         if ( !wins || wins.length === 0 )
            return null;
         for ( var i = 1; i < wins.length; ++i )
            wins[ i ].forceClose();
         opened.win = wins[ 0 ];
         return wins[ 0 ].mainView.image;
      }
      if ( item && item.mainView && item.mainView.image )
         return item.mainView.image;
      return item; // assume it is already an Image
   }

   function maxCombine( items )
   {
      var acc = null;
      items = items || [];
      for ( var i = 0; i < items.length; ++i )
      {
         var opened = { win: null };
         try
         {
            var img = imageFromItem( items[ i ], opened );
            if ( img === null || img === undefined )
               continue;
            if ( acc === null )
               acc = new Image( img );
            else if ( img.width === acc.width && img.height === acc.height &&
                      img.numberOfChannels === acc.numberOfChannels )
               acc.apply( img, ImageOp.Max );
            else
               try { console.warningln( "SIRender.maxCombine: frame " + i +
                        " dimensions differ, skipped" ); } catch ( e2 ) {}
         }
         catch ( e )
         {
            try { console.warningln( "SIRender.maxCombine: " + e.message ); } catch ( e3 ) {}
         }
         finally
         {
            if ( opened.win !== null )
               try { opened.win.forceClose(); } catch ( e4 ) {}
         }
      }
      return acc;
   }

   // ------------------------------------------------------------------------
   // Show a Bitmap in a new ImageWindow (create + blit + show).

   function showBitmap( bitmap, id )
   {
      var w = bitmap.width, h = bitmap.height;
      var win = new ImageWindow( w, h, 3, 8, false, true, safeId( id ) );
      var view = win.mainView;
      beginNoSwap( view );
      var ok = false;
      try { view.image.blend( bitmap ); ok = true; }
      catch ( e )
      {
         try { view.image.blend( bitmap, new Point( 0, 0 ) ); ok = true; }
         catch ( e2 )
         {
            try { console.warningln( "SIRender.showBitmap blit: " + e2.message ); } catch ( e3 ) {}
         }
      }
      view.endProcess();
      win.show();
      try { if ( typeof win.zoomToFit === "function" ) win.zoomToFit(); } catch ( e4 ) {}
      return win;
   }

   // Show an Image directly in a new ImageWindow (used for max-combine).
   function showImage( image, id )
   {
      var color = ( image.numberOfChannels >= 3 );
      var win = new ImageWindow( image.width, image.height, image.numberOfChannels,
                                 32, true, color, safeId( id ) );
      beginNoSwap( win.mainView );
      try { win.mainView.image.assign( image ); }
      catch ( e )
      {
         try { console.warningln( "SIRender.showImage assign: " + e.message ); } catch ( e2 ) {}
      }
      win.mainView.endProcess();
      win.show();
      try { if ( typeof win.zoomToFit === "function" ) win.zoomToFit(); } catch ( e3 ) {}
      return win;
   }

   return {
      hexToArgb: hexToArgb,
      withAlpha: withAlpha,
      stretchedBitmap: stretchedBitmap,
      bitmapToBase64Png: bitmapToBase64Png,
      annotateField: annotateField,
      drawTrails: drawTrails,
      scaleBitmap: scaleBitmap,
      cropThumbnail: cropThumbnail,
      maxCombine: maxCombine,
      showBitmap: showBitmap,
      showImage: showImage
   };
} )();
