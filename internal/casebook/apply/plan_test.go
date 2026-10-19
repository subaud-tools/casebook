package apply

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/engine"
	"github.com/subaud-tools/casebook/internal/casebook/item"
	"github.com/subaud-tools/casebook/internal/casebook/observe"
)

// epoch is a fixed clock used by all tests.
var epoch = time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)

func decided(d item.Disposition, note string) *item.Decision {
	return &item.Decision{
		Disposition: d,
		Note:        note,
		DecidedBy:   "court",
		DecidedAt:   epoch.Add(-time.Hour),
	}
}

func branchItem(repo, branch, machine, clonePath string) engine.Item {
	k := item.BranchKey(repo, branch)
	return engine.Item{
		Key:       k,
		ID:        k.String(),
		Kind:      item.KindBranch,
		Repo:      repo,
		Status:    item.StatusToApply,
		Decision:  decided(item.Delete, ""),
		Landed:    "all-machines",
		Locations: []string{machine + ":" + clonePath},
	}
}

// onGitHub gives it a looked-up GitHub copy at tip in repository R_1.
func onGitHub(it engine.Item, tip string) engine.Item {
	it.Copies = append(it.Copies, engine.Copy{Tip: tip, RepoID: "R_1"})
	return it
}

func TestPlanGroupsByActionAndLane(t *testing.T) {
	builtAt := epoch.Add(-10 * time.Minute)

	bk := item.BranchKey("schuettc/myrepo", "feat/thing")
	br := engine.Item{
		Key:       bk,
		ID:        bk.String(),
		Kind:      item.KindBranch,
		Status:    item.StatusToApply,
		Decision:  decided(item.Delete, ""),
		Landed:    "all-machines",
		Locations: []string{"mymachine:/Users/me/repos/myrepo"},
	}

	rk := item.RepoKey("schuettc/oldrepo")
	rp := engine.Item{
		Key:      rk,
		ID:       rk.String(),
		Kind:     item.KindRepo,
		Status:   item.StatusToApply,
		Decision: decided(item.Archive, ""),
	}

	snap := snapWith("mymachine", []observe.Clone{{
		Path:     "/Users/me/repos/myrepo",
		Repo:     "schuettc/myrepo",
		Remotes:  map[string]string{"origin": "schuettc/myrepo"},
		Branches: []observe.Branch{{Name: "feat/thing", Upstream: "origin/x", Tip: "aaa", RemoteTip: "aaa"}},
	}})
	plan, err := Build([]engine.Item{onGitHub(br, "aaa"), rp}, snap, epoch, builtAt, 30*time.Minute)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}

	groups := plan.Groups()
	if len(groups) == 0 {
		t.Fatal("Groups() returned none")
	}

	seen := map[string]bool{}
	for _, g := range groups {
		seen[g.Action] = true
		if len(g.Steps) == 0 {
			t.Errorf("group %q has no steps", g.Action)
		}
	}
	for _, want := range []string{"branch-delete-local", "branch-delete-remote", "repo-archive"} {
		if !seen[want] {
			t.Errorf("no group for action %q; groups: %v", want, groups)
		}
	}

	// A branch's GitHub copy goes first, then its local copies.
	if groups[0].Action != "branch-delete-remote" || groups[1].Action != "branch-delete-local" {
		t.Errorf("groups %q %q, want branch-delete-remote, branch-delete-local", groups[0].Action, groups[1].Action)
	}
}

