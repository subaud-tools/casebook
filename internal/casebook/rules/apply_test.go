package rules

import (
	"context"
	"path/filepath"
	"slices"
	"sort"
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/db"
	"github.com/subaud-tools/casebook/internal/casebook/engine"
	"github.com/subaud-tools/casebook/internal/casebook/item"
	"github.com/subaud-tools/casebook/internal/casebook/propose"
)

// applyTestNow is the fixed reference time used across apply tests.
var applyTestNow = time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)

// applyDB opens a fresh in-memory-style database and registers cleanup.
func applyDB(t *testing.T) *db.DB {
	t.Helper()
	d, err := db.Open(context.Background(), filepath.Join(t.TempDir(), "casebook.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}

// applyStore returns a propose.Store whose clock is pinned to applyTestNow.
func applyStore(d *db.DB) *propose.Store {
	s := propose.New(d)
	s.Now = func() time.Time { return applyTestNow }
	return s
}

// activeRule returns a minimal active rule that matches all items of kind repo.
func activeRepoRule(id string) Rule {
	return Rule{
		ID:       id,
		Name:     "Test: " + id,
		Status:   StatusActive,
		EditedAt: applyTestNow.Add(-24 * time.Hour),
		Match: []Condition{
			{Field: "kind", Op: "is", Value: "repo"},
		},
		Propose: RuleAction{Disposition: "archive"},
	}
}

// repoItem builds a minimal undecided repo item for the result.
func repoItem(key string) engine.Item {
	return engine.Item{
		ID:   key,
		Kind: item.KindRepo,
		Repo: "schuettc/hail",
	}
}

// buildResult returns a Result with items sorted by ID (Find requires sorted items).
func buildResult(items ...engine.Item) engine.Result {
	sorted := make([]engine.Item, len(items))
	copy(sorted, items)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].ID < sorted[j].ID })
	return engine.Result{Items: sorted}
}

// TestActiveRuleProposesMatchesOnRebuild checks that EvaluateActive (the
// "rebuild" step) creates pending proposals sourced "rule:<id>" for every item
// an active rule matches.
func TestActiveRuleProposesMatchesOnRebuild(t *testing.T) {
	ctx := context.Background()
	d := applyDB(t)
	s := applyStore(d)

	r := activeRepoRule("archive-repos")
	res := buildResult(
		repoItem("repo:schuettc/hail"),
		repoItem("repo:schuettc/old"),
	)

	createdPs, err := EvaluateActive(ctx, []Rule{r}, res, applyTestNow, s)
	created := len(createdPs)
	if err != nil {
		t.Fatalf("EvaluateActive: %v", err)
	}
	if created != 2 {
		t.Fatalf("created = %d, want 2", created)
	}

	pending, err := s.Pending(ctx)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	for _, key := range []string{"repo:schuettc/hail", "repo:schuettc/old"} {
		p, ok := pending[key]
		if !ok {
			t.Errorf("no pending proposal for %s", key)
			continue
		}
		if p.Source != "rule:archive-repos" {
			t.Errorf("proposal for %s source = %q, want rule:archive-repos", key, p.Source)
		}
		if p.Disposition != "archive" {
			t.Errorf("proposal for %s disposition = %q, want archive", key, p.Disposition)
		}
	}
}

// TestActiveRuleReProposesNewMatchAfterSync verifies that a second call to
// EvaluateActive (simulating a new HEAD after a sync) proposes newly matched
// items without re-proposing items that already have a pending proposal.
func TestActiveRuleReProposesNewMatchAfterSync(t *testing.T) {
	ctx := context.Background()
	d := applyDB(t)
	s := applyStore(d)

	r := activeRepoRule("archive-repos")

	// First rebuild: one item.
	res1 := buildResult(repoItem("repo:schuettc/hail"))
	created1Ps, err := EvaluateActive(ctx, []Rule{r}, res1, applyTestNow, s)
	created1 := len(created1Ps)
	if err != nil || created1 != 1 {
		t.Fatalf("first EvaluateActive: created=%d err=%v", created1, err)
	}

	// Second rebuild (after sync): original item plus a newly appeared one.
	res2 := buildResult(
		repoItem("repo:schuettc/hail"),
		repoItem("repo:schuettc/old"),
	)
	created2Ps, err := EvaluateActive(ctx, []Rule{r}, res2, applyTestNow, s)
	created2 := len(created2Ps)
	if err != nil {
		t.Fatalf("second EvaluateActive: %v", err)
	}
	if created2 != 1 {
		t.Fatalf("second created = %d, want 1 (only the new item)", created2)
	}

	// Both items must have a pending proposal.
	pending, _ := s.Pending(ctx)
	for _, key := range []string{"repo:schuettc/hail", "repo:schuettc/old"} {
		if _, ok := pending[key]; !ok {
			t.Errorf("no pending proposal for %s after two rebuilds", key)
		}
	}
}

