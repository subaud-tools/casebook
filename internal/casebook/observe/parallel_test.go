package observe

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/item"
)

// slowGh is a gh whose every call takes 50ms (plus jitter, so calls finish
// in a different order each run). It counts the calls in flight, and the
// search calls in flight, at their peak.
type slowGh struct {
	handle func(args []string) (string, error)
	delay  func(args []string) time.Duration

	mu                sync.Mutex
	calls             int
	inFlight, peak    int
	searching, peakS  int
	seq               int // each start and each rate-limit answer takes the next number
	limitedAt         int // seq of the first rate-limit answer, 0 = none yet
	startedAfterLimit []string
}

func (f *slowGh) Gh(_ context.Context, args ...string) ([]byte, error) {
	search := apiPath(args) == "search/issues"
	f.mu.Lock()
	f.calls++
	f.seq++
	if f.limitedAt != 0 {
		f.startedAfterLimit = append(f.startedAfterLimit, strings.Join(args, " "))
	}
	f.inFlight++
	f.peak = max(f.peak, f.inFlight)
	if search {
		f.searching++
		f.peakS = max(f.peakS, f.searching)
	}
	f.mu.Unlock()

	d := 50*time.Millisecond + rand.N(5*time.Millisecond)
	if f.delay != nil {
		d = f.delay(args)
	}
	time.Sleep(d)
	out, err := f.handle(args)

	f.mu.Lock()
	f.inFlight--
	if search {
		f.searching--
	}
	if rateLimited(err) && f.limitedAt == 0 {
		f.seq++
		f.limitedAt = f.seq
	}
	f.mu.Unlock()
	return []byte(out), err
}

// world is two owners with four repos each, every repo with two open PRs
// and an open issue that have comments, two authored PRs elsewhere, and 40
// keys across a dozen other repos: repos, PRs, issues and branches.
func world(a []string) (string, error) {
	j := strings.Join(a, " ")
	p, q := apiPath(a), searchQ(a)
	repos := func(owner string) string {
		var rs []string
		for i := 0; i < 4; i++ {
			rs = append(rs, repoJSON(fmt.Sprintf("%s/r%d", owner, i), 3))
		}
		return "[" + strings.Join(rs, ",") + "]"
	}
	open := func(owner string, pr bool) string {
		var items []string
		for i := 0; i < 4; i++ {
			repo := fmt.Sprintf("%s/r%d", owner, i)
			if pr {
				items = append(items, issueJSON(repo, 1, "bob", "User", 2, true), issueJSON(repo, 2, "dependabot[bot]", "Bot", 1, true))
			} else {
				items = append(items, issueJSON(repo, 3, "eve", "User", 4, false))
			}
		}
		return searchJSON(len(items), items...)
	}
	switch {
	case j == "api user --jq .login":
		return "schuettc\n", nil
	case strings.HasPrefix(j, "api user/orgs"):
		return "Acme\n", nil
	case p == "user/repos":
		return repos("schuettc"), nil
	case p == "orgs/Acme/repos":
		return repos("Acme"), nil
	case q == "is:open is:pr user:schuettc":
		return open("schuettc", true), nil
	case q == "is:open is:issue user:schuettc":
		return open("schuettc", false), nil
	case q == "is:open is:pr org:Acme":
		return open("Acme", true), nil
	case q == "is:open is:issue org:Acme":
		return open("Acme", false), nil
	case q == "is:pr is:open archived:false author:schuettc":
		return searchJSON(3, issueJSON("up/x", 7, "schuettc", "User", 0, true), issueJSON("up/x", 8, "schuettc", "User", 0, true), issueJSON("schuettc/r0", 1, "bob", "User", 2, true)), nil
	case strings.HasSuffix(p, "/pulls") && strings.HasPrefix(p, "repos/"):
		repo := strings.TrimSuffix(strings.TrimPrefix(p, "repos/"), "/pulls")
		return fmt.Sprintf(`[{"number":1,"created_at":"2026-09-01T00:00:01Z","head":{"ref":"feat/%s","repo":{"full_name":%q}}},{"number":2,"head":{"ref":"deps","repo":null}}]`, repo, repo), nil
	case strings.Contains(p, "/comments"):
		return fmt.Sprintf(`[{"user":{"login":"c-%s","type":"User"},"created_at":"2026-09-03T00:00:00Z"}]`, p), nil
	case strings.HasPrefix(p, "repos/up/x/pulls/"):
		return fmt.Sprintf(`{"number":%s,"state":"open","mergeable_state":"clean","head":{"ref":"fix-%s","repo":{"full_name":"schuettc/x"}}}`, p[len("repos/up/x/pulls/"):], p), nil
	case strings.HasPrefix(p, "repos/Acme/r2/pulls/"):
		return `{"number":1,"state":"open","mergeable_state":"behind","head":{"ref":"merge-me","repo":{"full_name":"Acme/r2"}}}`, nil
	case strings.HasPrefix(p, "repos/ext/repo"):
		if strings.HasSuffix(p, "9") {
			return "", notFoundErr()
		}
		return fmt.Sprintf(`{"full_name":%q,"archived":true,"pushed_at":"2026-09-10T00:00:00Z"}`, strings.TrimPrefix(p, "repos/")), nil
	case strings.HasPrefix(p, "repos/ext/p/pulls/"):
		return `{"number":1,"state":"closed","merged_at":"2026-09-20T00:00:00Z","updated_at":"2026-09-20T00:00:00Z"}`, nil
	case strings.HasPrefix(p, "repos/ext/i/issues/"):
		return `{"number":1,"state":"closed","updated_at":"2026-09-21T00:00:00Z"}`, nil
	case strings.HasPrefix(p, "repos/br/") && strings.Contains(p, "/git/ref/heads/"):
		if strings.HasSuffix(p, "/gone") {
			return "", notFoundErr()
		}
		return fmt.Sprintf(`{"object":{"sha":"sha-%s"}}`, p), nil
	case strings.HasPrefix(p, "repos/br/"):
		return repoJSON(strings.TrimPrefix(p, "repos/"), 0), nil
	}
	return "", fmt.Errorf("unexpected gh %s", j)
}