func TestBranchDeleteIsCasebookLaneWithExactCommand(t *testing.T) {
	builtAt := epoch.Add(-5 * time.Minute)

	k := item.BranchKey("schuettc/myrepo", "feat/my-branch")
	it := engine.Item{
		Key:       k,
		ID:        k.String(),
		Kind:      item.KindBranch,
		Status:    item.StatusToApply,
		Decision:  decided(item.Delete, ""),
		Landed:    "all-machines",
		Locations: []string{"mymachine:/Users/me/repos/myrepo"},
	}

	snap := snapWith("mymachine", []observe.Clone{{
		Path:     "/Users/me/repos/myrepo",
		Repo:     "schuettc/myrepo",
		Remotes:  map[string]string{"origin": "schuettc/myrepo"},
		Branches: []observe.Branch{{Name: "feat/my-branch", Upstream: "origin/x", Tip: "tip123", RemoteTip: "tip123"}},
	}})
	plan, err := Build([]engine.Item{onGitHub(it, "tip123")}, snap, epoch, builtAt, 30*time.Minute)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if len(plan.Steps) != 2 {
		t.Fatalf("want 2 steps (local + remote), got %d: %v", len(plan.Steps), plan.Steps)
	}

	local := plan.Steps[1]
	if local.Action != "branch-delete-local" {
		t.Errorf("Steps[1].Action = %q, want branch-delete-local", local.Action)
	}
	if local.Lane != LaneCasebook {
		t.Errorf("Steps[0].Lane = %q, want %q", local.Lane, LaneCasebook)
	}
	if local.Key != k.String() {
		t.Errorf("Steps[0].Key = %q, want %q", local.Key, k.String())
	}
	wantLocal := "git -C '/Users/me/repos/myrepo' update-ref -d 'refs/heads/feat/my-branch' tip123"
	if local.Command != wantLocal {
		t.Errorf("Steps[0].Command =\n  %q\nwant\n  %q", local.Command, wantLocal)
	}
	if local.Precondition != "branch-tip-unchanged-and-landed" {
		t.Errorf("Steps[0].Precondition = %q, want branch-tip-unchanged-and-landed", local.Precondition)
	}
	if local.Posts {
		t.Error("Steps[0].Posts should be false for local branch delete")
	}

	remote := plan.Steps[0]
	if remote.Action != "branch-delete-remote" {
		t.Errorf("Steps[0].Action = %q, want branch-delete-remote", remote.Action)
	}
	if remote.Lane != LaneCasebook {
		t.Errorf("Steps[1].Lane = %q, want %q", remote.Lane, LaneCasebook)
	}
	wantRemote := branchDeleteGitHubCmd("R_1", "feat/my-branch", "tip123")
	if remote.Command != wantRemote {
		t.Errorf("Steps[1].Command =\n  %q\nwant\n  %q", remote.Command, wantRemote)
	}
	if remote.Precondition != PreconditionGitHubTip || remote.ExpectedTip != "tip123" {
		t.Errorf("Steps[1] = %+v, want precondition %s and tip tip123", remote, PreconditionGitHubTip)
	}
}

func TestArchiveAndCloseAreAgentLane(t *testing.T) {
	builtAt := epoch.Add(-5 * time.Minute)

	rk := item.RepoKey("schuettc/oldrepo")
	archive := engine.Item{
		Key:      rk,
		ID:       rk.String(),
		Kind:     item.KindRepo,
		Status:   item.StatusToApply,
		Decision: decided(item.Archive, ""),
	}

	pk := item.PRKey("schuettc/myrepo", 42)
	prClose := engine.Item{
		Key:      pk,
		ID:       pk.String(),
		Kind:     item.KindPR,
		Status:   item.StatusToApply,
		Decision: decided(item.Close, "no activity"),
	}

	plan, err := Build([]engine.Item{archive, prClose}, snapWith("mymachine", nil), epoch, builtAt, 30*time.Minute)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if len(plan.Steps) != 2 {
		t.Fatalf("want 2 steps, got %d: %v", len(plan.Steps), plan.Steps)
	}

	archiveStep := plan.Steps[0]
	if archiveStep.Lane != LaneAgent {
		t.Errorf("archive step Lane = %q, want %q", archiveStep.Lane, LaneAgent)
	}
	if archiveStep.Action != "repo-archive" {
		t.Errorf("archive step Action = %q, want repo-archive", archiveStep.Action)
	}
	if archiveStep.Posts {
		t.Error("archive step Posts should be false")
	}

	closeStep := plan.Steps[1]
	if closeStep.Lane != LaneAgent {
		t.Errorf("pr close step Lane = %q, want %q", closeStep.Lane, LaneAgent)
	}
	if closeStep.Action != "pr-close" {
		t.Errorf("pr close step Action = %q, want pr-close", closeStep.Action)
	}
	if !closeStep.Posts {
		t.Error("pr close step Posts should be true (posts public text)")
	}
	wantCmd := "gh pr close 42 -R 'schuettc/myrepo' --comment 'no activity'"
	if closeStep.Command != wantCmd {
		t.Errorf("pr close Command =\n  %q\nwant\n  %q", closeStep.Command, wantCmd)
	}
}

