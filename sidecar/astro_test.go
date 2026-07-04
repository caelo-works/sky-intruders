package main

import (
	"math"
	"testing"
	"time"
)

// TestPropagateAtValladoFixture checks the whole time pipeline (jday handling,
// epoch-fraction correction, sub-second interpolation) against the standard
// SGP4 verification vector for object 06251 (Vallado, AIAA 2006-6753; same
// fixture go-satellite's own suite uses): tsince = 120 min after the TLE
// epoch 2006-06-25 19:46:43.980096 UTC.
func TestPropagateAtValladoFixture(t *testing.T) {
	tles := parseTLEs([]byte("DELTA\n" + deltaLine1 + "\n" + deltaLine2 + "\n"))
	if len(tles) != 1 {
		t.Fatal("fixture TLE did not parse")
	}
	e := newSatEntry(tles[0])

	// epoch + 120 min, sub-second wall-clock time
	at := time.Date(2006, 6, 25, 21, 46, 43, 980096000, time.UTC)
	pos, vel, ok := propagateAt(&e, at)
	if !ok {
		t.Fatal("propagation failed")
	}
	want := vec3{X: -3935.69800083, Y: 409.10980837, Z: 5471.33577327}
	wantV := vec3{X: -3.374784183, Y: -6.635211043, Z: -1.942056221}
	if d := norm3(sub3(pos, want)); d > 0.1 {
		t.Errorf("position off by %.4f km: got %+v want %+v", d, pos, want)
	}
	if d := norm3(sub3(vel, wantV)); d > 0.01 {
		t.Errorf("velocity off by %.5f km/s: got %+v want %+v", d, vel, wantV)
	}
}

func TestEpochFracSecond(t *testing.T) {
	// 06176.82412014 -> 19:46:43.980096, fractional second 0.980096
	if got := epochFracSecond(deltaLine1); math.Abs(got-0.980096) > 1e-4 {
		t.Errorf("epochFracSecond = %f, want ~0.980096", got)
	}
}

func TestSunDirectionSeasons(t *testing.T) {
	// March equinox 2026 (Mar 20 ~14:46 UTC): sun near dec 0
	eq := sunDirection(jdayOf(time.Date(2026, 3, 20, 14, 46, 0, 0, time.UTC)))
	if d := vecToRaDec(eq); math.Abs(d.DecDeg) > 0.3 {
		t.Errorf("equinox sun dec = %.3f, want ~0", d.DecDeg)
	}
	// June solstice 2026 (Jun 21): sun near dec +23.43
	so := sunDirection(jdayOf(time.Date(2026, 6, 21, 8, 25, 0, 0, time.UTC)))
	if d := vecToRaDec(so); math.Abs(d.DecDeg-23.43) > 0.2 {
		t.Errorf("solstice sun dec = %.3f, want ~23.43", d.DecDeg)
	}
	if n := norm3(eq); math.Abs(n-1) > 1e-9 {
		t.Errorf("sun direction not unit length: %f", n)
	}
}

func TestIsSunlit(t *testing.T) {
	sun := vec3{X: 1, Y: 0, Z: 0}
	cases := []struct {
		name string
		r    vec3
		want bool
	}{
		{"day side", vec3{X: 7000, Y: 0, Z: 0}, true},
		{"deep in shadow", vec3{X: -7000, Y: 0, Z: 0}, false},
		{"night side but above shadow cylinder", vec3{X: -7000, Y: 6500, Z: 0}, true},
		{"night side inside shadow cylinder", vec3{X: -7000, Y: 6000, Z: 0}, false},
		{"terminator", vec3{X: 0, Y: 6800, Z: 0}, true},
	}
	for _, c := range cases {
		if got := isSunlit(c.r, sun); got != c.want {
			t.Errorf("%s: sunlit=%v, want %v", c.name, got, c.want)
		}
	}
}

func TestFovContains(t *testing.T) {
	fov := fovSpec{RaDeg: 100, DecDeg: 45, WidthDeg: 4, HeightDeg: 2}
	cases := []struct {
		name string
		rot  float64
		p    raDec
		want bool
	}{
		{"center", 0, raDec{100, 45}, true},
		{"inside north", 0, raDec{100, 45.9}, true},
		{"outside north", 0, raDec{100, 46.2}, false},
		{"inside east (RA compressed by cos dec)", 0, raDec{102, 45}, true},
		{"outside east", 0, raDec{104, 45}, false},
		{"far away", 0, raDec{280, -45}, false},
		// rotating the frame 90 deg swaps width/height on the sky
		{"north outside unrotated", 0, raDec{100, 46.5}, false},
		{"north inside when rotated 90", 90, raDec{100, 46.5}, true},
		{"east inside unrotated", 0, raDec{102.5, 45}, true},
		{"east outside when rotated 90", 90, raDec{102.5, 45}, false},
	}
	for _, c := range cases {
		fov.RotationDeg = c.rot
		if got := fovContains(fov, c.p); got != c.want {
			t.Errorf("%s: contains=%v, want %v", c.name, got, c.want)
		}
	}
}

func TestOrientationDiffDeg(t *testing.T) {
	cases := []struct{ a, b, want float64 }{
		{10, 10, 0},
		{10, 190, 0}, // same orientation, opposite direction
		{0, 90, 90},
		{175, 5, 10}, // wraps around 180
		{350, 10, 20},
	}
	for _, c := range cases {
		if got := orientationDiffDeg(c.a, c.b); math.Abs(got-c.want) > 1e-9 {
			t.Errorf("orientationDiffDeg(%g,%g) = %g, want %g", c.a, c.b, got, c.want)
		}
	}
}

func TestAngularSepAndPositionAngle(t *testing.T) {
	a := raDec{RaDeg: 100, DecDeg: 0}
	if got := angularSepDeg(a, raDec{RaDeg: 101, DecDeg: 0}); math.Abs(got-1) > 1e-9 {
		t.Errorf("sep along equator = %g, want 1", got)
	}
	if got := positionAngleDeg(a, raDec{RaDeg: 100, DecDeg: 1}); math.Abs(got-0) > 1e-9 {
		t.Errorf("PA due north = %g, want 0", got)
	}
	if got := positionAngleDeg(a, raDec{RaDeg: 101, DecDeg: 0}); math.Abs(got-90) > 1e-9 {
		t.Errorf("PA due east = %g, want 90", got)
	}
}