func worldKeys() []item.Key {
	var keys []item.Key
	for i := 0; i < 10; i++ {
		keys = append(keys, item.RepoKey(fmt.Sprintf("ext/repo%d", i)), item.PRKey("ext/p", 100+i))
	}
	for i := 0; i < 8; i++ {
		keys = append(keys, item.IssueKey("ext/i", 200+i))
	}
	for i := 0; i < 6; i++ {
		repo := fmt.Sprintf("br/b%d", i)
		keys = append(keys, item.BranchKey(repo, "feat"), item.BranchKey(repo, "gone"))
	}
	return keys
}

func worldPrev() *GitHub {
	prev := NewGitHub()
	prev.Refs["pr:ext/p#109"] = Ref{Exists: true, State: "OPEN"}
	return prev
}

func worldOptions() RefreshOptions {
	return RefreshOptions{Keys: worldKeys(), Merge: []item.Key{item.PRKey("Acme/r2", 1)},
		Now: time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)}
}

// The reads run several at a time: much faster than one by one, with the
// same cache, byte for byte. No more than a pool's worth of calls are in
// flight, and no more than one search.
func TestRefreshRunsReadsSeveralAtATime(t *testing.T) {
	if len(worldKeys()) != 40 {
		t.Fatalf("%d keys", len(worldKeys()))
	}
	run := func(size int) (*slowGh, []byte, time.Duration) {
		gh := &slowGh{handle: world}
		start := time.Now()
		g, rep := refresh(ctx, gh, worldPrev(), worldOptions(), size)
		took := time.Since(start)
		if len(rep.Errors) != 0 || rep.RateLimited {
			t.Fatalf("size %d: %+v", size, rep)
		}
		b, err := json.Marshal(g)
		if err != nil {
			t.Fatal(err)
		}
		return gh, b, took
	}
	serialGh, serial, serialTook := run(1)
	if serialGh.peak != 1 {
		t.Fatalf("serial run had %d calls in flight", serialGh.peak)
	}
	for i := 0; i < 3; i++ {
		gh, got, took := run(poolSize)
		if string(got) != string(serial) {
			t.Fatalf("run %d: cache differs from the serial run:\nserial %s\nparallel %s", i, serial, got)
		}
		if gh.calls != serialGh.calls {
			t.Errorf("run %d: %d calls, serial made %d", i, gh.calls, serialGh.calls)
		}
		if gh.peak > poolSize || gh.peak < 2 {
			t.Errorf("run %d: %d calls in flight at the peak, want 2 to %d", i, gh.peak, poolSize)
		}
		if gh.peakS != 1 {
			t.Errorf("run %d: %d searches in flight at the peak, want 1", i, gh.peakS)
		}
		if took*4 > serialTook {
			t.Errorf("run %d: %v, serial %v (%d calls): want at least 4x faster", i, took, serialTook, serialGh.calls)
		}
		t.Logf("run %d: %v vs serial %v, %d calls, peak %d", i, took, serialTook, gh.calls, gh.peak)
	}
	// The serial cache is what it should be, so "the same" means right.
	var g GitHub
	if err := json.Unmarshal(serial, &g); err != nil {
		t.Fatal(err)
	}
	if n := len(g.Owners["acme"].Repos[0].PRs); n != 2 {
		t.Errorf("acme repo PRs %d", n)
	}
	if r := g.Refs["pr:ext/p#109"]; r.State != "MERGED" {
		t.Errorf("ref %+v", r)
	}
	if r := g.Refs["branch:br/b3@feat"]; r.Tip != "sha-repos/br/b3/git/ref/heads/feat" || r.Permission != "ADMIN" {
		t.Errorf("branch ref %+v", r)
	}
	if len(g.Authored) != 3 || g.Authored[0].HeadRef != "fix-repos/up/x/pulls/7" {
		t.Errorf("authored %+v", g.Authored)
	}
}

