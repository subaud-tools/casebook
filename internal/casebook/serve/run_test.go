package serve

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/apptest"
	"github.com/subaud-tools/casebook/internal/casebook/config"
	"github.com/subaud-tools/tools-common/localweb"
	"github.com/subaud-tools/tools-common/pageserve"
)

func TestRunAdvertStopAndInterrupt(t *testing.T) {
	r := apptest.New(t)
	started := make(chan pageserve.Entry, 1)
	errc := make(chan error, 1)
	go func() {
		errc <- Run(context.Background(), r.App, Options{Version: "test", Started: func(_ *Server, a pageserve.Entry) { started <- a }})
	}()
	var adv pageserve.Entry
	select {
	case adv = <-started:
	case err := <-errc:
		t.Fatalf("run: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("serve did not start")
	}
	got, err := Running()
	if err != nil || got.PID != os.Getpid() || got.Token == "" || got.Base != adv.Base {
		t.Fatalf("advert %+v %v", got, err)
	}
	// The entry is where casebook's advert always was, so an older binary
	// finds a newer serve and the other way round.
	if want := filepath.Join(config.StateDir(), "live", "serve.json"); Live().ServePath() != want {
		t.Errorf("entry at %s, want %s", Live().ServePath(), want)
	}
	fi, _ := os.Stat(Live().ServePath())
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("advert mode %v", fi.Mode().Perm())
	}
	// Header auth works for the channel; no token is refused.
	req, _ := http.NewRequest("GET", adv.Base+"/api/summary", nil)
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no token: %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
	req.Header.Set(localweb.TokenHeader, adv.Token)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("token: %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
	if err := Run(context.Background(), r.App, Options{}); err == nil {
		t.Fatal("second serve started")
	}
	if err := pageserve.Stop(context.Background(), Live()); err != nil {
		t.Fatal(err)
	}
	if err := <-errc; err != nil {
		t.Fatalf("run returned %v", err)
	}
	if _, err := Running(); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("after stop: %v", err)
	}
}

// runOnce starts serve, returns its advert and whether it was told the page
// was open, and a stop function.
func runOnce(t *testing.T, r *apptest.Rig, opened *[]string) (pageserve.Entry, bool, func()) {
	adv, was, _, stop := runOnceSession(t, r, opened)
	return adv, was, stop
}

