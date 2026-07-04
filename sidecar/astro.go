package main

import (
	"math"
	"strconv"
	"strings"
	"time"

	satellite "github.com/joshuaferrara/go-satellite"
)

const (
	deg2rad     = math.Pi / 180
	rad2deg     = 180 / math.Pi
	earthRadius = 6378.137      // km, equatorial
	earthOmega  = 7.29211585e-5 // rad/s, rotation rate
)

// raDec is a J2000-ish equatorial direction in degrees. Satellite directions
// are computed in TEME (true equator, mean equinox of date), which differs
// from the J2000 frame of plate-solved WCS by precession (~0.35 deg in 2026).
// The architecture spec explicitly accepts this: matchMaxSepDeg absorbs it
// together with TLE epoch drift.
type raDec struct {
	RaDeg  float64 `json:"raDeg"`
	DecDeg float64 `json:"decDeg"`
}

type vec3 = satellite.Vector3

func sub3(a, b vec3) vec3    { return vec3{X: a.X - b.X, Y: a.Y - b.Y, Z: a.Z - b.Z} }
func norm3(a vec3) float64   { return math.Sqrt(a.X*a.X + a.Y*a.Y + a.Z*a.Z) }
func dot3(a, b vec3) float64 { return a.X*b.X + a.Y*b.Y + a.Z*b.Z }
func cross3(a, b vec3) vec3 {
	return vec3{
		X: a.Y*b.Z - a.Z*b.Y,
		Y: a.Z*b.X - a.X*b.Z,
		Z: a.X*b.Y - a.Y*b.X,
	}
}

// jdayOf returns the Julian date (UT) of t with sub-second precision
// (go-satellite's JDay only takes integer seconds).
func jdayOf(t time.Time) float64 {
	t = t.UTC()
	frac := (float64(t.Second()) + float64(t.Nanosecond())/1e9) / 86400
	return satellite.JDay(t.Year(), int(t.Month()), t.Day(), t.Hour(), t.Minute(), 0) + frac
}

// vecToRaDec converts a direction vector (equatorial frame) to RA/Dec degrees.
func vecToRaDec(v vec3) raDec {
	ra := math.Atan2(v.Y, v.X) * rad2deg
	if ra < 0 {
		ra += 360
	}
	dec := math.Asin(v.Z/norm3(v)) * rad2deg
	return raDec{RaDeg: ra, DecDeg: dec}
}

// angularSepDeg is the great-circle separation of two directions (haversine,
// stable at small angles).
func angularSepDeg(a, b raDec) float64 {
	ra1, de1 := a.RaDeg*deg2rad, a.DecDeg*deg2rad
	ra2, de2 := b.RaDeg*deg2rad, b.DecDeg*deg2rad
	sd := math.Sin((de2 - de1) / 2)
	sr := math.Sin((ra2 - ra1) / 2)
	h := sd*sd + math.Cos(de1)*math.Cos(de2)*sr*sr
	return 2 * math.Asin(math.Min(1, math.Sqrt(h))) * rad2deg
}

// positionAngleDeg is the bearing of b as seen from a, east of north, in
// [0, 360). Segment *orientations* compare modulo 180.
func positionAngleDeg(a, b raDec) float64 {
	ra1, de1 := a.RaDeg*deg2rad, a.DecDeg*deg2rad
	ra2, de2 := b.RaDeg*deg2rad, b.DecDeg*deg2rad
	dra := ra2 - ra1
	y := math.Sin(dra) * math.Cos(de2)
	x := math.Cos(de1)*math.Sin(de2) - math.Sin(de1)*math.Cos(de2)*math.Cos(dra)
	pa := math.Atan2(y, x) * rad2deg
	if pa < 0 {
		pa += 360
	}
	return pa
}

// orientationDiffDeg compares two segment orientations modulo 180, in [0, 90].
func orientationDiffDeg(pa1, pa2 float64) float64 {
	d := math.Mod(math.Abs(pa1-pa2), 180)
	if d > 90 {
		d = 180 - d
	}
	return d
}

