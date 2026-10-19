package serve

import (
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/apply"
	"github.com/subaud-tools/casebook/internal/casebook/item"
)

func TestRunMarksGroupsEachItemByItsLatestJob(t *testing.T) {
	st := func(job int64, key, state string) apply.JobStep {
		return apply.JobStep{JobID: job, Key: key, State: state}
	}
	undone := st(30, "D", apply.StepVerified)
	undone.UndoneAt = time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	jobs := []apply.Job{
		{ID: 28, State: apply.JobDone, Steps: []apply.JobStep{st(28, "A", apply.StepVerified)}},
		{ID: 30, State: apply.JobDone, Steps: []apply.JobStep{undone}},
		{ID: 33, State: apply.JobPaused, Steps: []apply.JobStep{st(33, "A", apply.StepFailed), st(33, "B", apply.StepFailed)}},
		{ID: 35, State: apply.JobRunning, Steps: []apply.JobStep{st(35, "C", apply.StepPending)}},
		{ID: 36, State: apply.JobPlanned, Steps: []apply.JobStep{st(36, "E", apply.StepPending)}},
	}
	m := runMarks(jobs)
	if a := m["A"]; a.Job != 33 || a.Group != RunNeedsYou || len(a.Steps) != 1 || a.Steps[0].State != apply.StepFailed {
		t.Errorf("A: %+v", a)
	}
	if m["B"].Group != RunNeedsYou {
		t.Errorf("B: %+v", m["B"])
	}
	if m["C"].Group != RunRunning {
		t.Errorf("C: %+v", m["C"])
	}
	if m["D"].Group != RunUndone {
		t.Errorf("D: %+v", m["D"])
	}
	if _, ok := m["E"]; ok {
		t.Errorf("E is on a planned job only: %+v", m["E"])
	}
}

// TestRunMarksAFailedStepInAFinishedJobNotNeedsYou: needs you holds only
// steps that need Court in a job still open (approved, running, paused). A
// step that failed in a job that has finished needs nothing.
func TestRunMarksAFailedStepInAFinishedJobNotNeedsYou(t *testing.T) {
	st := func(job int64, key, state string) apply.JobStep {
		return apply.JobStep{JobID: job, Key: key, State: state}
	}
	m := runMarks([]apply.Job{
		{ID: 2, State: apply.JobFailed, Steps: []apply.JobStep{st(2, "A", apply.StepFailed)}},
		{ID: 3, State: apply.JobDone, Steps: []apply.JobStep{st(3, "B", apply.StepFailed)}},
		{ID: 4, State: apply.JobPaused, Steps: []apply.JobStep{st(4, "C", apply.StepFailed)}},
	})
	if g := m["A"].Group; g == RunNeedsYou {
		t.Errorf("A failed in finished job 2: %s, want not needs you", g)
	}
	if g := m["B"].Group; g == RunNeedsYou {
		t.Errorf("B failed in done job 3: %s, want not needs you", g)
	}
	if g := m["C"].Group; g != RunNeedsYou {
		t.Errorf("C failed in paused job 4: %s, want needs you", g)
	}
	if !m["A"].Finished || m["C"].Finished {
		t.Errorf("finished: A %v, C %v", m["A"].Finished, m["C"].Finished)
	}
}

// TestRunMarksADoneItemDoneDespiteAnOldFailedStep: an item that is done
// (merged by hand after its job's merge failed) is in done, whatever its
// old steps say; one that is to apply again, its job finished, isn't in run
// at all: it waits in review.
func TestRunMarksADoneItemDoneDespiteAnOldFailedStep(t *testing.T) {
	failed := RunMark{Job: 2, Group: RunNeedsYou, Steps: []apply.JobStep{{JobID: 2, Key: "A", State: apply.StepFailed}}}
	if g, in := runGroupFor(failed, item.StatusDone, false); !in || g != RunDone {
		t.Errorf("done item with a failed step: %s (in run %v), want done", g, in)
	}
	finished := RunMark{Job: 2, Group: RunDone, Finished: true, Steps: failed.Steps}
	if _, in := runGroupFor(finished, item.StatusToApply, true); in {
		t.Errorf("an item to apply again, its job finished, is in run; want it waiting in review")
	}
	if g, in := runGroupFor(failed, item.StatusToApply, true); !in || g != RunNeedsYou {
		t.Errorf("an item in an open job: %s (in run %v), want needs you", g, in)
	}
}
