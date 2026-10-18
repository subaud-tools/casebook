package deliver

import (
	"strings"
	"testing"
	"time"
)

// Court asks from the list with nothing open or ticked ("ask agent to
// suggest rules"): the message carries the list as it is narrowed (its
// filters, rule, search and group), not thousands of keys, and the agent
// reads it in the words casebook_attention takes.
func TestAttachedListReachesTheAgent(t *testing.T) {
	q, _ := newQueue(t)
	th := thread(t, q, "s1")
	a := Attached{List: &AttachedList{Filters: []string{"a", "b"}, Rule: "x", Q: "q", Group: "none"}}
	if a.Empty() {
		t.Fatal("an attached list counts as nothing attached")
	}
	if (Attached{List: &AttachedList{}}).Empty() {
		t.Fatal("the whole list, not narrowed, counts as nothing attached")
	}
	if _, err := q.Post(ctx, th.ID, "suggest rules for these", a, false); err != nil {
		t.Fatal(err)
	}
	d, err := q.Next(ctx, "s1")
	if err != nil || d == nil {
		t.Fatalf("Next: %v %v", d, err)
	}
	got := d.Messages[0].Attached.List
	if got == nil || strings.Join(got.Filters, ",") != "a,b" || got.Rule != "x" || got.Q != "q" || got.Group != "none" {
		t.Fatalf("the stored message lost its list: %+v", got)
	}
	want := `attached: list filters a,b · rule x · search "q" · group none` + "\n"
	if got := Render(*d, "", "", "schuettc", time.UTC); !strings.Contains(got, want) {
		t.Fatalf("delivery text does not say %q:\n%s", want, got)
	}
	if got := describe(Attached{List: &AttachedList{}}); got != "list" {
		t.Fatalf("the whole list reads %q, want \"list\"", got)
	}
	if got := describe(Attached{List: &AttachedList{Q: "foo"}}); got != `list search "foo"` {
		t.Fatalf("a searched list reads %q", got)
	}
}

// A draft previewing on the page (review 2026-10-17): the list Court sees
// is the draft's conditions, and the agent reads them as match.
func TestAttachedDraftListReachesTheAgent(t *testing.T) {
	const m = `[{"field":"kind","op":"is","value":"issue"}]`
	if got := describe(Attached{List: &AttachedList{Match: m, Q: "foo"}}); got != `list matching `+m+` · search "foo"` {
		t.Fatalf("a draft's list reads %q", got)
	}
}
