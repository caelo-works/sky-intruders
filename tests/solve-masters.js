/*
 * solve-masters.js — plate-solve every master in <scriptdir>/masters with the
 * stock ImageSolver (library mode) and save the solved copies into
 * <scriptdir>/masters-solved. Seed comes from each file's RA/DEC/FOCALLEN/
 * XPIXSZ keywords, exactly like a user running Script > Image Analysis >
 * ImageSolver before Treasure Hunt.
 *
 * NOTE: no "#engine v8" here — the AdP solver stack only loads in the
 * default engine. That is why solving is a separate stage from the v8
 * treasure runner.
 *
 * Results: <system-temp>/si-solve-masters.json
 *
 * Run:
 *   powershell: & <PI-exe> -n --automation-mode --force-exit
 *               -r=<abs>/tests/solve-masters.js
 */

/* beautify ignore:start */
#define USE_SOLVER_LIBRARY true
#define SETTINGS_MODULE "SOLVER"
#define STAR_CSV_FILE   (File.systemTempDirectory + "/si-treasure-stars.csv")
#define __PJSR_USE_STAR_DETECTOR_V2
#include <pjsr/BRQuadTree.jsh>
#include <pjsr/ColorSpace.jsh>
#include <pjsr/DataType.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/LinearTransformation.jsh>
#include <pjsr/NumericControl.jsh>
#include <pjsr/RBFType.jsh>
#include <pjsr/SectionBar.jsh>
#include <pjsr/Sizer.jsh>
#include <pjsr/StarDetector.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdCursor.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/UndoFlag.jsh>
#include "C:/Program Files/PixInsight/src/scripts/AdP/WCSmetadata.jsh"
#include "C:/Program Files/PixInsight/src/scripts/AdP/AstronomicalCatalogs.jsh"
#include "C:/Program Files/PixInsight/src/scripts/AdP/SearchCoordinatesDialog.js"
#include "C:/Program Files/PixInsight/src/scripts/AdP/CatalogDownloader.js"
#include "C:/Program Files/PixInsight/src/scripts/AdP/ImageSolver.js"
/* beautify ignore:end */

function solveScriptDir()
{
   return File.extractDrive( #__FILE__ ) + File.extractDirectory( #__FILE__ );
}

function main()
{
   var out = { ok: true, masters: [] };
   var srcDir = solveScriptDir() + "/masters";
   var dstDir = solveScriptDir() + "/masters-solved";
   try
   {
      if ( !File.directoryExists( dstDir ) )
         File.createDirectory( dstDir );

      var files = [];
      var ff = new FileFind;
      if ( ff.begin( srcDir + "/*.xisf" ) )
         do
         {
            if ( ff.isFile )
               files.push( srcDir + "/" + ff.name );
         }
         while ( ff.next() );
      files.sort();
      out.fileCount = files.length;

      for ( var i = 0; i < files.length; ++i )
      {
         var entry = { file: File.extractName( files[ i ] ) };
         out.masters.push( entry );
         var window = null;
         var t0 = Date.now();
         try
         {
            var dstPath = dstDir + "/" + File.extractName( files[ i ] ) + "_solved.xisf";
            if ( File.exists( dstPath ) )
            {
               entry.skipped = "already solved";
               continue;
            }

            console.noteln( "=== solving " + files[ i ] );
            var wins = ImageWindow.open( files[ i ] );
            if ( !wins || wins.length < 1 )
               throw new Error( "cannot open" );
            window = wins[ 0 ];

            var solver = new ImageSolver();
            solver.Init( window );
            solver.solverCfg.showStars = false;
            solver.solverCfg.showDistortion = false;
            solver.solverCfg.generateErrorImg = false;
            solver.solverCfg.catalogMode = CatalogMode.prototype.Automatic;
            if ( !solver.SolveImage( window ) )
               throw new Error( "plate solve failed" );
            solver.metadata.SaveKeywords( window, false );
            solver.metadata.SaveProperties( window, "ImageSolver " + SOLVERVERSION );
            try
            {
               if ( typeof window.regenerateAstrometricSolution === "function" )
                  window.regenerateAstrometricSolution();
            }
            catch ( e ) {}

            entry.resolutionArcsec = Math.round( solver.metadata.resolution*3600*1000 )/1000;
            try { entry.rotationDeg = Math.round( solver.metadata.GetRotation()[ 0 ]*100 )/100; }
            catch ( e ) {}
            entry.raDeg = Math.round( solver.metadata.ra*10000 )/10000;
            entry.decDeg = Math.round( solver.metadata.dec*10000 )/10000;

            if ( !window.saveAs( dstPath, false, false, false, false ) )
               throw new Error( "saveAs failed" );
            entry.solvedPath = dstPath;
            entry.ms = Date.now() - t0;
         }
         catch ( e )
         {
            entry.error = String( e.message || e );
            console.criticalln( entry.file + ": " + entry.error );
         }
         finally
         {
            if ( window )
               try { window.forceClose(); } catch ( e ) {}
            gc();
         }
      }
   }
   catch ( e )
   {
      out.ok = false;
      out.error = String( e.message || e );
   }
   File.writeTextFile( File.systemTempDirectory + "/si-solve-masters.json",
                       JSON.stringify( out, null, 2 ) );
   console.noteln( "Wrote " + File.systemTempDirectory + "/si-solve-masters.json" );
}

main();
