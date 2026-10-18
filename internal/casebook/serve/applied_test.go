package serve

import (
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/apply"
)

// TestDoneUntilObserved (Court, 2026-10-17): an item casebook verified done
// stays out of review until GitHub has been read for its owner after it;
// the index's build time doesn't count (a restart rebuilds from the cache).
func TestDoneUntilObserved(t *testing.T) {
	t0 := time.Date(2026, 10, 17, 23, 29, 40, 0, time.UTC)
	at := func(d time.Duration) apply.Verified { return apply.Verified{First: t0.Add(d), Last: t0.Add(d)} }
	verified := map[string]apply.Verified{
		"repo:schuettc/a":     at(2 * time.Minute), // after schuettc was read
		"repo:other/b":        at(2 * time.Minute), // other was read since
		"branch:schuettc/c@x": at(-time.Hour),      // before the read: it shows the truth
		"pr:Schuettc/d#4":     at(time.Minute),     // owner in any case
		"repo:unknown/e":      at(time.Minute),     // owner never read: the build time
		// Decided again after its step verified: it waits to run again.
		"repo:schuettc/f": at(2 * time.Minute),
	}
	decided := func(key string) time.Time {
		if key == "repo:schuettc/f" {
			return t0.Add(3 * time.Minute)
		}
		return t0.Add(-2 * time.Hour)
	}
	read := map[string]time.Time{"schuettc": t0, "other": t0.Add(5 * time.Minute)}
	built := t0.Add(10 * time.Minute)
	got := doneUntilObserved(verified, func(owner string) (time.Time, bool) {
		at, ok := read[owner]
		return at, ok
	}, decided, built)
	want := map[string]bool{"repo:schuettc/a": true, "pr:Schuettc/d#4": true}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for k := range want {
		if !got[k] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

// TestDoneSaysHow (Court, 2026-10-18: "we can't claim something in browser
// if it's not real"): a done item says whether casebook did it (which job,
// verified when) or found it already so, with nothing run.
func TestDoneSaysHow(t *testing.T) {
	at := time.Date(2026, 10, 18, 4, 31, 48, 0, time.UTC)
	loc := time.FixedZone("CDT", -5*3600)
	if got, want := doneHow("done", 20, at, loc), "by job #20, verified Oct 17 23:31"; got != want {
		t.Errorf("by casebook: %q, want %q", got, want)
	}
	if got, want := doneHow("done", 0, time.Time{}, loc), "found so, nothing ran"; got != want {
		t.Errorf("found so: %q, want %q", got, want)
	}
	if got := doneHow("to-apply", 0, time.Time{}, loc); got != "" {
		t.Errorf("not done: %q, want empty", got)
	}
}
