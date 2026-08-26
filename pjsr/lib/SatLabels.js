// SPDX-License-Identifier: GPL-3.0-only
/*
 * SatLabels.js — SISatLabels: how a satellite is named, flagged and
 * described on the night image and in the events.
 *
 * Operator flag from the SATCAT owner code (name heuristic as fallback),
 * object nature from the SATCAT record (payload in/out of service, rocket
 * body, debris), the telemetry sub-line (range, rate, launch year, service
 * status, shadow transitions), the per-class colours and the fallback
 * labels for trails that got no satellite name. Pure JS, no PixInsight
 * types — runs under plain Node for testing.
 */

var SISatLabels = ( function()
{
   // Operator country for the flag chip on the result image, from the
   // catalog name. Coarse by design; unknown stays a neutral placeholder.
   function countryCode( name )
   {
      var n = ( name || "" ).toUpperCase();
      if ( /STARLINK|IRIDIUM|GLOBALSTAR|NAVSTAR|GPS |FLOCK|SKYSAT|LEMUR|KUIPER|USA |NOSS|LACROSSE|IMAGE|GOES|TERRA|AQUA|LANDSAT/.test( n ) ) return "us";
      if ( /QIANFAN|G60|HULIANWANG|CHUANGXIN|TIANGONG|^CSS|CZ-|YAOGAN|FENGYUN|SHIYAN|JILIN|GAOFEN|BEIDOU|CHINASAT|SHENZHOU/.test( n ) ) return "cn";
      if ( /COSMOS|GLONASS|SOYUZ|PROGRESS|METEOR-|RESURS/.test( n ) ) return "ru";
      if ( /ONEWEB/.test( n ) ) return "gb";
      if ( /GALILEO|SENTINEL|METEOSAT|ARIANE/.test( n ) ) return "eu";
      if ( /HIMAWARI|ALOS|QZS/.test( n ) ) return "jp";
      if ( /IRNSS|CARTOSAT|GSAT|RISAT/.test( n ) ) return "in";
      if ( /SPOT |PLEIADES|ELISA|CERES/.test( n ) ) return "fr";
      return "xx";
   }

   // CelesTrak SATCAT OWNER codes -> ISO flag codes (vendored circle-flags).
   var OWNER_FLAG = {
      US: "us", PRC: "cn", CIS: "ru", UK: "gb", FR: "fr", GER: "de",
      JPN: "jp", IND: "in", ESA: "eu", EUTE: "eu", EUME: "eu", EUSP: "eu",
      IT: "it", CA: "ca", AUS: "au", BRAZ: "br", ISRA: "il", SKOR: "kr",
      TURK: "tr", ARGN: "ar", SAFR: "za", SPN: "es", NETH: "nl", SWED: "se",
      NOR: "no", SWTZ: "ch", POL: "pl", DEN: "dk", SING: "sg", THAI: "th",
      INDO: "id", MEX: "mx", UKR: "ua", KAZ: "kz", SAUD: "sa", UAE: "ae",
      LUXE: "lu", SES: "lu", O3B: "lu", GLOB: "us", IRID: "us", ORB: "us"
   };

   // Flag code for a crossing: SATCAT owner first, catalog-name heuristic
   // when the record is missing or its owner is not mapped.
   function flagCode( satcatRec, name )
   {
      return OWNER_FLAG[ ( satcatRec || {} ).owner ] || countryCode( name );
   }

   // What kind of thing is this, per the SATCAT record: a working payload,
   // a dead one, an unknown one (classified objects come out '?'), a rocket
   // body or debris — the last two have no ops status, the notion does not
   // apply. Returns a language-neutral code, or null without a record (a
   // failed SATCAT fetch must not relabel everything "unknown").
   function classCode( rec )
   {
      if ( !rec )
         return null;
      if ( rec.type == "R/B" )
         return "rb";
      if ( rec.type == "DEB" )
         return "debris";
      if ( rec.ops && "+PBSX".indexOf( rec.ops ) >= 0 )
         return "active";
      if ( rec.ops == "-" )
         return "dead";
      return "unknown";
   }

   var CLASS_LABEL = {
      en: { rb: "rocket body", debris: "debris", active: "in service",
            dead: "out of service", unknown: "unknown" },
      fr: { rb: "\u00e9tage de fus\u00e9e", debris: "d\u00e9bris", active: "en service",
            dead: "hors service", unknown: "inconnu" }
   };

   // Second label line on the result image: distance, angular rate, launch
   // year (from the COSPAR designator), service status (SATCAT), shadow
   // transitions inside the field.
   function telemetryLine( crossing, satcat, lang )
   {
      var fr = ( lang == "fr" );
      var parts = [];
      if ( crossing.rangeKm > 0 )
         parts.push( Math.round( crossing.rangeKm ) + "\u2009km" );
      if ( crossing.angularRateDegPerSec > 0 )
      {
         var r = crossing.angularRateDegPerSec.toFixed( 2 );
         parts.push( ( fr ? r.replace( ".", "," ) : r ) + "\u00b0/s" );
      }
      var des = String( crossing.intlDes || "" );
      var m = /^(\d{4})-/.exec( des );
      if ( m )
         parts.push( m[ 1 ] );
      var cls = classCode( satcat[ crossing.noradId ] );
      if ( cls != null )
         parts.push( CLASS_LABEL[ fr ? "fr" : "en" ][ cls ] );
      // shadow transition inside the field: the streak stops or starts here
      if ( crossing.shadowEntryUtc )
         parts.push( ( fr ? "entre dans l'ombre " : "into shadow " ) +
                     String( crossing.shadowEntryUtc ).substring( 11, 19 ) + " UT" );
      if ( crossing.shadowExitUtc )
         parts.push( ( fr ? "sort de l'ombre " : "out of shadow " ) +
                     String( crossing.shadowExitUtc ).substring( 11, 19 ) + " UT" );
      return parts.join( " \u00b7 " );
   }

   // Catalog name, or the NORAD id when the catalog has none.
   function displayName( crossing )
   {
      return crossing.name || ( "NORAD " + crossing.noradId );
   }

   // " · HH:MM UT" from the crossing's entry time, empty without one.
   function entryTimeSuffix( crossing )
   {
      return crossing.entryUtc
         ? " \u00b7 " + String( crossing.entryUtc ).substring( 11, 16 ) + " UT"
         : "";
   }

   // Label of a trail matched to a crossing: name, "?" on a medium-
   // confidence (rescued) match, entry time.
   function matchedLabel( crossing )
   {
      return displayName( crossing ) +
             ( crossing.matchConfidence === "medium" ? " ?" : "" ) +
             entryTimeSuffix( crossing );
   }

   // Label of a predicted (ghost) crosser drawn on the composite: name,
   // entry time, "(shadow)" when it was eclipsed.
   function predictedLabel( crossing, lang )
   {
      return displayName( crossing ) + entryTimeSuffix( crossing ) +
             ( crossing.sunlit ? "" : ( lang == "fr" ? " (ombre)" : " (shadow)" ) );
   }

   var TRAIL_STYLE = {
      satellite: "#22d3ee",
      "satellite-candidate": "#ffa05f",
      meteor: "#ff5f8f",
      plane: "#a7b34d",
      train: "#8fd18f",
      unknown: "#c9d2dd"
   };

   var FALLBACK_LABEL = {
      en: { "satellite-candidate": "unidentified satellite", meteor: "meteor?",
            plane: "airplane", train: "satellite train", unknown: "intruder?" },
      fr: { "satellite-candidate": "satellite non identifié", meteor: "météore ?",
            plane: "avion", train: "train de satellites", unknown: "intrus ?" }
   };

   function fallbackLabels( lang )
   {
      return FALLBACK_LABEL[ lang ] || FALLBACK_LABEL.en;
   }

   return {
      countryCode: countryCode,
      OWNER_FLAG: OWNER_FLAG,
      flagCode: flagCode,
      classCode: classCode,
      CLASS_LABEL: CLASS_LABEL,
      telemetryLine: telemetryLine,
      displayName: displayName,
      entryTimeSuffix: entryTimeSuffix,
      matchedLabel: matchedLabel,
      predictedLabel: predictedLabel,
      TRAIL_STYLE: TRAIL_STYLE,
      FALLBACK_LABEL: FALLBACK_LABEL,
      fallbackLabels: fallbackLabels
   };
} )();
