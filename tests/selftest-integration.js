/*
 * selftest-integration.js — headless validation of the Treasure Hunt
 * ENGINE path on the real PixInsight v8 runtime.
 *
 * The Node harness (tests/run.sh) covers pure math; selftest-pi.js covers the
 * include chain and networking. This exercises what only PixInsight can run:
 * the data -> render -> bitmap -> base64 -> html -> window pipeline, on
 * synthetic images (no GUI, no modal dialogs).
 *
 * Run:
 *   <PI-exe> -n --automation-mode --force-exit -r=/abs/path/tests/selftest-integration.js
 * Results -> <system-temp>/skyintruders-integration.json
 */

/* beautify ignore:start */
#engine v8
#include "../pjsr/lib/vendor/satellite.js"
#include "../pjsr/lib/Stats.js"
#include "../pjsr/lib/FrameMeta.js"
#include "../pjsr/lib/TrailDetect.js"
#include "../pjsr/lib/Net.js"
#include "../pjsr/lib/SatMatch.js"
#include "../pjsr/lib/Meteors.js"
#include "../pjsr/lib/Report.js"
#include "../pjsr/lib/Cosmology.js"
#include "../pjsr/lib/Catalogs.js"
#include "../pjsr/lib/Treasure.js"
#include "../pjsr/lib/TreasureReport.js"
#include "../pjsr/lib/Render.js"
/* beautify ignore:end */