func TestPlanRefusesStaleObservation(t *testing.T) {
	// builtAt 31 minutes ago, syncInterval 30m → ErrStale.
	builtAt := epoch.Add(-31 * time.Minute)

	emptySnap := snapWith("mymachine", nil)
	_, err := Build(nil, emptySnap, epoch, builtAt, 30*time.Minute)
	if !errors.Is(err, ErrStale) {
		t.Fatalf("Build with stale observation: got %v, want ErrStale", err)
	}

	// Exactly at boundary: 30m → not stale.
	builtAt30 := epoch.Add(-30 * time.Minute)
	_, err = Build(nil, emptySnap, epoch, builtAt30, 30*time.Minute)
	if err != nil {
		t.Fatalf("Build at exactly syncInterval: got %v, want nil", err)
	}
}

func TestKeepProducesNoStep(t *testing.T) {
	builtAt := epoch.Add(-5 * time.Minute)

	// Keep/wait/watch/ignore produce no steps even if status is manually set to-apply.
	for _, disp := range []item.Disposition{item.Keep, item.Wait, item.Watch, item.Ignore} {
		k := item.RepoKey("schuettc/somerepo")
		it := engine.Item{
			Key:      k,
			ID:       k.String(),
			Kind:     item.KindRepo,
			Status:   item.StatusToApply, // manually forced; not reachable through engine normally
			Decision: decided(disp, ""),
		}

		plan, err := Build([]engine.Item{it}, snapWith("mymachine", nil), epoch, builtAt, 30*time.Minute)
		if err != nil {
			t.Fatalf("Build(%s): %v", disp, err)
		}
		if len(plan.Steps) != 0 {
			t.Errorf("disposition %s: want 0 steps, got %d: %v", disp, len(plan.Steps), plan.Steps)
		}
	}
}

func TestLocalStepsOnlyForThisMachine(t *testing.T) {
	builtAt := epoch.Add(-5 * time.Minute)

	// Branch present on machineA and machineB.
	bk := item.BranchKey("schuettc/myrepo", "feat/shared")
	branch := engine.Item{
		Key:      bk,
		ID:       bk.String(),
		Kind:     item.KindBranch,
		Status:   item.StatusToApply,
		Decision: decided(item.Delete, ""),
		Landed:   "all-machines",
		Locations: []string{
			"machineA:/Users/A/repos/myrepo",
			"machineB:/Users/B/repos/myrepo",
		},
	}

	// Worktree on machineB only.
	wk := item.WorktreeKey("machineB", "/Users/B/worktrees/feat-shared")
	worktree := engine.Item{
		Key:       wk,
		ID:        wk.String(),
		Kind:      item.KindWorktree,
		Status:    item.StatusToApply,
		Decision:  decided(item.Delete, ""),
		Locations: []string{"machineB:/Users/B/repos/myrepo"},
	}

	snapA := snapWith("machineA", []observe.Clone{{
		Path:     "/Users/A/repos/myrepo",
		Repo:     "schuettc/myrepo",
		Remotes:  map[string]string{"origin": "schuettc/myrepo"},
		Branches: []observe.Branch{{Name: "feat/shared", Upstream: "origin/x", Tip: "tipA", RemoteTip: "tipA"}},
	}})
	plan, err := Build([]engine.Item{onGitHub(branch, "tipA"), worktree}, snapA, epoch, builtAt, 30*time.Minute)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}

	// Expect: 1 local delete (machineA's clone) + 1 remote delete (from machineA).
	// No step for machineB's clone. No worktree step (machineB worktree).
	if len(plan.Steps) != 2 {
		t.Fatalf("want 2 steps, got %d: %v", len(plan.Steps), plan.Steps)
	}

	local := plan.Steps[1]
	if local.Action != "branch-delete-local" {
		t.Errorf("Steps[1].Action = %q, want branch-delete-local", local.Action)
	}
	wantLocal := "git -C '/Users/A/repos/myrepo' update-ref -d 'refs/heads/feat/shared' tipA"
	if local.Command != wantLocal {
		t.Errorf("Steps[0].Command =\n  %q\nwant\n  %q", local.Command, wantLocal)
	}

	remote := plan.Steps[0]
	if remote.Action != "branch-delete-remote" {
		t.Errorf("Steps[0].Action = %q, want branch-delete-remote", remote.Action)
	}
	wantRemote := branchDeleteGitHubCmd("R_1", "feat/shared", "tipA")
	if remote.Command != wantRemote {
		t.Errorf("Steps[1].Command =\n  %q\nwant\n  %q", remote.Command, wantRemote)
	}

	// Verify no step uses machineB's clone path.
	for _, s := range plan.Steps {
		if strings.Contains(s.Command, "/Users/B/") {
			t.Errorf("step for machineB found in machineA plan: %v", s)
		}
	}
}

