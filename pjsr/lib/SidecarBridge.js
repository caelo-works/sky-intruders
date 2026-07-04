/*
 * SidecarBridge.js — locate and drive the sky-sidecar Go binary.
 *
 * PJSR cannot do outbound networking and cannot reliably read a child
 * process's stdout, so every exchange goes through files: requests are
 * written as JSON, the sidecar answers into --out-file, we read it back.
 * The out-file always holds either a result or { "error": "..." }.
 * Pattern lifted from Distributed WBPP's SidecarBridge.
 */

function SISidecarBridge( scriptFilePath )
{
   this.scriptDir = File.extractDrive( scriptFilePath ) + File.extractDirectory( scriptFilePath );
   this.binaryPath = null;
   this._session = format( "%08x", Math.floor( Math.random() * 0xffffffff ) );
   this._seq = 0;

   // --- binary resolution -------------------------------------------------

   this._machineArch = function()
   {
      if ( CoreApplication.platform.indexOf( "MSWindows" ) >= 0 )
         return "amd64";
      // No CPU-arch API in PJSR: shell uname through a temp file (stdout is
      // not capturable from ExternalProcess).
      var tmp = this._tmp( "arch.txt" );
      try
      {
         var P = new ExternalProcess;
         P.start( "/bin/sh", [ "-c", "uname -m > \"" + tmp + "\"" ] );
         P.waitForFinished( -1 );
         var m = File.readTextFile( tmp ).trim();
         if ( m.match( /arm64|aarch64/i ) )
            return "arm64";
      }
      catch ( e ) {}
      finally
      {
         try { if ( File.exists( tmp ) ) File.remove( tmp ); } catch ( e ) {}
      }
      return "amd64";
   };

   this._platform = function()
   {
      var p = CoreApplication.platform;
      if ( p.indexOf( "MSWindows" ) >= 0 )
         return "windows";
      if ( p.match( /MAC|macOS|OSX/i ) )
         return "darwin";
      return "linux";
   };

   this.binaryName = function()
   {
      var os = this._platform();
      var name = "sky-sidecar-" + os + "-" + this._machineArch();
      return ( os == "windows" ) ? name + ".exe" : name;
   };

   this.candidates = function()
   {
      var name = this.binaryName();
      return [ this.scriptDir + "/bin/" + name,       // installed package layout
               this.scriptDir + "/../../../../bin/" + name, // dev: repo bin/ from pjsr/lib
               this.scriptDir + "/../bin/" + name ];  // dev: repo bin/ from pjsr
   };

   this.resolve = function()
   {
      if ( this.binaryPath != null )
         return this.binaryPath;
      var tried = this.candidates();
      for ( var i = 0; i < tried.length; ++i )
         if ( File.exists( tried[ i ] ) )
         {
            var path = tried[ i ];
            if ( !path.endsWith( ".exe" ) )
            {
               // Zip extraction drops the exec bit; macOS may quarantine.
               try
               {
                  if ( this._platform() == "darwin" )
                  {
                     var Q = new ExternalProcess;
                     Q.start( "/usr/bin/xattr", [ "-dr", "com.apple.quarantine", path ] );
                     Q.waitForFinished( -1 );
                  }
                  var C = new ExternalProcess;
                  C.start( "/bin/chmod", [ "+x", path ] );
                  C.waitForFinished( -1 );
               }
               catch ( e ) {}
            }
            this.binaryPath = path;
            return path;
         }
      throw new Error( "sky-sidecar binary not found. Tried:\n" + tried.join( "\n" ) );
   };

   // --- file-based round trips --------------------------------------------

   this._tmp = function( name )
   {
      var p = File.systemTempDirectory + "/skyintruders-" + this._session + "-" + ( this._seq++ ) + "-" + name;
      try { if ( File.exists( p ) ) File.remove( p ); } catch ( e ) {}
      return p;
   };

   this._runOneShot = function( args )
   {
      var P = new ExternalProcess;
      P.start( this.resolve(), args );
      if ( P.waitForStarted && !P.waitForStarted() )
         throw new Error( "sky-sidecar did not start: " + this.binaryPath );
      P.waitForFinished( -1 ); // Qt default 30 s is too short for a cold TLE fetch
      return P.exitCode;
   };

   this._readJSON = function( path )
   {
      try
      {
         if ( !File.exists( path ) )
            return null;
         return JSON.parse( File.readTextFile( path ) );
      }
      catch ( e )
      {
         return null;
      }
   };

   this._roundTrip = function( label, args, outFile )
   {
      this._runOneShot( args );
      var r = this._readJSON( outFile );
      try { if ( File.exists( outFile ) ) File.remove( outFile ); } catch ( e ) {}
      if ( r == null )
         throw new Error( label + ": sidecar produced no readable response" );
      if ( r.error )
         throw new Error( label + ": " + r.error );
      return r;
   };

   // --- public API ---------------------------------------------------------

   // -> { tlePath, count, fetchedUtc, fromCache, stale?, sourceUrl }
   this.fetchTle = function( group, cacheDir, maxAgeHours )
   {
      var out = this._tmp( "tle.json" );
      return this._roundTrip( "fetch-tle",
         [ "fetch-tle", "--group", group, "--cache-dir", cacheDir,
           "--max-age-hours", String( maxAgeHours ), "--out-file", out ], out );
   };

   // request per docs/ARCHITECTURE.md -> response per docs/ARCHITECTURE.md
   this.match = function( tleFile, request )
   {
      var inFile = this._tmp( "match-req.json" );
      var out = this._tmp( "match-res.json" );
      File.writeTextFile( inFile, JSON.stringify( request ) );
      try
      {
         return this._roundTrip( "match",
            [ "match", "--tle-file", tleFile, "--in-file", inFile, "--out-file", out ], out );
      }
      finally
      {
         try { if ( File.exists( inFile ) ) File.remove( inFile ); } catch ( e ) {}
      }
   };

   this.version = function()
   {
      // --version prints to stdout, which we cannot read; presence of the
      // binary is enough for the UI. Kept for symmetry with DWBPP.
      return this.binaryPath != null ? "resolved" : "unresolved";
   };
}
