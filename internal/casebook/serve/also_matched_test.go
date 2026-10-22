package serve

import (
	"net/url"
	"testing"
)

// TestItemSaysWhichOtherRulesAlsoMatch: when two active rules match one
// item, the first one's recommendation stays, and GET /api/item names the
// other as also matching it, leaving out the rule that proposed.
func TestItemSaysWhichOtherRulesAlsoMatch(t *testing.T) {
	r := newRig(t)
	for _, id := range []string{"close-prs", "keep-prs"} {
		disp := "close"
		if id == "keep-prs" {
			disp = "keep"
		}
		body := draftBody(id, disp, "", kindCond("pr"))
		body["name"] = map[string]string{"close-prs": "Close PRs", "keep-prs": "Keep PRs"}[id]
		var saved RuleDetailView
		if c := r.do(t, "POST", "/api/rules/draft", body, &saved); c != 200 {
			t.Fatalf("save %s: %d", id, c)
		}
		if c := r.do(t, "POST", "/api/rules/activate", map[string]any{"id": id, "version": saved.Version}, nil); c != 200 {
			t.Fatalf("activate %s: %d", id, c)
		}
	}
	var d ItemDetailView
	if c := r.do(t, "GET", "/api/item?key="+url.QueryEscape("pr:schuettc/hail#3"), nil, &d); c != 200 {
		t.Fatalf("GET /api/item: %d", c)
	}
	if d.Item.Proposal == nil || d.Item.Proposal.Source != "rule:close-prs" {
		t.Fatalf("proposal %+v, want close-prs's", d.Item.Proposal)
	}
	if len(d.AlsoMatched) != 1 || d.AlsoMatched[0] != (RuleRef{ID: "keep-prs", Name: "Keep PRs"}) {
		t.Fatalf("also_matched %+v, want [keep-prs Keep PRs]", d.AlsoMatched)
	}
	var none ItemDetailView
	if c := r.do(t, "GET", "/api/item?key="+url.QueryEscape("issue:schuettc/hail#4"), nil, &none); c != 200 {
		t.Fatalf("GET /api/item: %d", c)
	}
	if none.AlsoMatched == nil || len(none.AlsoMatched) != 0 {
		t.Fatalf("issue also_matched %+v, want []", none.AlsoMatched)
	}
}
