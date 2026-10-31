/*
 * dialog.test.js — the Return key in the script dialogs (source-level).
 *
 * Under the contained windowing of PixInsight 1.9.6, Return in any control
 * presses a push button of the dialog: the one flagged as default, or else
 * the first one (Qt auto-default). Return in the mirror URL or the observer
 * fields started the analysis, and Return in the report dialogs saved the
 * report. Every dialog must therefore turn auto-default off, and only
 * SIColorDialog keeps a default button (its OK button: Return validates the
 * colour).
 *
 * The dialogs need PixInsight to run, so the rules are checked on the source
 * of the entry script.
 */
"use strict";
var assert = require( "assert" );
var fs = require( "fs" );
var path = require( "path" );

var src = fs.readFileSync( path.join( __dirname, "..", "pjsr", "SkyIntruders.js" ), "utf8" );

// Split the source into the bodies of the Dialog subclasses.
var re = /^class (\w+) extends Dialog\b/gm;
var heads = [];
var m;
while ( ( m = re.exec( src ) ) !== null )
   heads.push( { name: m[1], start: m.index } );
assert.ok( heads.length >= 4, "found the dialog classes (" + heads.length + ")" );

var bodies = {};
heads.forEach( function( h, i )
{
   var next = src.slice( h.start + 1 ).search( /^class \w+/m );
   var end = next < 0 ? src.length : h.start + 1 + next;
   bodies[h.name] = src.slice( h.start, end );
} );

var KEEPS_DEFAULT = { SIColorDialog: true };

[ "SkyIntrudersDialog", "ReportDialog", "HtmlResultDialog", "SIColorDialog" ].forEach( function( name )
{
   assert.ok( bodies[name], name + " exists" );
} );

Object.keys( bodies ).forEach( function( name )
{
   var body = bodies[name];
   var defaults = body.match( /\.defaultButton\s*=\s*true/g ) || [];
   if ( KEEPS_DEFAULT[name] )
   {
      assert.strictEqual( defaults.length, 1, name + " keeps exactly one default button" );
      return;
   }
   assert.strictEqual( defaults.length, 0, name + " has no default button" );

   // Auto-default off, right after the base construction and before any
   // control is created.
   var sup = body.indexOf( "super();" );
   var off = body.search( /this\.autoDefaultButton\s*=\s*false\s*;/ );
   var firstControl = body.search( /new (PushButton|ToolButton|Edit|NumericEdit|ComboBox|CheckBox|TextBox|TabBox)\b/ );
   assert.ok( sup >= 0, name + " calls super()" );
   assert.ok( off > sup, name + " sets autoDefaultButton = false after super()" );
   assert.ok( firstControl < 0 || off < firstControl, name + " sets it before creating controls" );
} );

console.log( "dialog.test.js: " + Object.keys( bodies ).length + " dialogs checked" );
