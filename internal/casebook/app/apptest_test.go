package app

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/observe"
	"github.com/subaud-tools/casebook/internal/casebook/testgit"
)

var ctx = context.Background()

// fakeGh serves a tiny GitHub through REST: user schuettc, no orgs, one repo
// schuettc/hail with one open incoming PR, nothing authored elsewhere, and
// nothing else: any other repo, PR, issue or branch is GitHub's 404.
type fakeGh struct{ fail bool }

func (f *fakeGh) Gh(_ context.Context, args ...string) ([]byte, error) {
	if f.fail {
		return nil, &observe.GhError{Code: 1, Stderr: "gh: offline"}
	}
	j := strings.Join(args, " ")
	p, q := restCall(args)
	switch {
	case j == "api user --jq .login":
		return []byte("schuettc\n"), nil
	case strings.HasPrefix(j, "api user/orgs"):
		return []byte(""), nil
	case strings.HasPrefix(j, "auth status"):
		return []byte("ok"), nil
	case p == "user/repos":
		return []byte(`[{"full_name":"schuettc/hail","pushed_at":"2026-09-20T00:00:00Z","default_branch":"main","open_issues_count":1}]`), nil
	case p == "search/issues" && q.Get("q") == "is:open is:pr user:schuettc":
		return []byte(`{"total_count":1,"items":[{"number":3,"title":"fix","state":"open","created_at":"2026-09-01T00:00:00Z",
		 "updated_at":"2026-09-01T00:00:00Z","user":{"login":"bob","type":"User"},"repository_url":"https://api.github.com/repos/schuettc/hail","pull_request":{}}]}`), nil
	case p == "search/issues":
		return []byte(`{"total_count":0,"items":[]}`), nil
	case p == "repos/schuettc/hail/pulls" && q.Get("state") == "open":
		return []byte(`[{"number":3,"head":{"ref":"","repo":null}}]`), nil
	case p == "repos/schuettc/hail/pulls" && q.Get("state") == "closed":
		return []byte(`[]`), nil
	case strings.HasPrefix(p, "repos/"):
		return nil, &observe.GhError{Code: 1, Stderr: "gh: Not Found (HTTP 404)"}
	}
	return nil, fmt.Errorf("fakeGh: unexpected %s", j)
}

// restCall is a gh api call's path and query.
func restCall(args []string) (string, url.Values) {
	for i := 1; i < len(args) && args[0] == "api"; i++ {
		switch a := args[i]; {
		case a == "-H" || a == "--jq":
			i++
		case strings.HasPrefix(a, "-"):
		default:
			p, raw, _ := strings.Cut(a, "?")
			q, _ := url.ParseQuery(raw)
			return p, q
		}
	}
	return "", nil
}

type rig struct {
	app    *App
	remote string
	root   string
	clone  string
	now    time.Time
}

// newRig initializes a casebook against a bare remote with one scanned clone
// (schuettc/hail, branch feat/client with an unpushed commit). The casebook
// is built once per test binary; each test gets its own copy of it from
// testgit.Fixture.
func newRig(t *testing.T) *rig {
	t.Helper()
	testgit.Env(t)
	gh := &fakeGh{}
	r := &rig{now: time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)}
	use := func(dir string) {
		home := filepath.Join(dir, "home")
		t.Setenv("HOME", home)
		t.Setenv("CASEBOOK_HOME", filepath.Join(home, "casebook-home"))
		r.remote = filepath.Join(dir, "remote", "remote.git")
		r.root, _ = filepath.EvalSymlinks(filepath.Join(dir, "root"))
		r.clone = filepath.Join(r.root, "hail")
	}
	dir := testgit.Fixture(t, "app", func(dir string) {
		for _, d := range []string{"home", "remote", filepath.Join("root", "hail")} {
			if err := os.MkdirAll(filepath.Join(dir, d), 0o755); err != nil {
				t.Fatal(err)
			}
		}
		use(dir)
		testgit.Git(t, filepath.Dir(r.remote), "init", "-q", "--bare", "-b", "main", r.remote)
		testgit.Git(t, r.clone, "init", "-q", "-b", "main")
		c1 := testgit.Commit(t, r.clone, "a", "1")
		testgit.Git(t, r.clone, "remote", "add", "origin", "git@github.com:schuettc/hail.git")
		testgit.Git(t, r.clone, "update-ref", "refs/remotes/origin/main", c1)
		testgit.Git(t, r.clone, "switch", "-q", "-c", "feat/client")
		testgit.Commit(t, r.clone, "b", "2")
		if _, err := Init(ctx, InitOptions{Remote: r.remote, Machine: "mbp", User: "schuettc", Roots: []string{r.root}}, gh); err != nil {
			t.Fatal(err)
		}
	})
	use(dir)
	a, err := Open(gh)
	if err != nil {
		t.Fatal(err)
	}
	a.Now = func() time.Time { return r.now }
	r.app = a
	return r
}