// runOnceSession is runOnce, with the agent the reopened page is attached to.
func runOnceSession(t *testing.T, r *apptest.Rig, opened *[]string) (pageserve.Entry, bool, string, func()) {
	t.Helper()
	started := make(chan pageserve.Entry, 1)
	was := make(chan bool, 1)
	sess := make(chan string, 1)
	errc := make(chan error, 1)
	go func() {
		errc <- Run(context.Background(), r.App, Options{Version: "test",
			Ready:   func(_ string, pageWasOpen bool, session string) { was <- pageWasOpen; sess <- session },
			Open:    func(url string) error { *opened = append(*opened, url); return nil },
			Started: func(_ *Server, a pageserve.Entry) { started <- a }})
	}()
	var adv pageserve.Entry
	select {
	case adv = <-started:
	case err := <-errc:
		t.Fatalf("run: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("serve did not start")
	}
	return adv, <-was, <-sess, func() {
		if err := pageserve.Stop(context.Background(), Live()); err != nil {
			t.Fatal(err)
		}
		<-errc
	}
}

// TestRestartReopensThePageForItsAgent (Court, 2026-10-18: every restart left
// the page with no agent): the page an agent's tab had open is reopened for
// that agent, so the tab can still run what Court approves.
func TestRestartReopensThePageForItsAgent(t *testing.T) {
	r := apptest.New(t)
	var opened []string
	adv, _, _, stop := runOnceSession(t, r, &opened)
	closeTab := stream(t, adv.Base, adv.Token)
	defer closeTab()
	time.Sleep(100 * time.Millisecond)
	if c := callBody(t, adv, "/api/page/attached", `{"session":"s1"}`); c != http.StatusOK {
		t.Fatalf("attached: %d", c)
	}
	stop()
	_, was, sess, stop := runOnceSession(t, r, &opened)
	defer stop()
	if !was || sess != "s1" {
		t.Fatalf("restart reopened %v for %q, want the page for s1", was, sess)
	}
}

// TestTheDockSaysWhichAgentItIsAttachedTo (review, 2026-10-18): the agent a
// restart reopens the page for is the one the tab's dock last attached, as
// it said so; a page reading a session (To apply's jobs, the dock's own
// reads) doesn't choose it, and a detach clears it.
func TestTheDockSaysWhichAgentItIsAttachedTo(t *testing.T) {
	r := apptest.New(t)
	var opened []string
	restart := func(adv pageserve.Entry, stop func(), do func(pageserve.Entry)) (pageserve.Entry, string, func()) {
		closeTab := stream(t, adv.Base, adv.Token)
		time.Sleep(100 * time.Millisecond)
		do(adv)
		stop()
		closeTab()
		adv, _, sess, stop := runOnceSession(t, r, &opened)
		return adv, sess, stop
	}
	adv, _, _, stop := runOnceSession(t, r, &opened)
	adv, sess, stop := restart(adv, stop, func(a pageserve.Entry) {
		call(t, a, "GET", "/api/sessions?session=s1")
	})
	if sess != "" {
		t.Errorf("a sessions read for s1 chose it: restart for %q", sess)
	}
	adv, sess, stop = restart(adv, stop, func(a pageserve.Entry) {
		callBody(t, a, "/api/page/attached", `{"session":"s1"}`)
	})
	if sess != "s1" {
		t.Errorf("after an attach to s1, restart for %q", sess)
	}
	_, sess, stop = restart(adv, stop, func(a pageserve.Entry) {
		callBody(t, a, "/api/page/attached", `{"session":""}`)
	})
	defer stop()
	if sess != "" {
		t.Errorf("after a detach, restart for %q", sess)
	}
}

func call(t *testing.T, adv pageserve.Entry, method, path string) int {
	t.Helper()
	req, _ := http.NewRequest(method, adv.Base+path, strings.NewReader("{}"))
	req.Header.Set(localweb.TokenHeader, adv.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

func TestRestartReopensAnOpenPage(t *testing.T) {
	r := apptest.New(t)
	var opened []string
	// No tab: a restart doesn't open one, and agent traffic doesn't count.
	adv, was, stop := runOnce(t, r, &opened)
	if was || adv.Reopened {
		t.Fatalf("first start: was %v, reopened %v", was, adv.Reopened)
	}
	call(t, adv, "POST", "/api/agent/presence")
	call(t, adv, "GET", "/api/summary")
	stop()
	adv, was, stop = runOnce(t, r, &opened)
	if was || adv.Reopened {
		t.Fatal("requests without a connected tab made the restart reopen the page")
	}
	// A tab connects, then closes: the page is closed, so no reopen.
	closeTab := stream(t, adv.Base, adv.Token)
	time.Sleep(100 * time.Millisecond)
	closeTab()
	time.Sleep(100 * time.Millisecond)
	stop()
	adv, was, stop = runOnce(t, r, &opened)
	if was || adv.Reopened {
		t.Fatal("a tab closed before the restart was reopened")
	}
	// A tab is connected when serve stops: the next serve reopens it, however
	// long the gap. casebook_open works too.
	closeTab = stream(t, adv.Base, adv.Token)
	defer closeTab()
	time.Sleep(100 * time.Millisecond)
	if c := call(t, adv, "POST", "/api/agent/open"); c != http.StatusOK || len(opened) != 1 || !strings.Contains(opened[0], "?t="+adv.Token) {
		t.Fatalf("open: %d %v", c, opened)
	}
	stop()
	adv, was, stop = runOnce(t, r, &opened)
	if !was || !adv.Reopened {
		t.Fatalf("restart with a connected tab: was %v, reopened %v", was, adv.Reopened)
	}
	if got, _ := Running(); !got.Reopened {
		t.Fatal("advert doesn't say the page was reopened")
	}
	// The flag was taken: another restart with no tab doesn't reopen again.
	stop()
	adv, was, stop = runOnce(t, r, &opened)
	defer stop()
	if was || adv.Reopened {
		t.Fatal("the page was reopened twice from one connected tab")
	}
}

func callBody(t *testing.T, adv pageserve.Entry, path, body string) int {
	t.Helper()
	req, _ := http.NewRequest("POST", adv.Base+path, strings.NewReader(body))
	req.Header.Set(localweb.TokenHeader, adv.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

func TestOpenLandsOnAnItemOrTheFront(t *testing.T) {
	r := apptest.New(t)
	var opened []string
	adv, _, stop := runOnce(t, r, &opened)
	defer stop()
	for _, c := range []struct {
		body string
		code int
		url  string // suffix of the opened URL; "" when nothing opens
	}{
		{`{}`, 200, "?t=" + adv.Token},
		{`{"key":"pr:schuettc/hail#3"}`, 200, "?t=" + adv.Token + "#/item/pr:schuettc%2Fhail%233"},
		// An older channel's view is ignored (TestOpenAttachesThePageToTheCallingSession).
		{`{"view":"new"}`, 200, "?t=" + adv.Token},
		{`{"key":"pr:schuettc/hail#999"}`, 404, ""},
		{`{"key":"not a key"}`, 400, ""},
		{`{"key":"pr:schuettc/hail#3","view":"new"}`, 200, "?t=" + adv.Token + "#/item/pr:schuettc%2Fhail%233"},
	} {
		before := len(opened)
		if got := callBody(t, adv, "/api/agent/open", c.body); got != c.code {
			t.Fatalf("%s: %d, want %d", c.body, got, c.code)
		}
		if c.url == "" {
			if len(opened) != before {
				t.Fatalf("%s opened %v", c.body, opened[before:])
			}
			continue
		}
		if len(opened) != before+1 || !strings.HasSuffix(opened[before], c.url) {
			t.Fatalf("%s opened %v, want a URL ending %q", c.body, opened[before:], c.url)
		}
	}
}

// An open page keeps serve up past its idle limit (Options.Busy), and serve
// stops once the page closes.
func TestAnOpenPageKeepsServeUpPastIdle(t *testing.T) {
	r := apptest.New(t)
	started := make(chan pageserve.Entry, 1)
	errc := make(chan error, 1)
	go func() {
		errc <- Run(context.Background(), r.App, Options{Version: "test", Idle: 300 * time.Millisecond,
			Started: func(_ *Server, e pageserve.Entry) { started <- e }})
	}()
	var e pageserve.Entry
	select {
	case e = <-started:
	case err := <-errc:
		t.Fatalf("run: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("serve did not start")
	}
	closeTab := stream(t, e.Base, e.Token)
	select {
	case err := <-errc:
		closeTab()
		t.Fatalf("serve stopped under an open page: %v", err)
	case <-time.After(1500 * time.Millisecond):
	}
	closeTab()
	select {
	case err := <-errc:
		if err != nil {
			t.Fatalf("run returned %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serve didn't stop after the page closed")
	}
	if _, err := Running(); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("after idle exit: %v", err)
	}
}
