package engine

import (
	"testing"

	"github.com/subaud-tools/casebook/internal/casebook/item"
)

// TestFieldsWorktreeAndRelation: a worktree item reports its own worktree
// state, a branch its worktree's; a repo's relation is empty for matching
// (repos are matched with ownership), while the item keeps its Relation.
func TestFieldsWorktreeAndRelation(t *testing.T) {
	r := Build(fixture())
	if got := mustFind(t, r, "worktree:mbp:/w/hail-client").Fields(now).Worktree; got != "dirty" {
		t.Errorf("dirty worktree item: worktree = %q, want dirty", got)
	}
	if got := mustFind(t, r, "branch:schuettc/hail@feat/client").Fields(now).Worktree; got != "dirty" {
		t.Errorf("branch with a dirty worktree: worktree = %q, want dirty", got)
	}
	if got := mustFind(t, r, "branch:schuettc/hail@fix/landed").Fields(now).Worktree; got != "none" {
		t.Errorf("branch with no worktree: worktree = %q, want none", got)
	}
	in := fixture()
	in.Snapshots[0].Clones[0].Worktrees[0].Dirty = false
	if got := mustFind(t, Build(in), "worktree:mbp:/w/hail-client").Fields(now).Worktree; got != "clean" {
		t.Errorf("clean worktree item: worktree = %q, want clean", got)
	}
	fork := mustFind(t, r, "repo:schuettc/pi-usage")
	if f := fork.Fields(now); f.Relation != "" || f.Ownership != "fork" {
		t.Errorf("fork repo fields: relation %q ownership %q, want empty and fork", f.Relation, f.Ownership)
	}
	if fork.Relation == "" {
		t.Error("the repo item itself should keep its relation")
	}
	if got := mustFind(t, r, "pr:schuettc/hail#3").Fields(now).Relation; got != "incoming" {
		t.Errorf("incoming PR relation = %q", got)
	}
}

// TestOwnership: a repo's relation gives its ownership (yours, an org's, a
// fork); a repo with no relation, and every other kind, has none.
func TestOwnership(t *testing.T) {
	for _, c := range []struct {
		kind     item.Kind
		relation string
		want     string
	}{
		{item.KindRepo, "owned", "yours"},
		{item.KindRepo, "org", "org"},
		{item.KindRepo, "fork-of:up/hail", "fork"},
		{item.KindRepo, "", ""},
		{item.KindPR, "own", ""},
	} {
		it := Item{ID: "x", Kind: c.kind, Repo: "a/b", Relation: c.relation}
		if got := it.Fields(now).Ownership; got != c.want {
			t.Errorf("%s with relation %q: ownership %q, want %q", c.kind, c.relation, got, c.want)
		}
	}
}
