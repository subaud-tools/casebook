package serve

import (
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/apply"
)

// decideTwo decides the rig's PR and issue (close), so both are to apply.
func decideTwo(t *testing.T, r *rig) {
	t.Helper()
	if c := r.do(t, "POST", "/api/decide", map[string]any{
		"keys": []string{"pr:schuettc/hail#3", "issue:schuettc/hail#4"}, "disposition": "close", "note": "stale",
	}, nil); c != http.StatusOK {
		t.Fatalf("decide: %d", c)
	}
}

// planKeys is the space-joined step keys of a plan.
func planKeys(v PlanView) string {
	var ks []string
	for _, s := range v.Job.Steps {
		ks = append(ks, s.Key)
	}
	return strings.Join(ks, " ")
}

// TestAnItemIsInAtMostOneUnfinishedJob: an item in a job that hasn't finished
// (planned, approved, running or paused) can't be planned again. Plan all
// leaves it out; naming it is refused with the job it's in. A job that
// finished, failed or was cancelled releases its items.
func TestAnItemIsInAtMostOneUnfinishedJob(t *testing.T) {
	r := newRig(t)
	decideTwo(t, r)
	r.attach(t, "s1")

	var first PlanView
	if c := r.do(t, "POST", "/api/apply/plan", map[string]any{"keys": []string{"pr:schuettc/hail#3"}}, &first); c != http.StatusOK {
		t.Fatalf("plan the PR: %d", c)
	}
	// Approved through the store, so no lane moves it on: the test walks it
	// through approved, running and paused itself.
	if _, err := r.s.Apply.Approve(ctx, first.Job.ID, "s1"); err != nil {
		t.Fatalf("approve: %v", err)
	}

	for _, st := range []apply.JobState{apply.JobApproved, apply.JobRunning, apply.JobPaused} {
		if st != apply.JobApproved {
			if err := r.s.Apply.SetJobState(ctx, first.Job.ID, st); err != nil {
				t.Fatalf("set %s: %v", st, err)
			}
		}
		// Plan all leaves the PR out.
		var all PlanView
		if c := r.do(t, "POST", "/api/apply/plan", map[string]any{"all": true}, &all); c != http.StatusOK {
			t.Fatalf("%s: plan all: %d", st, c)
		}
		if got := planKeys(all); got != "issue:schuettc/hail#4" {
			t.Fatalf("%s: plan all = %q, want only the issue (the PR is in job %d)", st, got, first.Job.ID)
		}
		if c := r.do(t, "POST", "/api/apply/cancel", map[string]any{"plan_id": all.Job.ID}, nil); c != http.StatusOK {
			t.Fatalf("discard: %d", c)
		}
		// Naming it is refused, and the refusal names the job.
		var out map[string]any
		if c := r.do(t, "POST", "/api/apply/plan", map[string]any{"keys": []string{"pr:schuettc/hail#3", "issue:schuettc/hail#4"}}, &out); c != http.StatusConflict {
			t.Fatalf("%s: plan the PR again: %d %v, want 409", st, c, out)
		}
		msg, _ := out["error"].(string)
		want := "pr:schuettc/hail#3 is already in job #" + strconv.FormatInt(first.Job.ID, 10)
		if !strings.Contains(msg, want) {
			t.Fatalf("%s: refusal %q doesn't say %q", st, msg, want)
		}
	}

	// A plan for the issue alone (named plans reuse or replace each other:
	// TestPlanForAGroupReusesOrReplacesItsPlan).
	var issuePlan PlanView
	if c := r.do(t, "POST", "/api/apply/plan", map[string]any{"keys": []string{"issue:schuettc/hail#4"}}, &issuePlan); c != http.StatusOK {
		t.Fatalf("plan the issue: %d", c)
	}

	// Failed releases (the PR's job), cancelled releases (the issue's plan).
	if err := r.s.Apply.Finish(ctx, first.Job.ID, apply.JobFailed); err != nil {
		t.Fatal(err)
	}
	if c := r.do(t, "POST", "/api/apply/cancel", map[string]any{"plan_id": issuePlan.Job.ID}, nil); c != http.StatusOK {
		t.Fatalf("discard: %d", c)
	}
	var again PlanView
	if c := r.do(t, "POST", "/api/apply/plan", map[string]any{"keys": []string{"pr:schuettc/hail#3", "issue:schuettc/hail#4"}}, &again); c != http.StatusOK {
		t.Fatalf("plan after failed and cancelled: %d", c)
	}
	// Done releases.
	if err := r.s.Apply.Cancel(ctx, again.Job.ID); err != nil {
		t.Fatal(err)
	}
	done, err := r.s.Apply.Create(ctx, apply.Plan{Steps: []apply.Step{{Key: "pr:schuettc/hail#3", Action: "pr-close", Lane: apply.LaneAgent}}}, "mbp")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.s.Apply.Approve(ctx, done.ID, "s1"); err != nil {
		t.Fatal(err)
	}
	if err := r.s.Apply.SetJobState(ctx, done.ID, apply.JobRunning); err != nil {
		t.Fatal(err)
	}
	if err := r.s.Apply.Finish(ctx, done.ID, apply.JobDone); err != nil {
		t.Fatal(err)
	}
	var afterDone PlanView
	if c := r.do(t, "POST", "/api/apply/plan", map[string]any{"all": true}, &afterDone); c != http.StatusOK {
		t.Fatalf("plan all after done: %d", c)
	}
	if got := planKeys(afterDone); !strings.Contains(got, "pr:schuettc/hail#3") {
		t.Fatalf("plan all after the PR's job is done = %q, want the PR", got)
	}
}

