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
   // Display autostretch. Astro frames are linear and render near-black. This
   // is the PixInsight STF/MTF auto-stretch: a robust shadows clip plus a
   // midtones transfer that lands the background at a target level — adaptive
   // and gentle (no blown highlights), unlike a hard linear rescale.

   function normalizedMAD( image )
   {
      try
      {
         if ( typeof image.MAD === "function" )
         {
            var m = image.MAD()*1.4826;
            if ( m > 0 )
               return m;
         }
      }
      catch ( e ) {}
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

   function beginNoSwap( view )
   {
      if ( typeof UndoFlag_NoSwapFile !== "undefined" )
         view.beginProcess( UndoFlag_NoSwapFile );
      else
         view.beginProcess();
   }

   // Midtones balance that maps a clipped-median x to a target background,
   // derived from the MTF: for target 0.25 the closed form is 3x/(2x+1).
   function midtonesForTarget( x, targetBg )
   {
      if ( !( x > 0 ) )
         return 0;
      if ( x >= 1 )
         return 1;
      var t = ( targetBg > 0 && targetBg < 1 ) ? targetBg : 0.25;
      // Solve MTF(m,x)=t  ->  m = ((t-1)x) / ((2t-1)x - t).
      var denom = ( 2*t - 1 )*x - t;
      if ( denom === 0 )
         return 0.5;
      var m = ( ( t - 1 )*x )/denom;
      return clamp01( m );
   }

   function stretchedBitmap( image, options )
   {
      options = options || {};
      var targetBg = ( options.targetBg > 0 ) ? options.targetBg : 0.25;
      var shadowsClip = ( typeof options.shadowsClip === "number" ) ? options.shadowsClip : -2.8;

      var medN;
      try { medN = image.median(); }
      catch ( e ) { medN = 0.1; }
      var madN = normalizedMAD( image );
      if ( !( madN > 0 ) )
         madN = 0.02;

      // STF auto-stretch parameters: shadows clip at median + C*MADn, midtones
      // that carry the clipped median to the target background.
      var c0 = clamp01( medN + shadowsClip*madN );
      var span = 1 - c0;
      var xMed = ( span > 0 ) ? ( medN - c0 )/span : medN;
      xMed = clamp01( xMed );
      var mid = midtonesForTarget( xMed, targetBg );

      // Apply through HistogramTransformation (C++), which is a real MTF, on a
      // throwaway window holding a copy of the image.
      if ( typeof HistogramTransformation !== "undefined" && typeof ImageWindow !== "undefined" )
      {
         var win = null;
         try
         {
            var ch = image.numberOfChannels;
            var isColor = ch >= 3;
            win = new ImageWindow( image.width, image.height, ch, 32, true, isColor, safeId( "SI_stretch" ) );
            var v = win.mainView;
            beginNoSwap( v );
            v.image.assign( image );
            v.endProcess();

            var Ht = new HistogramTransformation;
            var Hm = Ht.H;
            for ( var r = 0; r < Hm.length; ++r )
               Hm[ r ] = [ 0, 0.5, 1, 0, 1 ];
            // Rows: R, G, B, RGB/K, Alpha. Stretch the color rows and the K row
            // so both color and grayscale images get the same linked stretch.
            var stretchRow = [ c0, mid, 1, 0, 1 ];
            Hm[ 0 ] = stretchRow; Hm[ 1 ] = stretchRow; Hm[ 2 ] = stretchRow; Hm[ 3 ] = stretchRow;
            Ht.H = Hm;
            Ht.executeOn( v, false );

            var bmp = v.image.render();
            win.forceClose();
            win = null;
            return bmp;
         }
         catch ( e )
         {
            try { if ( win != null ) win.forceClose(); } catch ( e2 ) {}
            try { console.warningln( "SIRender.stretchedBitmap (STF): " + e.message ); } catch ( e3 ) {}
         }
      }

      // Fallback: a plain shadows-clip + linear rescale in the engine.
      try
      {
         var w = new Image( image );
         var lo = c0, hi = clamp01( medN + 8.0*madN );
         if ( hi <= lo ) hi = clamp01( lo + 0.05 );
         if ( typeof ImageOp !== "undefined" && lo > 0 )
            w.apply( lo, ImageOp.Sub );
         if ( typeof ImageOp !== "undefined" && ( hi - lo ) > 0 )
            w.apply( 1.0/( hi - lo ), ImageOp.Mul );
         if ( typeof w.truncate === "function" )
            w.truncate( 0, 1 );
         return w.render();
      }
      catch ( e4 )
      {
         return image.render();
      }
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

      // Default marker/label sizes scale with the image so they stay legible
      // once the map is viewed or downscaled (a 9 px circle vanishes on a
      // 6000 px frame). Caller can override any of these.
      var longSide = Math.max( bmp.width, bmp.height );
      var r = ( opts.radius > 0 ) ? opts.radius : Math.max( 10, Math.round( longSide/110 ) );
      var pw = ( opts.penWidth > 0 ) ? opts.penWidth : Math.max( 2, Math.round( longSide/900 ) );
      var fontSize = ( opts.fontSize > 0 ) ? opts.fontSize : Math.max( 12, Math.round( longSide/90 ) );
      var ldx = ( typeof opts.labelDx === "number" ) ? opts.labelDx : ( r + Math.round( r*0.4 ) );
      var ldy = ( typeof opts.labelDy === "number" ) ? opts.labelDy : -Math.round( r*0.4 );
      var halo = hexToArgb( "#000000", 0xb8 ); // ~72% opaque dark outline
      var haloW = Math.max( 3, pw + Math.round( fontSize/5 ) );

      var g = new Graphics( bmp );
      try
      {
         g.antialiasing = true;
         try { g.font = new Font( "SansSerif", fontSize ); } catch ( e ) {}

         marks = marks || [];
         for ( var i = 0; i < marks.length; ++i )
         {
            var m = marks[ i ];
            if ( m === null || m === undefined )
               continue;
            var col = hexToArgb( m.color || "#ffffff" );

            // Dark outline behind the glyph, then the bright glyph on top —
            // readable over both empty sky and bright nebulosity.
            g.pen = new Pen( halo, haloW );
            drawGlyph( g, m.glyph, m.x, m.y, r );
            g.pen = new Pen( col, pw );
            drawGlyph( g, m.glyph, m.x, m.y, r );

            if ( m.label )
            {
               var lx = m.x + ldx, ly = m.y + ldy;
               var s = String( m.label );
               // Halo: the label drawn in dark at 8 offsets, then bright.
               g.pen = new Pen( halo, 1 );
               var o = Math.max( 1, Math.round( fontSize/12 ) );
               var offs = [ [-o,-o],[o,-o],[-o,o],[o,o],[0,-o],[0,o],[-o,0],[o,0] ];
               for ( var k = 0; k < offs.length; ++k )
                  g.drawText( lx + offs[ k ][ 0 ], ly + offs[ k ][ 1 ], s );
               g.pen = new Pen( hexToArgb( m.labelColor || m.color || "#e6ebf2" ), 1 );
               g.drawText( lx, ly, s );
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
    * annotateTrails( baseBitmap, items, opts ) -> a NEW Bitmap with each
    * trail highlighted (glow line over the actual streak) and labeled near
    * its midpoint. items: [ { x1, y1, x2, y2, color, label } ]. Sizes scale
    * with the image like annotateField; labels get the same 8-offset dark
    * halo so they stay readable over nebulosity.
    */
   function annotateTrails( baseBitmap, items, opts )
   {
      opts = opts || {};
      var bmp = new Bitmap( baseBitmap );
      var longSide = Math.max( bmp.width, bmp.height );
      var lw = ( opts.lineWidth > 0 ) ? opts.lineWidth : Math.max( 2, Math.round( longSide/1300 ) );
      var fontSize = ( opts.fontSize > 0 ) ? opts.fontSize : Math.max( 12, Math.round( longSide/114 ) );
      var halo = hexToArgb( "#000000", 0xb8 );

      // Country flags (circle-flags SVGs) rendered at text height, cached
      // per code. opts.flagDir points at the assets/flags directory.
      var flagSize = Math.round( fontSize*1.15 );
      var flagCache = {};
      function flagBitmap( code )
      {
         if ( !opts.flagDir || !code )
            return null;
         if ( flagCache[ code ] !== undefined )
            return flagCache[ code ];
         var out = null;
         try
         {
            var p = opts.flagDir + "/" + code + ".svg";
            if ( File.exists( p ) )
               out = scaleBitmap( new Bitmap( p ), flagSize, flagSize );
         }
         catch ( e )
         {
            out = null;
         }
         flagCache[ code ] = out;
         return out;
      }

      var font = null;
      try { font = new Font( "SansSerif", fontSize ); } catch ( e ) {}
      function textWidth( s )
      {
         try
         {
            if ( font && typeof font.width === "function" )
               return font.width( s );
         }
         catch ( e ) {}
         return s.length*fontSize*0.62; // fallback estimate
      }

      var g = new Graphics( bmp );
      try
      {
         g.antialiasing = true;
         if ( font )
            try { g.font = font; } catch ( e ) {}

         items = items || [];
         for ( var i = 0; i < items.length; ++i )
         {
            var t = items[ i ];
            if ( t === null || t === undefined )
               continue;
            var col = hexToArgb( t.color || "#22d3ee" );

            // Wide translucent glow so the (often faint) streak underneath
            // stays visible, then a thin bright line right on it.
            g.pen = new Pen( withAlpha( col, 0x46 ), lw*5 + 2 );
            g.drawLine( t.x1, t.y1, t.x2, t.y2 );
            g.pen = new Pen( withAlpha( col, 0xcc ), lw );
            g.drawLine( t.x1, t.y1, t.x2, t.y2 );

            if ( t.label )
            {
               // Label at the midpoint, pushed off the line along the
               // perpendicular; the WHOLE box (flag + text, measured) is
               // clamped inside the frame.
               var s = String( t.label );
               var flag = flagBitmap( t.flag );
               var flagAdvance = ( flag !== null ) ? flagSize + Math.round( fontSize*0.35 ) : 0;
               var boxW = flagAdvance + textWidth( s );
               var margin = Math.round( fontSize*0.6 );

               var mx = ( t.x1 + t.x2 )/2, my = ( t.y1 + t.y2 )/2;
               var dx = t.x2 - t.x1, dy = t.y2 - t.y1;
               var len = Math.max( 1e-6, Math.sqrt( dx*dx + dy*dy ) );
               var off = fontSize*1.4;
               var lx = mx + ( -dy/len )*off, ly = my + ( dx/len )*off;
               lx = Math.max( margin, Math.min( bmp.width - boxW - margin, lx ) );
               ly = Math.max( fontSize*1.5, Math.min( bmp.height - fontSize, ly ) );

               if ( flag !== null )
                  // drawText's y is the BASELINE; center the flag on the
                  // lowercase body of the text.
                  g.drawBitmap( Math.round( lx ),
                                Math.round( ly - fontSize*0.82 - ( flagSize - fontSize )/2 ),
                                flag );

               var tx = lx + flagAdvance;
               g.pen = new Pen( halo, 1 );
               var o = Math.max( 1, Math.round( fontSize/12 ) );
               var offs = [ [-o,-o],[o,-o],[-o,o],[o,o],[0,-o],[0,o],[-o,0],[o,0] ];
               for ( var k = 0; k < offs.length; ++k )
                  g.drawText( tx + offs[ k ][ 0 ], ly + offs[ k ][ 1 ], s );
               g.pen = new Pen( col, 1 );
               g.drawText( tx, ly, s );
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

   // Register a set of frame files to the first one with StarAlignment so a
   // dithered/rotated session can be pixel-combined. Returns a list of file
   // paths on the reference grid ([reference] + successfully aligned targets),
   // or null if StarAlignment is unavailable. Frames that fail to register
   // (too few stars, clouds) are silently dropped.
   function registerFramesMapped( framePaths, outDir )
   {
      // StarAlignment of every frame onto framePaths[0], keeping the
      // input -> output correspondence: returns { ref, paths } where
      // paths[i] is the registered file for input i (paths[0] === ref,
      // failures are null), or null when registration is unavailable.
      if ( typeof StarAlignment === "undefined" || !framePaths || framePaths.length < 2 )
         return null;
      try
      {
         if ( !File.directoryExists( outDir ) )
            File.createDirectory( outDir, true );
         var ref = framePaths[ 0 ];
         var postfix = "_r";
         var SA = new StarAlignment;
         SA.referenceImage = ref;
         SA.referenceIsFile = true;
         SA.outputDirectory = outDir;
         SA.outputPostfix = postfix;
         SA.outputPrefix = "";
         SA.generateDrizzleData = false;
         SA.generateMasks = false;
         var targets = [];
         for ( var i = 1; i < framePaths.length; ++i )
            targets.push( [ true, true, framePaths[ i ] ] );
         SA.targets = targets;
         SA.executeGlobal();

         var paths = [ ref ];
         for ( var j = 1; j < framePaths.length; ++j )
         {
            var base = File.extractName( framePaths[ j ] );
            var cand = outDir + "/" + base + postfix + ".xisf";
            paths.push( File.exists( cand ) ? cand : null );
         }
         return { ref: ref, paths: paths };
      }
      catch ( e )
      {
         try { console.warningln( "SIRender.registerFramesMapped: " + e.message ); } catch ( e2 ) {}
         return null;
      }
   }

   function registerFrames( framePaths, outDir )
   {
      var m = registerFramesMapped( framePaths, outDir );
      if ( m === null )
         return framePaths ? framePaths.slice() : null;
      var out = [];
      for ( var i = 0; i < m.paths.length; ++i )
         if ( m.paths[ i ] !== null )
            out.push( m.paths[ i ] );
      return out;
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
      annotateTrails: annotateTrails,
      drawTrails: drawTrails,
      scaleBitmap: scaleBitmap,
      cropThumbnail: cropThumbnail,
      registerFrames: registerFrames,
      registerFramesMapped: registerFramesMapped,
      maxCombine: maxCombine,
      showBitmap: showBitmap,
      showImage: showImage
   };
} )();
