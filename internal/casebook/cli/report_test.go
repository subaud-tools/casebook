package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/subaud-tools/casebook/internal/casebook/channel"
	"github.com/subaud-tools/casebook/internal/casebook/serve"
)

// The Claude Code plugin's mod runs casebook report: each report reaches
// serve for the session the harness names.
func TestReportReachesServe(t *testing.T) {
	wbSetup(t)
	var mu sync.Mutex
	var got []map[string]string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agent/report" {
			var b map[string]string
			_ = json.NewDecoder(r.Body).Decode(&b)
			mu.Lock()
			got = append(got, b)
			mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"moved":[]}`))
	}))
	t.Cleanup(ts.Close)
	prev := newSettledClient
	newSettledClient = func() *channel.Client {
		c := channel.NewClient()
		c.Find = func() (serve.Advert, error) { return serve.Advert{Base: ts.URL, Token: "test"}, nil }
		return c
	}
	t.Cleanup(func() { newSettledClient = prev })
	t.Setenv("CLAUDE_CODE_SESSION_ID", "cc-9")
	t.Setenv("AGENT_SESSION_ID", "")
	t.Setenv("PI_CLAUDE_BRIDGE", "")

	for _, args := range [][]string{{"report", "landed", "0123456789abcdef"}, {"report", "held", "0123456789abcdef"}} {
		if code, out, errw := run(args...); code != 0 || out != "" {
			t.Fatalf("%v: %d %q %q", args, code, out, errw)
		}
	}
	want := []map[string]string{
		{"session": "cc-9", "event": "landed", "token": "0123456789abcdef"},
		{"session": "cc-9", "event": "held", "token": "0123456789abcdef"},
	}
	if len(got) != len(want) {
		t.Fatalf("serve got %v, want %v", got, want)
	}
	for i, w := range want {
		if got[i]["session"] != w["session"] || got[i]["event"] != w["event"] || got[i]["token"] != w["token"] {
			t.Fatalf("report %d: %v, want %v", i+1, got[i], w)
		}
	}
}
