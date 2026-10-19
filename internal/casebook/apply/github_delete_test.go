package apply

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/observe"
)

const (
	zeros  = "0000000000000000000000000000000000000000"
	tipOne = "1111111111111111111111111111111111111111"
	tipTwo = "2222222222222222222222222222222222222222"
)

// ghReply is one scripted gh answer.
type ghReply struct {
	out string
	err error
}

// ghScript answers gh by its joined args; anything unscripted fails the test.
type ghScript struct {
	t     *testing.T
	reply map[string]ghReply
	calls []string
}

func (g *ghScript) Gh(_ context.Context, args ...string) ([]byte, error) {
	j := strings.Join(args, " ")
	g.calls = append(g.calls, j)
	r, ok := g.reply[j]
	if !ok {
		g.t.Errorf("unscripted gh %s", j)
		return nil, &observe.GhError{Code: 1, Stderr: "unscripted"}
	}
	return []byte(r.out), r.err
}

func (g *ghScript) sent(sub string) bool {
	for _, c := range g.calls {
		if strings.Contains(c, sub) {
			return true
		}
	}
	return false
}

func err404() error { return &observe.GhError{Code: 1, Stderr: "gh: Not Found (HTTP 404)"} }

// ghDeleteArgs is the updateRefs delete as gh receives it.
func ghDeleteArgs(repoID, branch, tip string) string {
	return "api graphql -f query=" + updateRefsMutation + " -f r=" + repoID + " -f n=refs/heads/" + branch + " -f b=" + tip + " -f a=" + zeros
}

// landedScript answers every read of a branch feat/x at tip on o/r, landed
// in main, with no open PR, and the delete itself.
func landedScript(t *testing.T, tip string) *ghScript {
	return &ghScript{t: t, reply: map[string]ghReply{
		"api repos/o/r --jq " + repoJq:                                     {out: "main\n"},
		"api repos/o/r/git/ref/heads/feat/x --jq .object.sha":              {out: tip + "\n"},
		"api repos/o/r/compare/main..." + tip + " --jq .status":            {out: "behind\n"},
		"api repos/o/r/pulls?state=open&head=o:feat%2Fx --jq [.[].number]": {out: "[]\n"},
		ghDeleteArgs("R_1", "feat/x", tip):                                 {out: `{"data":{"updateRefs":{"clientMutationId":null}}}`},
	}}
}

func ghStep(branch, tip string) JobStep {
	return JobStep{
		Key:          "branch:o/r@" + branch,
		Action:       "branch-delete-remote",
		Lane:         LaneCasebook,
		Command:      branchDeleteGitHubCmd("R_1", branch, tip),
		Precondition: PreconditionGitHubTip,
		ExpectedTip:  tip,
	}
}

func ghRunner(t *testing.T, gh observe.Runner) Runner {
	return Runner{Repo: casebookRepo(t), Gh: gh, RunGit: newSpy().run, Now: func() time.Time { return time.Unix(0, 0) }}
}

func TestGitHubDeleteCommandIsExact(t *testing.T) {
	want := "gh api graphql -f query='mutation($r:ID!,$n:String!,$b:GitObjectID!,$a:GitObjectID!){updateRefs(input:{repositoryId:$r,refUpdates:[{name:$n,beforeOid:$b,afterOid:$a}]}){clientMutationId}}'" +
		" -f r='R_1' -f n='refs/heads/feat/x' -f b='abc' -f a='" + zeros + "'"
	if got := branchDeleteGitHubCmd("R_1", "feat/x", "abc"); got != want {
		t.Fatalf("command\n  %s\nwant\n  %s", got, want)
	}
	id, b, tip, err := parseGitHubDelete(want)
	if err != nil || id != "R_1" || b != "feat/x" || tip != "abc" {
		t.Fatalf("parse = %q %q %q %v", id, b, tip, err)
	}
	if _, _, _, err := parseGitHubDelete(branchRestoreGitHubCmd("R_1", "feat/x", "abc")); err == nil {
		t.Error("the restore parsed as a delete")
	}
	args, err := ghCommand(want)
	if err != nil || strings.Join(args, " ") != ghDeleteArgs("R_1", "feat/x", "abc") {
		t.Fatalf("ghCommand = %q %v", args, err)
	}
}

