package apply

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/testgit"
)

func TestPauseStopsLaneAfterStep(t *testing.T) {
	testgit.Env(t)
	ctx := context.Background()
	cloneA, tipA := landedClone(t)
	cloneB, tipB := landedCloneAt(t, filepath.Join(t.TempDir(), "b"))
	spy := newSpy()
	cb := casebookRepo(t)
	s, job := laneJob(t, ctx,
		JobStep{Key: "branch:schuettc/hail@feat/x", Action: "branch-delete-local", Lane: LaneCasebook,
			Command: branchDeleteLocalCmd(cloneA, "feat/x", tipA), Precondition: "branch-tip-unchanged-and-landed", ExpectedTip: tipA},
		JobStep{Key: "branch:schuettc/hail@feat/x", Action: "branch-delete-local", Lane: LaneCasebook,
			Command: branchDeleteLocalCmd(cloneB, "feat/x", tipB), Precondition: "branch-tip-unchanged-and-landed", ExpectedTip: tipB},
	)
	r := Runner{Repo: cb, RunGit: spy.run, Now: func() time.Time { return time.Unix(0, 0) }}
	// Pause after the first step.
	calls := 0
	pause := func() bool { calls++; return calls > 1 }
	if err := s.RunCasebookLane(ctx, job, r, Env{RunGit: spy.run}, pause); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get(ctx, job.ID)
	if got.Steps[0].State != StepVerified {
		t.Fatalf("step0 = %q, want verified", got.Steps[0].State)
	}
	if got.Steps[1].State != StepPending {
		t.Errorf("step1 = %q, want pending (paused before it ran)", got.Steps[1].State)
	}
	if branchExists(t, cloneB, "feat/x") == false {
		t.Error("clone B branch should be untouched after pause")
	}
}

// landedCloneAt is landedClone but at a chosen directory.
func landedCloneAt(t *testing.T, dir string) (clone, tip string) {
	t.Helper()
	testgit.Git(t, filepath.Dir(dir), "init", "-q", "-b", "main", dir)
	testgit.Commit(t, dir, "README", "hi\n")
	testgit.Git(t, dir, "branch", "feat/x", "main")
	tip = testgit.Git(t, dir, "rev-parse", "refs/heads/feat/x")
	return dir, tip
}