// unfinishedHolding is the unfinished jobs with a step on key.
func unfinishedHolding(t *testing.T, r *rig, key string) []apply.Job {
	t.Helper()
	jobs, err := r.s.Apply.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var out []apply.Job
	for _, j := range jobs {
		switch j.State {
		case apply.JobPlanned, apply.JobApproved, apply.JobRunning, apply.JobPaused:
		default:
			continue
		}
		for _, st := range j.Steps {
			if st.Key == key {
				out = append(out, j)
				break
			}
		}
	}
	return out
}

// TestPlanForAGroupReusesOrReplacesItsPlan: opening a group in review plans
// exactly its keys. A plan not yet approved with the same keys is reused (no
// new job); one that holds any of the keys otherwise is cancelled and a fresh
// plan built, so an item is still in one unfinished job. An approved job
// still holds its items (TestAnItemIsInAtMostOneUnfinishedJob).
func TestPlanForAGroupReusesOrReplacesItsPlan(t *testing.T) {
	r := newRig(t)
	decideTwo(t, r)
	pr, issue := "pr:schuettc/hail#3", "issue:schuettc/hail#4"

	var first PlanView
	if c := r.do(t, "POST", "/api/apply/plan", map[string]any{"keys": []string{pr}}, &first); c != http.StatusOK {
		t.Fatalf("plan the PR: %d", c)
	}
	before, _ := r.s.Apply.List(ctx)
	var again PlanView
	if c := r.do(t, "POST", "/api/apply/plan", map[string]any{"keys": []string{pr}}, &again); c != http.StatusOK {
		t.Fatalf("plan the PR again: %d, want 200 (reused)", c)
	}
	if again.Job.ID != first.Job.ID || again.Job.State != apply.JobPlanned {
		t.Fatalf("plan again = job %d (%s), want plan #%d reused", again.Job.ID, again.Job.State, first.Job.ID)
	}
	if len(again.Groups) == 0 || len(again.Plan.Steps) == 0 {
		t.Fatalf("a reused plan came back without its steps: %+v", again)
	}
	if jobs, _ := r.s.Apply.List(ctx); len(jobs) != len(before) {
		t.Fatalf("reusing made a job: %d jobs, want %d", len(jobs), len(before))
	}

	// Different keys: the plan holding the PR is cancelled, a fresh one built.
	var both PlanView
	if c := r.do(t, "POST", "/api/apply/plan", map[string]any{"keys": []string{pr, issue}}, &both); c != http.StatusOK {
		t.Fatalf("plan the PR and issue: %d, want 200 (replaced)", c)
	}
	if both.Job.ID == first.Job.ID {
		t.Fatalf("plan for other keys reused plan #%d", first.Job.ID)
	}
	if got := planKeys(both); !strings.Contains(got, pr) || !strings.Contains(got, issue) {
		t.Fatalf("fresh plan keys = %q, want the PR and the issue", got)
	}
	if j, _ := r.s.Apply.Get(ctx, first.Job.ID); j.State != apply.JobCancelled {
		t.Fatalf("replaced plan #%d is %s, want cancelled", first.Job.ID, j.State)
	}
	for _, k := range []string{pr, issue} {
		if h := unfinishedHolding(t, r, k); len(h) != 1 || h[0].ID != both.Job.ID {
			t.Fatalf("%s is in %d unfinished jobs, want only #%d", k, len(h), both.Job.ID)
		}
	}
}

