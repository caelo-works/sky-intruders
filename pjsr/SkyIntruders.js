/*
 * SkyIntruders.js — entry point.
 *
 * Who crossed your photo last night? Scans a night's light frames for trails,
 * identifies them (TLE cross-match with SGP4, meteor shower heuristics, slow
 * movers) and renders a night-log report with fun stats and a Reddit-ready
 * markdown post. Runs entirely in PixInsight — no external helper.
 */

/* beautify ignore:start */

#engine v8

#feature-id    Batch Processing > Sky Intruders
#feature-icon  @script_icons_dir/SkyIntruders.svg
#feature-info  Detect and identify satellite, meteor and asteroid trails in your light frames.

// Stamped by scripts/build-update-package.sh at packaging time.
#define SKYINTRUDERS_BUILD "__BUILD__"

// NEVER write slash-star inside a comment (preprocessor trap:
// it swallows everything to the next star-slash).
#include "lib/vendor/satellite.js"
#include "lib/Stats.js"
#include "lib/FrameMeta.js"
#include "lib/TrailDetect.js"
#include "lib/Net.js"
#include "lib/SatMatch.js"
#include "lib/Meteors.js"
#include "lib/Report.js"

#define SKYINTRUDERS_TITLE "Sky Intruders"

/* beautify ignore:end */

// ---------------------------------------------------------------------------
// Version gate — fail with a clear message instead of a cryptic v8 error.
function ensureMinimumVersion( maj, min, rel )
{
   var ok = ( CoreApplication.versionMajor > maj ) ||
            ( CoreApplication.versionMajor == maj && ( CoreApplication.versionMinor > min ||
              ( CoreApplication.versionMinor == min && CoreApplication.versionRelease >= rel ) ) );
   if ( !ok )
      throw new Error( SKYINTRUDERS_TITLE + " requires PixInsight " + maj + "." + min + "." + rel +
                       " or newer (this is " + CoreApplication.versionMajor + "." +
                       CoreApplication.versionMinor + "." + CoreApplication.versionRelease + ")." );
}

// ---------------------------------------------------------------------------
// Parameters, persisted as JSON (Settings-free: one less v8 API risk).

var DEFAULT_PARAMS = {
   kSigma: 5.0,
   minLengthFrac: 0.15,
   fillRatioMin: 0.6,
   maxTrails: 10,
   tleGroup: "active",
   tleMaxAgeHours: 12,
   tleBaseUrl: null,   // override to use a CelesTrak mirror
   matchMaxSepDeg: 0.2,
   matchMaxAngleDiffDeg: 12,
   stepSec: 1.0,
   detectAsteroids: true,
   maxSources: 600,
   lang: "en",
   observerLatDeg: null,   // fallbacks when FITS headers lack the site
   observerLonDeg: null,
   observerAltM: 0
};

function configDir()
{
   return File.homeDirectory + "/.caeloworks/sky-intruders";
}

function loadParams()
{
   var p = configDir() + "/settings.json";
   var out = JSON.parse( JSON.stringify( DEFAULT_PARAMS ) );
   try
   {
      if ( File.exists( p ) )
      {
         var saved = JSON.parse( File.readTextFile( p ) );
         for ( var k in out )
            if ( saved[ k ] !== undefined )
               out[ k ] = saved[ k ];
      }
   }
   catch ( e ) {}
   return out;
}

function saveParams( params )
{
   try
   {
      if ( !File.directoryExists( configDir() ) )
         File.createDirectory( configDir(), true );
      File.writeTextFile( configDir() + "/settings.json", JSON.stringify( params, null, 2 ) );
   }
   catch ( e )
   {
      console.warningln( SKYINTRUDERS_TITLE + ": could not save settings: " + e.message );
   }
}

// ---------------------------------------------------------------------------
// Analysis pipeline.

