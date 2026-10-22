package rules

import (
	"slices"
	"testing"

	"github.com/subaud-tools/casebook/internal/casebook/engine"
	"github.com/subaud-tools/casebook/internal/casebook/item"
)

func boolPtr(v bool) *bool { return &v }

// adminMatches returns the keys of items the single condition admin op
// value matches, in order.
func adminMatches(t *testing.T, items []engine.Item, op, value string) []string {
	t.Helper()
	r := Rule{ID: "x", Match: []Condition{{Field: "admin", Op: op, Value: value}}}
	if err := ValidateConditions(r.Match); err != nil {
		t.Fatal(err)
	}
	ms, err := r.MatchAll(engine.Result{Items: items}, testNow)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, m := range ms {
		got = append(got, m.Key)
	}
	return got
}

var adminOps = []struct{ op, value string }{
	{"is", "true"}, {"is", "false"}, {"is-not", "true"}, {"is-not", "false"},
}

func TestAdminFieldMatchesKnownAdmin(t *testing.T) {
	it := engine.Item{ID: "pr:o/r#1", Kind: item.KindPR, Repo: "o/r", Admin: boolPtr(true)}
	want := map[string]bool{"is true": true, "is false": false, "is-not true": false, "is-not false": true}
	for _, c := range adminOps {
		got := len(adminMatches(t, []engine.Item{it}, c.op, c.value)) == 1
		if w := want[c.op+" "+c.value]; got != w {
			t.Errorf("admin %s %s on a known admin: matched %v, want %v", c.op, c.value, got, w)
		}
	}
}

func TestAdminFieldMatchesKnownNotAdmin(t *testing.T) {
	it := engine.Item{ID: "pr:o/r#1", Kind: item.KindPR, Repo: "o/r", Admin: boolPtr(false)}
	want := map[string]bool{"is true": false, "is false": true, "is-not true": true, "is-not false": false}
	for _, c := range adminOps {
		got := len(adminMatches(t, []engine.Item{it}, c.op, c.value)) == 1
		if w := want[c.op+" "+c.value]; got != w {
			t.Errorf("admin %s %s on a known non-admin: matched %v, want %v", c.op, c.value, got, w)
		}
	}
}

// TestAdminFieldUnknownMatchesNeither: not knowing never satisfies an admin
// condition either way, so no rule acts on a guess.
func TestAdminFieldUnknownMatchesNeither(t *testing.T) {
	items := []engine.Item{
		{ID: "branch:o/r:x", Kind: item.KindBranch, Repo: "o/r"},
		{ID: "issue:o/r#2", Kind: item.KindIssue, Repo: "o/r"},
		{ID: "repo:o/r", Kind: item.KindRepo, Repo: "o/r"},
	}
	for _, c := range adminOps {
		if got := adminMatches(t, items, c.op, c.value); len(got) != 0 {
			t.Errorf("admin %s %s on unknown admin matched %v", c.op, c.value, got)
		}
	}
}

func TestAdminFieldVocabulary(t *testing.T) {
	f, ok := vocabIndex["admin"]
	if !ok {
		t.Fatal("no admin field")
	}
	if f.Type != FieldTypeBool || !slices.Equal(f.Ops, boolOps) || f.Help != "you're an admin of its repo" ||
		!slices.Equal(f.Kinds, []string{"pr", "issue", "branch", "repo"}) {
		t.Errorf("admin field %+v", f)
	}
	if err := ValidateCondition(Condition{Field: "admin", Op: "in", Value: "true"}); err == nil {
		t.Error("admin in true was accepted")
	}
	if err := ValidateConditions([]Condition{{Field: "kind", Op: "is", Value: "worktree"}, {Field: "admin", Op: "is", Value: "true"}}); err == nil {
		t.Error("admin on worktrees was accepted")
	}
}
