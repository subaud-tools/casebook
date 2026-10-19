package engine

import (
	"reflect"
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/item"
	"github.com/subaud-tools/casebook/internal/casebook/observe"
)

// holdsInput is one repo o/r on GitHub and one snapshot of machine "work"
// with clone /r holding branch feat/x; mod changes it before the build.
func holdsInput(mod func(in *Input, c *observe.Clone)) Input {
	g := observe.NewGitHub()
	g.User = "court"
	g.Owners["o"] = &observe.Owner{Login: "o", Reachable: true, FetchedAt: now, Repos: []observe.RepoObs{{Repo: "o/r", DefaultBranch: "main"}}}
	c := observe.Clone{Path: "/r", Repo: "o/r", Head: "main", Branches: []observe.Branch{{Name: "main", Tip: "m"}, {Name: "feat/x", Tip: "e46d896"}}}
	in := Input{Now: now, GitHub: g, Machine: "work", Decisions: map[string]item.Decision{}, Seen: map[string]time.Time{}}
	if mod != nil {
		mod(&in, &c)
	}
	in.Snapshots = append([]observe.Snapshot{{Version: 1, Machine: "work", Clones: []observe.Clone{c}}}, in.Snapshots...)
	return in
}

func holdsOf(t *testing.T, in Input, id string) Item {
	t.Helper()
	return mustFind(t, Build(in), id)
}

const featX = "branch:o/r@feat/x"

var deleteOnly = []item.Disposition{item.Delete}

func TestHoldDirtyWorktree(t *testing.T) {
	in := holdsInput(func(_ *Input, c *observe.Clone) {
		c.Worktrees = []observe.Worktree{{Path: "/r/.worktrees/ops", Branch: "feat/x", Dirty: true}}
	})
	it := holdsOf(t, in, featX)
	want := []Hold{{Kind: HoldWorktree, Text: "in use by worktree ops on work, which has uncommitted changes",
		Fix: "Commit or discard its changes, then decide that worktree Remove it.", By: "worktree:work:/r/.worktrees/ops",
		Stops: deleteOnly, Local: true, Machine: "work"}}
	if !reflect.DeepEqual(it.Holds, want) {
		t.Errorf("holds %+v\nwant %+v", it.Holds, want)
	}
	if it.Stopped(item.Delete) {
		t.Error("a local hold stops the whole decision")
	}
}

func TestCleanWorktreeDecidedRemoveIsNeededNotAHold(t *testing.T) {
	in := holdsInput(func(in *Input, c *observe.Clone) {
		c.Worktrees = []observe.Worktree{{Path: "/r/.worktrees/faqux", Branch: "feat/x"}}
		decide(*in, "worktree:work:/r/.worktrees/faqux", item.Delete, "")
	})
	it := holdsOf(t, in, featX)
	if len(it.Holds) != 0 || !reflect.DeepEqual(it.Needs, []string{"worktree:work:/r/.worktrees/faqux"}) {
		t.Errorf("holds %+v needs %v", it.Holds, it.Needs)
	}
}

func TestUndecidedCleanWorktreeHolds(t *testing.T) {
	in := holdsInput(func(_ *Input, c *observe.Clone) {
		c.Worktrees = []observe.Worktree{{Path: "/r/.worktrees/faqux", Branch: "feat/x"}}
	})
	it := holdsOf(t, in, featX)
	if len(it.Holds) != 1 || it.Holds[0].Text != "in use by worktree faqux on work" ||
		it.Holds[0].Fix != "Decide that worktree Remove it and review removes it first, then deletes this branch." || len(it.Needs) != 0 {
		t.Errorf("holds %+v needs %v", it.Holds, it.Needs)
	}
}

func TestHoldCheckedOutInClone(t *testing.T) {
	in := holdsInput(func(_ *Input, c *observe.Clone) {
		c.Branches = append(c.Branches, observe.Branch{Name: "runner", Tip: "r1"})
		c.Head = "runner"
	})
	it := holdsOf(t, in, "branch:o/r@runner")
	want := []Hold{{Kind: HoldCheckedOut, Text: "checked out in the clone itself (/r) on work", Fix: "Switch that clone to another branch.",
		Stops: deleteOnly, Local: true, Machine: "work"}}
	if !reflect.DeepEqual(it.Holds, want) {
		t.Errorf("holds %+v\nwant %+v", it.Holds, want)
	}
}