function analyzeFrame( filePath, params )
{
   var windows = ImageWindow.open( filePath );
   if ( windows.length == 0 )
      throw new Error( "cannot open " + filePath );
   var window = windows[ 0 ];
   try
   {
      for ( var i = 1; i < windows.length; ++i )
         windows[ i ].forceClose();

      var meta = SIFrameMeta.read( window, filePath );
      var det = SITrailDetect.detect( window.mainView.image, params );

      var w = window.mainView.image.width, h = window.mainView.image.height;
      var margin = Math.max( 8, Math.round( 0.03 * Math.max( w, h ) ) );
      function nearEdge( x, y )
      {
         return x <= margin || y <= margin || x >= w - margin || y >= h - margin;
      }
      for ( var t = 0; t < det.trails.length; ++t )
      {
         var tr = det.trails[ t ];
         tr.index = t;
         tr.spansEdgeToEdge = nearEdge( tr.x1, tr.y1 ) && nearEdge( tr.x2, tr.y2 );
         tr.p1 = meta.wcs.imageToCelestial ? meta.wcs.imageToCelestial( tr.x1, tr.y1 ) : null;
         tr.p2 = meta.wcs.imageToCelestial ? meta.wcs.imageToCelestial( tr.x2, tr.y2 ) : null;
      }

      // Point sources for asteroid tracking — only useful when we can turn
      // pixels into sky coordinates, so gate on a working WCS.
      var blobs = [];
      if ( meta.wcs.imageToCelestial && params.detectAsteroids )
         blobs = extractPointSources( window.mainView.image, meta.wcs, params );

      return { meta: meta, trails: det.trails, stats: det.stats, blobs: blobs };
   }
   finally
   {
      window.forceClose();
   }
}

// Extract the brightest compact sources and map them to sky coordinates.
// Capped so the O(n^2) mover search downstream stays cheap; movers are found
// among what does NOT recur frame to frame, so a generous cap is fine.
function extractPointSources( image, wcs, params )
{
   var sd = new StarDetector;
   sd.structureLayers = 5;
   sd.applyHotPixelFilter = true;
   sd.upperLimit = 1.0; // keep bright stars too (we filter by motion, not flux)
   var stars = sd.stars( image );

   var list = [];
   for ( var i = 0; i < stars.length; ++i )
   {
      var s = stars[ i ];
      var px = ( s.pos != null ) ? s.pos.x : s.x;
      var py = ( s.pos != null ) ? s.pos.y : s.y;
      var sky = wcs.imageToCelestial( px, py );
      if ( sky != null )
         list.push( { raDeg: sky.raDeg, decDeg: sky.decDeg,
                      fluxAdu: ( s.flux || 0 ) * 65535, x: px, y: py } );
   }
   list.sort( function( a, b ) { return b.fluxAdu - a.fluxAdu; } );
   var cap = params.maxSources || 600;
   return ( list.length > cap ) ? list.slice( 0, cap ) : list;
}

function buildMatchRequest( frames, observer, params )
{
   var req = { observer: observer, frames: [], options: {
      stepSec: params.stepSec,
      matchMaxSepDeg: params.matchMaxSepDeg,
      matchMaxAngleDiffDeg: params.matchMaxAngleDiffDeg } };
   for ( var i = 0; i < frames.length; ++i )
   {
      var f = frames[ i ];
      if ( f.meta.dateObs == null || f.meta.exposureSec == null )
         continue;
      var fov = f.meta.wcs.fov();
      if ( fov == null )
         continue;
      var trails = [];
      for ( var t = 0; t < f.trails.length; ++t )
         trails.push( { index: f.trails[ t ].index,
                        p1: f.trails[ t ].p1, p2: f.trails[ t ].p2,
                        pixLength: f.trails[ t ].lengthPx,
                        meanFluxAdu: f.trails[ t ].meanFluxAdu,
                        widthPx: f.trails[ t ].widthPx,
                        brightnessVariation: f.trails[ t ].brightnessVariation } );
      req.frames.push( { id: f.meta.id,
                         startUtc: f.meta.dateObs.toISOString(),
                         exposureSec: f.meta.exposureSec,
                         fov: fov, trails: trails } );
   }
   return req;
}

function nightLabel( frames )
{
   var dates = [];
   for ( var i = 0; i < frames.length; ++i )
      if ( frames[ i ].meta.dateObs != null )
         dates.push( frames[ i ].meta.dateObs );
   if ( dates.length == 0 )
      return "(undated)";
   dates.sort( function( a, b ) { return a - b; } );
   function ymd( d )
   {
      return d.getFullYear() + "-" +
             ( d.getMonth() < 9 ? "0" : "" ) + ( d.getMonth() + 1 ) + "-" +
             ( d.getDate() < 10 ? "0" : "" ) + d.getDate();
   }
   var a = ymd( dates[ 0 ] ), b = ymd( dates[ dates.length - 1 ] );
   return ( a == b ) ? a : a + "/" + b.substring( 8 );
}

