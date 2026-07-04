package main

import (
	"math"
	"testing"
	"time"

	satellite "github.com/joshuaferrara/go-satellite"
)

// destination returns the point at the given bearing (deg east of north) and
// angular distance (deg) from p.
func destination(p raDec, bearingDeg, distDeg float64) raDec {
	la1, lo1 := p.DecDeg*deg2rad, p.RaDeg*deg2rad
	br, d := bearingDeg*deg2rad, distDeg*deg2rad
	la2 := math.Asin(math.Sin(la1)*math.Cos(d) + math.Cos(la1)*math.Sin(d)*math.Cos(br))
	lo2 := lo1 + math.Atan2(math.Sin(br)*math.Sin(d)*math.Cos(la1),
		math.Cos(d)-math.Sin(la1)*math.Sin(la2))
	ra := math.Mod(lo2*rad2deg+360, 360)
	return raDec{RaDeg: ra, DecDeg: la2 * rad2deg}
}

// synthCrossing builds a sunlit crossing whose path runs from the midpoint m
// along the given orientation.
func synthCrossing(norad int, m raDec, paDeg, lenDeg float64) crossing {
	return crossing{
		NoradID: norad,
		Name:    "SYNTH",
		Sunlit:  true,
		Path: pathSpec{
			P1: destination(m, paDeg+180, lenDeg/2),
			P2: destination(m, paDeg, lenDeg/2),
		},
	}
}

func synthTrail(index int, m raDec, paDeg, lenDeg float64) trailSpec {
	p1 := destination(m, paDeg+180, lenDeg/2)
	p2 := destination(m, paDeg, lenDeg/2)
	return trailSpec{Index: index, P1: &p1, P2: &p2}
}

func defaultOpts() matchOptions {
	o := matchOptions{}
	o.applyDefaults()
	return o
}

func TestAssignTrailsMatchesAlignedTrail(t *testing.T) {
	m := raDec{RaDeg: 150, DecDeg: 30}
	crossings := []crossing{synthCrossing(1, m, 40, 1.0)}
	fr := frameSpec{Trails: []trailSpec{
		// same orientation, midpoint offset 0.05 deg, slightly shorter
		synthTrail(7, destination(m, 130, 0.05), 40, 0.9),
	}}
	assignTrails(crossings, fr, defaultOpts())
	c := crossings[0]
	if c.MatchedTrailIndex == nil || *c.MatchedTrailIndex != 7 {
		t.Fatalf("expected match to trail 7, got %+v", c)
	}
	if c.MatchScore == nil || *c.MatchScore < 0.5 || *c.MatchScore > 1 {
		t.Errorf("score out of range: %v", *c.MatchScore)
	}
	if *c.SepDeg > 0.06 || *c.AngleDiffDeg > 1 {
		t.Errorf("sep/angle wrong: sep=%v angle=%v", *c.SepDeg, *c.AngleDiffDeg)
	}
}

func TestAssignTrailsRejectsWrongOrientation(t *testing.T) {
	m := raDec{RaDeg: 150, DecDeg: 30}
	crossings := []crossing{synthCrossing(1, m, 40, 1.0)}
	fr := frameSpec{Trails: []trailSpec{
		synthTrail(0, m, 40+90, 1.0), // perpendicular
	}}
	assignTrails(crossings, fr, defaultOpts())
	if crossings[0].MatchedTrailIndex != nil {
		t.Fatal("perpendicular trail must not match")
	}
}

func TestAssignTrailsRejectsFarTrail(t *testing.T) {
	m := raDec{RaDeg: 150, DecDeg: 30}
	crossings := []crossing{synthCrossing(1, m, 40, 1.0)}
	fr := frameSpec{Trails: []trailSpec{
		synthTrail(0, destination(m, 130, 0.5), 40, 1.0), // 0.5 deg off, > matchMaxSepDeg
	}}
	assignTrails(crossings, fr, defaultOpts())
	if crossings[0].MatchedTrailIndex != nil {
		t.Fatal("distant trail must not match")
	}
}