// --- Fix round 1 tests ---

// snapWith builds a minimal observe.Snapshot for tests.
func snapWith(machine string, clones []observe.Clone) observe.Snapshot {
	return observe.Snapshot{
		Version: 1,
		Machine: machine,
		Clones:  clones,
	}
}

// TestBranchStepsHaveExpectedTips checks fix 2: local-delete steps carry the
// snapshot branch tip; the GitHub-delete step carries the GitHub copy's tip.
func TestBranchStepsHaveExpectedTips(t *testing.T) {
	builtAt := epoch.Add(-5 * time.Minute)

	k := item.BranchKey("schuettc/myrepo", "feat/tips")
	it := engine.Item{
		Key:       k,
		ID:        k.String(),
		Kind:      item.KindBranch,
		Status:    item.StatusToApply,
		Decision:  decided(item.Delete, ""),
		Landed:    "all-machines",
		Locations: []string{"mymachine:/Users/me/repos/myrepo"},
	}

	const wantTip = "cafebabe00000000"
	snap := snapWith("mymachine", []observe.Clone{{
		Path: "/Users/me/repos/myrepo",
		Repo: "schuettc/myrepo",
		Remotes: map[string]string{
			"origin": "schuettc/myrepo",
		},
		Branches: []observe.Branch{{
			Name:      "feat/tips",
			Upstream:  "origin/feat/tips",
			Tip:       wantTip,
			RemoteTip: wantTip,
		}},
	}})

	plan, err := Build([]engine.Item{onGitHub(it, wantTip)}, snap, epoch, builtAt, 30*time.Minute)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if len(plan.Steps) != 2 {
		t.Fatalf("want 2 steps, got %d: %v", len(plan.Steps), plan.Steps)
	}

	if got := plan.Steps[1].ExpectedTip; got != wantTip {
		t.Errorf("local step ExpectedTip = %q, want %q", got, wantTip)
	}
	if got := plan.Steps[0].ExpectedTip; got != wantTip {
		t.Errorf("remote step ExpectedTip = %q, want %q", got, wantTip)
	}
}