// midpointRaDec is the direction halfway along the great circle from a to b
// (unit-vector average; fine for short arcs).
func midpointRaDec(a, b raDec) raDec {
	av := raDecToVec(a)
	bv := raDecToVec(b)
	return vecToRaDec(vec3{X: av.X + bv.X, Y: av.Y + bv.Y, Z: av.Z + bv.Z})
}

func raDecToVec(p raDec) vec3 {
	ra, de := p.RaDeg*deg2rad, p.DecDeg*deg2rad
	return vec3{X: math.Cos(de) * math.Cos(ra), Y: math.Cos(de) * math.Sin(ra), Z: math.Sin(de)}
}

// fovContains reports whether direction p falls inside the FOV rectangle.
// The FOV is treated as a rectangle on the gnomonic tangent plane at its
// center — a good approximation of the spherical rectangle for fields up to a
// few degrees (documented v1 simplification). rotationDeg is the position
// angle of the frame's height (+y) axis, east of north (WCS-like rotation).
func fovContains(fov fovSpec, p raDec) bool {
	x, y, ok := tangentOffsets(raDec{RaDeg: fov.RaDeg, DecDeg: fov.DecDeg}, p)
	if !ok {
		return false
	}
	th := fov.RotationDeg * deg2rad
	// rotate sky offsets (x east, y north) into the frame's axes
	fx := x*math.Cos(th) - y*math.Sin(th)
	fy := x*math.Sin(th) + y*math.Cos(th)
	return math.Abs(fx) <= fov.WidthDeg/2 && math.Abs(fy) <= fov.HeightDeg/2
}

// tangentOffsets projects p onto the gnomonic tangent plane at center and
// returns standard coordinates in degrees (x toward +RA/east, y toward +Dec/
// north). ok is false when p is 90 deg or more away (behind the plane).
func tangentOffsets(center, p raDec) (x, y float64, ok bool) {
	ra0, de0 := center.RaDeg*deg2rad, center.DecDeg*deg2rad
	ra, de := p.RaDeg*deg2rad, p.DecDeg*deg2rad
	dra := ra - ra0
	d := math.Sin(de0)*math.Sin(de) + math.Cos(de0)*math.Cos(de)*math.Cos(dra)
	if d <= 1e-6 {
		return 0, 0, false
	}
	x = math.Cos(de) * math.Sin(dra) / d * rad2deg
	y = (math.Cos(de0)*math.Sin(de) - math.Sin(de0)*math.Cos(de)*math.Cos(dra)) / d * rad2deg
	return x, y, true
}

// sunDirection returns the unit vector toward the Sun in the true-of-date
// equatorial frame (matches TEME well enough for a shadow test), using the
// low-precision solar position of Meeus, Astronomical Algorithms ch. 25
// (accuracy ~0.01 deg, orders of magnitude better than needed here).
func sunDirection(jday float64) vec3 {
	tj := (jday - 2451545.0) / 36525.0
	l0 := math.Mod(280.46646+36000.76983*tj, 360) * deg2rad // geometric mean longitude
	m := math.Mod(357.52911+35999.05029*tj, 360) * deg2rad  // mean anomaly
	c := (1.914602-0.004817*tj)*math.Sin(m) +
		0.019993*math.Sin(2*m) +
		0.000289*math.Sin(3*m) // equation of center, deg
	lam := l0 + c*deg2rad                        // true ecliptic longitude
	eps := (23.4392911 - 0.0130042*tj) * deg2rad // mean obliquity
	return vec3{
		X: math.Cos(lam),
		Y: math.Cos(eps) * math.Sin(lam),
		Z: math.Sin(eps) * math.Sin(lam),
	}
}

// isSunlit applies a cylindrical Earth-shadow model: a satellite at geocentric
// position r (km) is eclipsed iff it is on the night side (projection on the
// sun direction negative) and within one Earth radius of the shadow axis.
// Penumbra is ignored (v1 simplification, fine for a boolean visibility cue).
func isSunlit(r vec3, sunDir vec3) bool {
	along := dot3(r, sunDir)
	if along >= 0 {
		return true
	}
	perp2 := dot3(r, r) - along*along
	return perp2 > earthRadius*earthRadius
}

