// SPDX-License-Identifier: GPL-3.0-only
/*
 * NightEvents.js — SINightEvents: the night's event list assembled from
 * the analyzed frames and their satellite crossings.
 *
 * build( frames, crossingsByFrame, satcatInfo, lang ) walks the frames in
 * order and, for each one, emits the matched satellites, the airplane /
 * train bundles and the leftover trails classified by SIMeteors, plus the
 * sunlit crossers that matched nothing (predicted passes). Alongside the
 * events it returns the labeled segments the result image draws, and the
 * clean-frame / total-exposure counts the report needs. Pure JS (SIMeteors
 * + SISatLabels only) — runs under plain Node for testing.
 */

var SINightEvents = ( function()
{
   function build( frames, crossingsByFrame, satcatInfo, lang )
   {
      var STYLE = SISatLabels.TRAIL_STYLE;
      var langLabels = SISatLabels.fallbackLabels( lang );
      var events = [];
      var labeledTrails = [];
      var predicted = [];
      var cleanFrames = 0, totalExposureSec = 0;
      for ( var i = 0; i < frames.length; ++i )
      {
         var f = frames[ i ];
         totalExposureSec += f.meta.exposureSec || 0;
         if ( f.trails.length == 0 )
            cleanFrames++;
         var crossings = crossingsByFrame[ f.meta.id ] || [];
         // Sunlit crossers that did not get matched to any trail still belong
         // in the report — the pass happened whether we caught the streak or not.
         for ( var c0 = 0; c0 < crossings.length; ++c0 )
            if ( crossings[ c0 ].matchedTrailIndex == null && crossings[ c0 ].sunlit )
               predicted.push( { name: crossings[ c0 ].name,
                                 noradId: crossings[ c0 ].noradId,
                                 timeUtc: crossings[ c0 ].entryUtc ? new Date( crossings[ c0 ].entryUtc ) : null,
                                 elevationDeg: crossings[ c0 ].elevationDeg,
                                 frameId: f.meta.id, frameName: f.meta.name } );
         var matchedIdx = {};
         for ( var c = 0; c < crossings.length; ++c )
            if ( crossings[ c ].matchedTrailIndex != null )
            {
               matchedIdx[ crossings[ c ].matchedTrailIndex ] = true;
               events.push( { timeUtc: crossings[ c ].entryUtc ? new Date( crossings[ c ].entryUtc ) : f.meta.dateObs,
                              klass: "satellite",
                              name: crossings[ c ].name,
                              noradId: crossings[ c ].noradId,
                              confidence: crossings[ c ].matchConfidence || "high",
                              elevationDeg: crossings[ c ].elevationDeg,
                              angularRateDegPerSec: crossings[ c ].angularRateDegPerSec,
                              satClass: SISatLabels.classCode( satcatInfo[ crossings[ c ].noradId ] ),
                              // shadow transition inside the field (matched on
                              // the lit sub-path): the report says so instead
                              // of leaving a truncated streak to the meteor
                              // heuristic
                              sunlitFraction: crossings[ c ].sunlitFraction,
                              shadowEntryUtc: crossings[ c ].shadowEntryUtc
                                 ? new Date( crossings[ c ].shadowEntryUtc ) : null,
                              shadowExitUtc: crossings[ c ].shadowExitUtc
                                 ? new Date( crossings[ c ].shadowExitUtc ) : null,
                              frameId: f.meta.id, frameName: f.meta.name } );
               var tr0 = null;
               for ( var tt = 0; tt < f.trails.length; ++tt )
                  if ( f.trails[ tt ].index === crossings[ c ].matchedTrailIndex )
                     tr0 = f.trails[ tt ];
               if ( tr0 != null )
                  labeledTrails.push( { frameIndex: i,
                                        x1: tr0.x1, y1: tr0.y1, x2: tr0.x2, y2: tr0.y2,
                                        color: STYLE.satellite,
                                        flag: SISatLabels.flagCode( satcatInfo[ crossings[ c ].noradId ],
                                                                    crossings[ c ].name ),
                                        sub: SISatLabels.telemetryLine( crossings[ c ], satcatInfo, lang ),
                                        label: SISatLabels.matchedLabel( crossings[ c ] ) } );
            }
         // One event (and one drawn line) per bundle — airplane or train.
         for ( var g = 0; g < ( f.planeGroups || [] ).length; ++g )
         {
            var pg = f.planeGroups[ g ];
            var kind = pg.kind || "plane";
            events.push( { timeUtc: f.meta.dateObs,
                           klass: kind,
                           name: null,
                           segments: pg.segments,
                           frameId: f.meta.id, frameName: f.meta.name } );
            labeledTrails.push( { frameIndex: i,
                                  x1: pg.x1, y1: pg.y1, x2: pg.x2, y2: pg.y2,
                                  color: STYLE[ kind ],
                                  label: langLabels[ kind ] + " (" + pg.segments + ")" } );
         }
         for ( var t = 0; t < f.trails.length; ++t )
            if ( !matchedIdx[ f.trails[ t ].index ] && f.trails[ t ].planeGroup == null )
            {
               var cls = SIMeteors.classifyTrail( f.trails[ t ], f.meta.dateObs );
               events.push( { timeUtc: f.meta.dateObs,
                              klass: cls.klass,
                              name: null,
                              shower: cls.shower ? cls.shower.name : null,
                              confidence: cls.confidence,
                              reason: cls.reason,
                              frameId: f.meta.id, frameName: f.meta.name } );
               var lb = langLabels[ cls.klass ] || langLabels.unknown;
               if ( cls.klass === "meteor" && cls.shower )
                  lb += " (" + cls.shower.name + ")";
               labeledTrails.push( { frameIndex: i,
                                     x1: f.trails[ t ].x1, y1: f.trails[ t ].y1,
                                     x2: f.trails[ t ].x2, y2: f.trails[ t ].y2,
                                     color: STYLE[ cls.klass ] || STYLE.unknown,
                                     label: lb } );
            }
      }
      return { events: events, labeledTrails: labeledTrails, predicted: predicted,
               cleanFrames: cleanFrames, totalExposureSec: totalExposureSec };
   }

   return { build: build };
} )();