function runAnalysis( files, params )
{
   var frames = [];
   for ( var i = 0; i < files.length; ++i )
   {
      console.writeln( format( "<b>[%d/%d]</b> ", i + 1, files.length ) + files[ i ] );
      try
      {
         var r = analyzeFrame( files[ i ], params );
         frames.push( r );
         if ( r.trails.length > 0 )
            console.writeln( format( "   %d trail(s), background %.1f ADU, noise %.1f ADU",
                                     r.trails.length, r.stats.medianAdu, r.stats.madAdu ) );
      }
      catch ( e )
      {
         console.warningln( "   skipped: " + e.message );
      }
      processEvents();
   }
   if ( frames.length == 0 )
      throw new Error( "no frame could be analyzed" );

   // Observer site: headers first, dialog fallback second.
   var observer = null;
   for ( var i = 0; i < frames.length; ++i )
      if ( frames[ i ].meta.observer != null )
      {
         observer = frames[ i ].meta.observer;
         break;
      }
   if ( observer == null && params.observerLatDeg != null && params.observerLonDeg != null )
      observer = { latDeg: params.observerLatDeg, lonDeg: params.observerLonDeg,
                   altM: params.observerAltM || 0 };

   // TLE cross-match through the sidecar; degrade gracefully without it.
   var matchResponse = null, tleInfo = null;
   if ( observer == null )
      console.warningln( SKYINTRUDERS_TITLE + ": no observer site (SITELAT/SITELONG headers " +
                         "or dialog fallback) — satellite identification disabled." );
   else
      try
      {
         console.writeln( "Fetching TLE catalog (group: " + params.tleGroup + ")…" );
         tleInfo = SITleNet.fetchTle( params.tleGroup, configDir() + "/tle",
                                      params.tleMaxAgeHours, params.tleBaseUrl );
         console.writeln( format( "   %d satellites, %s%s", tleInfo.count,
                                  tleInfo.fromCache ? "from cache" : "fresh download",
                                  tleInfo.stale ? " (STALE — network unreachable)" : "" ) );
         var req = buildMatchRequest( frames, observer, params );
         if ( req.frames.length > 0 )
         {
            console.writeln( "Cross-matching " + req.frames.length + " frame window(s)…" );
            matchResponse = SISatMatch.match( req, File.readTextFile( tleInfo.tlePath ) );
         }
      }
      catch ( e )
      {
         console.warningln( SKYINTRUDERS_TITLE + ": TLE matching unavailable — " + e.message );
      }

   // Merge crossings + heuristics into events.
   var events = [];
   var crossingsByFrame = {};
   if ( matchResponse != null )
      for ( var i = 0; i < matchResponse.frames.length; ++i )
         crossingsByFrame[ matchResponse.frames[ i ].id ] = matchResponse.frames[ i ].crossings || [];

   var cleanFrames = 0, totalExposureSec = 0;
   for ( var i = 0; i < frames.length; ++i )
   {
      var f = frames[ i ];
      totalExposureSec += f.meta.exposureSec || 0;
      if ( f.trails.length == 0 )
         cleanFrames++;
      var crossings = crossingsByFrame[ f.meta.id ] || [];
      var matchedIdx = {};
      for ( var c = 0; c < crossings.length; ++c )
         if ( crossings[ c ].matchedTrailIndex != null )
         {
            matchedIdx[ crossings[ c ].matchedTrailIndex ] = true;
            events.push( { timeUtc: crossings[ c ].entryUtc ? new Date( crossings[ c ].entryUtc ) : f.meta.dateObs,
                           klass: "satellite",
                           name: crossings[ c ].name,
                           noradId: crossings[ c ].noradId,
                           elevationDeg: crossings[ c ].elevationDeg,
                           angularRateDegPerSec: crossings[ c ].angularRateDegPerSec,
                           frameId: f.meta.id } );
         }
      for ( var t = 0; t < f.trails.length; ++t )
         if ( !matchedIdx[ f.trails[ t ].index ] )
         {
            var cls = SIMeteors.classifyTrail( f.trails[ t ], f.meta.dateObs );
            events.push( { timeUtc: f.meta.dateObs,
                           klass: cls.klass,
                           name: null,
                           shower: cls.shower ? cls.shower.name : null,
                           confidence: cls.confidence,
                           reason: cls.reason,
                           frameId: f.meta.id } );
         }
   }

   // Asteroid candidates: slow, coherent movers among the point sources of
   // frames that have sky coordinates.
   var movers = [];
   if ( params.detectAsteroids )
   {
      var blobsByFrame = [];
      for ( var i = 0; i < frames.length; ++i )
         if ( frames[ i ].blobs && frames[ i ].blobs.length > 0 )
            blobsByFrame.push( { id: frames[ i ].meta.id, dateObs: frames[ i ].meta.dateObs,
                                 blobs: frames[ i ].blobs } );
      if ( blobsByFrame.length >= 3 )
      {
         console.writeln( "Searching for slow movers across " + blobsByFrame.length + " solved frame(s)…" );
         movers = SIMeteors.findAsteroidCandidates( blobsByFrame, 3, null );
         for ( var m = 0; m < movers.length; ++m )
            events.push( { timeUtc: movers[ m ].points[ 0 ].t,
                           klass: "asteroid",
                           name: null,
                           rateArcsecPerMin: movers[ m ].rateArcsecPerMin,
                           nFrames: movers[ m ].points.length,
                           frameId: movers[ m ].points[ 0 ].frame } );
      }
   }

   var night = { dateLabel: nightLabel( frames ),
                 frames: frames.length,
                 cleanFrames: cleanFrames,
                 totalExposureSec: totalExposureSec,
                 target: frames[ 0 ].meta.keywords[ "OBJECT" ] || null,
                 events: events,
                 movers: movers };

   var history = SIReport.loadHistory();
   var report = SIReport.build( night, history, params.lang );
   SIReport.saveHistory( SIReport.appendNight( history, report.summary ) );

   return { night: night, report: report, tleInfo: tleInfo };
}