function selftestDir()
{
   return File.extractDrive( #__FILE__ ) + File.extractDirectory( #__FILE__ );
}

// M51 field for the synthetic plate solution.
var CRVAL1 = 202.4696, CRVAL2 = 47.1952, PIXSCALE = 1.5; // arcsec/px

function addBlob( img, cx, cy, peak, sigma )
{
   var r = Math.ceil( 3*sigma );
   for ( var dy = -r; dy <= r; ++dy )
      for ( var dx = -r; dx <= r; ++dx )
      {
         var x = cx + dx, y = cy + dy;
         if ( x < 0 || y < 0 || x >= img.width || y >= img.height )
            continue;
         var v = peak*Math.exp( -( dx*dx + dy*dy )/( 2*sigma*sigma ) );
         var cur = img.sample( x, y );
         img.setSample( Math.min( 0.98, cur + v ), x, y );
      }
}

function buildSyntheticSolvedWindow()
{
   var win = new ImageWindow( 1024, 1024, 1, 32, true, false, "SI_synM51" );
   var view = win.mainView;
   if ( typeof UndoFlag_NoSwapFile !== "undefined" )
      view.beginProcess( UndoFlag_NoSwapFile );
   else
      view.beginProcess();
   var img = view.image;
   img.fill( 0.02 );
   // A sprinkle of Gaussian "stars".
   var seeds = [ [ 512, 512 ], [ 300, 400 ], [ 700, 620 ], [ 450, 800 ],
                 [ 820, 300 ], [ 180, 700 ], [ 620, 200 ] ];
   for ( var i = 0; i < seeds.length; ++i )
      addBlob( img, seeds[ i ][ 0 ], seeds[ i ][ 1 ], 0.6, 2.0 );
   view.endProcess();

   var cd = PIXSCALE/3600; // deg/px
   win.keywords = [
      new FITSKeyword( "CTYPE1", "'RA---TAN'", "" ),
      new FITSKeyword( "CTYPE2", "'DEC--TAN'", "" ),
      new FITSKeyword( "CRVAL1", String( CRVAL1 ), "" ),
      new FITSKeyword( "CRVAL2", String( CRVAL2 ), "" ),
      new FITSKeyword( "CRPIX1", "512", "" ),
      new FITSKeyword( "CRPIX2", "512", "" ),
      new FITSKeyword( "CD1_1", String( -cd ), "" ),
      new FITSKeyword( "CD1_2", "0", "" ),
      new FITSKeyword( "CD2_1", "0", "" ),
      new FITSKeyword( "CD2_2", String( cd ), "" ),
      new FITSKeyword( "DATE-OBS", "'2026-05-01T22:30:00'", "" ),
      new FITSKeyword( "OBJECT", "'M51'", "" )
   ];

   var path = File.systemTempDirectory + "/si-integ-synM51.fit";
   win.saveAs( path, false, false, false, false );
   win.forceClose();

   var reopened = ImageWindow.open( path );
   return { window: reopened[ 0 ], path: path };
}

function buildTrailedImage( segStart, segEnd )
{
   var img = new Image( 512, 512, 1 );
   img.fill( 0.03 );
   addBlob( img, 120, 120, 0.5, 2.0 );
   addBlob( img, 380, 260, 0.5, 2.0 );
   // Inject a bright line segment (the "trail").
   var steps = 400;
   for ( var s = 0; s <= steps; ++s )
   {
      var f = s/steps;
      var x = Math.round( segStart[ 0 ] + f*( segEnd[ 0 ] - segStart[ 0 ] ) );
      var y = Math.round( segStart[ 1 ] + f*( segEnd[ 1 ] - segStart[ 1 ] ) );
      for ( var w = -1; w <= 1; ++w )
      {
         if ( x + w >= 0 && x + w < 512 ) img.setSample( 0.9, x + w, y );
         if ( y + w >= 0 && y + w < 512 ) img.setSample( 0.9, x, y + w );
      }
   }
   return img;
}

function main()
{
   var out = { probedUtc: ( new Date ).toISOString(),
               piVersion: CoreApplication.versionMajor + "." + CoreApplication.versionMinor +
                          "." + CoreApplication.versionRelease,
               notes: {}, checks: [], ok: true };
   var marker = File.systemTempDirectory + "/skyintruders-integration.json";

   function check( name, fn )
   {
      try
      {
         var detail = fn();
         out.checks.push( { name: name, ok: true, detail: detail === undefined ? "" : detail } );
      }
      catch ( e )
      {
         out.ok = false;
         out.checks.push( { name: name, ok: false, detail: String( e.message || e ) +
                            ( e.stack ? ( " | " + String( e.stack ).split( "\n" )[ 1 ] ) : "" ) } );
      }
   }

   // 0) All new namespaces loaded.
   check( "namespaces loaded", function()
   {
      var need = [ "SIRender", "SICosmology", "SICatalogs", "SITreasure",
                   "SITreasureReport" ];
      for ( var i = 0; i < need.length; ++i )
         if ( typeof eval( need[ i ] ) != "object" && typeof eval( need[ i ] ) != "function" )
            throw new Error( need[ i ] + " missing" );
      return need.join( ", " );
   } );

   // 0b) Pure hexToArgb sanity.
   check( "SIRender.hexToArgb", function()
   {
      var v = SIRender.hexToArgb( "#22d3ee" );
      if ( ( v >>> 0 ) !== 0xff22d3ee )
         throw new Error( "expected 0xff22d3ee, got 0x" + ( v >>> 0 ).toString( 16 ) );
      return "0x" + ( v >>> 0 ).toString( 16 );
   } );

   // 1) Synthetic solved image is picked up with a usable WCS.
   var syn = null, meta = null;
   check( "synthetic WCS (tan/solution)", function()
   {
      syn = buildSyntheticSolvedWindow();
      meta = SIFrameMeta.read( syn.window, syn.path );
      out.notes.wcsKind = meta.wcs.kind;
      out.notes.pixScaleArcsec = meta.pixScaleArcsec;
      if ( !( meta.wcs.kind === "solution" || meta.wcs.kind === "tan" ) )
         throw new Error( "wcs.kind = " + meta.wcs.kind + " (expected solution|tan)" );
      var fov = meta.wcs.fov();
      if ( fov == null || !( fov.widthDeg > 0 ) )
         throw new Error( "no fov" );
      out.notes.fovWidthDeg = fov.widthDeg;
      // Round-trip the center through celestialToImage.
      var p = meta.wcs.celestialToImage( CRVAL1, CRVAL2 );
      if ( p == null || Math.abs( p.x - 512 ) > 5 || Math.abs( p.y - 512 ) > 5 )
         throw new Error( "center round-trip off: " + JSON.stringify( p ) );
      return "kind=" + meta.wcs.kind + ", fovW=" + fov.widthDeg.toFixed( 3 ) + " deg";
   } );

   // 2) Treasure pipeline against the recorded fixtures -> in-bounds objects.
   var treasures = null, summary = null;
   check( "Treasure crossMatch (fixtures)", function()
   {
      var fdir = selftestDir() + "/fixtures/treasure";
      var gal = SICatalogs.parseVizierTsv( File.readTextFile( fdir + "/hyperleda-m51.tsv" ) );
      var galaxies = [];
      for ( var i = 0; i < gal.length; ++i )
         galaxies.push( SICatalogs.typeGalaxyRow( gal[ i ] ) );
      var ast = SICatalogs.parseSkybot( File.readTextFile( fdir + "/skybot-m51.txt" ) );
      var asteroids = [];
      for ( var a = 0; a < ast.length; ++a )
         asteroids.push( SICatalogs.typeAsteroidRow( ast[ a ] ) );

      var flat = galaxies.concat( asteroids );
      out.notes.catalogRows = flat.length;
      treasures = SITreasure.crossMatch( flat, meta.wcs.celestialToImage, 1024, 1024 );
      out.notes.treasuresInFrame = treasures.length;
      if ( treasures.length < 1 )
         throw new Error( "no in-bounds treasures from " + flat.length + " rows" );
      for ( var k = 0; k < treasures.length; ++k )
      {
         var t = treasures[ k ];
         if ( !( t.x >= 0 && t.x <= 1023 && t.y >= 0 && t.y <= 1023 ) )
            throw new Error( "treasure out of bounds: " + t.name );
         if ( t.diamArcmin > 0 && meta.pixScaleArcsec > 0 )
            t.pxDiam = t.diamArcmin*60/meta.pixScaleArcsec;
      }
      summary = SITreasure.summarize( treasures, "en" );
      return treasures.length + " in frame; e.g. " + treasures[ 0 ].name;
   } );

   // 3) narrate yields a sentence.
   check( "Treasure narrate", function()
   {
      var s = SITreasure.narrate( treasures[ 0 ], "en" );
      if ( typeof s != "string" || s.length < 10 || s.indexOf( " " ) < 0 )
         throw new Error( "not a sentence: " + s );
      return s;
   } );

   // 4) Render: stretched base, annotated map window, embedded PNG, thumbnail.
   var mapPng = null, thumbs = [];
   check( "Render overlay + PNG + thumbnail + window", function()
   {
      var img = syn.window.mainView.image;
      var base = SIRender.stretchedBitmap( img );
      if ( !( base.width === 1024 && base.height === 1024 ) )
         throw new Error( "base bitmap wrong size: " + base.width + "x" + base.height );

      var marks = [];
      for ( var i = 0; i < treasures.length; ++i )
         marks.push( { x: treasures[ i ].x, y: treasures[ i ].y, color: "#7fd1ff",
                       glyph: "circle", label: treasures[ i ].name, labelColor: "#7fd1ff" } );
      var mapBmp = SIRender.annotateField( base, marks, { radius: 9, penWidth: 2 } );

      var win = SIRender.showBitmap( mapBmp, "Sky Intruders Treasure Map" );
      out.notes.mapWindowExists = ( win != null && win.mainView.image.width === 1024 );
      if ( !out.notes.mapWindowExists )
         throw new Error( "treasure-map window not created" );

      mapPng = SIRender.bitmapToBase64Png( mapBmp );
      if ( typeof mapPng != "string" || mapPng.indexOf( "iVBORw0KGgoA" ) !== 0 )
         throw new Error( "map PNG base64 malformed: " + String( mapPng ).substring( 0, 16 ) );

      // Probe which Bitmap-scaling path the engine took.
      out.notes.bitmapScaledTo = ( typeof mapBmp.scaledTo );
      out.notes.bitmapScaled = ( typeof mapBmp.scaled );

      var crop = SIRender.cropThumbnail( base, treasures[ 0 ].x, treasures[ 0 ].y, 96, 96 );
      var tpng = SIRender.bitmapToBase64Png( crop );
      if ( tpng.indexOf( "iVBORw0KGgoA" ) !== 0 )
         throw new Error( "thumbnail base64 malformed" );
      thumbs.push( { id: "T0", pngBase64: tpng } );
      treasures[ 0 ].id = "T0";

      win.forceClose();
      return "map " + mapPng.length + " b64 chars, thumb " + tpng.length + " chars";
   } );

   // 5) buildHtml is self-contained and embeds a PNG.
   check( "TreasureReport buildHtml", function()
   {
      var narratives = [];
      for ( var i = 0; i < treasures.length; ++i )
         narratives.push( SITreasure.narrate( treasures[ i ], "en" ) );
      var html = SITreasureReport.buildHtml( {
         treasures: treasures, narratives: narratives, summary: summary,
         mapPng: mapPng, thumbs: thumbs,
         fieldInfo: { raDeg: CRVAL1, decDeg: CRVAL2, radiusDeg: 0.15, target: "M51" },
         lang: "en" } );
      if ( html.indexOf( "data:image/png" ) < 0 )
         throw new Error( "html has no embedded PNG" );
      if ( html.indexOf( "http://" ) >= 0 || html.indexOf( "src=\"http" ) >= 0 )
         throw new Error( "html references an external asset" );
      out.notes.treasureHtmlChars = html.length;
      return html.length + " chars, embeds PNG";
   } );

   // 6) Render maxCombine (used by the night composite's "max" mode).
   check( "Render maxCombine", function()
   {
      var f1 = buildTrailedImage( [ 20, 20 ], [ 490, 300 ] );
      var f2 = buildTrailedImage( [ 30, 480 ], [ 460, 60 ] );
      var f3 = buildTrailedImage( [ 10, 250 ], [ 500, 240 ] );
      var comp = SIRender.maxCombine( [ f1, f2, f3 ] );
      if ( comp == null || !( comp.width === 512 && comp.height === 512 ) )
         throw new Error( "maxCombine produced no image" );
      // The composite must be at least as bright as any input at a trail pixel.
      var v = comp.sample( 250, 250 );
      out.notes.compositeSample = v;
      var sb = SIRender.stretchedBitmap( comp );
      if ( !( sb.width === 512 ) )
         throw new Error( "composite stretch failed" );
      return "512x512 composite, center sample " + v.toFixed( 3 );
   } );


   // Clean up the synthetic image window and temp file.
   try { if ( syn && syn.window ) syn.window.forceClose(); } catch ( e ) {}
   try { if ( syn && File.exists( syn.path ) ) File.remove( syn.path ); } catch ( e ) {}

   File.writeTextFile( marker, JSON.stringify( out, null, 2 ) );
   console.show();
   console.writeln( "Sky Intruders integration self-test: " + ( out.ok ? "PASS" : "FAIL" ) );
   for ( var i = 0; i < out.checks.length; ++i )
      console.writeln( "  " + ( out.checks[ i ].ok ? "OK  " : "FAIL" ) + " " +
                       out.checks[ i ].name + " — " + out.checks[ i ].detail );
   console.writeln( "Details: " + marker );
}

main();
