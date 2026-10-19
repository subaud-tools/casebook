package serve

import (
	"encoding/json"
	"net/http"
	"testing"
)

// TestAcceptingAGroupIsOneDecidedEvent (Court, 2026-10-18: pressing a
// group's button made the page count down one item at a time): accepting
// several recommendations announces them in one "decided" event, so a tab
// redraws once.
func TestAcceptingAGroupIsOneDecidedEvent(t *testing.T) {
	r := newRig(t)
	r.attach(t, "s1")
	var res struct {
		Proposals []struct{ ID int64 } `json:"proposals"`
	}
	keys := []string{"issue:schuettc/hail#4", "issue:schuettc/hail#5", "issue:schuettc/hail#6"}
	r.do(t, "POST", "/api/agent/propose", map[string]any{"session": "s1", "keys": keys, "disposition": "close"}, &res)
	if len(res.Proposals) != 3 {
		t.Fatalf("proposed %d", len(res.Proposals))
	}
	before, _ := r.s.Bus.Head(ctx)
	var ids []int64
	for _, p := range res.Proposals {
		ids = append(ids, p.ID)
	}
	if c := r.do(t, "POST", "/api/proposals/accept", map[string]any{"ids": ids}, nil); c != http.StatusOK {
		t.Fatalf("accept: %d", c)
	}
	evs, _, _ := r.s.Bus.Since(ctx, before, 100)
	var decided [][]string
	for _, e := range evs {
		if e.Type != "decided" {
			continue
		}
		var d struct {
			Keys []string `json:"keys"`
		}
		_ = json.Unmarshal(e.Data, &d)
		decided = append(decided, d.Keys)
	}
	if len(decided) != 1 || len(decided[0]) != 3 {
		t.Fatalf("decided events %v, want one naming all 3", decided)
	}
}