// ---------------------------------------------------------------------------
// UI.

class ReportDialog extends Dialog
{
   constructor( result, params, suggestedDir )
   {
      super();
      this.windowTitle = SKYINTRUDERS_TITLE + " — " + result.night.dateLabel;

      this.titleLabel = new Label( this );
      this.titleLabel.useRichText = true;
      this.titleLabel.text = "<b>" + result.report.redditTitle + "</b>";
      this.titleLabel.wordWrapping = true;
      this.titleLabel.margin = 6;
      this.titleLabel.frameStyle = FrameStyle.Box;

      this.textBox = new TextBox( this );
      this.textBox.readOnly = true;
      this.textBox.text = result.report.markdown;
      this.textBox.setMinSize( 640, 480 );

      this.saveButton = new PushButton( this );
      this.saveButton.text = "Save report…";
      this.saveButton.onClick = () =>
      {
         var d = new SaveFileDialog;
         d.caption = "Save night report";
         d.filters = [ [ "Markdown", "*.md" ], [ "Any file", "*" ] ];
         d.initialPath = ( suggestedDir || File.homeDirectory ) +
                         "/SkyIntruders-" + result.night.dateLabel.replace( "/", "-" ) + ".md";
         if ( d.execute() )
         {
            File.writeTextFile( d.fileName, result.report.markdown + "\n" );
            console.writeln( SKYINTRUDERS_TITLE + ": report saved to " + d.fileName );
         }
      };

      this.closeButton = new PushButton( this );
      this.closeButton.text = "Close";
      this.closeButton.onClick = () => this.ok();

      this.buttons = new HorizontalSizer;
      this.buttons.addStretch();
      this.buttons.add( this.saveButton );
      this.buttons.addSpacing( 6 );
      this.buttons.add( this.closeButton );

      this.sizer = new VerticalSizer;
      this.sizer.margin = 8;
      this.sizer.spacing = 8;
      this.sizer.add( this.titleLabel );
      this.sizer.add( this.textBox, 100 );
      this.sizer.add( this.buttons );
      this.adjustToContents();
   }
}

