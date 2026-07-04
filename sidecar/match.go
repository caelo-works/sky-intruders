package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	satellite "github.com/joshuaferrara/go-satellite"
)

// ---- request/response shapes (see docs/ARCHITECTURE.md "Sidecar contracts") ----

type observerSpec struct {
	LatDeg float64 `json:"latDeg"`
	LonDeg float64 `json:"lonDeg"`
	AltM   float64 `json:"altM"`
}

type fovSpec struct {
	RaDeg       float64 `json:"raDeg"`
	DecDeg      float64 `json:"decDeg"`
	WidthDeg    float64 `json:"widthDeg"`
	HeightDeg   float64 `json:"heightDeg"`
	RotationDeg float64 `json:"rotationDeg"`
	HasWcs      bool    `json:"hasWcs"`
}

type trailSpec struct {
	Index               int     `json:"index"`
	P1                  *raDec  `json:"p1"`
	P2                  *raDec  `json:"p2"`
	PixLength           float64 `json:"pixLength"`
	MeanFluxAdu         float64 `json:"meanFluxAdu"`
	WidthPx             float64 `json:"widthPx"`
	BrightnessVariation float64 `json:"brightnessVariation"`
}

type frameSpec struct {
	ID          string      `json:"id"`
	StartUtc    string      `json:"startUtc"`
	ExposureSec float64     `json:"exposureSec"`
	Fov         fovSpec     `json:"fov"`
	Trails      []trailSpec `json:"trails"`
}

type matchOptions struct {
	StepSec              float64 `json:"stepSec"`
	MatchMaxSepDeg       float64 `json:"matchMaxSepDeg"`
	MatchMaxAngleDiffDeg float64 `json:"matchMaxAngleDiffDeg"`
}

type matchRequest struct {
	Observer observerSpec `json:"observer"`
	Frames   []frameSpec  `json:"frames"`
	Options  matchOptions `json:"options"`
}

type pathSpec struct {
	P1 raDec `json:"p1"`
	P2 raDec `json:"p2"`
}

type crossing struct {
	NoradID              int      `json:"noradId"`
	Name                 string   `json:"name"`
	IntlDes              string   `json:"intlDes"`
	EntryUtc             string   `json:"entryUtc"`
	ExitUtc              string   `json:"exitUtc"`
	Path                 pathSpec `json:"path"`
	AngularRateDegPerSec float64  `json:"angularRateDegPerSec"`
	RangeKm              float64  `json:"rangeKm"`
	ElevationDeg         float64  `json:"elevationDeg"`
	Sunlit               bool     `json:"sunlit"`
	MatchedTrailIndex    *int     `json:"matchedTrailIndex"`
	MatchScore           *float64 `json:"matchScore,omitempty"`
	SepDeg               *float64 `json:"sepDeg,omitempty"`
	AngleDiffDeg         *float64 `json:"angleDiffDeg,omitempty"`
}

type frameResult struct {
	ID        string     `json:"id"`
	Crossings []crossing `json:"crossings"`
}

type tleInfo struct {
	Count  int    `json:"count"`
	Source string `json:"source"`
}

type matchResponse struct {
	TLE    tleInfo       `json:"tle"`
	Frames []frameResult `json:"frames"`
	Error  interface{}   `json:"error"` // always null; failures go through fatalJSON
}

// ---- command ----

func runMatchCmd(args []string) {
	fs := flag.NewFlagSet("match", flag.ExitOnError)
	tleFile := fs.String("tle-file", "", "TLE catalog file (from fetch-tle)")
	inFile := fs.String("in-file", "", "request JSON")
	outFile := fs.String("out-file", "", "write the JSON response to this file")
	_ = fs.Parse(args)

	if *tleFile == "" || *inFile == "" || *outFile == "" {
		fatalJSON(*outFile, "match: --tle-file, --in-file and --out-file are required")
	}
	tleData, err := os.ReadFile(*tleFile)
	if err != nil {
		fatalJSON(*outFile, "match: read tle file: %v", err)
	}
	tles := parseTLEs(tleData)
	if len(tles) == 0 {
		fatalJSON(*outFile, "match: %s contains no valid TLE records", *tleFile)
	}
	reqData, err := os.ReadFile(*inFile)
	if err != nil {
		fatalJSON(*outFile, "match: read in-file: %v", err)
	}
	var req matchRequest
	if err := json.Unmarshal(reqData, &req); err != nil {
		fatalJSON(*outFile, "match: parse request: %v", err)
	}
	source := strings.TrimSuffix(filepath.Base(*tleFile), ".tle")
	res, err := runMatch(req, tles, source)
	if err != nil {
		fatalJSON(*outFile, "match: %v", err)
	}
	writeJSON(*outFile, res)
}

// ---- matching ----