func TestGitHubDeleteEscapesTheBranch(t *testing.T) {
	branch := "fix/a+b #2"
	cmd := branchDeleteGitHubCmd("R_1", branch, tipOne)
	if !strings.Contains(cmd, " -f n='refs/heads/fix/a+b #2' ") {
		t.Errorf("command %s", cmd)
	}
	if _, b, _, err := parseGitHubDelete(cmd); err != nil || b != branch {
		t.Fatalf("parse branch %q %v", b, err)
	}
	gh := &ghScript{t: t, reply: map[string]ghReply{
		"api repos/o/r --jq " + repoJq:                                             {out: "main"},
		"api repos/o/r/git/ref/heads/fix/a%2Bb%20%232 --jq .object.sha":            {out: tipOne},
		"api repos/o/r/compare/main..." + tipOne + " --jq .status":                 {out: "identical"},
		"api repos/o/r/pulls?state=open&head=o:fix%2Fa%2Bb+%232 --jq [.[].number]": {out: "[]"},
	}}
	chk, err := Check(context.Background(), ghStep(branch, tipOne), Env{Gh: gh})
	if err != nil || !chk.OK || chk.Tip != tipOne || chk.Branch != branch {
		t.Fatalf("check %+v %v", chk, err)
	}
}

func TestGitHubDeleteRunsWhenLandedInDefault(t *testing.T) {
	gh := landedScript(t, tipOne)
	res, err := ghRunner(t, gh).RunStep(context.Background(), ghStep("feat/x", tipOne), Env{Gh: gh})
	if err != nil || res.State != StepReported {
		t.Fatalf("RunStep %+v %v", res, err)
	}
	if !gh.sent(ghDeleteArgs("R_1", "feat/x", tipOne)) {
		t.Errorf("no updateRefs with b=%s: %v", tipOne, gh.calls)
	}
	if res.Restore != branchRestoreGitHubCmd("R_1", "feat/x", tipOne) {
		t.Errorf("restore %q", res.Restore)
	}
}

func TestGitHubDeleteLandedByMergedPRHead(t *testing.T) {
	gh := landedScript(t, tipOne)
	gh.reply["api repos/o/r/compare/main..."+tipOne+" --jq .status"] = ghReply{out: "diverged"}
	gh.reply["api repos/o/r/commits/"+tipOne+"/pulls --jq [.[] | select(.merged_at != null and .head.sha == \""+tipOne+"\")] | length"] = ghReply{out: "1"}
	chk, err := Check(context.Background(), ghStep("feat/x", tipOne), Env{Gh: gh})
	if err != nil || !chk.OK {
		t.Fatalf("check %+v %v", chk, err)
	}
}

func TestGitHubBranchMovedIsRefused(t *testing.T) {
	gh := landedScript(t, tipTwo)
	res, _ := ghRunner(t, gh).RunStep(context.Background(), ghStep("feat/x", tipOne), Env{Gh: gh})
	if res.State != StepSkipped || res.Detail != "branch on GitHub moved: have 222222222222, expected 111111111111" {
		t.Fatalf("RunStep %+v", res)
	}
	if gh.sent("updateRefs") {
		t.Error("a delete was sent for a moved branch")
	}
}

func TestGitHubBranchNotLandedIsRefused(t *testing.T) {
	gh := landedScript(t, tipOne)
	gh.reply["api repos/o/r/compare/main..."+tipOne+" --jq .status"] = ghReply{out: "ahead"}
	gh.reply["api repos/o/r/commits/"+tipOne+"/pulls --jq [.[] | select(.merged_at != null and .head.sha == \""+tipOne+"\")] | length"] = ghReply{out: "0"}
	res, _ := ghRunner(t, gh).RunStep(context.Background(), ghStep("feat/x", tipOne), Env{Gh: gh})
	if res.State != StepSkipped || res.Detail != "branch is not landed" {
		t.Fatalf("RunStep %+v", res)
	}
}

func TestGitHubLongLivedIsRefused(t *testing.T) {
	gh := &ghScript{t: t, reply: map[string]ghReply{"api repos/o/r --jq " + repoJq: {out: "trunk\n"}}}
	res, _ := ghRunner(t, gh).RunStep(context.Background(), ghStep("trunk", tipOne), Env{Gh: gh})
	if res.State != StepSkipped || res.Detail != "trunk is a long-lived branch: casebook never deletes it" {
		t.Fatalf("RunStep %+v", res)
	}
	if gh.sent("git/ref") {
		t.Error("the ref was read for a long-lived branch")
	}
}

func TestGitHubBranchWithAnOpenPRIsRefused(t *testing.T) {
	gh := landedScript(t, tipOne)
	gh.reply["api repos/o/r/pulls?state=open&head=o:feat%2Fx --jq [.[].number]"] = ghReply{out: "[12]\n"}
	res, _ := ghRunner(t, gh).RunStep(context.Background(), ghStep("feat/x", tipOne), Env{Gh: gh})
	if res.State != StepSkipped || res.Detail != "open PR #12 uses this branch: deleting it on GitHub closes that PR" {
		t.Fatalf("RunStep %+v", res)
	}
	if gh.sent("updateRefs") {
		t.Error("a delete was sent for a branch with an open PR")
	}
}

