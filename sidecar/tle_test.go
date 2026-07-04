package main

import (
	"strings"
	"testing"
)

const issLine1 = "1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927"
const issLine2 = "2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537"

// Vallado SGP4 verification case (same fixture as go-satellite's own suite).
const deltaLine1 = "1 06251U 62025E   06176.82412014  .00008885  00000-0  12808-3 0  3985"
const deltaLine2 = "2 06251  58.0579  54.0425 0030035 139.1568 221.1854 15.56387291  6774"

const sampleCatalog = "ISS (ZARYA)\r\n" + issLine1 + "\r\n" + issLine2 + "\r\n" +
	"DELTA 1 DEB\n" + deltaLine1 + "\n" + deltaLine2 + "\n"

func TestParseTLEs(t *testing.T) {
	tles := parseTLEs([]byte(sampleCatalog))
	if len(tles) != 2 {
		t.Fatalf("got %d records, want 2", len(tles))
	}
	iss := tles[0]
	if iss.Name != "ISS (ZARYA)" || iss.NoradID != 25544 || iss.IntlDes != "1998-067A" {
		t.Errorf("ISS record: %+v", iss)
	}
	if iss.Line1 != issLine1 || iss.Line2 != issLine2 {
		t.Errorf("ISS lines not preserved")
	}
	delta := tles[1]
	if delta.Name != "DELTA 1 DEB" || delta.NoradID != 6251 || delta.IntlDes != "1962-025E" {
		t.Errorf("Delta record: %+v", delta)
	}
}

func TestParseTLEsRejectsGarbage(t *testing.T) {
	cases := map[string]string{
		"html":         "<html><head><title>Error</title></head><body>Rate limited</body></html>",
		"empty":        "",
		"name only":    "ISS (ZARYA)\n",
		"truncated l1": "ISS\n1 25544U 98067A\n" + issLine2 + "\n",
		"mismatched satnums": "X\n" + issLine1 + "\n" +
			"2 06251  58.0579  54.0425 0030035 139.1568 221.1854 15.56387291  6774\n",
		// Alpha-5 satnum: go-satellite would log.Fatal on it, must be skipped
		"alpha-5": "X\n" + "1 A1234U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927" +
			"\n" + "2 A1234  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537" + "\n",
		"letters in fields": "X\n" + strings.Replace(issLine1, "08264", "ABCDE", 1) + "\n" + issLine2 + "\n",
	}
	for name, data := range cases {
		if got := parseTLEs([]byte(data)); len(got) != 0 {
			t.Errorf("%s: got %d records, want 0", name, len(got))
		}
	}
}

func TestParseTLEsSkipsBadKeepsGood(t *testing.T) {
	data := "JUNK LINE\n<html>\n" + sampleCatalog + "garbage trailing line\n"
	tles := parseTLEs([]byte(data))
	if len(tles) != 2 {
		t.Fatalf("got %d records, want 2", len(tles))
	}
}