// TestNoGitHubStepWithoutALookedUpCopy: the GitHub delete needs the branch's
// commit and repository id on GitHub; without both, no GitHub step.
func TestNoGitHubStepWithoutALookedUpCopy(t *testing.T) {
	snap := snapWith("m", []observe.Clone{{Path: "/src/repo", Repo: "schuettc/repo", Branches: []observe.Branch{{Name: "feat", Tip: "abc123"}}}})
	for name, copies := range map[string][]engine.Copy{
		"no copies":      nil,
		"gone on GitHub": {{Absent: true}},
		"not looked up":  {{Tip: "abc123"}},
		"looked up":      {{Tip: "abc123", RepoID: "R_1"}},
	} {
		it := branchItem("schuettc/repo", "feat", "m", "/src/repo")
		it.Copies = copies
		p, err := Build([]engine.Item{it}, snap, epoch, epoch, 30*time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		var got *Step
		for i := range p.Steps {
			if p.Steps[i].Action == "branch-delete-remote" {
				got = &p.Steps[i]
			}
		}
		if name != "looked up" {
			if got != nil {
				t.Errorf("%s: GitHub step %+v", name, got)
			}
			continue
		}
		if got == nil || got.ExpectedTip != "abc123" || got.Command != branchDeleteGitHubCmd("R_1", "feat", "abc123") {
			t.Errorf("%s: GitHub step %+v", name, got)
		}
	}
}

// TestWorktreeStepUsesSnapshotClone checks fix 3: the worktree remove command
// uses the clone path from the snapshot (matched by the worktree path), not
// the item's Locations entry which may be for a different machine.
func TestWorktreeStepUsesSnapshotClone(t *testing.T) {
	builtAt := epoch.Add(-5 * time.Minute)

	wk := item.WorktreeKey("mymachine", "/Users/me/worktrees/feat")
	it := engine.Item{
		Key:      wk,
		ID:       wk.String(),
		Kind:     item.KindWorktree,
		Status:   item.StatusToApply,
		Decision: decided(item.Delete, ""),
		// Locations comes from the engine; the clone is "/Users/me/repos/myrepo".
		Locations: []string{"mymachine:/Users/me/repos/myrepo"},
	}

	snap := snapWith("mymachine", []observe.Clone{{
		Path: "/Users/me/repos/myrepo",
		Repo: "schuettc/myrepo",
		Worktrees: []observe.Worktree{{
			Path:   "/Users/me/worktrees/feat",
			Branch: "feat/my-branch",
		}},
	}})

	plan, err := Build([]engine.Item{it}, snap, epoch, builtAt, 30*time.Minute)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if len(plan.Steps) != 1 {
		t.Fatalf("want 1 step, got %d: %v", len(plan.Steps), plan.Steps)
	}

	step := plan.Steps[0]
	wantCmd := "git -C '/Users/me/repos/myrepo' worktree remove '/Users/me/worktrees/feat'"
	if step.Command != wantCmd {
		t.Errorf("worktree step Command =\n  %q\nwant\n  %q", step.Command, wantCmd)
	}
}

// TestCloseCommentIsTheDecisionsNote: a close posts the decision's note as
// its closing comment, and nothing else. A note left empty (or blank) means
// no comment: the command has no --comment and the step posts nothing (no
// "Closing." stand-in).
func TestCloseCommentIsTheDecisionsNote(t *testing.T) {
	builtAt := epoch.Add(-5 * time.Minute)
	closing := func(k item.Key, note string) engine.Item {
		return engine.Item{
			Key:      k,
			ID:       k.String(),
			Kind:     k.Kind,
			Status:   item.StatusToApply,
			Decision: decided(item.Close, note),
		}
	}
	for _, tc := range []struct {
		name, note, wantCmd string
		posts               bool
	}{
		{"pr with a comment", "Thanks! Superseded by #9.", "gh pr close 42 -R 'schuettc/myrepo' --comment 'Thanks! Superseded by #9.'", true},
		{"pr without comment", "", "gh pr close 42 -R 'schuettc/myrepo'", false},
		{"pr with a blank note", "  \n", "gh pr close 42 -R 'schuettc/myrepo'", false},
		{"issue with a comment", "Fixed in v2; it's in the release notes.", `gh issue close 13 -R 'schuettc/myrepo' --comment 'Fixed in v2; it'"'"'s in the release notes.'`, true},
		{"issue without comment", "", "gh issue close 13 -R 'schuettc/myrepo'", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			k := item.PRKey("schuettc/myrepo", 42)
			if strings.HasPrefix(tc.name, "issue") {
				k = item.IssueKey("schuettc/myrepo", 13)
			}
			plan, err := Build([]engine.Item{closing(k, tc.note)}, snapWith("mymachine", nil), epoch, builtAt, 30*time.Minute)
			if err != nil {
				t.Fatalf("Build: %v", err)
			}
			if len(plan.Steps) != 1 {
				t.Fatalf("want 1 step, got %d: %v", len(plan.Steps), plan.Steps)
			}
			st := plan.Steps[0]
			if st.Command != tc.wantCmd {
				t.Errorf("Command =\n  %q\nwant\n  %q", st.Command, tc.wantCmd)
			}
			if st.Posts != tc.posts {
				t.Errorf("Posts = %v, want %v", st.Posts, tc.posts)
			}
			if strings.Contains(st.Command, "Closing.") {
				t.Errorf("Command %q posts the old stand-in comment", st.Command)
			}
		})
	}
}

