package app

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/subaud-tools/casebook/internal/casebook/engine"
	"github.com/subaud-tools/casebook/internal/casebook/item"
	"github.com/subaud-tools/casebook/internal/casebook/observe"
)

// The tracked PR waits on a PR casebook doesn't track.
const (
	waiter = "pr:schuettc/hail#3"
	named  = "pr:schuettc/hail#999"
)

// lookupGh is fakeGh with the single-PR reads answered by lookup, which gets
// the PR number and returns its data (raw JSON) or, for an error, GitHub's
// status text ("HTTP 404", "HTTP 403"). whole, when set, answers every
// single-PR read instead (a transient failure).
type lookupGh struct {
	fakeGh
	lookup func(n int) (data, errText string)
	whole  func() ([]byte, error)
}

func (f *lookupGh) Gh(c context.Context, args ...string) ([]byte, error) {
	p, _ := restCall(args)
	num, ok := strings.CutPrefix(p, "repos/schuettc/hail/pulls/")
	if !ok {
		return f.fakeGh.Gh(c, args...)
	}
	if f.whole != nil {
		return f.whole()
	}
	n, _ := strconv.Atoi(num)
	d, et := f.lookup(n)
	if et != "" {
		return nil, &observe.GhError{Code: 1, Stderr: "gh: no (" + et + ")"}
	}
	return []byte(d), nil
}

// openPR answers every lookup with an open PR.
func openPR(int) (string, string) {
	return `{"state":"open","updated_at":"2026-09-01T00:00:00Z"}`, ""
}

// waitOnNamed decides the waiter Not now until named merges.
func waitOnNamed(t *testing.T, r *rig) {
	t.Helper()
	if _, _, err := r.app.Decide(ctx, waiter, "wait", DecideOptions{Until: "merged(" + named + ")"}); err != nil {
		t.Fatal(err)
	}
}

func syncThenFind(t *testing.T, r *rig, gh *lookupGh) engine.Item {
	t.Helper()
	r.app.Gh = gh
	if _, err := r.app.Sync(ctx, SyncOptions{}); err != nil {
		t.Fatal(err)
	}
	return find(t, r)
}

func find(t *testing.T, r *rig) engine.Item {
	t.Helper()
	res, _, err := r.app.Build(ctx)
	if err != nil {
		t.Fatal(err)
	}
	it, ok := res.Find(waiter)
	if !ok {
		t.Fatalf("%s not built", waiter)
	}
	return it
}

// TestUntilKeyNotFoundReturnsToAttention: a sync GitHub answers "not found"
// for the condition's key brings the item back as due, with the reason.
func TestUntilKeyNotFoundReturnsToAttention(t *testing.T) {
	r := newRig(t)
	waitOnNamed(t, r)
	it := syncThenFind(t, r, &lookupGh{lookup: func(n int) (string, string) {
		if n == 999 {
			return "", "HTTP 404"
		}
		return openPR(n)
	}})
	if it.Status != item.StatusDue {
		t.Fatalf("status %s, want due", it.Status)
	}
	if want := "its condition names " + named + ", which GitHub can't find"; it.DueReason != want {
		t.Fatalf("reason %q, want %q", it.DueReason, want)
	}
}

// TestUntilKeyNotLookedUpYetStaysWaiting: before any sync has looked the key
// up, the item waits as before.
func TestUntilKeyNotLookedUpYetStaysWaiting(t *testing.T) {
	r := newRig(t)
	waitOnNamed(t, r)
	if it := find(t, r); it.Status != item.StatusWaiting || it.DueReason != "" {
		t.Fatalf("status %s reason %q, want waiting and none", it.Status, it.DueReason)
	}
}

// TestUntilKeyTransientFailureStaysWaiting: a failure that isn't a definite
// not-found (the network, a rate limit, a 5xx, another error) isn't one.
func TestUntilKeyTransientFailureStaysWaiting(t *testing.T) {
	for name, gh := range map[string]*lookupGh{
		"502":        {whole: func() ([]byte, error) { return nil, &observe.GhError{Code: 1, Stderr: "gh: HTTP 502: Bad Gateway"} }},
		"offline":    {whole: func() ([]byte, error) { return nil, &observe.GhError{Code: 1, Stderr: "gh: dial tcp: no such host"} }},
		"rate limit": {whole: func() ([]byte, error) { return nil, &observe.GhError{Code: 1, Stderr: "gh: API rate limit exceeded"} }},
		"other error": {lookup: func(n int) (string, string) {
			if n == 999 {
				return "", "HTTP 403"
			}
			return openPR(n)
		}},
	} {
		t.Run(name, func(t *testing.T) {
			r := newRig(t)
			waitOnNamed(t, r)
			if it := syncThenFind(t, r, gh); it.Status != item.StatusWaiting || it.DueReason != "" {
				t.Fatalf("status %s reason %q, want waiting and none", it.Status, it.DueReason)
			}
		})
	}
}

// TestUntilKeyFoundBehavesAsBefore: a key GitHub finds is read as before:
// open waits, merged is met (due, saying its condition was met, not that
// GitHub can't find it).
func TestUntilKeyFoundBehavesAsBefore(t *testing.T) {
	r := newRig(t)
	waitOnNamed(t, r)
	if it := syncThenFind(t, r, &lookupGh{lookup: openPR}); it.Status != item.StatusWaiting || it.DueReason != "" {
		t.Fatalf("open: status %s reason %q, want waiting", it.Status, it.DueReason)
	}
	it := syncThenFind(t, r, &lookupGh{lookup: func(n int) (string, string) {
		if n == 999 {
			return `{"state":"closed","merged_at":"2026-09-20T00:00:00Z","updated_at":"2026-09-20T00:00:00Z"}`, ""
		}
		return openPR(n)
	}})
	if it.Status != item.StatusDue || it.DueReason != "its condition was met" {
		t.Fatalf("merged: status %s reason %q, want due: its condition was met", it.Status, it.DueReason)
	}
}
