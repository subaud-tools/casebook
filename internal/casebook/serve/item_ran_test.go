package serve

import (
	"net/url"
	"testing"

	"github.com/subaud-tools/casebook/internal/casebook/apply"
)

// TestItemDetailNamesItsLatestJobThatRan: a cold #/run?item=<key> asks
// serve which job is the item's: the latest that ran, never a plan not yet
// approved (a higher job id) or one discarded, and the steps that ran.
func TestItemDetailNamesItsLatestJobThatRan(t *testing.T) {
	r := newRig(t)
	const k = "issue:schuettc/hail#4"
	plan := apply.Plan{Steps: []apply.Step{{Key: k, Action: "issue-close", Lane: apply.LaneCasebook, Command: "true"}}}
	ran, err := r.s.Apply.Create(ctx, plan, "mbp")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.s.Apply.Approve(ctx, ran.ID, ""); err != nil {
		t.Fatal(err)
	}
	if err := r.s.Apply.Finish(ctx, ran.ID, apply.JobFailed); err != nil {
		t.Fatal(err)
	}
	cancelled, err := r.s.Apply.Create(ctx, plan, "mbp")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.s.Apply.Cancel(ctx, cancelled.ID); err != nil {
		t.Fatal(err)
	}
	planned, err := r.s.Apply.Create(ctx, plan, "mbp")
	if err != nil {
		t.Fatal(err)
	}
	var d ItemDetailView
	if c := r.do(t, "GET", "/api/item?key="+url.QueryEscape(k), nil, &d); c != 200 {
		t.Fatalf("item: %d", c)
	}
	if d.Ran == nil || d.Ran.Job != ran.ID {
		t.Fatalf("ran %+v, want job %d (not %d planned, nor %d cancelled)", d.Ran, ran.ID, planned.ID, cancelled.ID)
	}
	if len(d.RanSteps) != 1 || d.RanSteps[0].JobID != ran.ID {
		t.Fatalf("ran steps %+v, want job %d's alone", d.RanSteps, ran.ID)
	}
}