// repoJq is the precondition's repo read: the default branch and the
// parent a fork has.
const repoJq = `.default_branch + " " + (.parent.full_name // "")`

// TestGitHubBranchWithAnOpenPRUpstreamIsRefused: a fork's branch that is
// the head of an open PR into its parent is refused, as one into the fork.
func TestGitHubBranchWithAnOpenPRUpstreamIsRefused(t *testing.T) {
	gh := landedScript(t, tipOne)
	gh.reply["api repos/o/r --jq "+repoJq] = ghReply{out: "main u/p\n"}
	gh.reply["api repos/u/p/pulls?state=open&head=o:feat%2Fx --jq [.[].number]"] = ghReply{out: "[7]\n"}
	res, _ := ghRunner(t, gh).RunStep(context.Background(), ghStep("feat/x", tipOne), Env{Gh: gh})
	if res.State != StepSkipped || res.Detail != "open PR #7 uses this branch: deleting it on GitHub closes that PR" {
		t.Fatalf("RunStep %+v", res)
	}
	if gh.sent("updateRefs") {
		t.Error("a delete was sent for a branch with an open PR upstream")
	}
}

func TestGitHubBranchAlreadyGoneIsDone(t *testing.T) {
	gh := landedScript(t, tipOne)
	gh.reply["api repos/o/r/git/ref/heads/feat/x --jq .object.sha"] = ghReply{err: err404()}
	res, err := ghRunner(t, gh).RunStep(context.Background(), ghStep("feat/x", tipOne), Env{Gh: gh})
	if err != nil || res.State != StepReported || res.Restore != "" {
		t.Fatalf("RunStep %+v %v", res, err)
	}
	if gh.sent("updateRefs") {
		t.Error("a delete was sent for a branch already gone")
	}
}

func TestGitHubDeleteRestoreIsACreateAtTheSameCommit(t *testing.T) {
	rec, ok := RestoreFor(ghStep("feat/x", tipOne), Checked{OK: true, Tip: tipOne, Branch: "feat/x"})
	want := branchRestoreGitHubCmd("R_1", "feat/x", tipOne)
	if !ok || rec.RestoreCommand != want || rec.Before != tipOne {
		t.Fatalf("restore %+v %v", rec, ok)
	}
	if !strings.Contains(want, " -f b='"+zeros+"' -f a='"+tipOne+"'") {
		t.Errorf("restore is not a create at the tip: %s", want)
	}
	if !AutoUndoable(want) {
		t.Error("not auto-undoable")
	}
	if AutoUndoable(branchDeleteGitHubCmd("R_1", "feat/x", tipOne)) {
		t.Error("a delete counts as an undo")
	}
}

func TestGitHubDeleteRefusedWhenItMovedMeanwhile(t *testing.T) {
	gh := landedScript(t, tipOne)
	gh.reply[ghDeleteArgs("R_1", "feat/x", tipOne)] = ghReply{err: &observe.GhError{Code: 1, Stderr: "gh: Expected branch to point to \"1111\" but it did not. Pull and try again."}}
	res, err := ghRunner(t, gh).RunStep(context.Background(), ghStep("feat/x", tipOne), Env{Gh: gh})
	if err != nil || res.State != StepFailed || !strings.Contains(res.Detail, "Expected branch to point to") {
		t.Fatalf("RunStep %+v %v", res, err)
	}
	if res.Restore != "" {
		t.Errorf("a refused delete left an undo: %q", res.Restore)
	}
}

func TestGitHubDeleteVerifiedByA404(t *testing.T) {
	gh := &ghScript{t: t, reply: map[string]ghReply{"api repos/o/r/git/ref/heads/feat/x --jq .object.sha": {err: err404()}}}
	step := ghStep("feat/x", tipOne)
	obs := ghRunner(t, gh).Observe(context.Background(), step)
	if !obs.Known || obs.Exists || Verify(step, obs) != StepVerified {
		t.Fatalf("observed %+v", obs)
	}
	gh.reply["api repos/o/r/git/ref/heads/feat/x --jq .object.sha"] = ghReply{out: tipOne}
	if obs := ghRunner(t, gh).Observe(context.Background(), step); !obs.Known || !obs.Exists {
		t.Fatalf("still there: observed %+v", obs)
	}
	gh.reply["api repos/o/r/git/ref/heads/feat/x --jq .object.sha"] = ghReply{err: &observe.GhError{Code: 1, Stderr: "HTTP 502"}}
	if obs := ghRunner(t, gh).Observe(context.Background(), step); obs.Known {
		t.Fatalf("an error is known: %+v", obs)
	}
}