func (o *matchOptions) applyDefaults() {
	if o.StepSec <= 0 {
		o.StepSec = 1.0
	}
	if o.MatchMaxSepDeg <= 0 {
		o.MatchMaxSepDeg = 0.2
	}
	if o.MatchMaxAngleDiffDeg <= 0 {
		o.MatchMaxAngleDiffDeg = 12
	}
}

func runMatch(req matchRequest, tles []TLE, source string) (matchResponse, error) {
	req.Options.applyDefaults()

	sats := make([]satEntry, len(tles))
	for i, t := range tles {
		sats[i] = newSatEntry(t)
	}

	res := matchResponse{
		TLE:    tleInfo{Count: len(tles), Source: source},
		Frames: make([]frameResult, 0, len(req.Frames)),
	}
	for _, fr := range req.Frames {
		fres, err := matchFrame(fr, req.Observer, req.Options, sats)
		if err != nil {
			return res, fmt.Errorf("frame %q: %v", fr.ID, err)
		}
		res.Frames = append(res.Frames, fres)
	}
	return res, nil
}

func matchFrame(fr frameSpec, obs observerSpec, opt matchOptions, sats []satEntry) (frameResult, error) {
	start, err := time.Parse(time.RFC3339, fr.StartUtc)
	if err != nil {
		return frameResult{}, fmt.Errorf("bad startUtc %q: %v", fr.StartUtc, err)
	}
	if fr.ExposureSec <= 0 {
		return frameResult{}, fmt.Errorf("bad exposureSec %g", fr.ExposureSec)
	}

	var crossings []crossing
	for i := range sats {
		if !coarseCandidate(&sats[i], fr, obs, opt, start) {
			continue
		}
		crossings = append(crossings, fineCrossings(&sats[i], fr, obs, opt, start)...)
	}
	sort.Slice(crossings, func(i, j int) bool { return crossings[i].EntryUtc < crossings[j].EntryUtc })

	assignTrails(crossings, fr, opt)
	if crossings == nil {
		crossings = []crossing{} // stable JSON shape: [] rather than null
	}
	return frameResult{ID: fr.ID, Crossings: crossings}, nil
}

// coarseCandidate propagates one satellite at the exposure midpoint and keeps
// it only if it could plausibly touch the FOV during the window: angular
// separation from the FOV center must not exceed the FOV half-diagonal plus
// how far the satellite can travel in half the exposure plus the match margin.
func coarseCandidate(e *satEntry, fr frameSpec, obs observerSpec, opt matchOptions, start time.Time) bool {
	tMid := start.Add(time.Duration(fr.ExposureSec / 2 * float64(time.Second)))
	pos, vel, ok := propagateAt(e, tMid)
	if !ok {
		return false
	}
	jd := jdayOf(tMid)
	obsPos, obsVel := observerECI(obs, jd)
	rho := sub3(pos, obsPos)
	rhoDot := sub3(vel, obsVel)
	rhoLen := norm3(rho)
	if rhoLen == 0 {
		return false
	}
	// topocentric angular rate: |rho x rhodot| / |rho|^2
	rateDeg := norm3(cross3(rho, rhoDot)) / (rhoLen * rhoLen) * rad2deg
	reachDeg := rateDeg * fr.ExposureSec / 2

	// below the horizon for the whole window -> skip (2 deg slack on top of
	// the angular reach, so risers/setters at the edge are kept)
	el := elevationDeg(pos, obs, jd)
	if el < -(reachDeg + 2) {
		return false
	}

	sep := angularSepDeg(vecToRaDec(rho), raDec{RaDeg: fr.Fov.RaDeg, DecDeg: fr.Fov.DecDeg})
	halfDiag := 0.5 * math.Hypot(fr.Fov.WidthDeg, fr.Fov.HeightDeg)
	return sep <= halfDiag+reachDeg+opt.MatchMaxSepDeg
}