// TestDraftRuleProposesNothingUntilProposeOnce confirms that a draft rule is
// ignored by EvaluateActive (no proposals), while ProposeOnce creates them.
func TestDraftRuleProposesNothingUntilProposeOnce(t *testing.T) {
	ctx := context.Background()
	d := applyDB(t)
	s := applyStore(d)

	draft := Rule{
		ID:       "draft-rule",
		Name:     "Draft rule",
		Status:   StatusDraft,
		EditedAt: applyTestNow.Add(-24 * time.Hour),
		Match: []Condition{
			{Field: "kind", Op: "is", Value: "repo"},
		},
		Propose: RuleAction{Disposition: "archive"},
	}
	res := buildResult(repoItem("repo:schuettc/hail"))

	// EvaluateActive ignores draft rules (caller pre-filters; passing draft
	// directly verifies the defensive skip inside EvaluateActive).
	createdPs, err := EvaluateActive(ctx, []Rule{draft}, res, applyTestNow, s)
	created := len(createdPs)
	if err != nil {
		t.Fatalf("EvaluateActive: %v", err)
	}
	if created != 0 {
		t.Errorf("EvaluateActive with draft rule: created = %d, want 0", created)
	}

	pending, _ := s.Pending(ctx)
	if len(pending) != 0 {
		t.Errorf("pending after EvaluateActive with draft: %d proposals, want 0", len(pending))
	}

	// ProposeOnce works on a draft rule.
	proposals, n, propErr := ProposeOnce(ctx, draft, res, applyTestNow, s)
	if propErr != nil {
		t.Fatalf("ProposeOnce: %v", propErr)
	}
	if n != 1 {
		t.Fatalf("ProposeOnce: created = %d, want 1", n)
	}
	if len(proposals) != 1 {
		t.Fatalf("ProposeOnce: returned %d proposals, want 1", len(proposals))
	}

	pending, _ = s.Pending(ctx)
	if _, ok := pending["repo:schuettc/hail"]; !ok {
		t.Error("no pending proposal after ProposeOnce")
	}
}

// TestRuleNeverReProposesAfterAccept verifies that once an item has a decision
// (the user accepted the proposal and the item is now decided in the result),
// EvaluateActive does not generate a new proposal for it.
func TestRuleNeverReProposesAfterAccept(t *testing.T) {
	ctx := context.Background()
	d := applyDB(t)
	s := applyStore(d)

	r := activeRepoRule("archive-repos")

	// First rebuild: item is undecided.
	res1 := buildResult(repoItem("repo:schuettc/hail"))
	if _, err := EvaluateActive(ctx, []Rule{r}, res1, applyTestNow, s); err != nil {
		t.Fatalf("first EvaluateActive: %v", err)
	}

	// Court accepts the proposal → the item now has a Decision in the result.
	dec := item.Decision{Disposition: item.Archive, DecidedBy: "court", DecidedAt: applyTestNow}
	decided := engine.Item{
		ID:       "repo:schuettc/hail",
		Kind:     item.KindRepo,
		Repo:     "schuettc/hail",
		Decision: &dec,
	}
	res2 := buildResult(decided)

	// Second rebuild: item is decided, so Proposable should skip it.
	createdPs, err := EvaluateActive(ctx, []Rule{r}, res2, applyTestNow, s)
	created := len(createdPs)
	if err != nil {
		t.Fatalf("second EvaluateActive: %v", err)
	}
	if created != 0 {
		t.Errorf("second EvaluateActive: created = %d, want 0 (item is decided)", created)
	}
}

// TestEvaluateActivePerItemNote verifies that the note is rendered per item,
// using each item's own fields (e.g. {repo} expands to that item's repo).
func TestEvaluateActivePerItemNote(t *testing.T) {
	ctx := context.Background()
	d := applyDB(t)
	s := applyStore(d)

	r := Rule{
		ID:       "repo-note",
		Name:     "Per-item note test",
		Status:   StatusActive,
		EditedAt: applyTestNow.Add(-24 * time.Hour),
		Match: []Condition{
			{Field: "kind", Op: "is", Value: "repo"},
		},
		Propose: RuleAction{Disposition: "archive", Note: "archiving {repo}"},
	}
	items := []engine.Item{
		{ID: "repo:schuettc/alpha", Kind: item.KindRepo, Repo: "schuettc/alpha"},
		{ID: "repo:schuettc/beta", Kind: item.KindRepo, Repo: "schuettc/beta"},
	}
	res := buildResult(items...)

	if _, err := EvaluateActive(ctx, []Rule{r}, res, applyTestNow, s); err != nil {
		t.Fatalf("EvaluateActive: %v", err)
	}

	pending, _ := s.Pending(ctx)
	wantNotes := map[string]string{
		"repo:schuettc/alpha": "archiving schuettc/alpha",
		"repo:schuettc/beta":  "archiving schuettc/beta",
	}
	for key, want := range wantNotes {
		p, ok := pending[key]
		if !ok {
			t.Errorf("no pending proposal for %s", key)
			continue
		}
		if p.Note != want {
			t.Errorf("proposal for %s note = %q, want %q", key, p.Note, want)
		}
	}
}

