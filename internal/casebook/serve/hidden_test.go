package serve

import (
	"net/url"
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/engine"
	"github.com/subaud-tools/casebook/internal/casebook/item"
)

// TestHiddenRepoItemPageStillOpens: a repo hidden from the lists still has
// its item page, so links to it keep working.
func TestHiddenRepoItemPageStillOpens(t *testing.T) {
	r := newRig(t)
	k := item.RepoKey("ft/team")
	hidden := engine.Item{Key: k, ID: k.String(), Kind: item.KindRepo, Repo: "ft/team", Status: item.StatusNew}
	res := r.s.Index.Result()
	res.Hidden = []engine.Item{hidden}
	r.s.Index.set(res, r.s.Index.Head(), time.Now())
	var out struct {
		Item struct {
			Key string `json:"key"`
		} `json:"item"`
	}
	if c := r.do(t, "GET", "/api/item?key="+url.QueryEscape(k.String()), nil, &out); c != 200 || out.Item.Key != k.String() {
		t.Fatalf("GET /api/item: %d %+v", c, out)
	}
	var list struct {
		Items []struct {
			Key string `json:"key"`
		} `json:"items"`
	}
	if c := r.do(t, "GET", "/api/items?view=tracked&limit=500", nil, &list); c != 200 {
		t.Fatalf("GET /api/items: %d", c)
	}
	for _, it := range list.Items {
		if it.Key == k.String() {
			t.Error("a hidden repo is listed")
		}
	}
}
