package channel

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/serve"
	"github.com/subaud-tools/tools-common/channelmcp"
)

// reportServe is serve answering the channel's loop: presence, a quiet
// long-poll unless wait answers, and whatever else handle takes.
func reportServe(t *testing.T, wait func(w http.ResponseWriter) bool, handle func(w http.ResponseWriter, r *http.Request) bool) *Client {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if handle != nil && handle(w, r) {
			return
		}
		switch r.URL.Path {
		case "/api/agent/wait":
			if wait == nil || !wait(w) {
				time.Sleep(50 * time.Millisecond)
				w.WriteHeader(http.StatusNoContent)
			}
		default:
			_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		}
	}))
	t.Cleanup(ts.Close)
	return &Client{HTTP: &http.Client{Timeout: 10 * time.Second}, Find: func() (serve.Advert, error) {
		return serve.Advert{Base: ts.URL, Token: "tok"}, nil
	}}
}

func TestTheEventsMetaCarriesTheReportToken(t *testing.T) {
	var sent atomic.Bool
	c := reportServe(t, func(w http.ResponseWriter) bool {
		if sent.Swap(true) {
			return false
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"delivery": map[string]any{"id": 4, "messages": []map[string]any{{"id": 7}}},
			"text":     "casebook: 1 message", "report": "0123456789abcdef"})
		return true
	}, nil)
	ch := New(Identity{Session: "s1", Harness: "pi"}, c, "test")
	ch.Retry, ch.Poll = 50*time.Millisecond, time.Second
	m := start(t, ch)
	meta := m.next(5 * time.Second)["params"].(map[string]any)["meta"].(map[string]any)
	token, _ := meta[channelmcp.MetaReport].(string)
	if !regexp.MustCompile(`^[0-9a-zA-Z]+$`).MatchString(token) || token != "0123456789abcdef" {
		t.Fatalf("meta %v, want report 0123456789abcdef", meta)
	}
}

// pi's reports reach serve in the order sent, and a slow serve never holds
// up the channel's answers to the agent's tool calls.
func TestReportsReachServeInOrderWithoutBlockingToolCalls(t *testing.T) {
	release := make(chan struct{})
	posted := make(chan map[string]string, 4)
	c := reportServe(t, nil, func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/api/agent/report" {
			return false
		}
		var b map[string]string
		_ = json.NewDecoder(r.Body).Decode(&b)
		<-release
		posted <- b
		_ = json.NewEncoder(w).Encode(map[string]any{"moved": []int64{}})
		return true
	})
	ch := New(Identity{Session: "s1", Harness: "pi"}, c, "test")
	ch.Retry, ch.Poll = 50*time.Millisecond, time.Second
	m := start(t, ch)
	for _, p := range []map[string]string{{"event": "landed", "report": "0123456789abcdef"}, {"event": "turn_ended"}} {
		b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "notifications/channels/report", "params": p})
		_, _ = io.WriteString(m.w, string(b)+"\n")
	}
	done := make(chan struct{})
	go func() {
		m.call("tools/list", map[string]any{})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("a tools call waited on serve's report answer")
	}
	close(release)
	want := []map[string]string{
		{"session": "s1", "event": "landed", "token": "0123456789abcdef"},
		{"session": "s1", "event": "turn_ended", "token": ""},
	}
	for i, w := range want {
		select {
		case got := <-posted:
			if got["session"] != w["session"] || got["event"] != w["event"] || got["token"] != w["token"] {
				t.Fatalf("report %d posted %v, want %v", i+1, got, w)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("report %d never reached serve", i+1)
		}
	}
}

// casebook_reply offers the shared acknowledgement, and no longer received.
func TestReplyOffersTheSharedAcknowledgement(t *testing.T) {
	for _, tool := range Tools() {
		if tool.Name != "casebook_reply" {
			continue
		}
		var s struct {
			Properties struct {
				State struct {
					Enum []string `json:"enum"`
				} `json:"state"`
			} `json:"properties"`
		}
		if err := json.Unmarshal(tool.InputSchema, &s); err != nil {
			t.Fatal(err)
		}
		if got := strings.Join(s.Properties.State.Enum, ","); got != "working,answered,declined,failed" {
			t.Fatalf("casebook_reply states %s, want working,answered,declined,failed", got)
		}
		return
	}
	t.Fatal("no casebook_reply tool")
}