// TestEvaluateActiveReturnsErrorOnProposeFailure verifies that when
// props.Propose returns errors (e.g. invalid disposition that passes rule
// status check but fails Propose's own item.Decision.Validate), EvaluateActive
// surfaces those errors rather than silently discarding them.
// Before fix: EvaluateActive discards the []error from Propose ("ps, _") →
// returns (0, nil); test FAILS. After fix: returns a non-nil error → PASS.
func TestEvaluateActiveReturnsErrorOnProposeFailure(t *testing.T) {
	ctx := context.Background()
	d := applyDB(t)
	s := applyStore(d)

	// Build a rule whose disposition is intentionally invalid. We do NOT call
	// r.Validate() here (EvaluateActive doesn't validate either), so the rule
	// passes the StatusActive check and reaches props.Propose, which then
	// fails its own item.Decision.Validate → returns []error.
	r := Rule{
		ID:       "bad-disp-rule",
		Name:     "Bad Disposition",
		Status:   StatusActive,
		EditedAt: applyTestNow.Add(-24 * time.Hour),
		Match:    []Condition{{Field: "kind", Op: "is", Value: "repo"}},
		Propose:  RuleAction{Disposition: "not-a-real-disposition"},
	}
	res := buildResult(repoItem("repo:schuettc/hail"))

	_, err := EvaluateActive(ctx, []Rule{r}, res, applyTestNow, s)
	if err == nil {
		t.Fatal("EvaluateActive: expected non-nil error when Propose fails (invalid disposition), got nil — Propose errors are being silently discarded")
	}
}

// TestProposeOnceReturnsErrorOnProposeFailure is the ProposeOnce equivalent:
// when the disposition is invalid, ProposeOnce must return the Propose error.
func TestProposeOnceReturnsErrorOnProposeFailure(t *testing.T) {
	ctx := context.Background()
	d := applyDB(t)
	s := applyStore(d)

	r := Rule{
		ID:       "bad-disp-once",
		Name:     "Bad Disposition Once",
		Status:   StatusDraft,
		EditedAt: applyTestNow.Add(-24 * time.Hour),
		Match:    []Condition{{Field: "kind", Op: "is", Value: "repo"}},
		Propose:  RuleAction{Disposition: "not-a-real-disposition"},
	}
	res := buildResult(repoItem("repo:schuettc/hail"))

	_, _, err := ProposeOnce(ctx, r, res, applyTestNow, s)
	if err == nil {
		t.Fatal("ProposeOnce: expected non-nil error when Propose fails (invalid disposition), got nil — Propose errors are being silently discarded")
	}
}

func TestStaleWithdrawsARecommendationAHoldStops(t *testing.T) {
	closeAll := Rule{ID: "close-prs", Status: StatusActive, Match: []Condition{{Field: "kind", Op: "is", Value: "pr"}}, Propose: RuleAction{Disposition: "close"}}
	res := engine.Result{Items: []engine.Item{
		{ID: "pr:o/old#3", Kind: item.KindPR, Holds: []engine.Hold{archivedHold}},
		{ID: "pr:o/r#4", Kind: item.KindPR},
	}}
	pending := []propose.Proposal{
		{ID: 7, Key: "pr:o/old#3", Disposition: "close", Source: "rule:close-prs", State: propose.Pending},
		{ID: 8, Key: "pr:o/r#4", Disposition: "close", Source: "rule:close-prs", State: propose.Pending},
	}
	if got := Stale([]Rule{closeAll}, res, testNow, pending); !slices.Equal(got, []int64{7}) {
		t.Errorf("stale %v, want [7]", got)
	}
}