func TestHoldLongLived(t *testing.T) {
	in := holdsInput(func(_ *Input, c *observe.Clone) {
		c.Branches = append(c.Branches, observe.Branch{Name: "dev", Tip: "d1"})
	})
	it := holdsOf(t, in, "branch:o/r@dev")
	if len(it.Holds) != 1 || it.Holds[0].Kind != HoldLongLived || it.Holds[0].Local ||
		it.Holds[0].Text != "dev is a long-lived branch: casebook never deletes it" || it.Holds[0].Fix != "Decide it again: Keep it or Stop tracking it." {
		t.Fatalf("holds %+v", it.Holds)
	}
	if !it.Stopped(item.Delete) {
		t.Error("long-lived does not stop delete")
	}
}

func TestHoldArchivedStopsCloseAndMerge(t *testing.T) {
	in := holdsInput(func(in *Input, _ *observe.Clone) {
		in.GitHub.Owners["o"].Repos = []observe.RepoObs{{Repo: "o/old", Archived: true,
			PRs: []observe.PRObs{{Repo: "o/old", Number: 3, State: "OPEN", Author: "bob"}}}}
	})
	it := holdsOf(t, in, "pr:o/old#3")
	want := []Hold{{Kind: HoldArchived, Text: "o/old is archived: GitHub refuses any change to it", Fix: "Unarchive it on GitHub, or decide this again.",
		Stops: []item.Disposition{item.Close, item.Merge}}}
	if !reflect.DeepEqual(it.Holds, want) {
		t.Errorf("holds %+v\nwant %+v", it.Holds, want)
	}
	if !it.Stopped(item.Close) || !it.Stopped(item.Merge) || it.Stopped(item.Keep) {
		t.Error("Stopped wrong")
	}
}

func TestHoldMergeBlocked(t *testing.T) {
	for state, text := range map[string]string{
		"BEHIND":  "merge blocked: the PR is behind its base branch",
		"BLOCKED": "merge blocked: a required check or review is missing",
		"DIRTY":   "merge blocked: the PR has conflicts with its base branch",
		"CLEAN":   "", "UNKNOWN": "", "UNSTABLE": "", "HAS_HOOKS": "", "DRAFT": "", "": "",
	} {
		in := holdsInput(func(in *Input, _ *observe.Clone) {
			in.GitHub.Owners["o"].Repos[0].PRs = []observe.PRObs{{Repo: "o/r", Number: 9, State: "OPEN", MergeState: state}}
		})
		it := holdsOf(t, in, "pr:o/r#9")
		if text == "" {
			if len(it.Holds) != 0 {
				t.Errorf("%q: holds %+v", state, it.Holds)
			}
			continue
		}
		if len(it.Holds) != 1 || it.Holds[0].Kind != HoldMergeBlocked || it.Holds[0].Text != text ||
			!reflect.DeepEqual(it.Holds[0].Stops, []item.Disposition{item.Merge}) || !it.Stopped(item.Merge) || it.Stopped(item.Close) {
			t.Errorf("%q: holds %+v", state, it.Holds)
		}
	}
}

func TestHoldOtherMac(t *testing.T) {
	pro := observe.Snapshot{Version: 1, Machine: "pro-2", Clones: []observe.Clone{{Path: "/p", Repo: "o/r",
		Branches: []observe.Branch{{Name: "feat/only", Tip: "o1"}, {Name: "feat/x", Tip: "e46d896"}}}}}
	in := holdsInput(func(in *Input, _ *observe.Clone) { in.Snapshots = []observe.Snapshot{pro} })
	it := holdsOf(t, in, "branch:o/r@feat/only")
	want := []Hold{{Kind: HoldOtherMac, Text: "its local copy is only on pro-2", Fix: "Review it on pro-2: its local copy is deleted there.",
		Stops: deleteOnly, Local: true, Machine: "pro-2"}}
	if !reflect.DeepEqual(it.Holds, want) {
		t.Errorf("only on pro-2: holds %+v\nwant %+v", it.Holds, want)
	}
	if both := holdsOf(t, in, featX); len(both.Holds) != 0 {
		t.Errorf("on both: holds %+v", both.Holds)
	}
	in.Machine = ""
	if none := holdsOf(t, in, "branch:o/r@feat/only"); len(none.Holds) != 0 {
		t.Errorf("no machine: holds %+v", none.Holds)
	}
}

