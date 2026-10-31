/*
 * params.test.js — settings.json merge (SIParams.merge), with the upgrade
 * path from files written by older versions.
 *
 * The report attribution line is opt-in (CPD rule 6.4): a settings.json
 * written by 0.3.x has no "reportAttribution" key, and must load as false —
 * never inferred from the old always-on behaviour.
 */
"use strict";
var assert = require( "assert" );
var P = require( "./build/module.js" ).SIParams;

// The default itself
assert.strictEqual( P.DEFAULTS.reportAttribution, false, "attribution is off by default" );
assert.strictEqual( P.merge( null ).reportAttribution, false, "no settings file -> off" );
assert.strictEqual( P.merge( undefined ).reportAttribution, false, "unreadable settings file -> off" );

// A settings.json as 0.3.1 wrote it: every key of that version, none newer.
var v031 = {
   kSigma: 5, diffKSigma: 4.5, minLengthFrac: 0.15, fillRatioMin: 0.6, maxTrails: 10,
   tleGroup: "active", tleExtraGroups: [ "last-30-days", "catalog" ], tleMaxAgeHours: 12,
   tleBaseUrl: null, matchMaxSepDeg: 0.2, matchMaxAngleDiffDeg: 12, stepSec: 1,
   detectAsteroids: true, nightShowPredicted: false, nightShowShadow: false, maxSources: 600,
   lang: "fr", observerLatDeg: 45.5, observerLonDeg: 6.1, observerAltM: 300, mode: "treasure",
   treasureMaxRows: 400, treasureGalaxies: true, treasureQuasars: true, treasurePne: true,
   treasureAsteroids: true, treasureAccent: "#9FD8D2", saveHistory: true,
   nightResultImage: true, nightResultCombine: "best", debugFrameOverlays: false,
   matchDiagnostics: false
};
var m = P.merge( JSON.parse( JSON.stringify( v031 ) ) );
assert.strictEqual( m.reportAttribution, false, "0.3.x settings.json (no key) -> off" );
assert.strictEqual( m.lang, "fr", "the user's other choices survive the upgrade" );
assert.strictEqual( m.mode, "treasure" );
assert.strictEqual( m.observerLatDeg, 45.5 );

// The user's explicit choice round-trips; anything that is not a boolean
// keeps the default.
assert.strictEqual( P.merge( { reportAttribution: true } ).reportAttribution, true, "opted in -> on" );
assert.strictEqual( P.merge( { reportAttribution: false } ).reportAttribution, false, "opted out -> off" );
[ "true", 1, null, [], {} ].forEach( function( v )
{
   assert.strictEqual( P.merge( { reportAttribution: v } ).reportAttribution, false,
                       "non-boolean " + JSON.stringify( v ) + " -> off" );
} );

// The existing guards still hold after the move to lib/Params.js
assert.strictEqual( P.merge( { tleBaseUrl: "http://example.org/" } ).tleBaseUrl, null, "http mirror dropped" );
assert.strictEqual( P.merge( { tleBaseUrl: "https://example.org/" } ).tleBaseUrl, "https://example.org/" );
assert.strictEqual( P.merge( { nightResultCombine: "median" } ).nightResultCombine, "best" );
assert.deepStrictEqual( P.merge( { tleExtraGroups: [ "last-30-days" ] } ).tleExtraGroups,
                        [ "last-30-days", "catalog" ], "frozen old default upgraded" );
assert.strictEqual( P.merge( { kSigma: "7" } ).kSigma, 5, "wrong type keeps the default" );
// merge never aliases the defaults
var a = P.merge( null ); a.tleExtraGroups.push( "x" );
assert.deepStrictEqual( P.DEFAULTS.tleExtraGroups, [ "last-30-days", "catalog" ], "defaults untouched" );

console.log( "params: defaults, 0.3.x upgrade (attribution off), type guards OK" );