// fineCrossings steps a coarse candidate through the exposure window and
// turns every contiguous in-FOV (and above-horizon) run into a crossing.
func fineCrossings(e *satEntry, fr frameSpec, obs observerSpec, opt matchOptions, start time.Time) []crossing {
	type sample struct {
		t     time.Time
		dir   raDec
		inFov bool
	}
	nSteps := int(math.Ceil(fr.ExposureSec/opt.StepSec)) + 1
	samples := make([]sample, 0, nSteps)
	for i := 0; i < nSteps; i++ {
		dt := math.Min(float64(i)*opt.StepSec, fr.ExposureSec)
		t := start.Add(time.Duration(dt * float64(time.Second)))
		pos, _, ok := propagateAt(e, t)
		if !ok {
			return nil
		}
		jd := jdayOf(t)
		obsPos, _ := observerECI(obs, jd)
		dir := vecToRaDec(sub3(pos, obsPos))
		in := fovContains(fr.Fov, dir) && elevationDeg(pos, obs, jd) > 0
		samples = append(samples, sample{t: t, dir: dir, inFov: in})
	}

	var out []crossing
	for i := 0; i < len(samples); {
		if !samples[i].inFov {
			i++
			continue
		}
		j := i
		for j+1 < len(samples) && samples[j+1].inFov {
			j++
		}
		entry, exit := samples[i], samples[j]

		// mean angular rate over the run; single-sample runs fall back to the
		// instantaneous rate over one step
		var rate float64
		if dur := exit.t.Sub(entry.t).Seconds(); dur > 0 {
			rate = angularSepDeg(entry.dir, exit.dir) / dur
		} else {
			tn := entry.t.Add(time.Duration(opt.StepSec * float64(time.Second)))
			if pos, _, ok := propagateAt(e, tn); ok {
				obsPos, _ := observerECI(obs, jdayOf(tn))
				rate = angularSepDeg(entry.dir, vecToRaDec(sub3(pos, obsPos))) / opt.StepSec
			}
		}

		tMid := entry.t.Add(exit.t.Sub(entry.t) / 2)
		jdMid := jdayOf(tMid)
		posMid, _, ok := propagateAt(e, tMid)
		if !ok {
			i = j + 1
			continue
		}
		obsPos, _ := observerECI(obs, jdMid)
		out = append(out, crossing{
			NoradID:              e.tle.NoradID,
			Name:                 e.tle.Name,
			IntlDes:              e.tle.IntlDes,
			EntryUtc:             entry.t.UTC().Format(time.RFC3339),
			ExitUtc:              exit.t.UTC().Format(time.RFC3339),
			Path:                 pathSpec{P1: entry.dir, P2: exit.dir},
			AngularRateDegPerSec: rate,
			RangeKm:              norm3(sub3(posMid, obsPos)),
			ElevationDeg:         elevationDeg(posMid, obs, jdMid),
			Sunlit:               isSunlit(posMid, sunDirection(jdMid)),
		})
		i = j + 1
	}
	return out
}

// assignTrails matches crossings to detected trails. Candidates: sunlit
// crossings vs trails with sky coordinates, midpoint separation within
// matchMaxSepDeg and orientation within matchMaxAngleDiffDeg (mod 180). The
// score blends separation (0.4), orientation (0.3) and path-length/rate
// agreement (0.3), each normalized to [0,1]. Conflicts are resolved globally
// by score order: each trail and each crossing is used at most once.
func assignTrails(crossings []crossing, fr frameSpec, opt matchOptions) {
	type cand struct {
		ci, ti  int // crossing index, trail slice index
		score   float64
		sep, ad float64
	}
	var cands []cand
	for ci := range crossings {
		c := &crossings[ci]
		if !c.Sunlit {
			// eclipsed crossers explain nothing visible; still listed, never matched
			continue
		}
		cPA := positionAngleDeg(c.Path.P1, c.Path.P2)
		cMid := midpointRaDec(c.Path.P1, c.Path.P2)
		cLen := angularSepDeg(c.Path.P1, c.Path.P2)
		for ti, tr := range fr.Trails {
			if tr.P1 == nil || tr.P2 == nil {
				continue
			}
			sep := angularSepDeg(cMid, midpointRaDec(*tr.P1, *tr.P2))
			if sep > opt.MatchMaxSepDeg {
				continue
			}
			ad := orientationDiffDeg(cPA, positionAngleDeg(*tr.P1, *tr.P2))
			if ad > opt.MatchMaxAngleDiffDeg {
				continue
			}
			// rate agreement compared as path lengths over the same window
			tLen := angularSepDeg(*tr.P1, *tr.P2)
			rateScore := 0.0
			if m := math.Max(cLen, tLen); m > 0 {
				rateScore = 1 - math.Min(1, math.Abs(cLen-tLen)/m)
			}
			score := 0.4*(1-sep/opt.MatchMaxSepDeg) +
				0.3*(1-ad/opt.MatchMaxAngleDiffDeg) +
				0.3*rateScore
			cands = append(cands, cand{ci: ci, ti: ti, score: score, sep: sep, ad: ad})
		}
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].score > cands[j].score })

	usedCross := make(map[int]bool)
	usedTrail := make(map[int]bool)
	for _, cd := range cands {
		if usedCross[cd.ci] || usedTrail[cd.ti] {
			continue
		}
		usedCross[cd.ci] = true
		usedTrail[cd.ti] = true
		idx := fr.Trails[cd.ti].Index
		sc, sep, ad := cd.score, cd.sep, cd.ad
		crossings[cd.ci].MatchedTrailIndex = &idx
		crossings[cd.ci].MatchScore = &sc
		crossings[cd.ci].SepDeg = &sep
		crossings[cd.ci].AngleDiffDeg = &ad
	}
}

// elevationDeg is the satellite's elevation above the observer's horizon.
func elevationDeg(satPos vec3, obs observerSpec, jday float64) float64 {
	ll := satellite.LatLong{Latitude: obs.LatDeg * deg2rad, Longitude: obs.LonDeg * deg2rad}
	la := satellite.ECIToLookAngles(satPos, ll, obs.AltM/1000, jday)
	return la.El * rad2deg
}
