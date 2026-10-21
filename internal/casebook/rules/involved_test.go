package rules

import (
	"slices"
	"sort"
	"testing"

	"github.com/subaud-tools/casebook/internal/casebook/engine"
	"github.com/subaud-tools/casebook/internal/casebook/item"
)

// TestReviewRequestedAndAssignedMatch: review-requested picks the PRs you're
// asked to review, assigned the PRs and issues assigned to you.
func TestReviewRequestedAndAssignedMatch(t *testing.T) {
	asked := engine.Item{ID: "pr:o/r#1", Kind: item.KindPR, Repo: "o/r", ReviewRequested: true}
	mine := engine.Item{ID: "issue:o/r#2", Kind: item.KindIssue, Repo: "o/r", Assigned: true}
	both := engine.Item{ID: "pr:o/r#3", Kind: item.KindPR, Repo: "o/r", ReviewRequested: true, Assigned: true}
	other := engine.Item{ID: "pr:o/r#4", Kind: item.KindPR, Repo: "o/r"}
	res := engine.Result{Items: []engine.Item{asked, mine, both, other}}
	for _, c := range []struct {
		field, op, value string
		want             []string
	}{
		{"review-requested", "is", "true", []string{asked.ID, both.ID}},
		{"review-requested", "is", "false", []string{mine.ID, other.ID}},
		{"review-requested", "is-not", "true", []string{mine.ID, other.ID}},
		{"assigned", "is", "true", []string{mine.ID, both.ID}},
		{"assigned", "is", "false", []string{asked.ID, other.ID}},
		{"assigned", "is-not", "false", []string{mine.ID, both.ID}},
	} {
		r := Rule{ID: "x", Match: []Condition{{Field: c.field, Op: c.op, Value: c.value}}}
		if err := ValidateConditions(r.Match); err != nil {
			t.Fatal(err)
		}
		ms, err := r.MatchAll(res, testNow)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, m := range ms {
			got = append(got, m.Key)
		}
		sort.Strings(got)
		want := slices.Clone(c.want)
		sort.Strings(want)
		if !slices.Equal(got, want) {
			t.Errorf("%s %s %s matched %v, want %v", c.field, c.op, c.value, got, want)
		}
	}
	if err := ValidateCondition(Condition{Field: "assigned", Op: "is", Value: "yes"}); err == nil {
		t.Error("assigned is yes was accepted")
	}
}