// TestTwoRulesOnOneItemDoNotFlip checks that when two active rules match one
// item, the first recommendation stays across passes: neither replaces the
// other's, so the item keeps one pending proposal and nothing is superseded.
func TestTwoRulesOnOneItemDoNotFlip(t *testing.T) {
	ctx := context.Background()
	s := applyStore(applyDB(t))

	a := activeRepoRule("archive-repos")
	b := activeRepoRule("ignore-repos")
	b.Propose = RuleAction{Disposition: "ignore"}
	res := buildResult(repoItem("repo:schuettc/hail"))

	var first int64
	for pass := range 3 {
		if _, err := EvaluateActive(ctx, []Rule{a, b}, res, applyTestNow, s); err != nil {
			t.Fatalf("pass %d: %v", pass, err)
		}
		// The second rule, on its own, must not replace the first's either.
		if _, err := EvaluateActive(ctx, []Rule{b}, res, applyTestNow, s); err != nil {
			t.Fatalf("pass %d (b alone): %v", pass, err)
		}
		pending, err := s.Pending(ctx)
		if err != nil {
			t.Fatal(err)
		}
		p, ok := pending["repo:schuettc/hail"]
		if !ok {
			t.Fatalf("pass %d: no pending proposal", pass)
		}
		if pass == 0 {
			first = p.ID
		} else if p.ID != first {
			t.Fatalf("pass %d: pending id %d, want %d (it flipped)", pass, p.ID, first)
		}
	}
	all, err := s.ForKey(ctx, "repo:schuettc/hail")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 {
		t.Fatalf("proposals for the item = %d, want 1: %+v", len(all), all)
	}
	if all[0].Source != "rule:archive-repos" {
		t.Errorf("source = %q, want rule:archive-repos", all[0].Source)
	}
}

// TestARuleDoesNotReplaceAnAgentProposal checks that a rule leaves an
// agent's pending recommendation in place, both on a rebuild and when
// proposing once.
func TestARuleDoesNotReplaceAnAgentProposal(t *testing.T) {
	ctx := context.Background()
	s := applyStore(applyDB(t))

	ps, errs := s.Propose(ctx, "session:agent", []string{"repo:schuettc/hail"}, "keep", "", "agent says keep")
	if len(errs) > 0 || len(ps) != 1 {
		t.Fatalf("agent propose: %v %v", ps, errs)
	}
	r := activeRepoRule("archive-repos")
	res := buildResult(repoItem("repo:schuettc/hail"))
	if created, err := EvaluateActive(ctx, []Rule{r}, res, applyTestNow, s); err != nil || len(created) != 0 {
		t.Fatalf("EvaluateActive created %d, err %v; want 0", len(created), err)
	}
	if _, n, err := ProposeOnce(ctx, r, res, applyTestNow, s); err != nil || n != 0 {
		t.Fatalf("ProposeOnce created %d, err %v; want 0", n, err)
	}
	pending, _ := s.Pending(ctx)
	if p := pending["repo:schuettc/hail"]; p.ID != ps[0].ID || p.Source != "session:agent" {
		t.Errorf("pending = %+v, want the agent's proposal %d", p, ps[0].ID)
	}
}

// TestWhenTheFirstRuleStopsMatchingTheSecondProposes checks the hand-over:
// rule A's recommendation stays while A matches; once A stops matching,
// Stale withdraws it and the next pass lets rule B propose.
func TestWhenTheFirstRuleStopsMatchingTheSecondProposes(t *testing.T) {
	ctx := context.Background()
	s := applyStore(applyDB(t))

	a := activeRepoRule("archive-hail")
	a.Match = append(a.Match, Condition{Field: "repo", Op: "is", Value: "schuettc/hail"})
	b := activeRepoRule("ignore-repos")
	b.Propose = RuleAction{Disposition: "ignore"}
	key := "repo:schuettc/hail"
	res := buildResult(repoItem(key))

	if _, err := EvaluateActive(ctx, []Rule{a, b}, res, applyTestNow, s); err != nil {
		t.Fatal(err)
	}
	if p, _ := s.Pending(ctx); p[key].Source != "rule:archive-hail" {
		t.Fatalf("pending source = %q, want rule:archive-hail (A matched first)", p[key].Source)
	}
	fromRules, _ := s.PendingFromRules(ctx)
	if stale := Stale([]Rule{a, b}, res, applyTestNow, fromRules); len(stale) != 0 {
		t.Fatalf("stale while A still matches: %v", stale)
	}

	// A stops matching: the item now lives in another repo.
	moved := repoItem(key)
	moved.Repo = "schuettc/other"
	res2 := buildResult(moved)
	fromRules, _ = s.PendingFromRules(ctx)
	stale := Stale([]Rule{a, b}, res2, applyTestNow, fromRules)
	if len(stale) != 1 {
		t.Fatalf("stale = %v, want A's one proposal", stale)
	}
	if _, err := s.WithdrawRuleProposals(ctx, stale); err != nil {
		t.Fatal(err)
	}
	if _, err := EvaluateActive(ctx, []Rule{a, b}, res2, applyTestNow, s); err != nil {
		t.Fatal(err)
	}
	pending, _ := s.Pending(ctx)
	if p := pending[key]; p.Source != "rule:ignore-repos" {
		t.Errorf("pending source = %q, want rule:ignore-repos", p.Source)
	}
}
