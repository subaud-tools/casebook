package serve

import (
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/apply"
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
		{ID: 33, State: apply.JobFailed, Steps: []apply.JobStep{st(33, "A", apply.StepFailed), st(33, "B", apply.StepFailed)}},
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
