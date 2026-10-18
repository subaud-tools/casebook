package serve

import (
	"strings"
	"testing"
)

type vocabChoice struct {
	Disposition string `json:"disposition"`
	Label       string `json:"label"`
	Says        string `json:"says"`
	Outward     bool   `json:"outward"`
	NeedsUntil  bool   `json:"needs_until"`
}

type vocabDone struct {
	Label    string `json:"label"`
	Done     string `json:"done"`
	DoneMany string `json:"done_many"`
}

type vocabKind struct {
	Kind     string        `json:"kind"`
	Allowed  []string      `json:"allowed"`
	Question string        `json:"question"`
	Choices  []vocabChoice `json:"choices"`
}

type vocabNotNow struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Template string `json:"template"`
	Asks     string `json:"asks"`
	Days     int    `json:"days"`
}

type vocabView struct {
	Kinds  []vocabKind   `json:"kinds"`
	NotNow []vocabNotNow `json:"not_now"`
}

// TestVocabularySaysWhatEachDid: each choice carries what it did, for one
// item and for several, as the page's strip shows them.
func TestVocabularySaysWhatEachDid(t *testing.T) {
	r := newRig(t)
	var v struct {
		Kinds []struct {
			Kind    string      `json:"kind"`
			Choices []vocabDone `json:"choices"`
		} `json:"kinds"`
	}
	if c := r.do(t, "GET", "/api/decisions/vocabulary", nil, &v); c != 200 {
		t.Fatalf("vocabulary %d", c)
	}
	n := 0
	for _, k := range v.Kinds {
		for _, ch := range k.Choices {
			n++
			if ch.Done == "" || !strings.Contains(ch.DoneMany, "{n}") {
				t.Errorf("%s %q: done %q, done_many %q", k.Kind, ch.Label, ch.Done, ch.DoneMany)
			}
			if k.Kind == "issue" && ch.Label == "Close it" && (ch.Done != "Closed it" || ch.DoneMany != "Closed {n}") {
				t.Errorf("issue close: %+v", ch)
			}
		}
	}
	if n == 0 {
		t.Fatal("no choices")
	}
}

func (r *rig) vocab(t *testing.T) vocabView {
	t.Helper()
	var v vocabView
	if c := r.do(t, "GET", "/api/decisions/vocabulary", nil, &v); c != 200 {
		t.Fatalf("vocabulary %d", c)
	}
	return v
}

const (
	saysKeep    = "Decides to keep it as it is. Nothing to run."
	saysNotNow  = "Hides it until a date or an event you pick. Nothing to run."
	saysIgnore  = "casebook stops asking about it. Nothing to run."
	saysLeaveOp = saysKeep
)