func TestAssignTrailsEclipsedNeverMatches(t *testing.T) {
	m := raDec{RaDeg: 150, DecDeg: 30}
	c := synthCrossing(1, m, 40, 1.0)
	c.Sunlit = false
	crossings := []crossing{c}
	fr := frameSpec{Trails: []trailSpec{synthTrail(0, m, 40, 1.0)}}
	assignTrails(crossings, fr, defaultOpts())
	if crossings[0].MatchedTrailIndex != nil {
		t.Fatal("eclipsed crossing must not match a trail")
	}
}

func TestAssignTrailsResolvesConflictByScore(t *testing.T) {
	m := raDec{RaDeg: 150, DecDeg: 30}
	// two crossings compete for the same trail; the closer one must win
	near := synthCrossing(1, destination(m, 130, 0.01), 40, 1.0)
	far := synthCrossing(2, destination(m, 130, 0.15), 40, 1.0)
	crossings := []crossing{far, near}
	fr := frameSpec{Trails: []trailSpec{synthTrail(0, m, 40, 1.0)}}
	assignTrails(crossings, fr, defaultOpts())
	if crossings[1].MatchedTrailIndex == nil || crossings[0].MatchedTrailIndex != nil {
		t.Fatalf("conflict resolved wrong: far=%+v near=%+v",
			crossings[0].MatchedTrailIndex, crossings[1].MatchedTrailIndex)
	}
}

func TestAssignTrailsSkipsTrailsWithoutWcs(t *testing.T) {
	m := raDec{RaDeg: 150, DecDeg: 30}
	crossings := []crossing{synthCrossing(1, m, 40, 1.0)}
	fr := frameSpec{Trails: []trailSpec{{Index: 0, P1: nil, P2: nil}}}
	assignTrails(crossings, fr, defaultOpts())
	if crossings[0].MatchedTrailIndex != nil {
		t.Fatal("trail without sky coordinates must not match")
	}
}