// When GitHub answers with a rate limit partway through, no call starts
// after that answer; the calls already running finish; the report says
// rate limited, and the keys not read keep their previous Refs.
func TestRefreshStartsNothingAfterARateLimit(t *testing.T) {
	gh := &slowGh{
		handle: func(a []string) (string, error) {
			if apiPath(a) == "repos/ext/p/pulls/105" {
				return "", &GhError{Code: 1, Stderr: "gh: API rate limit exceeded for user ID 1. (HTTP 403)"}
			}
			return world(a)
		},
		delay: func(a []string) time.Duration {
			if apiPath(a) == "repos/ext/p/pulls/105" {
				return 25 * time.Millisecond // answers between the others' answers
			}
			return 50 * time.Millisecond
		},
	}
	g, rep := refresh(ctx, gh, worldPrev(), worldOptions(), poolSize)
	if !rep.RateLimited {
		t.Fatalf("report %+v", rep)
	}
	if gh.limitedAt == 0 {
		t.Fatal("the rate-limited read was never made")
	}
	if len(gh.startedAfterLimit) != 0 {
		t.Errorf("started after the rate limit: %v", gh.startedAfterLimit)
	}
	if r := g.Refs["pr:ext/p#105"]; r != (Ref{}) {
		t.Errorf("rate-limited key got %+v", r)
	}
	if r := g.Refs["pr:ext/p#109"]; r != (Ref{Exists: true, State: "OPEN"}) && r.State != "MERGED" {
		t.Errorf("a key not read lost its previous Ref: %+v", r)
	}
	if !g.Owners["acme"].Reachable || len(g.Owners["acme"].Repos) != 4 {
		t.Errorf("owners listed before the rate limit were lost: %+v", g.Owners["acme"])
	}
}

// Search keeps GitHub's own limit inside the pool: no more than 30 started
// in any minute.
func TestSearchKeepsThirtyAMinute(t *testing.T) {
	now := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	var waited []time.Duration
	l := newLimiter(&fakeGh{handle: func([]string) (string, error) { return "{}", nil }}, poolSize)
	l.now = func() time.Time { return now }
	l.wait = func(_ context.Context, d time.Duration) error {
		waited = append(waited, d)
		now = now.Add(d)
		return nil
	}
	for i := 0; i < 31; i++ {
		if _, err := l.Gh(ctx, "api", "search/issues?q=x"); err != nil {
			t.Fatal(err)
		}
		now = now.Add(time.Second)
	}
	if len(waited) != 1 || waited[0] != 30*time.Second {
		t.Errorf("waited %v, want once for 30s (the 31st search, a minute after the first)", waited)
	}
	if _, err := l.Gh(ctx, "api", "repos/o/r"); err != nil || len(waited) != 1 {
		t.Errorf("a core call waited: %v %v", err, waited)
	}
}

// Merged-PR lists are read several at a time too, into the same map.
func TestFetchMergedPRsRunsSeveralAtATime(t *testing.T) {
	var repos []string
	for i := 0; i < 16; i++ {
		repos = append(repos, fmt.Sprintf("o/r%d", i))
	}
	gh := &slowGh{handle: func(a []string) (string, error) {
		if strings.HasSuffix(apiPath(a), "r3/pulls") {
			return "", &GhError{Code: 1, Stderr: "gh: HTTP 502"}
		}
		return fmt.Sprintf(`[{"number":1,"merged_at":"2026-09-01T00:00:00Z","head":{"ref":%q,"sha":"s"}}]`, apiPath(a)), nil
	}}
	now := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	start := time.Now()
	out := fetchMergedPRs(ctx, gh, repos, nil, now, poolSize, &RefreshReport{})
	took := time.Since(start)
	if took > 16*50*time.Millisecond/4 {
		t.Errorf("took %v for 16 lists", took)
	}
	if gh.peak > poolSize {
		t.Errorf("%d in flight", gh.peak)
	}
	for _, r := range repos {
		ml := out[r]
		if r == "o/r3" {
			if ml.Fetched {
				t.Errorf("%s fetched despite its error", r)
			}
			continue
		}
		if !ml.Fetched || len(ml.PRs) != 1 || ml.PRs[0].HeadRefName != "repos/"+r+"/pulls" {
			t.Errorf("%s = %+v", r, ml)
		}
	}
}