// TestApproveRefusesAPlanWhoseItemsAreInAnotherJob: two plans can overlap
// before either is approved (built before serve kept items to one job, or
// straight through the store). Approving the first holds its items; the
// second is refused with a message naming the first and stays a plan.
func TestApproveRefusesAPlanWhoseItemsAreInAnotherJob(t *testing.T) {
	r := newRig(t)
	r.attach(t, "s1")
	a, err := r.s.Apply.Create(ctx, agentTestPlan(), "mbp")
	if err != nil {
		t.Fatal(err)
	}
	b, err := r.s.Apply.Create(ctx, agentTestPlan(), "mbp")
	if err != nil {
		t.Fatal(err)
	}
	if c := r.do(t, "POST", "/api/apply/approve", map[string]any{"plan_id": a.ID, "session": "s1"}, nil); c != http.StatusOK {
		t.Fatalf("approve the first: %d", c)
	}
	var out map[string]any
	if c := r.do(t, "POST", "/api/apply/approve", map[string]any{"plan_id": b.ID, "session": "s1"}, &out); c != http.StatusConflict {
		t.Fatalf("approve the overlapping second: %d %v, want 409", c, out)
	}
	msg, _ := out["error"].(string)
	if !strings.Contains(msg, "pr:schuettc/hail#3 is already in job #"+strconv.FormatInt(a.ID, 10)) {
		t.Fatalf("refusal %q doesn't name job %d", msg, a.ID)
	}
	j, _ := r.s.Apply.Get(ctx, b.ID)
	if j.State != apply.JobPlanned {
		t.Fatalf("refused plan is %s, want planned", j.State)
	}
	if cards, _ := r.s.Apply.NeedsYouFor(ctx, b.ID); len(cards) != 0 {
		t.Fatalf("a refused approve opened cards: %+v", cards)
	}
	// Once the first has finished, the second approves.
	if err := r.s.Apply.Finish(ctx, a.ID, apply.JobFailed); err != nil {
		t.Fatal(err)
	}
	if c := r.do(t, "POST", "/api/apply/approve", map[string]any{"plan_id": b.ID, "session": "s1"}, nil); c != http.StatusOK {
		t.Fatalf("approve after the first failed: %d", c)
	}
}

// TestConcurrentPlansAndApprovesKeepAnItemInOneJob: the overlap check and the
// create (or approve) are one step, so concurrent requests can't both pass.
// A test hook holds each request between its check and its write, which
// makes the race certain without the lock.
func TestConcurrentPlansAndApprovesKeepAnItemInOneJob(t *testing.T) {
	r := newRig(t)
	decideTwo(t, r)
	r.attach(t, "s1")
	r.s.afterOverlapCheck = func() { time.Sleep(30 * time.Millisecond) }

	const n = 6
	codes := make([]int, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i] = r.do(t, "POST", "/api/apply/plan", map[string]any{"keys": []string{"pr:schuettc/hail#3"}}, nil)
		}()
	}
	wg.Wait()
	for _, c := range codes {
		if c != http.StatusOK {
			t.Fatalf("concurrent plan answered %d (codes %v): each reuses the one plan", c, codes)
		}
	}
	if n := len(unfinishedHolding(t, r, "pr:schuettc/hail#3")); n != 1 {
		t.Fatalf("%d unfinished jobs hold the PR after concurrent plans, want 1", n)
	}
	ok := 0

	// Two overlapping plans (through the store), approved at once: one wins.
	jobs, _ := r.s.Apply.List(ctx)
	for _, j := range jobs {
		_ = r.s.Apply.Cancel(ctx, j.ID)
	}
	var ids []int64
	for range n {
		j, err := r.s.Apply.Create(ctx, agentTestPlan(), "mbp")
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, j.ID)
	}
	for i, id := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i] = r.do(t, "POST", "/api/apply/approve", map[string]any{"plan_id": id, "session": "s1"}, nil)
		}()
	}
	wg.Wait()
	ok = 0
	for _, c := range codes {
		if c == http.StatusOK {
			ok++
		} else if c != http.StatusConflict {
			t.Fatalf("concurrent approve answered %d", c)
		}
	}
	if ok != 1 {
		t.Fatalf("%d overlapping plans were approved at once (codes %v), want 1", ok, codes)
	}
}