// TestVocabularyWordingPerKind pins the question and every choice's label
// and sentence per kind, in order: the page and the guide render only these.
func TestVocabularyWordingPerKind(t *testing.T) {
	r := newRig(t)
	v := r.vocab(t)
	type c = vocabChoice
	want := map[string]struct {
		q       string
		choices []c
	}{
		"pr": {"What should happen to this pull request?", []c{
			{"keep", "Leave it open", saysLeaveOp, false, false},
			{"merge", "Merge it", "Decides to merge this pull request. Nothing happens on GitHub until you run it in apply.", true, false},
			{"close", "Close it without merging", "Decides to close this pull request. Nothing happens on GitHub until you run it in apply.", true, false},
			{"wait", "Not now", saysNotNow, false, true},
			{"ignore", "Stop tracking it", saysIgnore, false, false},
		}},
		"issue": {"What should happen to this issue?", []c{
			{"keep", "Leave it open", saysLeaveOp, false, false},
			{"close", "Close it", "Decides to close this issue. Nothing happens on GitHub until you run it in apply.", true, false},
			{"wait", "Not now", saysNotNow, false, true},
			{"ignore", "Stop tracking it", saysIgnore, false, false},
		}},
		"branch": {"What should happen to this branch?", []c{
			{"keep", "Keep it", saysKeep, false, false},
			{"delete", "Delete it", "Decides to delete this branch. Nothing is deleted until you run it in apply.", true, false},
			{"wait", "Not now", saysNotNow, false, true},
			{"ignore", "Stop tracking it", saysIgnore, false, false},
		}},
		"worktree": {"What should happen to this worktree?", []c{
			{"keep", "Keep it", saysKeep, false, false},
			{"delete", "Remove it", "Decides to remove this worktree. Nothing is removed until you run it in apply.", true, false},
			{"wait", "Not now", saysNotNow, false, true},
			{"ignore", "Stop tracking it", saysIgnore, false, false},
		}},
		"repo": {"What should happen to this repository?", []c{
			{"keep", "Keep it", saysKeep, false, false},
			{"archive", "Archive it on GitHub", "Decides to archive this repository. Nothing happens on GitHub until you run it in apply.", true, false},
			{"delete", "Delete it", "Decides to delete this repository. Nothing happens on GitHub until you run it in apply.", true, false},
			{"wait", "Not now", saysNotNow, false, true},
			{"ignore", "Stop tracking it", saysIgnore, false, false},
		}},
	}
	if len(v.Kinds) != len(want) {
		t.Fatalf("kinds %d, want %d", len(v.Kinds), len(want))
	}
	for _, k := range v.Kinds {
		w, ok := want[k.Kind]
		if !ok {
			t.Errorf("unexpected kind %q", k.Kind)
			continue
		}
		if k.Question != w.q {
			t.Errorf("%s question %q, want %q", k.Kind, k.Question, w.q)
		}
		if len(k.Choices) != len(w.choices) {
			t.Errorf("%s choices %+v, want %+v", k.Kind, k.Choices, w.choices)
			continue
		}
		for i := range w.choices {
			if k.Choices[i] != w.choices[i] {
				t.Errorf("%s choice %d = %+v, want %+v", k.Kind, i, k.Choices[i], w.choices[i])
			}
		}
		// watch is read and accepted (Allowed) but never offered (Choices).
		for _, ch := range k.Choices {
			if ch.Disposition == "watch" {
				t.Errorf("%s offers watch", k.Kind)
			}
		}
		if k.Kind != "worktree" && !contains(k.Allowed, "watch") {
			t.Errorf("%s allowed %v lacks watch", k.Kind, k.Allowed)
		}
	}
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

// TestVocabularyOutwardFlags: a choice is outward exactly when it changes
// something outside casebook (it goes to To apply).
func TestVocabularyOutwardFlags(t *testing.T) {
	r := newRig(t)
	outward := map[string]bool{"merge": true, "close": true, "archive": true, "delete": true}
	n := 0
	for _, k := range r.vocab(t).Kinds {
		for _, ch := range k.Choices {
			n++
			if ch.Outward != outward[ch.Disposition] {
				t.Errorf("%s %s outward=%v", k.Kind, ch.Disposition, ch.Outward)
			}
		}
	}
	if n == 0 {
		t.Fatal("no choices")
	}
}

// TestVocabularyNotNowForms: the seven Not now conditions, in order, as
// the endpoint serves them.
func TestVocabularyNotNowForms(t *testing.T) {
	r := newRig(t)
	want := []vocabNotNow{
		{"in-1w", "in 1 week", "date(%s)", "days", 7},
		{"in-1m", "in 1 month", "date(%s)", "days", 30},
		{"on-date", "on a date…", "date(%s)", "date", 0},
		{"pr-merges", "when a PR merges…", "merged(%s)", "pr", 0},
		{"closes", "when a PR or issue closes…", "closed(%s)", "pr-or-issue", 0},
		{"quiet-90", "when it goes quiet for 90 days", "inactive(90d)", "", 0},
		{"release", "when a repo releases…", "released(%s)", "repo", 0},
	}
	got := r.vocab(t).NotNow
	if len(got) != len(want) {
		t.Fatalf("not_now %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("not_now[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
}

// TestVocabularyWaitingStrip: the strip after an outward decision and the
// item page's came-back fact are serve's words.
func TestVocabularyWaitingStrip(t *testing.T) {
	r := newRig(t)
	var v struct {
		Waiting struct {
			Text  string `json:"text"`
			Apply string `json:"apply"`
			Undo  string `json:"undo"`
		} `json:"waiting"`
		CameBackFact string `json:"came_back_fact"`
	}
	if c := r.do(t, "GET", "/api/decisions/vocabulary", nil, &v); c != 200 {
		t.Fatalf("vocabulary %d", c)
	}
	if v.Waiting.Text != "{done} \u00b7 waiting in {apply} \u00b7 {undo}" || v.Waiting.Apply != "apply" || v.Waiting.Undo != "undo" {
		t.Errorf("waiting %+v", v.Waiting)
	}
	if v.CameBackFact != "came back \u00b7 {reason}" {
		t.Errorf("came_back_fact %q", v.CameBackFact)
	}
}

// TestVocabularyNamesEachKind: each kind's nouns, one and several, the
// words apply's group labels count in ("Delete 3 branches").
func TestVocabularyNamesEachKind(t *testing.T) {
	r := newRig(t)
	var v struct {
		Kinds []struct {
			Kind  string `json:"kind"`
			Noun  string `json:"noun"`
			Nouns string `json:"nouns"`
		} `json:"kinds"`
	}
	if c := r.do(t, "GET", "/api/decisions/vocabulary", nil, &v); c != 200 {
		t.Fatalf("vocabulary %d", c)
	}
	want := map[string]string{"repo": "repo/repos", "pr": "PR/PRs", "issue": "issue/issues", "branch": "branch/branches", "worktree": "worktree/worktrees"}
	for _, k := range v.Kinds {
		if got := k.Noun + "/" + k.Nouns; got != want[k.Kind] {
			t.Errorf("%s nouns %q, want %q", k.Kind, got, want[k.Kind])
		}
	}
	if len(v.Kinds) != len(want) {
		t.Errorf("%d kinds", len(v.Kinds))
	}
}
