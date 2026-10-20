package serve

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/apply"
)

// TestApproveRefusesAPlanWhoseKeysDiffer: the page sends the keys it shows
// ticked with its approval; serve refuses to approve a stored plan whose
// items are not exactly those (an item unticked a moment before the click
// is never run). The plan stays planned. The same keys, in any order,
// approve.
func TestApproveRefusesAPlanWhoseKeysDiffer(t *testing.T) {
	r := newRig(t)
	local := apply.Plan{BuiltAt: time.Now(), Head: "h", Steps: []apply.Step{
		{
			Key: "branch:schuettc/hail@feat/a", Action: "branch-delete-local", Lane: apply.LaneCasebook,
			Command:     "git -C '/nowhere' update-ref -d 'refs/heads/feat/a' " + strings.Repeat("a", 40),
			ExpectedTip: strings.Repeat("a", 40), Precondition: "branch-tip-unchanged-and-landed",
		},
		{
			Key: "branch:schuettc/hail@feat/b", Action: "branch-delete-local", Lane: apply.LaneCasebook,
			Command:     "git -C '/nowhere' update-ref -d 'refs/heads/feat/b' " + strings.Repeat("b", 40),
			ExpectedTip: strings.Repeat("b", 40), Precondition: "branch-tip-unchanged-and-landed",
		},
	}}
	job, err := r.s.Apply.Create(ctx, local, "mbp")
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if c := r.do(t, "POST", "/api/apply/approve", map[string]any{
		"plan_id": job.ID, "keys": []string{"branch:schuettc/hail@feat/a"},
	}, &out); c != http.StatusConflict {
		t.Fatalf("approve with one key of two: %d %v, want 409", c, out)
	}
	if j, _ := r.s.Apply.Get(ctx, job.ID); j.State != apply.JobPlanned {
		t.Fatalf("after the refusal the job is %s, want planned", j.State)
	}
	if c := r.do(t, "POST", "/api/apply/approve", map[string]any{
		"plan_id": job.ID, "keys": []string{"branch:schuettc/hail@feat/b", "branch:schuettc/hail@feat/a"},
	}, nil); c != http.StatusOK {
		t.Fatalf("approve with the plan's keys: %d, want 200", c)
	}
}
