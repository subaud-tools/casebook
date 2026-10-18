package serve

import (
	"net/http"
	"strings"
	"testing"
)

// TestToApplyViewListsDecidedItems: the page's To apply section lists the
// decided items waiting to be applied (spec §5.1: Court selects decided items
// in the to-apply state, or applies all), and the bar counts them
// ("to apply N", spec §3.1). They are not attention items, so the view reads
// every item, not the attention set.
func TestToApplyViewListsDecidedItems(t *testing.T) {
	r := newRig(t)

	var dec map[string]any
	if c := r.do(t, "POST", "/api/decide", map[string]any{
		"keys":        []string{"pr:schuettc/hail#3", "issue:schuettc/hail#4"},
		"disposition": "close",
		"note":        "stale",
	}, &dec); c != http.StatusOK || dec["decided"].(float64) != 2 {
		t.Fatalf("decide %d %v", c, dec)
	}

	var items ItemsView
	if c := r.do(t, "GET", "/api/items?view=to-apply", nil, &items); c != http.StatusOK {
		t.Fatalf("items: %d", c)
	}
	if items.Total != 2 || len(items.Items) != 2 {
		t.Fatalf("to-apply view: total %d, %d items; want the 2 decided", items.Total, len(items.Items))
	}
	// Group by group: pull requests before issues.
	for i, want := range []string{"pr:schuettc/hail#3", "issue:schuettc/hail#4"} {
		it := items.Items[i]
		if it.ID != want || it.Status != "to-apply" || it.Decision == nil || string(it.Decision.Disposition) != "close" {
			t.Errorf("item %d = %s (%s, %+v), want %s to-apply, decided close", i, it.ID, it.Status, it.Decision, want)
		}
	}

	// Filters apply as in any view.
	var prs ItemsView
	r.do(t, "GET", "/api/items?view=to-apply&kind=pr", nil, &prs)
	if prs.Total != 1 || prs.Items[0].ID != "pr:schuettc/hail#3" {
		t.Errorf("to-apply&kind=pr: %+v", prs)
	}

	var sum SummaryView
	r.do(t, "GET", "/api/summary", nil, &sum)
	if sum.Counts["to-apply"] != 2 {
		t.Errorf(`summary counts["to-apply"] = %d, want 2 (%v)`, sum.Counts["to-apply"], sum.Counts)
	}

	// Attention views are unchanged: a decided item isn't in them.
	var all ItemsView
	r.do(t, "GET", "/api/items?view=all", nil, &all)
	for _, it := range all.Items {
		if it.Status == "to-apply" {
			t.Errorf("attention's all view lists to-apply %s", it.ID)
		}
	}
}

// TestToApplyListsGroupsByWhatWillHappen: apply's waiting decisions come in
// groups by what will happen ("<disposition>|<kind>", labelled "Close 2
// PRs"), in kind order (repo, pr, issue, branch, worktree) then choice
// order; the list goes group by group, and a group filter narrows to one.
func TestToApplyListsGroupsByWhatWillHappen(t *testing.T) {
	r := newRig(t)
	for _, d := range []struct {
		keys []string
		disp string
	}{
		{[]string{"branch:schuettc/hail@feat/client"}, "delete"},
		{[]string{"issue:schuettc/hail#4", "issue:schuettc/hail#5"}, "close"},
		{[]string{"pr:schuettc/hail#3"}, "close"},
		{[]string{"pr:schuettc/hail#4"}, "merge"},
	} {
		var dec map[string]any
		if c := r.do(t, "POST", "/api/decide", map[string]any{"keys": d.keys, "disposition": d.disp}, &dec); c != http.StatusOK {
			t.Fatalf("decide %v %s: %d %v", d.keys, d.disp, c, dec)
		}
	}

	var items ItemsView
	if c := r.do(t, "GET", "/api/items?view=to-apply", nil, &items); c != http.StatusOK {
		t.Fatalf("items: %d", c)
	}
	want := []struct{ id, label string }{
		{"merge|pr", "Merge 1 PR"},
		{"close|pr", "Close 1 PR"},
		{"close|issue", "Close 2 issues"},
		{"delete|branch", "Delete 1 branch"},
	}
	if len(items.Groups) != len(want) {
		t.Fatalf("groups %+v, want %d", items.Groups, len(want))
	}
	for i, w := range want {
		g := items.Groups[i]
		if g.ID != w.id || g.Label != w.label || !g.Outward {
			t.Errorf("group %d = %+v, want %s %q outward", i, g, w.id, w.label)
		}
	}
	var order []string
	for _, it := range items.Items {
		order = append(order, it.Group)
	}
	wantOrder := []string{"merge|pr", "close|pr", "close|issue", "close|issue", "delete|branch"}
	if strings.Join(order, ",") != strings.Join(wantOrder, ",") {
		t.Errorf("items' groups %v, want %v", order, wantOrder)
	}

	var one ItemsView
	r.do(t, "GET", "/api/items?view=to-apply&group=close%7Cissue", nil, &one)
	if one.Total != 2 || one.Items[0].Group != "close|issue" {
		t.Errorf("group=close|issue: %+v", one)
	}
	if len(one.Groups) != len(want) {
		t.Errorf("a group filter keeps every group's count: %+v", one.Groups)
	}
}