class SkyIntrudersDialog extends Dialog
{
   constructor( params )
   {
      super();
      this.params = params;
      this.files = [];
      this.result = null;
      this.windowTitle = SKYINTRUDERS_TITLE;

      this.infoLabel = new Label( this );
      this.infoLabel.useRichText = true;
      this.infoLabel.text = "<b>" + SKYINTRUDERS_TITLE + "</b> — who crossed your photo last night? " +
                            "Add your raw light frames, then Analyze. (build " + SKYINTRUDERS_BUILD + ")";
      this.infoLabel.wordWrapping = true;
      this.infoLabel.frameStyle = FrameStyle.Box;
      this.infoLabel.margin = 6;

      // --- file list
      this.fileTree = new TreeBox( this );
      this.fileTree.alternateRowColor = true;
      this.fileTree.multipleSelection = true;
      this.fileTree.numberOfColumns = 1;
      this.fileTree.setHeaderText( 0, "Light frames" );
      this.fileTree.rootDecoration = false;
      this.fileTree.setMinSize( 560, 220 );

      this.addFilesButton = new PushButton( this );
      this.addFilesButton.text = "Add files…";
      this.addFilesButton.onClick = () =>
      {
         var d = new OpenFileDialog;
         d.multipleSelections = true;
         d.caption = "Select light frames";
         d.filters = [ [ "FITS / XISF", "*.fits", "*.fit", "*.fts", "*.xisf" ], [ "Any file", "*" ] ];
         if ( d.execute() )
            this.addFiles( d.fileNames );
      };

      this.addDirButton = new PushButton( this );
      this.addDirButton.text = "Add directory…";
      this.addDirButton.onClick = () =>
      {
         var d = new GetDirectoryDialog;
         d.caption = "Select a directory of light frames";
         if ( d.execute() )
         {
            var found = [];
            var exts = [ ".fits", ".fit", ".fts", ".xisf" ];
            var ff = new FileFind;
            if ( ff.begin( d.directory + "/*" ) )
               do
               {
                  if ( !ff.isDirectory )
                     for ( var e = 0; e < exts.length; ++e )
                        if ( ff.name.toLowerCase().endsWith( exts[ e ] ) )
                        {
                           found.push( d.directory + "/" + ff.name );
                           break;
                        }
               } while ( ff.next() );
            found.sort();
            this.addFiles( found );
         }
      };

      this.clearButton = new PushButton( this );
      this.clearButton.text = "Clear";
      this.clearButton.onClick = () =>
      {
         this.files = [];
         this.fileTree.clear();
      };

      this.fileButtons = new HorizontalSizer;
      this.fileButtons.add( this.addFilesButton );
      this.fileButtons.addSpacing( 6 );
      this.fileButtons.add( this.addDirButton );
      this.fileButtons.addSpacing( 6 );
      this.fileButtons.add( this.clearButton );
      this.fileButtons.addStretch();

      // --- detection parameters
      this.kSigmaControl = new NumericControl( this );
      this.kSigmaControl.label.text = "Detection threshold (σ):";
      this.kSigmaControl.setRange( 3, 12 );
      this.kSigmaControl.setPrecision( 1 );
      this.kSigmaControl.setValue( params.kSigma );
      this.kSigmaControl.toolTip = "Trail pixels must exceed the frame background by this many robust sigmas.";
      this.kSigmaControl.onValueUpdated = ( v ) => { this.params.kSigma = v; };

      this.langCombo = new ComboBox( this );
      this.langCombo.addItem( "English report" );
      this.langCombo.addItem( "Rapport en français" );
      this.langCombo.currentItem = ( params.lang == "fr" ) ? 1 : 0;
      this.langCombo.onItemSelected = ( i ) => { this.params.lang = ( i == 1 ) ? "fr" : "en"; };

      this.paramsSizer = new HorizontalSizer;
      this.paramsSizer.add( this.kSigmaControl, 100 );
      this.paramsSizer.addSpacing( 12 );
      this.paramsSizer.add( this.langCombo );

      this.paramsGroup = new GroupBox( this );
      this.paramsGroup.title = "Detection";
      this.paramsGroup.sizer = new VerticalSizer;
      this.paramsGroup.sizer.margin = 8;
      this.paramsGroup.sizer.add( this.paramsSizer );

      // --- observer fallback
      this.latEdit = this.makeCoordEdit( "Latitude (°):", params.observerLatDeg,
                                         ( v ) => { this.params.observerLatDeg = v; } );
      this.lonEdit = this.makeCoordEdit( "Longitude (°):", params.observerLonDeg,
                                         ( v ) => { this.params.observerLonDeg = v; } );
      this.altEdit = this.makeCoordEdit( "Altitude (m):", params.observerAltM,
                                         ( v ) => { this.params.observerAltM = v; } );

      this.observerGroup = new GroupBox( this );
      this.observerGroup.title = "Observer site (used when FITS headers have none)";
      this.observerGroup.sizer = new HorizontalSizer;
      this.observerGroup.sizer.margin = 8;
      this.observerGroup.sizer.spacing = 12;
      this.observerGroup.sizer.add( this.latEdit.sizer );
      this.observerGroup.sizer.add( this.lonEdit.sizer );
      this.observerGroup.sizer.add( this.altEdit.sizer );
      this.observerGroup.sizer.addStretch();

      // --- actions
      this.analyzeButton = new PushButton( this );
      this.analyzeButton.text = "Analyze night";
      this.analyzeButton.defaultButton = true;
      this.analyzeButton.onClick = () => this.runNow();

      this.closeButton = new PushButton( this );
      this.closeButton.text = "Close";
      this.closeButton.onClick = () => this.cancel();

      this.actions = new HorizontalSizer;
      this.actions.addStretch();
      this.actions.add( this.analyzeButton );
      this.actions.addSpacing( 6 );
      this.actions.add( this.closeButton );

      this.sizer = new VerticalSizer;
      this.sizer.margin = 8;
      this.sizer.spacing = 8;
      this.sizer.add( this.infoLabel );
      this.sizer.add( this.fileTree, 100 );
      this.sizer.add( this.fileButtons );
      this.sizer.add( this.paramsGroup );
      this.sizer.add( this.observerGroup );
      this.sizer.add( this.actions );
      this.adjustToContents();
   }