// TestPreviewMakesNoPlan (Court, 2026-10-17: two tabs reviewing one group
// cancelled each other's plans): preview builds the plan to show and stores
// nothing: no job is made and no plan holding the keys is cancelled.
func TestPreviewMakesNoPlan(t *testing.T) {
	r := newRig(t)
	decideTwo(t, r)
	pr := "pr:schuettc/hail#3"
	var saved PlanView
	if c := r.do(t, "POST", "/api/apply/plan", map[string]any{"keys": []string{pr}}, &saved); c != http.StatusOK {
		t.Fatalf("plan: %d", c)
	}
	before, _ := r.s.Apply.List(ctx)
	var v PlanView
	if c := r.do(t, "POST", "/api/apply/plan", map[string]any{"keys": []string{pr, "issue:schuettc/hail#4"}, "preview": true}, &v); c != http.StatusOK {
		t.Fatalf("preview: %d", c)
	}
	if v.Job.ID != 0 || v.Job.State != apply.JobPlanned || len(v.Job.Steps) == 0 || len(v.Groups) == 0 {
		t.Fatalf("preview = job %d (%s) with %d steps, want an unsaved plan with steps", v.Job.ID, v.Job.State, len(v.Job.Steps))
	}
	if after, _ := r.s.Apply.List(ctx); len(after) != len(before) {
		t.Fatalf("preview made a job: %d jobs, want %d", len(after), len(before))
	}
	if j, _ := r.s.Apply.Get(ctx, saved.Job.ID); j.State != apply.JobPlanned {
		t.Fatalf("preview cancelled plan #%d (%s)", saved.Job.ID, j.State)
	}
}

// TestAVerifiedItemLeavesReview (Court, 2026-10-17: nine repos deleted and
// still listed in review): an item whose step casebook verified since the
// last sync leaves review and its count at once; the next sync, which sees
// it gone, takes over. An item whose step failed stays.
func TestAVerifiedItemLeavesReview(t *testing.T) {
	r := newRig(t)
	decideTwo(t, r)
	pr, issue := "pr:schuettc/hail#3", "issue:schuettc/hail#4"
	var v PlanView
	if c := r.do(t, "POST", "/api/apply/plan", map[string]any{"keys": []string{pr, issue}}, &v); c != http.StatusOK {
		t.Fatalf("plan: %d", c)
	}
	for _, st := range v.Job.Steps {
		for _, s := range []apply.StepState{apply.StepRunning, apply.StepReported} {
			if err := r.s.Apply.SetStepState(ctx, st.ID, s, ""); err != nil {
				t.Fatal(err)
			}
		}
		end := apply.StepVerified
		if st.Key == issue {
			end = apply.StepFailed
		}
		if err := r.s.Apply.SetStepState(ctx, st.ID, end, ""); err != nil {
			t.Fatal(err)
		}
	}
	var l ItemsView
	if c := r.do(t, "GET", "/api/items?view=to-apply&limit=200", nil, &l); c != http.StatusOK {
		t.Fatalf("items %d", c)
	}
	if got := ids(l.Items); len(got) != 1 || got[0] != issue || l.Total != 1 {
		t.Fatalf("review lists %v (total %d), want only the failed %s", got, l.Total, issue)
	}
	if n := r.summary(t).Counts["to-apply"]; n != 1 {
		t.Fatalf("review count %d, want 1", n)
	}
}
