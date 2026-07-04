package main

// Fixture generator for the JS port of the matching engine. Skipped unless
// SI_GEN_FIXTURES=1; then it writes concrete reference files under
// ../tests/fixtures/match/ that the PJSR-side tests replay:
//
//   delta.tle         the SGP4 verification object (06251)
//   request.json      a match request whose trail is the satellite's own path
//   propagation.json  stepwise ECI + topocentric RA/Dec from this engine
//
// response.json is produced by running the built CLI on these files, so the
// whole stack (parse -> propagate -> match -> serialize) is the reference.

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	satellite "github.com/joshuaferrara/go-satellite"
)

func TestGenerateFixtures(t *testing.T) {
	if os.Getenv("SI_GEN_FIXTURES") != "1" {
		t.Skip("set SI_GEN_FIXTURES=1 to (re)generate the JS reference fixtures")
	}
	outDir := "../tests/fixtures/match"
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		t.Fatal(err)
	}

	tleText := "DELTA 1 DEB\n" + deltaLine1 + "\n" + deltaLine2 + "\n"
	tles := parseTLEs([]byte(tleText))
	if len(tles) != 1 {
		t.Fatal("fixture TLE did not parse")
	}
	e := newSatEntry(tles[0])

	// Same scenario as TestRunMatchEndToEnd: sunlit moment near epoch,
	// observer at the subpoint, FOV on the topocentric direction.
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

	pos, _, _ := propagateAt(&e, tMid)
	_, _, ll := satellite.ECIToLLA(pos, satellite.ThetaG_JD(jdayOf(tMid)))
	lld := satellite.LatLongDeg(ll)
	obs := observerSpec{LatDeg: lld.Latitude, LonDeg: lld.Longitude, AltM: 0}
	obsPos, _ := observerECI(obs, jdayOf(tMid))
	center := vecToRaDec(sub3(pos, obsPos))
	fov := fovSpec{RaDeg: center.RaDeg, DecDeg: center.DecDeg,
		WidthDeg: 4, HeightDeg: 3, RotationDeg: 0, HasWcs: true}
	start := tMid.Add(-30 * time.Second)

	// Pass 1 finds the crossing; its path becomes the request's trail so the
	// committed request exercises the full match (not just the crossing scan).
	frame := frameSpec{ID: "L_0001.fits", StartUtc: start.UTC().Format(time.RFC3339Nano),
		ExposureSec: 60, Fov: fov}
	res, err := runMatch(matchRequest{Observer: obs, Frames: []frameSpec{frame}}, tles, "delta")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Frames) != 1 || len(res.Frames[0].Crossings) == 0 {
		t.Fatal("no crossing in fixture scenario")
	}
	c := res.Frames[0].Crossings[0]
	frame.Trails = []trailSpec{{Index: 0, P1: &c.Path.P1, P2: &c.Path.P2}}
	req := matchRequest{Observer: obs, Frames: []frameSpec{frame}}

	// Stepwise propagation dump: ECI + topocentric RA/Dec over the window.
	type step struct {
		Utc     string  `json:"utc"`
		XKm     float64 `json:"xKm"`
		YKm     float64 `json:"yKm"`
		ZKm     float64 `json:"zKm"`
		RaDeg   float64 `json:"raDeg"`
		DecDeg  float64 `json:"decDeg"`
		Sunlit  bool    `json:"sunlit"`
		RangeKm float64 `json:"rangeKm"`
	}
	var steps []step
	for off := 0; off <= 60; off += 10 {
		tt := start.Add(time.Duration(off) * time.Second)
		p, _, ok := propagateAt(&e, tt)
		if !ok {
			t.Fatalf("propagation failed at +%ds", off)
		}
		op, _ := observerECI(obs, jdayOf(tt))
		rel := sub3(p, op)
		rd := vecToRaDec(rel)
		steps = append(steps, step{Utc: tt.UTC().Format(time.RFC3339),
			XKm: p.X, YKm: p.Y, ZKm: p.Z,
			RaDeg: rd.RaDeg, DecDeg: rd.DecDeg,
			Sunlit:  isSunlit(p, sunDirection(jdayOf(tt))),
			RangeKm: norm3(rel)})
	}

	writeFixture := func(name string, v interface{}) {
		b, err := json.MarshalIndent(v, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(outDir+"/"+name, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(outDir+"/delta.tle", []byte(tleText), 0o644); err != nil {
		t.Fatal(err)
	}
	writeFixture("request.json", req)
	writeFixture("propagation.json", map[string]interface{}{
		"observer": obs, "steps": steps})
	t.Logf("fixtures written to %s (run the CLI to produce response.json)", outDir)
}