// TestRunMatchEndToEnd drives the full pipeline with a real SGP4 fixture:
// point the FOV at wherever object 06251 actually is (as seen from its own
// subpoint, guaranteeing high elevation), run match, and check the crossing;
// then feed the reported path back in as a detected trail and require a
// match — and require NO match once the trail is rotated 90 deg in place.
func TestRunMatchEndToEnd(t *testing.T) {
	tles := parseTLEs([]byte("DELTA 1 DEB\n" + deltaLine1 + "\n" + deltaLine2 + "\n"))
	if len(tles) != 1 {
		t.Fatal("fixture TLE did not parse")
	}
	e := newSatEntry(tles[0])

	// find a moment near the TLE epoch where the satellite is sunlit
	epoch := time.Date(2006, 6, 25, 19, 46, 43, 980096000, time.UTC)
	var tMid time.Time
	found := false
	for off := 0; off <= 5400; off += 600 {
		tt := epoch.Add(time.Duration(off) * time.Second)
		if pos, _, ok := propagateAt(&e, tt); ok && isSunlit(pos, sunDirection(jdayOf(tt))) {
			tMid, found = tt, true
			break
		}
	}
	if !found {
		t.Fatal("no sunlit moment found near epoch")
	}

	// observer at the satellite's subpoint -> elevation ~90 deg
	pos, _, _ := propagateAt(&e, tMid)
	_, _, ll := satellite.ECIToLLA(pos, satellite.ThetaG_JD(jdayOf(tMid)))
	lld := satellite.LatLongDeg(ll)
	obs := observerSpec{LatDeg: lld.Latitude, LonDeg: lld.Longitude, AltM: 0}

	// FOV centered on the satellite's topocentric direction at tMid
	obsPos, _ := observerECI(obs, jdayOf(tMid))
	center := vecToRaDec(sub3(pos, obsPos))
	fov := fovSpec{RaDeg: center.RaDeg, DecDeg: center.DecDeg,
		WidthDeg: 4, HeightDeg: 3, RotationDeg: 0, HasWcs: true}
	start := tMid.Add(-30 * time.Second)

	frame := frameSpec{
		ID: "L_0001.fits", StartUtc: start.UTC().Format(time.RFC3339Nano),
		ExposureSec: 60, Fov: fov,
	}
	req := matchRequest{Observer: obs, Frames: []frameSpec{frame}}

	// pass 1: no trails, just find the crossing
	res, err := runMatch(req, tles, "test")
	if err != nil {
		t.Fatal(err)
	}
	if res.TLE.Count != 1 || res.TLE.Source != "test" {
		t.Errorf("bad tle info: %+v", res.TLE)
	}
	if len(res.Frames) != 1 || len(res.Frames[0].Crossings) == 0 {
		t.Fatalf("expected a crossing, got %+v", res.Frames)
	}
	c := res.Frames[0].Crossings[0]
	if c.NoradID != 6251 || c.IntlDes != "1962-025E" {
		t.Errorf("bad identity: %+v", c)
	}
	if !c.Sunlit {
		t.Error("crossing should be sunlit at the chosen time")
	}
	if c.ElevationDeg < 60 {
		t.Errorf("elevation %.1f, want near-zenith", c.ElevationDeg)
	}
	if c.RangeKm < 200 || c.RangeKm > 2000 {
		t.Errorf("range %.0f km out of LEO ballpark", c.RangeKm)
	}
	if c.AngularRateDegPerSec < 0.1 || c.AngularRateDegPerSec > 3 {
		t.Errorf("angular rate %.3f deg/s implausible", c.AngularRateDegPerSec)
	}
	if c.MatchedTrailIndex != nil {
		t.Error("no trails were provided; matchedTrailIndex must be null")
	}
	entry, err1 := time.Parse(time.RFC3339, c.EntryUtc)
	exit, err2 := time.Parse(time.RFC3339, c.ExitUtc)
	if err1 != nil || err2 != nil ||
		entry.Before(start.Truncate(time.Second)) || exit.After(start.Add(61*time.Second)) || exit.Before(entry) {
		t.Errorf("entry/exit outside window: %s .. %s", c.EntryUtc, c.ExitUtc)
	}

	// pass 2: the reported path, fed back as a detected trail, must match
	frame.Trails = []trailSpec{{Index: 0, P1: &c.Path.P1, P2: &c.Path.P2}}
	req.Frames = []frameSpec{frame}
	res2, err := runMatch(req, tles, "test")
	if err != nil {
		t.Fatal(err)
	}
	c2 := res2.Frames[0].Crossings[0]
	if c2.MatchedTrailIndex == nil || *c2.MatchedTrailIndex != 0 {
		t.Fatalf("crossing did not match its own path as trail: %+v", c2)
	}
	if *c2.MatchScore < 0.9 {
		t.Errorf("self-match score %.3f, want > 0.9", *c2.MatchScore)
	}

	// pass 3: same trail rotated 90 deg about its midpoint must NOT match
	mid := midpointRaDec(c.Path.P1, c.Path.P2)
	pa := positionAngleDeg(c.Path.P1, c.Path.P2)
	length := angularSepDeg(c.Path.P1, c.Path.P2)
	rot := synthTrail(0, mid, pa+90, length)
	frame.Trails = []trailSpec{rot}
	req.Frames = []frameSpec{frame}
	res3, err := runMatch(req, tles, "test")
	if err != nil {
		t.Fatal(err)
	}
	if res3.Frames[0].Crossings[0].MatchedTrailIndex != nil {
		t.Fatal("rotated trail must not match")
	}
}

func TestRunMatchBadFrame(t *testing.T) {
	tles := parseTLEs([]byte(sampleCatalog))
	req := matchRequest{Frames: []frameSpec{{ID: "x", StartUtc: "not-a-time", ExposureSec: 60}}}
	if _, err := runMatch(req, tles, "test"); err == nil {
		t.Fatal("expected error on bad startUtc")
	}
	req = matchRequest{Frames: []frameSpec{{ID: "x", StartUtc: "2026-07-03T02:13:05Z", ExposureSec: 0}}}
	if _, err := runMatch(req, tles, "test"); err == nil {
		t.Fatal("expected error on zero exposure")
	}
}
