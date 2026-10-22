package engine

import (
	"testing"

	"github.com/subaud-tools/casebook/internal/casebook/observe"
)

// adminOf is an item's admin as its fields say: "true", "false" or
// "unknown".
func adminOf(it Item) string {
	switch a := it.Fields(now).Admin; {
	case a == nil:
		return "unknown"
	case *a:
		return "true"
	default:
		return "false"
	}
}

// TestOwnAccountRepoIsAdmin: a repo under your own login is yours to
// administer whatever its listing says, and so is everything in it.
func TestOwnAccountRepoIsAdmin(t *testing.T) {
	in := fixture()
	in.GitHub.Owners["schuettc"].Repos[0].Admin = nil
	r := Build(in)
	for _, id := range []string{"repo:schuettc/hail", "pr:schuettc/hail#3", "issue:schuettc/hail#4"} {
		if got := adminOf(mustFind(t, r, id)); got != "true" {
			t.Errorf("%s: admin %s, want true", id, got)
		}
	}
	// With no known login, nothing is known to be yours.
	in = fixture()
	in.GitHub.User = ""
	if got := adminOf(mustFind(t, Build(in), "repo:schuettc/hail")); got != "unknown" {
		t.Errorf("no login: admin %s, want unknown", got)
	}
}

// TestBranchAndIssueAdminComeFromTheirRepo: a branch, a PR and an issue
// carry their repo's admin; a repo in no listing leaves it unknown.
func TestBranchAndIssueAdminComeFromTheirRepo(t *testing.T) {
	for _, c := range []struct {
		admin *bool
		want  string
	}{{ptr(true), "true"}, {ptr(false), "false"}, {nil, "unknown"}} {
		in := orgFixture()
		in.GitHub.Owners["ft"].Repos[0].Admin = c.admin
		in.GitHub.Owners["ft"].Repos[0].Issues = []observe.PRObs{{Repo: "ft/team", Number: 8, Author: "alice", State: "OPEN", CreatedAt: days(5), UpdatedAt: days(5)}}
		in.Snapshots = append(in.Snapshots, observe.Snapshot{Version: 1, Machine: "mini", Clones: []observe.Clone{{
			Path: "/c/team", Repo: "ft/team",
			Branches: []observe.Branch{{Name: "main", Tip: "a"}, {Name: "feat/z", Tip: "b"}},
		}}})
		r := Build(in)
		for _, id := range []string{"repo:ft/team", "pr:ft/team#7", "issue:ft/team#8", "branch:ft/team@feat/z"} {
			if got := adminOf(mustFind(t, r, id)); got != c.want {
				t.Errorf("listing admin %s: %s admin %s, want %s", c.want, id, got, c.want)
			}
		}
	}
	// An authored PR elsewhere: its repo is in no listing.
	if got := adminOf(mustFind(t, Build(fixture()), "pr:elidickinson/pi-claude-bridge#97")); got != "unknown" {
		t.Errorf("unlisted repo: admin %s, want unknown", got)
	}
	// A worktree has no admin.
	if got := adminOf(mustFind(t, Build(fixture()), "worktree:mbp:/w/hail-client")); got != "unknown" {
		t.Errorf("worktree: admin %s, want unknown", got)
	}
}