func TestHoldOpenPRStopsOnlyTheGitHubHalf(t *testing.T) {
	in := holdsInput(func(in *Input, _ *observe.Clone) {
		in.GitHub.Owners["o"].Repos[0].PRs = []observe.PRObs{{Repo: "o/r", Number: 12, State: "OPEN", HeadRef: "feat/x"}}
	})
	it := holdsOf(t, in, featX)
	want := []Hold{{Kind: HoldOpenPR, Text: "open PR #12 uses this branch: deleting it on GitHub closes that PR",
		Fix: "Merge or close PR #12 first, or decide this again.", By: "pr:o/r#12", Stops: deleteOnly, Remote: true}}
	if !reflect.DeepEqual(it.Holds, want) {
		t.Errorf("holds %+v\nwant %+v", it.Holds, want)
	}
	if it.Stopped(item.Delete) {
		t.Error("an open-pr hold stops the whole delete")
	}
}

// TestHoldOpenPRFromAForkIntoUpstream: a PR into upstream u/p from the
// fork c/p holds the fork's branch, not upstream's of the same name.
func TestHoldOpenPRFromAForkIntoUpstream(t *testing.T) {
	in := holdsInput(func(in *Input, c *observe.Clone) {
		c.Repo = "c/p"
		in.GitHub.Owners["u"] = &observe.Owner{Login: "u", Reachable: true, FetchedAt: now, Repos: []observe.RepoObs{{Repo: "u/p", DefaultBranch: "main",
			PRs: []observe.PRObs{{Repo: "u/p", Number: 7, State: "OPEN", HeadRef: "feat/x", HeadRepo: "c/p"}}}}}
	})
	it := holdsOf(t, in, "branch:c/p@feat/x")
	want := []Hold{{Kind: HoldOpenPR, Text: "open PR #7 uses this branch: deleting it on GitHub closes that PR",
		Fix: "Merge or close PR #7 first, or decide this again.", By: "pr:u/p#7", Stops: deleteOnly, Remote: true}}
	if !reflect.DeepEqual(it.Holds, want) {
		t.Errorf("holds %+v\nwant %+v", it.Holds, want)
	}
}

func TestCopiesSayWhereItIs(t *testing.T) {
	pro := observe.Snapshot{Version: 1, Machine: "pro-2", Clones: []observe.Clone{{Path: "/p", Repo: "o/r"}}}
	in := holdsInput(func(in *Input, c *observe.Clone) {
		in.Snapshots = []observe.Snapshot{pro}
		c.Branches[1].LandedState, c.Branches[1].Landed, c.Branches[1].LandedTip, c.Branches[1].LandedHow = "yes", "merged #107", "e46d896", "merged-pr"
		c.Worktrees = []observe.Worktree{{Path: "/r/.worktrees/faqux", Branch: "feat/x", Dirty: true}}
		in.GitHub.Refs[featX] = observe.Ref{Exists: true, Tip: "e46d896", RepoID: "R_1"}
	})
	it := holdsOf(t, in, featX)
	want := []Copy{
		{Machine: "pro-2", Absent: true},
		{Machine: "work", Path: "/r", Tip: "e46d896", Worktree: "/r/.worktrees/faqux"},
		{Tip: "e46d896", Landed: "merged #107", RepoID: "R_1"},
	}
	if !reflect.DeepEqual(it.Copies, want) {
		t.Errorf("copies %+v\nwant %+v", it.Copies, want)
	}
	if c, ok := it.GitHubCopy(); !ok || c.Tip != "e46d896" {
		t.Errorf("GitHubCopy %+v %v", c, ok)
	}
}

func TestCopiesGitHubFromTheSnapshotsRemoteTip(t *testing.T) {
	in := holdsInput(func(_ *Input, c *observe.Clone) {
		c.Branches[1].Upstream, c.Branches[1].RemoteTip = "origin/feat/x", "rt1"
	})
	it := holdsOf(t, in, featX)
	if gc := it.Copies[len(it.Copies)-1]; gc != (Copy{Tip: "rt1"}) {
		t.Errorf("github copy %+v", gc)
	}
	in.GitHub.Refs[featX] = observe.Ref{Exists: false}
	it = holdsOf(t, in, featX)
	if gc := it.Copies[len(it.Copies)-1]; gc != (Copy{Absent: true}) {
		t.Errorf("github copy looked up gone %+v", gc)
	}
	if _, ok := it.GitHubCopy(); ok {
		t.Error("GitHubCopy of an absent copy")
	}
}