   makeCoordEdit( label, value, apply )
   {
      var l = new Label( this );
      l.text = label;
      l.textAlignment = TextAlign.Right | TextAlign.VertCenter;
      var e = new Edit( this );
      e.setFixedWidth( this.font.width( "-000.000000" ) + 16 );
      if ( value != null )
         e.text = String( value );
      e.onEditCompleted = () =>
      {
         var v = parseFloat( e.text );
         apply( isNaN( v ) ? null : v );
      };
      var s = new HorizontalSizer;
      s.spacing = 4;
      s.add( l );
      s.add( e );
      return { label: l, edit: e, sizer: s };
   }

   addFiles( paths )
   {
      for ( var i = 0; i < paths.length; ++i )
         if ( this.files.indexOf( paths[ i ] ) < 0 )
         {
            this.files.push( paths[ i ] );
            var node = new TreeBoxNode( this.fileTree );
            node.setText( 0, paths[ i ] );
         }
   }

   setBusy( busy )
   {
      this.analyzeButton.enabled = !busy;
      this.addFilesButton.enabled = !busy;
      this.addDirButton.enabled = !busy;
      this.clearButton.enabled = !busy;
   }

   runNow()
   {
      if ( this.files.length == 0 )
      {
         ( new MessageBox( "Add some light frames first.", SKYINTRUDERS_TITLE,
                           StdIcon.Information, StdButton.Ok ) ).execute();
         return;
      }
      saveParams( this.params );
      this.setBusy( true );
      console.show();
      console.writeln( "<b>" + SKYINTRUDERS_TITLE + "</b> — analyzing " + this.files.length + " frame(s)…" );
      try
      {
         this.result = runAnalysis( this.files, this.params );
         console.writeln( "" );
         console.writeln( this.result.report.markdown );
         var dir = File.extractDrive( this.files[ 0 ] ) + File.extractDirectory( this.files[ 0 ] );
         ( new ReportDialog( this.result, this.params, dir ) ).execute();
      }
      catch ( e )
      {
         console.criticalln( SKYINTRUDERS_TITLE + ": " + e.message );
         ( new MessageBox( e.message, SKYINTRUDERS_TITLE, StdIcon.Error, StdButton.Ok ) ).execute();
      }
      finally
      {
         this.setBusy( false );
      }
   }
}

// ---------------------------------------------------------------------------
function main()
{
   ensureMinimumVersion( 1, 9, 4 );
   var params = loadParams();
   var dialog = new SkyIntrudersDialog( params );
   dialog.execute();
   saveParams( params );
}

main();
