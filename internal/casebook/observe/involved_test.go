package observe

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// TestRefreshRecordsAdmin: a listed repo says whether the user is its admin,
// from the listing's permissions.
func TestRefreshRecordsAdmin(t *testing.T) {
	member := strings.Replace(repoJSON("ft/team", 0), `"admin":true`, `"admin":false`, 1)
	gh := &fakeGh{handle: func(a []string) (string, error) {
		j := strings.Join(a, " ")
		switch p, q := apiPath(a), searchQ(a); {
		case j == "api user --jq .login":
			return "schuettc", nil
		case p == "user/repos":
			return "[]", nil
		case p == "orgs/ft/repos":
			return "[" + repoJSON("ft/mine", 0) + "," + member + "]", nil
		case q != "":
			return searchJSON(0), nil
		}
		return "", fmt.Errorf("unexpected gh %s", j)
	}}
	g, rep := Refresh(ctx, gh, NewGitHub(), RefreshOptions{Owners: []string{"schuettc", "ft"}, Now: time.Now()})
	if len(rep.Errors) != 0 {
		t.Fatal(rep.Errors)
	}
	admin := map[string]bool{}
	for _, r := range g.Owners["ft"].Repos {
		admin[r.Repo] = r.Admin
	}
	if !admin["ft/mine"] || admin["ft/team"] {
		t.Errorf("admin %v, want ft/mine only", admin)
	}
}
