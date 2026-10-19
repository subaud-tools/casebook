package apply

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/engine"
	"github.com/subaud-tools/casebook/internal/casebook/observe"
	"github.com/subaud-tools/casebook/internal/casebook/testgit"
)

// A branch checked out in a clone or worktree is never deleted: deleting it
// left applied-ai-research on an unborn dev (Court, 2026-10-18).
func TestCheckedOutBranchIsNeverDeleted(t *testing.T) {
	testgit.Env(t)
	ctx := context.Background()
	clone, tip := landedClone(t)
	testgit.Git(t, clone, "switch", "-q", "feat/x")
	r := Runner{Repo: casebookRepo(t), RunGit: newSpy().run, Now: func() time.Time { return time.Unix(0, 0) }}
	step := JobStep{
		Key:          "branch:schuettc/hail@feat/x",
		Action:       "branch-delete-local",
		Lane:         LaneCasebook,
		Command:      branchDeleteLocalCmd(clone, "feat/x", tip),
		Precondition: "branch-tip-unchanged-and-landed",
		ExpectedTip:  tip,
	}
	res, err := r.RunStep(ctx, step, Env{RunGit: newSpy().run})
	if err != nil {
		t.Fatal(err)
	}
	if res.State != StepSkipped || !strings.Contains(res.Detail, "checked out") {
		t.Fatalf("state = %q (%q), want skipped: checked out", res.State, res.Detail)
	}
	if !branchExists(t, clone, "feat/x") {
		t.Error("the checked-out branch was deleted")
	}
}

// A long-lived branch (dev, develop, staging, main, master or the repo's
// default) is never deleted, even when a job already holds the step: a
// dev → main release PR made dev look landed (Court, 2026-10-18).
func TestLongLivedBranchIsNeverDeleted(t *testing.T) {
	testgit.Env(t)
	ctx := context.Background()
	clone := testgit.NewRepo(t)
	testgit.Git(t, clone, "branch", "dev", "main")
	tip := testgit.Git(t, clone, "rev-parse", "refs/heads/dev")
	r := Runner{Repo: casebookRepo(t), RunGit: newSpy().run, Now: func() time.Time { return time.Unix(0, 0) }}
	step := JobStep{
		Key:          "branch:schuettc/hail@dev",
		Action:       "branch-delete-local",
		Lane:         LaneCasebook,
		Command:      branchDeleteLocalCmd(clone, "dev", tip),
		Precondition: "branch-tip-unchanged-and-landed",
		ExpectedTip:  tip,
	}
	res, err := r.RunStep(ctx, step, Env{RunGit: newSpy().run})
	if err != nil {
		t.Fatal(err)
	}
	if res.State != StepSkipped || !strings.Contains(res.Detail, "long-lived") {
		t.Fatalf("state = %q (%q), want skipped: long-lived", res.State, res.Detail)
	}
	if !branchExists(t, clone, "dev") {
		t.Error("dev was deleted")
	}
	remote := JobStep{
		Key:          "branch:schuettc/hail@dev",
		Action:       "branch-delete-remote",
		Lane:         LaneCasebook,
		Command:      branchDeleteRemoteCmd(clone, "origin", "dev", tip),
		Precondition: "remote-tip-unchanged-and-landed",
		ExpectedTip:  tip,
	}
	chk, err := Check(ctx, remote, Env{RunGit: newSpy().run})
	if err != nil {
		t.Fatal(err)
	}
	if chk.OK || chk.Done || !strings.Contains(chk.Reason, "long-lived") {
		t.Fatalf("remote check = %+v, want refused: long-lived", chk)
	}
}

// A plan never holds a delete of a long-lived branch.
func TestPlanHasNoDeleteOfALongLivedBranch(t *testing.T) {
	for _, b := range []string{"dev", "develop", "staging", "main", "master", "trunk"} {
		it := branchItem("schuettc/myrepo", b, "mbp", "/r")
		snap := snapWith("mbp", []observe.Clone{{
			Path:     "/r",
			Repo:     "schuettc/myrepo",
			Remotes:  map[string]string{"origin": "schuettc/myrepo"},
			Branches: []observe.Branch{{Name: b, Tip: "t", RemoteTip: "t", LongLived: b == "trunk"}},
		}})
		plan, err := Build([]engine.Item{it}, snap, epoch, epoch.Add(-time.Minute), 30*time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		if len(plan.Steps) != 0 {
			t.Errorf("%s: plan has %d steps, want none", b, len(plan.Steps))
		}
	}
}

// A remote delete skips the repo's pre-push hooks: they test the code being
// pushed, and a delete pushes none (a lefthook pre-push failed every delete
// in applied-ai-research, 2026-10-18).
func TestRemoteDeleteSkipsPushHooks(t *testing.T) {
	cmd := branchDeleteRemoteCmd("/r", "origin", "feat/x", "abc")
	if !strings.Contains(cmd, " --no-verify ") {
		t.Fatalf("command %q has no --no-verify", cmd)
	}
	dir, remote, branch, err := parseRemoteDelete(cmd)
	if err != nil || dir != "/r" || remote != "origin" || branch != "feat/x" {
		t.Fatalf("parse = %q %q %q %v", dir, remote, branch, err)
	}
}

// A merge names its method: gh refuses to pick one when nobody is at the
// keyboard, so four merges failed without running (2026-10-18).
func TestMergeIsASquash(t *testing.T) {
	if got := prMergeCmd(7, "o/r"); got != "gh pr merge 7 -R 'o/r' --squash" {
		t.Fatalf("got %q", got)
	}
}
