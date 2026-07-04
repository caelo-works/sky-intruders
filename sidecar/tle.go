package main

import (
	"fmt"
	"strconv"
	"strings"
)

// TLE is one catalog record: an optional name line plus the two element lines.
type TLE struct {
	Name    string
	NoradID int
	IntlDes string // "2020-001A" form, or "" when the designator field is blank
	Line1   string
	Line2   string
}

// parseTLEs extracts every valid TLE pair from raw catalog text (CelesTrak
// 3-line format: name line, line 1, line 2). Invalid or unparsable records are
// silently skipped: the validation here is deliberately strict because the
// SGP4 library (go-satellite) calls log.Fatal on any field it cannot parse —
// a single bad record must never kill the process. This also rejects HTML
// error pages that CelesTrak occasionally serves with HTTP 200.
func parseTLEs(data []byte) []TLE {
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	var out []TLE
	name := ""
	for i := 0; i < len(lines); i++ {
		l := strings.TrimRight(lines[i], " \t\r")
		if strings.HasPrefix(l, "1 ") && i+1 < len(lines) {
			l2 := strings.TrimRight(lines[i+1], " \t\r")
			if validTLEPair(l, l2) {
				norad, _ := strconv.Atoi(strings.TrimSpace(l[2:7]))
				out = append(out, TLE{
					Name:    name,
					NoradID: norad,
					IntlDes: intlDesignator(l),
					Line1:   l,
					Line2:   l2,
				})
				name = ""
				i++ // consume line 2
				continue
			}
		}
		if t := strings.TrimSpace(l); t != "" {
			name = t
		}
	}
	return out
}

// validTLEPair checks structure and, field by field, exactly the substrings
// go-satellite's ParseTLE/TLEToSat will feed to strconv — including the same
// space-stripping quirks — so that passing records can never trigger the
// library's log.Fatal path. Alpha-5 satnums (letter-prefixed, NORAD >= 100000)
// are rejected too: the library cannot parse them.
func validTLEPair(l1, l2 string) bool {
	if len(l1) < 69 || len(l2) < 69 {
		return false
	}
	if l1[0] != '1' || l2[0] != '2' {
		return false
	}
	if strings.TrimSpace(l1[2:7]) != strings.TrimSpace(l2[2:7]) {
		return false
	}
	if !intOK(strings.TrimSpace(l1[2:7])) {
		return false
	}
	// line 1 numeric fields, replicated from go-satellite ParseTLE
	if !intOK(l1[18:20]) ||
		!floatOK(l1[20:32]) ||
		!floatOK(strings.Replace(l1[33:43], " ", "", 2)) ||
		!floatOK(strings.Replace(l1[44:45]+"."+l1[45:50]+"e"+l1[50:52], " ", "", 2)) ||
		!floatOK(strings.Replace(l1[53:54]+"."+l1[54:59]+"e"+l1[59:61], " ", "", 2)) {
		return false
	}
	// line 2 numeric fields
	if !floatOK(strings.Replace(l2[8:16], " ", "", 2)) ||
		!floatOK(strings.Replace(l2[17:25], " ", "", 2)) ||
		!floatOK("."+l2[26:33]) ||
		!floatOK(strings.Replace(l2[34:42], " ", "", 2)) ||
		!floatOK(strings.Replace(l2[43:51], " ", "", 2)) ||
		!floatOK(strings.Replace(l2[52:63], " ", "", 2)) {
		return false
	}
	return true
}

func intOK(s string) bool {
	_, err := strconv.ParseInt(s, 10, 64)
	return err == nil
}

func floatOK(s string) bool {
	_, err := strconv.ParseFloat(s, 64)
	return err == nil
}

// intlDesignator formats the COSPAR field of line 1 ("98067A  ") as
// "1998-067A". Years 57-99 are 19xx, 00-56 are 20xx (TLE convention).
func intlDesignator(l1 string) string {
	raw := l1[9:17]
	yy := strings.TrimSpace(raw[0:2])
	launch := strings.TrimSpace(raw[2:5])
	piece := strings.TrimSpace(raw[5:])
	if yy == "" || launch == "" {
		return ""
	}
	y, err := strconv.Atoi(yy)
	if err != nil {
		return ""
	}
	if y < 57 {
		y += 2000
	} else {
		y += 1900
	}
	return fmt.Sprintf("%d-%s%s", y, launch, piece)
}