// satEntry couples a parsed TLE with its initialized SGP4 state.
type satEntry struct {
	tle TLE
	sat satellite.Satellite
	// epochFracSec is the fractional epoch second that go-satellite's
	// TLEToSat truncates when it computes jdsatepoch. Left uncorrected it
	// shifts every propagation by up to 1 s (~7 km along-track for LEO).
	// propagateAt subtracts it from the query time so the truncations cancel.
	epochFracSec float64
}

func newSatEntry(t TLE) satEntry {
	return satEntry{
		tle: t,
		// WGS72, not 84: TLE mean elements are fitted against WGS72 —
		// the standard gravity model for SGP4 (Vallado, AIAA 2006-6753).
		sat:          satellite.TLEToSat(t.Line1, t.Line2, satellite.GravityWGS72),
		epochFracSec: epochFracSecond(t.Line1),
	}
}

// epochFracSecond reproduces go-satellite's epoch decomposition (days2mdhms)
// and returns the sub-second part it drops.
func epochFracSecond(line1 string) float64 {
	days, err := strconv.ParseFloat(strings.TrimSpace(line1[20:32]), 64)
	if err != nil {
		return 0
	}
	frac := days - math.Floor(days)
	h := frac * 24
	frac = h - math.Floor(h)
	m := frac * 60
	sec := (m - math.Floor(m)) * 60
	return sec - math.Floor(sec)
}

// propagateAt returns the TEME position (km) and velocity (km/s) of e at t.
// go-satellite only propagates at integer seconds, so sub-second times are
// linearly interpolated between the two bracketing seconds (error < 2 m for
// LEO — far below every tolerance in play). ok is false when the propagation
// produced a non-physical state (decayed satellite, bad elements).
func propagateAt(e *satEntry, t time.Time) (pos, vel vec3, ok bool) {
	// cancel the library's epoch-second truncation
	t = t.Add(-time.Duration(e.epochFracSec * float64(time.Second))).UTC()
	t0 := t.Truncate(time.Second)
	fr := float64(t.Sub(t0)) / float64(time.Second)
	p0, v0 := satellite.Propagate(e.sat, t0.Year(), int(t0.Month()), t0.Day(), t0.Hour(), t0.Minute(), t0.Second())
	if !plausibleState(p0) {
		return pos, vel, false
	}
	if fr == 0 {
		return p0, v0, true
	}
	t1 := t0.Add(time.Second)
	p1, v1 := satellite.Propagate(e.sat, t1.Year(), int(t1.Month()), t1.Day(), t1.Hour(), t1.Minute(), t1.Second())
	if !plausibleState(p1) {
		return pos, vel, false
	}
	return lerp3(p0, p1, fr), lerp3(v0, v1, fr), true
}

func lerp3(a, b vec3, f float64) vec3 {
	return vec3{X: a.X + (b.X-a.X)*f, Y: a.Y + (b.Y-a.Y)*f, Z: a.Z + (b.Z-a.Z)*f}
}

// plausibleState guards against go-satellite's silent error mode: Propagate
// takes the Satellite by value, so its Error field is invisible to us and a
// decayed/degenerate record yields garbage coordinates instead.
func plausibleState(p vec3) bool {
	n := norm3(p)
	return !math.IsNaN(n) && !math.IsInf(n, 0) && n > 6400 && n < 500000
}

// observerECI returns the observer's position (km) and velocity (km/s) in the
// TEME/ECI frame at jday. Spherical-Earth model via go-satellite's LLAToECI;
// geodetic-vs-geocentric latitude costs at most ~0.2 deg of parallax on the
// satellite direction at LEO ranges, inside the accepted tolerance budget.
func observerECI(obs observerSpec, jday float64) (pos, vel vec3) {
	ll := satellite.LatLong{Latitude: obs.LatDeg * deg2rad, Longitude: obs.LonDeg * deg2rad}
	pos = satellite.LLAToECI(ll, obs.AltM/1000, jday)
	// velocity from Earth rotation: omega x r
	vel = vec3{X: -earthOmega * pos.Y, Y: earthOmega * pos.X, Z: 0}
	return pos, vel
}
