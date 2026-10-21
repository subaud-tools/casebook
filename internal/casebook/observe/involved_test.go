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

// TestRefreshRecordsReviewRequestsAndAssignments: an open PR says whether
// the user is asked to review it (the open pulls' requested_reviewers) and
// whether it is assigned to them; an open issue says the latter, from its
// assignees. Nothing more is read for them.
func TestRefreshRecordsReviewRequestsAndAssignments(t *testing.T) {
	assigned := func(js, who string) string {
		return strings.Replace(js, `"labels"`, `"assignees":[{"login":"`+who+`","type":"User"}],"labels"`, 1)
	}
	gh := &fakeGh{handle: func(a []string) (string, error) {
		j := strings.Join(a, " ")
		switch p, q := apiPath(a), searchQ(a); {
		case j == "api user --jq .login":
			return "schuettc", nil
		case p == "user/repos":
			return "[]", nil
		case p == "orgs/ft/repos":
			return "[" + repoJSON("ft/team", 4) + "]", nil
		case q == "is:open is:pr org:ft":
			return searchJSON(2, assigned(issueJSON("ft/team", 1, "alice", "User", 0, true), "Schuettc"), issueJSON("ft/team", 2, "alice", "User", 0, true)), nil
		case q == "is:open is:issue org:ft":
			return searchJSON(2, assigned(issueJSON("ft/team", 3, "alice", "User", 0, false), "schuettc"), assigned(issueJSON("ft/team", 4, "alice", "User", 0, false), "bob")), nil
		case p == "repos/ft/team/pulls":
			return `[{"number":1,"head":{"ref":"a"},"requested_reviewers":[{"login":"bob"}],"assignees":[{"login":"Schuettc"}]},
			 {"number":2,"head":{"ref":"b"},"requested_reviewers":[{"login":"SchuettC"}],"assignees":[]}]`, nil
		case q != "":
			return searchJSON(0), nil
		}
		return "", fmt.Errorf("unexpected gh %s", j)
	}}
	g, rep := Refresh(ctx, gh, NewGitHub(), RefreshOptions{Owners: []string{"schuettc", "ft"}, Now: time.Now()})
	if len(rep.Errors) != 0 {
		t.Fatal(rep.Errors)
	}
	r := g.Owners["ft"].Repos[0]
	got := map[string][2]bool{}
	for _, p := range r.PRs {
		got[fmt.Sprintf("pr#%d", p.Number)] = [2]bool{p.ReviewRequested, p.Assigned}
	}
	for _, p := range r.Issues {
		got[fmt.Sprintf("issue#%d", p.Number)] = [2]bool{p.ReviewRequested, p.Assigned}
	}
	want := map[string][2]bool{"pr#1": {false, true}, "pr#2": {true, false}, "issue#3": {false, true}, "issue#4": {false, false}}
	for k, w := range want {
		if got[k] != w {
			t.Errorf("%s: (review requested, assigned) %v, want %v", k, got[k], w)
		}
	}
	if n := countCalls(gh, func(a []string) bool {
		return strings.Contains(apiPath(a), "/requested_reviewers") || strings.Contains(apiPath(a), "/assignees")
	}); n != 0 {
		t.Errorf("%d extra reads", n)
	}
}

// TestRefreshAuthoredPRAssignment: an authored PR in a repo no listing
// holds takes its assignment from its own read.
func TestRefreshAuthoredPRAssignment(t *testing.T) {
	gh := &fakeGh{handle: func(a []string) (string, error) {
		j := strings.Join(a, " ")
		switch p, q := apiPath(a), searchQ(a); {
		case j == "api user --jq .login":
			return "schuettc", nil
		case p == "user/repos":
			return "[]", nil
		case q == "is:pr is:open archived:false author:schuettc":
			return searchJSON(1, issueJSON("up/stream", 9, "schuettc", "User", 0, true)), nil
		case p == "repos/up/stream/pulls/9":
			return `{"number":9,"state":"open","head":{"ref":"x"},"assignees":[{"login":"schuettc"}]}`, nil
		case q != "":
			return searchJSON(0), nil
		}
		return "", fmt.Errorf("unexpected gh %s", j)
	}}
	g, rep := Refresh(ctx, gh, NewGitHub(), RefreshOptions{Owners: []string{"schuettc"}, Now: time.Now()})
	if len(rep.Errors) != 0 || len(g.Authored) != 1 {
		t.Fatal(rep.Errors, g.Authored)
	}
	if !g.Authored[0].Assigned {
		t.Errorf("authored %+v, want assigned", g.Authored[0])
	}
}