// TestEveryPlanGroupSaysWhetherItCanBeUndone: every action the plan builder
// emits has an undo note, its group carries it, and an action whose restore
// is automatic (AutoUndoable) says it can be undone; the others say not.
func TestEveryPlanGroupSaysWhetherItCanBeUndone(t *testing.T) {
	br := onGitHub(branchItem("schuettc/myrepo", "feat/thing", "m", "/r/myrepo"), "aaa")
	wk := item.WorktreeKey("m", "/r/myrepo-wt")
	wt := engine.Item{Key: wk, ID: wk.String(), Kind: item.KindWorktree, Status: item.StatusToApply,
		Decision: decided(item.Delete, ""), Locations: []string{"m:/r/myrepo"}}
	var items = []engine.Item{br, wt}
	for i, d := range []item.Disposition{item.Archive, item.Delete} {
		k := item.RepoKey([]string{"schuettc/a", "schuettc/b"}[i])
		items = append(items, engine.Item{Key: k, ID: k.String(), Kind: item.KindRepo, Status: item.StatusToApply, Decision: decided(d, "")})
	}
	for i, d := range []item.Disposition{item.Close, item.Merge} {
		k := item.PRKey("schuettc/a", i+1)
		items = append(items, engine.Item{Key: k, ID: k.String(), Kind: item.KindPR, Status: item.StatusToApply, Decision: decided(d, "")})
	}
	ik := item.IssueKey("schuettc/a", 9)
	items = append(items, engine.Item{Key: ik, ID: ik.String(), Kind: item.KindIssue, Status: item.StatusToApply, Decision: decided(item.Close, "")})

	snap := snapWith("m", []observe.Clone{{
		Path:      "/r/myrepo",
		Repo:      "schuettc/myrepo",
		Remotes:   map[string]string{"origin": "schuettc/myrepo"},
		Branches:  []observe.Branch{{Name: "feat/thing", Upstream: "origin/feat/thing", Tip: "aaa", RemoteTip: "aaa"}},
		Worktrees: []observe.Worktree{{Path: "/r/myrepo-wt", Branch: "feat/thing"}},
	}})
	plan, err := Build(items, snap, epoch, epoch.Add(-time.Minute), 30*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"branch-delete-local", "branch-delete-remote", "worktree-remove", "repo-archive", "repo-delete", "pr-close", "pr-merge", "issue-close"}
	seen := map[string]bool{}
	for _, g := range plan.Groups() {
		seen[g.Action] = true
		if g.Undo == "" || g.Undo != UndoNote(g.Action) {
			t.Errorf("%s: group undo %q, UndoNote %q", g.Action, g.Undo, UndoNote(g.Action))
		}
		restore := ""
		if rec, ok := RestoreFor(JobStep{Key: g.Steps[0].Key, Action: g.Action, Command: g.Steps[0].Command}, Checked{Tip: "aaa", Branch: "feat/thing"}); ok {
			restore = rec.RestoreCommand
		}
		if can := strings.HasPrefix(g.Undo, "Can be undone"); can != AutoUndoable(restore) {
			t.Errorf("%s: undo %q, but its restore %q undoable = %v", g.Action, g.Undo, restore, AutoUndoable(restore))
		}
	}
	for _, a := range want {
		if !seen[a] {
			t.Errorf("the plan emitted no %s step (%v)", a, seen)
		}
	}
	if UndoNote("something-new") == "" {
		t.Error("an unknown action has no undo note")
	}
}

// TestPermanentIsWhatCannotBeUndone (Court, 2026-10-17: confirm on
// irrevocable changes): a step is permanent exactly when its undo note
// says it cannot be undone.
func TestPermanentIsWhatCannotBeUndone(t *testing.T) {
	for _, a := range []string{"branch-delete-local", "branch-delete-remote", "worktree-remove", "repo-archive", "repo-delete", "pr-close", "pr-merge", "issue-close"} {
		want := strings.HasPrefix(UndoNote(a), "Cannot be undone")
		if got := Permanent(a); got != want {
			t.Errorf("Permanent(%q) = %v, want %v (%q)", a, got, want, UndoNote(a))
		}
	}
	if !Permanent("repo-delete") || Permanent("repo-archive") {
		t.Fatal("repo-delete is permanent, repo-archive is not")
	}
}

func actions(p Plan) []string {
	var out []string
	for _, s := range p.Steps {
		out = append(out, s.Action)
	}
	return out
}

func TestGitHubDeleteNeedsNoClone(t *testing.T) {
	it := branchItem("o/r", "feat/x", "pro-2", "/p")
	it.Copies = []engine.Copy{{Machine: "pro-2", Path: "/p", Tip: "abc"}, {Machine: "work", Absent: true}, {Tip: "abc", RepoID: "R_1"}}
	it.Holds = []engine.Hold{{Kind: engine.HoldOtherMac, Text: "its local copy is only on pro-2", Stops: []item.Disposition{item.Delete}, Local: true, Machine: "pro-2"}}
	plan, err := Build([]engine.Item{it}, snapWith("work", nil), epoch, epoch, 30*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Steps) != 1 || plan.Steps[0].Action != "branch-delete-remote" || plan.Steps[0].Command != branchDeleteGitHubCmd("R_1", "feat/x", "abc") || plan.Steps[0].ExpectedTip != "abc" {
		t.Fatalf("steps %+v", plan.Steps)
	}
	if len(plan.Waiting) != 1 || plan.Waiting[0] != (Waiting{Key: it.ID, Machine: "pro-2", Path: "/p"}) {
		t.Errorf("waiting %+v", plan.Waiting)
	}
	if len(plan.HeldBack) != 0 {
		t.Errorf("held back %+v", plan.HeldBack)
	}
}

