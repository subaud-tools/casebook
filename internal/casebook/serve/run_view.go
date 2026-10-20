package serve

import (
	"slices"

	"github.com/subaud-tools/casebook/internal/casebook/apply"
	"github.com/subaud-tools/casebook/internal/casebook/item"
)

// ViewRun is run's list: every item a job ran on (planned and cancelled
// jobs aside), grouped by what happened to it in its latest job.
const ViewRun = "run"

// Run's groups, in the order run lists them.
const (
	RunNeedsYou = "needs-you"
	RunRunning  = "running"
	RunDone     = "done"
	RunUndone   = "undone"
)

var runGroups = []struct{ id, label string }{
	{RunNeedsYou, "needs you"},
	{RunRunning, "running"},
	{RunDone, "done"},
	{RunUndone, "undone"},
}

// RunMark is what ran on an item: its latest job that ran, that job's
// steps on it in position order, and the run group it puts the item in.
// Finished: that job has finished (done or failed): nothing in it waits.
type RunMark struct {
	Job      int64           `json:"job"`
	Group    string          `json:"group"`
	Finished bool            `json:"finished,omitempty"`
	Steps    []apply.JobStep `json:"steps"`
}

// runMarks is each key's mark from jobs: the highest job id holding a step
// for it, planned and cancelled jobs skipped.
func runMarks(jobs []apply.Job) map[string]RunMark {
	out := map[string]RunMark{}
	for _, j := range jobs {
		if j.State == apply.JobPlanned || j.State == apply.JobCancelled {
			continue
		}
		mine := map[string][]apply.JobStep{}
		var order []string
		for _, st := range j.Steps {
			if mine[st.Key] == nil {
				order = append(order, st.Key)
			}
			mine[st.Key] = append(mine[st.Key], st)
		}
		for _, k := range order {
			if m, ok := out[k]; ok && m.Job > j.ID {
				continue
			}
			out[k] = RunMark{Job: j.ID, Group: runGroup(j, mine[k]), Finished: !jobOpen(j), Steps: mine[k]}
		}
	}
	return out
}

// jobOpen: j is approved, running or paused, still going.
func jobOpen(j apply.Job) bool {
	return j.State == apply.JobApproved || j.State == apply.JobRunning || j.State == apply.JobPaused
}

// runGroup is the group a job's steps on one item put it in, the first
// that fits: needs you (a step that needs Court, in a job still open),
// running, undone, done. A step that failed in a job that has finished
// needs nothing: the item is back where its decision puts it.
func runGroup(j apply.Job, steps []apply.JobStep) string {
	has := func(states ...string) bool {
		return slices.ContainsFunc(steps, func(st apply.JobStep) bool { return slices.Contains(states, st.State) })
	}
	switch {
	case jobOpen(j) && has(apply.StepFailed, apply.StepNeedsYou, apply.StepPaused):
		return RunNeedsYou
	case jobOpen(j) && has(apply.StepPending, apply.StepRunning, apply.StepReported):
		return RunRunning
	case slices.ContainsFunc(steps, func(st apply.JobStep) bool { return !st.UndoneAt.IsZero() }):
		return RunUndone
	}
	return RunDone
}

// runGroupFor is the group run lists an item in, given its mark, its
// status and whether it is to apply again (in review's to-apply): a done
// item is done, whatever its old steps say; one to apply again whose job
// has finished isn't in run at all (in is false): it waits in review.
func runGroupFor(m RunMark, status item.Status, toApply bool) (group string, in bool) {
	if status == item.StatusDone {
		return RunDone, true
	}
	// To apply again with nothing verified (it failed or was skipped): it
	// waits in review. Something verified (or undone) on it, its other half
	// waiting, is still listed (Court, 2026-10-20).
	if m.Finished && toApply && !slices.ContainsFunc(m.Steps, func(st apply.JobStep) bool { return st.State == apply.StepVerified }) {
		return "", false
	}
	return m.Group, true
}

// runGroupOf is m's group as the list shows it.
func runGroupOf(m RunMark) GroupView {
	for _, g := range runGroups {
		if g.id == m.Group {
			return GroupView{ID: g.id, Label: g.label}
		}
	}
	return GroupView{ID: m.Group, Label: m.Group}
}

// runOrder is a run group's place in the list.
func runOrder(id string) int {
	return slices.IndexFunc(runGroups, func(g struct{ id, label string }) bool { return g.id == id })
}
