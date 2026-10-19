package serve

import (
	"net/http"
	"strconv"
	"testing"

	"github.com/subaud-tools/casebook/internal/casebook/item"
	"github.com/subaud-tools/casebook/internal/casebook/testgit"
)

// commits is casebook-data's commit count.
func commits(t *testing.T, r *rig) int {
	t.Helper()
	n, err := strconv.Atoi(testgit.Git(t, r.App.Repo.Dir, "rev-list", "--count", "HEAD"))
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// TestAGroupIsOneCommit (Court, 2026-10-18: 1,757 landed branches took six
// minutes, one commit each): accepting several recommendations, or deciding
// several items, writes all their decisions in one commit; each item still
// has its decision and its history names it.
func TestAGroupIsOneCommit(t *testing.T) {
	r := newRig(t)
	r.attach(t, "s1")
	keys := []string{"issue:schuettc/hail#4", "issue:schuettc/hail#5", "issue:schuettc/hail#6"}
	var res struct {
		Proposals []struct{ ID int64 } `json:"proposals"`
	}
	r.do(t, "POST", "/api/agent/propose", map[string]any{"session": "s1", "keys": keys, "disposition": "close"}, &res)
	var ids []int64
	for _, p := range res.Proposals {
		ids = append(ids, p.ID)
	}
	before := commits(t, r)
	var acc AcceptResult
	if c := r.do(t, "POST", "/api/proposals/accept", map[string]any{"ids": ids}, &acc); c != http.StatusOK || acc.Accepted != 3 {
		t.Fatalf("accept: %d %+v", c, acc)
	}
	if n := commits(t, r) - before; n != 1 {
		t.Fatalf("accepting 3 made %d commits, want 1", n)
	}
	for _, key := range keys {
		k, _ := item.ParseKey(key)
		if d, _ := r.s.App.Repo.ReadDecision(k); d == nil || d.Disposition != item.Close {
			t.Fatalf("%s: decision %+v, want close", key, d)
		}
		if log, _ := r.s.App.Repo.Log(ctx, k.File()); len(log) != 1 {
			t.Fatalf("%s: history %+v, want the one commit", key, log)
		}
	}
	if p, _ := r.s.Props.Get(ctx, ids[0]); p.State != "accepted" {
		t.Fatalf("proposal %d is %s, want accepted", ids[0], p.State)
	}

	before = commits(t, r)
	more := []string{"issue:schuettc/hail#7", "issue:schuettc/hail#8"}
	var dr DecideResult
	if c := r.do(t, "POST", "/api/decide", map[string]any{"keys": more, "disposition": "keep"}, &dr); c != http.StatusOK || dr.Decided != 2 {
		t.Fatalf("decide: %d %+v", c, dr)
	}
	if n := commits(t, r) - before; n != 1 {
		t.Fatalf("deciding 2 made %d commits, want 1", n)
	}
}