func TestWorktreeRemovedBeforeItsBranch(t *testing.T) {
	br := onGitHub(branchItem("o/r", "feat/x", "work", "/r"), "abc")
	br.Needs = []string{"worktree:work:/r/.worktrees/faqux"}
	wk := item.WorktreeKey("work", "/r/.worktrees/faqux")
	wt := engine.Item{Key: wk, ID: wk.String(), Kind: item.KindWorktree, Status: item.StatusToApply, Decision: decided(item.Delete, ""), Locations: []string{"work:/r"}}
	snap := snapWith("work", []observe.Clone{{Path: "/r", Repo: "o/r", Branches: []observe.Branch{{Name: "feat/x", Tip: "abc"}},
		Worktrees: []observe.Worktree{{Path: "/r/.worktrees/faqux", Branch: "feat/x"}}}})
	plan, err := Build([]engine.Item{br, wt}, snap, epoch, epoch, 30*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(actions(plan), " "); got != "worktree-remove branch-delete-remote branch-delete-local" {
		t.Fatalf("order %s", got)
	}
}

func TestHeldItemHasNoStep(t *testing.T) {
	it := onGitHub(branchItem("o/r", "dev", "work", "/r"), "abc")
	it.Holds = []engine.Hold{{Kind: engine.HoldLongLived, Text: "dev is a long-lived branch: casebook never deletes it", Stops: []item.Disposition{item.Delete}}}
	plan, err := Build([]engine.Item{it}, snapWith("work", nil), epoch, epoch, 30*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Steps) != 0 || len(plan.HeldBack) != 1 || plan.HeldBack[0].Key != it.ID || plan.HeldBack[0].Holds[0].Kind != engine.HoldLongLived {
		t.Fatalf("steps %+v held %+v", plan.Steps, plan.HeldBack)
	}
}

func TestWorktreeHoldStopsOnlyTheLocalDelete(t *testing.T) {
	it := onGitHub(branchItem("o/r", "feat/x", "work", "/r"), "abc")
	hold := engine.Hold{Kind: engine.HoldWorktree, Text: "in use by worktree ops on work, which has uncommitted changes", Stops: []item.Disposition{item.Delete}, Local: true, Machine: "work"}
	it.Holds = []engine.Hold{hold}
	snap := snapWith("work", []observe.Clone{{Path: "/r", Repo: "o/r", Branches: []observe.Branch{{Name: "feat/x", Tip: "abc"}}}})
	plan, err := Build([]engine.Item{it}, snap, epoch, epoch, 30*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(actions(plan), " "); got != "branch-delete-remote" {
		t.Fatalf("steps %s", got)
	}
	if len(plan.HeldBack) != 1 || plan.HeldBack[0].Holds[0].Text != hold.Text {
		t.Errorf("held back %+v", plan.HeldBack)
	}
}

func TestOpenPRHoldStopsOnlyTheGitHubDelete(t *testing.T) {
	it := onGitHub(branchItem("o/r", "feat/x", "work", "/r"), "abc")
	hold := engine.Hold{Kind: engine.HoldOpenPR, Text: "open PR #12 uses this branch: deleting it on GitHub closes that PR", By: "pr:o/r#12", Stops: []item.Disposition{item.Delete}, Remote: true}
	it.Holds = []engine.Hold{hold}
	snap := snapWith("work", []observe.Clone{{Path: "/r", Repo: "o/r", Branches: []observe.Branch{{Name: "feat/x", Tip: "abc"}}}})
	plan, err := Build([]engine.Item{it}, snap, epoch, epoch, 30*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(actions(plan), " "); got != "branch-delete-local" {
		t.Fatalf("steps %s", got)
	}
	if len(plan.HeldBack) != 1 || plan.HeldBack[0].Holds[0].Kind != engine.HoldOpenPR {
		t.Errorf("held back %+v", plan.HeldBack)
	}
}

func TestNoAccessHoldKeepsTheGitHubStepOut(t *testing.T) {
	it := onGitHub(branchItem("o/r", "feat/x", "work", "/r"), "abc")
	it.Holds = []engine.Hold{{Kind: engine.HoldNoAccess, Text: "you can't change branches in o/r on GitHub (your access: read)", Stops: []item.Disposition{item.Delete}, Remote: true}}
	snap := snapWith("work", []observe.Clone{{Path: "/r", Repo: "o/r", Branches: []observe.Branch{{Name: "feat/x", Tip: "abc"}}}})
	plan, err := Build([]engine.Item{it}, snap, epoch, epoch, 30*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(actions(plan), " "); got != "branch-delete-local" {
		t.Fatalf("steps %s", got)
	}
	if len(plan.HeldBack) != 1 || plan.HeldBack[0].Holds[0].Kind != engine.HoldNoAccess {
		t.Errorf("held back %+v", plan.HeldBack)
	}
}

func TestOtherMacCopyWaits(t *testing.T) {
	wk := item.WorktreeKey("pro-2", "/p/.worktrees/w")
	wt := engine.Item{Key: wk, ID: wk.String(), Kind: item.KindWorktree, Status: item.StatusToApply, Decision: decided(item.Delete, ""), Locations: []string{"pro-2:/p"},
		Holds: []engine.Hold{{Kind: engine.HoldOtherMac, Text: "its local copy is only on pro-2", Stops: []item.Disposition{item.Delete}, Local: true, Machine: "pro-2"}}}
	plan, err := Build([]engine.Item{wt}, snapWith("work", nil), epoch, epoch, 30*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Steps) != 0 || len(plan.Waiting) != 1 || plan.Waiting[0].Machine != "pro-2" || plan.Waiting[0].Path != "/p" || len(plan.HeldBack) != 0 {
		t.Fatalf("steps %+v waiting %+v held %+v", plan.Steps, plan.Waiting, plan.HeldBack)
	}
}

func TestItemWithNothingToRunSaysSo(t *testing.T) {
	it := branchItem("o/r", "feat/x", "work", "/gone")
	plan, err := Build([]engine.Item{it}, snapWith("work", nil), epoch, epoch, 30*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Steps) != 0 || len(plan.HeldBack) != 1 || plan.HeldBack[0].Holds[0].Text != "nothing to run for it from this Mac" ||
		plan.HeldBack[0].Holds[0].Kind != engine.HoldNothingHere {
		t.Fatalf("steps %+v held %+v", plan.Steps, plan.HeldBack)
	}
	// A GitHub copy that wasn't looked up says so.
	it.Copies = []engine.Copy{{Tip: "abc"}}
	plan, _ = Build([]engine.Item{it}, snapWith("work", nil), epoch, epoch, 30*time.Minute)
	if len(plan.HeldBack) != 1 || plan.HeldBack[0].Holds[0].Text != "GitHub copy not looked up yet: sync first" {
		t.Fatalf("held %+v", plan.HeldBack)
	}
}

func TestCloseStepCarriesItsCommentAndPublic(t *testing.T) {
	pk := item.PRKey("o/r", 3)
	pr := engine.Item{Key: pk, ID: pk.String(), Kind: item.KindPR, Status: item.StatusToApply, Decision: decided(item.Close, "stale"), Public: true}
	plan, _ := Build([]engine.Item{pr}, snapWith("work", nil), epoch, epoch, 30*time.Minute)
	if s := plan.Steps[0]; s.Comment != "stale" || !s.Public || !s.Posts {
		t.Errorf("step %+v", s)
	}
	pr.Decision = decided(item.Close, "")
	plan, _ = Build([]engine.Item{pr}, snapWith("work", nil), epoch, epoch, 30*time.Minute)
	if s := plan.Steps[0]; s.Comment != "" || s.Public || s.Posts {
		t.Errorf("step %+v", s)
	}
	ik := item.IssueKey("o/r", 4)
	is := engine.Item{Key: ik, ID: ik.String(), Kind: item.KindIssue, Status: item.StatusToApply, Decision: decided(item.Close, "done"), Public: true}
	plan, _ = Build([]engine.Item{is}, snapWith("work", nil), epoch, epoch, 30*time.Minute)
	if s := plan.Steps[0]; s.Comment != "done" || !s.Public {
		t.Errorf("issue step %+v", s)
	}
}
