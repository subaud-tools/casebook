package observe

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/item"
)

// casebook reads GitHub through REST only (Court, 2026-10-20): one GraphQL
// query for an org's repos with their open PRs and issues timed out (HTTP
// 502) on Fundamental-Technologies, and GraphQL's hourly budget ran out
// twice. GraphQL stays for the atomic branch delete and its undo
// (apply/command.go).

const (
	searchCap       = 1000 // GitHub search returns at most this many results per query
	searchPage      = 100
	maxMergedPages  = 20
	branchListAbove = 2 // a repo with more branch keys than this lists its refs once
)

// textJSON asks for body_text, GitHub's plain-text rendering of a body (what
// GraphQL's bodyText was).
const textJSON = "Accept: application/vnd.github.text+json"

type restUser struct {
	Login string `json:"login"`
	Type  string `json:"type"` // "User" | "Bot" | "Organization"
}

// name is the login as casebook spells it: "ghost" for a deleted account,
// and a bot without its "[bot]" suffix (as GraphQL spelled it, and as rules
// match it).
func (u *restUser) name() (string, bool) {
	if u == nil || u.Login == "" {
		return "ghost", false
	}
	if u.Type == "Bot" {
		return strings.TrimSuffix(u.Login, "[bot]"), true
	}
	return u.Login, false
}

type restLabel struct {
	Name string `json:"name"`
}

// restIssue is an issue or pull request as search and the issues endpoints
// return it.
type restIssue struct {
	Number        int         `json:"number"`
	Title         string      `json:"title"`
	HTMLURL       string      `json:"html_url"`
	State         string      `json:"state"`
	Draft         bool        `json:"draft"`
	CreatedAt     time.Time   `json:"created_at"`
	UpdatedAt     time.Time   `json:"updated_at"`
	User          *restUser   `json:"user"`
	BodyText      string      `json:"body_text"`
	Labels        []restLabel `json:"labels"`
	Comments      int         `json:"comments"`
	RepositoryURL string      `json:"repository_url"`
	PullRequest   *struct {
		MergedAt *time.Time `json:"merged_at"`
	} `json:"pull_request"`
}

// repo returns owner/name from repository_url.
func (i restIssue) repo() string {
	const p = "/repos/"
	if n := strings.LastIndex(i.RepositoryURL, p); n >= 0 {
		return i.RepositoryURL[n+len(p):]
	}
	return ""
}

type restPull struct {
	Number         int        `json:"number"`
	State          string     `json:"state"`
	Draft          bool       `json:"draft"`
	MergedAt       *time.Time `json:"merged_at"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
	MergeableState string     `json:"mergeable_state"` // single-PR endpoint only
	Head           struct {
		Ref  string `json:"ref"`
		SHA  string `json:"sha"`
		Repo *struct {
			FullName string `json:"full_name"`
		} `json:"repo"`
	} `json:"head"`
}

type restRepo struct {
	FullName        string    `json:"full_name"`
	NodeID          string    `json:"node_id"`
	Archived        bool      `json:"archived"`
	Fork            bool      `json:"fork"`
	Private         bool      `json:"private"`
	PushedAt        time.Time `json:"pushed_at"`
	DefaultBranch   string    `json:"default_branch"`
	OpenIssuesCount int       `json:"open_issues_count"` // open issues plus open PRs
	Permissions     *struct {
		Admin    bool `json:"admin"`
		Maintain bool `json:"maintain"`
		Push     bool `json:"push"`
		Triage   bool `json:"triage"`
		Pull     bool `json:"pull"`
	} `json:"permissions"`
	Parent *struct {
		FullName string `json:"full_name"`
	} `json:"parent"` // single-repo endpoint only
}

// permission is the viewer's access as GraphQL's viewerPermission spelled it.
func (r restRepo) permission() string {
	p := r.Permissions
	switch {
	case p == nil:
		return ""
	case p.Admin:
		return "ADMIN"
	case p.Maintain:
		return "MAINTAIN"
	case p.Push:
		return "WRITE"
	case p.Triage:
		return "TRIAGE"
	case p.Pull:
		return "READ"
	}
	return ""
}

func rateLimited(err error) bool {
	var ge *GhError
	if !errors.As(err, &ge) {
		return false
	}
	s := strings.ToLower(ge.Stderr)
	return strings.Contains(s, "rate limit") || strings.Contains(s, "http 429")
}

// notFound reports GitHub's 404 (or 410, a deleted issue).
func notFound(err error) bool {
	var ge *GhError
	return errors.As(err, &ge) && (strings.Contains(ge.Stderr, "HTTP 404") || strings.Contains(ge.Stderr, "HTTP 410"))
}

// rest makes GET calls through gh api.
type rest struct {
	ctx context.Context
	r   Runner
}

// get decodes path's JSON into v. Paginated, it decodes each page in turn
// (gh prints one JSON value per page) through each.
func (c rest) get(path string, v any, header ...string) error {
	args := []string{"api", path}
	for _, h := range header {
		args = append(args, "-H", h)
	}
	out, err := c.r.Gh(c.ctx, args...)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(out, v); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

func (c rest) pages(path string, each func(json.RawMessage) error, header ...string) error {
	args := []string{"api", "--paginate", path}
	for _, h := range header {
		args = append(args, "-H", h)
	}
	out, err := c.r.Gh(c.ctx, args...)
	if err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(out))
	for {
		var raw json.RawMessage
		if err := dec.Decode(&raw); errors.Is(err, io.EOF) {
			return nil
		} else if err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		if err := each(raw); err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
	}
}

// list decodes every page of an array endpoint into a slice.
func list[T any](c rest, path string, header ...string) ([]T, error) {
	var all []T
	err := c.pages(path, func(raw json.RawMessage) error {
		var page []T
		if err := json.Unmarshal(raw, &page); err != nil {
			return err
		}
		all = append(all, page...)
		return nil
	}, header...)
	return all, err
}

// search runs one search query: every result, or more=true when GitHub has
// more than searchCap of them (the caller splits the query).
func (c rest) search(q string) (items []restIssue, more bool, err error) {
	for page := 1; ; page++ {
		var resp struct {
			Total int         `json:"total_count"`
			Items []restIssue `json:"items"`
		}
		path := "search/issues?" + url.Values{"q": {q}, "per_page": {strconv.Itoa(searchPage)}, "page": {strconv.Itoa(page)}}.Encode()
		if err := c.get(path, &resp, textJSON); err != nil {
			return nil, false, err
		}
		if resp.Total > searchCap {
			return nil, true, nil
		}
		items = append(items, resp.Items...)
		if len(resp.Items) < searchPage || len(items) >= resp.Total {
			return items, false, nil
		}
	}
}

func repoPath(repo string) string {
	owner, name, _ := strings.Cut(repo, "/")
	return "repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name)
}

func refPath(branch string) string {
	segs := strings.Split(branch, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return strings.Join(segs, "/")
}

// RefreshOptions controls a refresh.
type RefreshOptions struct {
	Owners   []string   // explicit owners; empty = the user plus every org gh lists
	Keys     []item.Key // items to look up individually (decisions, until refs)
	Merge    []item.Key // pull requests decided merge: these get their merge state
	Releases []item.Key // repos a released() condition names: these get their latest release
	Now      time.Time
}

// RefreshReport lists what could not be refreshed.
type RefreshReport struct {
	Errors      []string
	RateLimited bool
}

// sweep is what this refresh's listings saw, for the lookups after it.
type sweep struct {
	repos map[string]restRepo // lower-case owner/name → as listed by a fresh owner
	open  map[string]PRObs    // item key text → an open PR or issue a fresh listing holds
}

// Refresh fetches GitHub state into a copy of prev. Whatever cannot be
// fetched keeps its previous observation, marked stale: absence is not
// evidence.
func Refresh(ctx context.Context, r Runner, prev *GitHub, o RefreshOptions) (*GitHub, RefreshReport) {
	g := clone(prev)
	c := rest{ctx, r}
	var rep RefreshReport
	fail := func(format string, a ...any) { rep.Errors = append(rep.Errors, fmt.Sprintf(format, a...)) }

	out, err := r.Gh(ctx, "api", "user", "--jq", ".login")
	user := strings.TrimSpace(string(out))
	if err != nil || user == "" {
		fail("gh unavailable, GitHub observations not refreshed: %v", err)
		for _, ow := range g.Owners {
			ow.Stale = true
		}
		return g, rep
	}
	g.User = user

	owners := o.Owners
	if len(owners) == 0 {
		owners = []string{user}
		out, err := r.Gh(ctx, "api", "user/orgs", "--paginate", "--jq", ".[].login")
		if err != nil {
			fail("listing orgs: %v (using previously known owners)", err)
			for k := range g.Owners {
				if k != strings.ToLower(user) {
					owners = append(owners, g.Owners[k].Login)
				}
			}
		} else {
			owners = append(owners, strings.Fields(string(out))...)
		}
	}

	prevPRs := prevItems(prev)
	merge := keySet(o.Merge)
	sw := sweep{repos: map[string]restRepo{}, open: map[string]PRObs{}}
	for _, login := range owners {
		key := strings.ToLower(login)
		ow := g.Owners[key]
		if ow == nil {
			ow = &Owner{Login: login}
			g.Owners[key] = ow
		}
		if rep.RateLimited {
			ow.Stale, ow.Reason = true, "rate limited; retry next sync"
			continue
		}
		f := ownerFetch{c: c, login: login, self: key == strings.ToLower(user), prev: ow.Repos, prevPRs: prevPRs, merge: merge}
		repos, listed, err := f.fetch()
		if err != nil {
			if rateLimited(err) {
				rep.RateLimited = true
				err = errors.New("rate limited; retry next sync")
			}
			var ge *GhError
			if errors.As(err, &ge) && strings.Contains(ge.Stderr, "SAML") {
				ow.Reachable, ow.Stale, ow.Reason = false, true, "SAML SSO: gh's token is not authorized for this org"
				fail("%s: unreachable (SAML SSO)", login)
				continue
			}
			ow.Stale, ow.Reason = true, err.Error()
			fail("%s: %v", login, err)
			continue
		}
		ow.Login, ow.Reachable, ow.Stale, ow.Reason, ow.FetchedAt, ow.Repos = login, true, false, "", o.Now.UTC(), repos
		for _, lr := range listed {
			sw.repos[strings.ToLower(lr.FullName)] = lr
		}
		for _, rr := range repos {
			for _, p := range rr.PRs {
				sw.open[item.PRKey(p.Repo, p.Number).String()] = p
			}
			for _, p := range rr.Issues {
				sw.open[item.IssueKey(p.Repo, p.Number).String()] = p
			}
		}
	}

	if !rep.RateLimited {
		if prs, err := fetchAuthored(c, user, sw, prevPRs, merge); err != nil {
			if rateLimited(err) {
				rep.RateLimited = true
			}
			fail("authored pull requests: %v", err)
		} else {
			g.Authored, g.AuthoredAt = prs, o.Now.UTC()
			for _, p := range prs {
				sw.open[item.PRKey(p.Repo, p.Number).String()] = p
			}
		}
	}
	if !rep.RateLimited {
		releases := keySet(o.Releases)
		lookupRefs(c, g, o.Keys, releases, sw, o.Now, &rep, fail)
		// A released() condition reads a listed repo's LatestRelease.
		for _, ow := range g.Owners {
			for i, rr := range ow.Repos {
				k := item.RepoKey(rr.Repo).String()
				if ref, ok := g.Refs[k]; ok && releases[k] {
					ow.Repos[i].LatestRelease = ref.LatestRelease
				}
			}
		}
	}
	return g, rep
}

func keySet(keys []item.Key) map[string]bool {
	s := make(map[string]bool, len(keys))
	for _, k := range keys {
		s[k.String()] = true
	}
	return s
}

// prevItems indexes the previous observation's open PRs and issues by key,
// so an unchanged one keeps its last comment without asking again.
func prevItems(prev *GitHub) map[string]PRObs {
	m := map[string]PRObs{}
	if prev == nil {
		return m
	}
	for _, ow := range prev.Owners {
		for _, rr := range ow.Repos {
			for _, p := range rr.PRs {
				m[item.PRKey(p.Repo, p.Number).String()] = p
			}
			for _, p := range rr.Issues {
				m[item.IssueKey(p.Repo, p.Number).String()] = p
			}
		}
	}
	for _, p := range prev.Authored {
		if _, ok := m[item.PRKey(p.Repo, p.Number).String()]; !ok {
			m[item.PRKey(p.Repo, p.Number).String()] = p
		}
	}
	return m
}

func clone(prev *GitHub) *GitHub {
	g := NewGitHub()
	if prev == nil {
		return g
	}
	g.User, g.Authored, g.AuthoredAt, g.RefsAt = prev.User, prev.Authored, prev.AuthoredAt, prev.RefsAt
	for k, v := range prev.Owners {
		c := *v
		g.Owners[k] = &c
	}
	for k, v := range prev.Refs {
		g.Refs[k] = v
	}
	for k, v := range prev.MergedPRs {
		g.MergedPRs[k] = v
	}
	return g
}

// ownerFetch lists one owner's repos with their open PRs and issues.
type ownerFetch struct {
	c       rest
	login   string
	self    bool             // the user's own account
	prev    []RepoObs        // the owner's previous repos: a fork keeps its parent
	prevPRs map[string]PRObs // previous open items: an unchanged one keeps its last comment
	merge   map[string]bool
}

func (f ownerFetch) fetch() ([]RepoObs, []restRepo, error) {
	qual := "org:" + f.login
	var listed []restRepo
	var err error
	switch {
	case f.self:
		qual = "user:" + f.login
		listed, err = list[restRepo](f.c, "user/repos?affiliation=owner&per_page=100")
	default:
		listed, err = list[restRepo](f.c, "orgs/"+url.PathEscape(f.login)+"/repos?type=all&per_page=100")
		if notFound(err) { // a user account, not an org
			qual = "user:" + f.login
			listed, err = list[restRepo](f.c, "users/"+url.PathEscape(f.login)+"/repos?type=owner&per_page=100")
		}
	}
	if err != nil {
		return nil, nil, err
	}
	sort.SliceStable(listed, func(i, j int) bool { return listed[i].PushedAt.After(listed[j].PushedAt) })

	parents := map[string]string{}
	for _, p := range f.prev {
		if p.Fork && p.Parent != "" {
			parents[strings.ToLower(p.Repo)] = p.Parent
		}
	}
	byName := map[string]*RepoObs{}
	repos := make([]RepoObs, 0, len(listed))
	for _, lr := range listed {
		rr := RepoObs{Repo: lr.FullName, Archived: lr.Archived, Fork: lr.Fork, Private: lr.Private, PushedAt: lr.PushedAt, DefaultBranch: lr.DefaultBranch}
		if lr.Fork {
			// The list has no parent; a fork's parent never changes, so it
			// is asked once.
			if p, ok := parents[strings.ToLower(lr.FullName)]; ok {
				rr.Parent = p
			} else {
				var one restRepo
				if err := f.c.get(repoPath(lr.FullName), &one); err != nil {
					return nil, nil, err
				}
				if one.Parent != nil {
					rr.Parent = one.Parent.FullName
				}
			}
		}
		repos = append(repos, rr)
	}
	for i := range repos {
		byName[strings.ToLower(repos[i].Repo)] = &repos[i]
	}

	prs, issues, err := f.open(qual, listed)
	if err != nil {
		return nil, nil, err
	}
	// Each repo with open PRs lists them once more for their branches.
	heads := map[string]map[int]restPull{}
	for _, it := range prs {
		repo := strings.ToLower(it.repo())
		if _, ok := byName[repo]; !ok || heads[repo] != nil {
			continue
		}
		pulls, err := list[restPull](f.c, repoPath(byName[repo].Repo)+"/pulls?state=open&per_page=100")
		if err != nil {
			return nil, nil, err
		}
		heads[repo] = map[int]restPull{}
		for _, p := range pulls {
			heads[repo][p.Number] = p
		}
	}
	for _, it := range prs {
		rr := byName[strings.ToLower(it.repo())]
		if rr == nil {
			continue
		}
		p, err := toItem(f.c, it, rr.Repo, item.PRKey(rr.Repo, it.Number), f.prevPRs)
		if err != nil {
			return nil, nil, err
		}
		if h, ok := heads[strings.ToLower(rr.Repo)][it.Number]; ok {
			withHead(&p, h)
		}
		if f.merge[item.PRKey(rr.Repo, it.Number).String()] {
			if err := mergeState(f.c, &p); err != nil {
				return nil, nil, err
			}
		}
		rr.PRs = append(rr.PRs, p)
	}
	for _, it := range issues {
		rr := byName[strings.ToLower(it.repo())]
		if rr == nil {
			continue
		}
		p, err := toItem(f.c, it, rr.Repo, item.IssueKey(rr.Repo, it.Number), f.prevPRs)
		if err != nil {
			return nil, nil, err
		}
		rr.Issues = append(rr.Issues, p)
	}
	for i := range repos {
		byUpdated(repos[i].PRs)
		byUpdated(repos[i].Issues)
	}
	return repos, listed, nil
}

// open finds the owner's open PRs and issues: one search each, or, when
// either is over the search cap, each repo with anything open lists its
// own (the cap split).
func (f ownerFetch) open(qual string, listed []restRepo) (prs, issues []restIssue, err error) {
	if len(listed) == 0 {
		return nil, nil, nil // no repos, nothing open (and search refuses the qualifier)
	}
	prs, morePRs, err := f.c.search("is:open is:pr " + qual)
	if err != nil {
		return nil, nil, err
	}
	issues, moreIssues, err := f.c.search("is:open is:issue " + qual)
	if err != nil {
		return nil, nil, err
	}
	if !morePRs && !moreIssues {
		return prs, issues, nil
	}
	var sPRs, sIssues []restIssue
	for _, lr := range listed {
		if lr.OpenIssuesCount == 0 {
			continue
		}
		all, err := list[restIssue](f.c, repoPath(lr.FullName)+"/issues?state=open&per_page=100", textJSON)
		if err != nil {
			return nil, nil, err
		}
		for _, it := range all {
			if it.RepositoryURL == "" {
				it.RepositoryURL = "https://api.github.com/repos/" + lr.FullName
			}
			if it.PullRequest != nil {
				sPRs = append(sPRs, it)
			} else {
				sIssues = append(sIssues, it)
			}
		}
	}
	if morePRs {
		prs = sPRs
	}
	if moreIssues {
		issues = sIssues
	}
	return prs, issues, nil
}

func byUpdated(ps []PRObs) {
	sort.SliceStable(ps, func(i, j int) bool { return ps[i].UpdatedAt.After(ps[j].UpdatedAt) })
}

// toItem turns a listed PR or issue into a PRObs, with its last comment: the
// previous one when the item hasn't changed since, else asked for.
func toItem(c rest, it restIssue, repo string, k item.Key, prevPRs map[string]PRObs) (PRObs, error) {
	p := toPR(it, repo)
	if it.Comments == 0 {
		return p, nil
	}
	if old, ok := prevPRs[k.String()]; ok && old.UpdatedAt.Equal(p.UpdatedAt) && !old.LastCommentAt.IsZero() {
		p.LastCommentAt, p.LastCommentAuthor = old.LastCommentAt, old.LastCommentAuthor
		return p, nil
	}
	var last []struct {
		User      *restUser `json:"user"`
		CreatedAt time.Time `json:"created_at"`
	}
	path := fmt.Sprintf("%s/issues/%d/comments?per_page=1&page=%d", repoPath(repo), it.Number, it.Comments)
	if err := c.get(path, &last); err != nil {
		return PRObs{}, err
	}
	if len(last) > 0 {
		p.LastCommentAt = last[len(last)-1].CreatedAt
		p.LastCommentAuthor, _ = last[len(last)-1].User.name()
	}
	return p, nil
}

func toPR(it restIssue, repo string) PRObs {
	p := PRObs{Repo: repo, Number: it.Number, Title: it.Title, State: strings.ToUpper(it.State), Draft: it.Draft,
		CreatedAt: it.CreatedAt, UpdatedAt: it.UpdatedAt, URL: it.HTMLURL}
	if it.PullRequest != nil && it.PullRequest.MergedAt != nil {
		p.State = "MERGED"
	}
	p.Author, p.AuthorIsBot = it.User.name()
	for _, l := range it.Labels {
		if l.Name != "" {
			p.Labels = append(p.Labels, l.Name)
		}
	}
	if it.BodyText != "" {
		body := it.BodyText
		if runes := []rune(body); len(runes) > 600 {
			body = string(runes[:600])
		}
		p.Body = body
	}
	return p
}

// withHead takes a PR's branch from GitHub's PR read, and its creation: the
// search index can have it a second off.
func withHead(p *PRObs, h restPull) {
	p.Draft, p.HeadRef = h.Draft, h.Head.Ref
	if !h.CreatedAt.IsZero() {
		p.CreatedAt = h.CreatedAt
	}
	if h.Head.Repo != nil {
		p.HeadRepo = strings.ToLower(h.Head.Repo.FullName)
	}
}

// mergeState asks for a PR on its own: only that endpoint has GitHub's
// mergeable_state.
func mergeState(c rest, p *PRObs) error {
	var one restPull
	if err := c.get(fmt.Sprintf("%s/pulls/%d", repoPath(p.Repo), p.Number), &one); err != nil {
		return err
	}
	withHead(p, one)
	p.MergeState = strings.ToUpper(one.MergeableState)
	return nil
}

// fetchAuthored lists the user's open PRs everywhere. One a listing already
// holds takes its branch from there; the others ask for theirs.
func fetchAuthored(c rest, user string, sw sweep, prevPRs map[string]PRObs, merge map[string]bool) ([]PRObs, error) {
	items, more, err := c.search("is:pr is:open archived:false author:" + user)
	if err != nil {
		return nil, err
	}
	if more {
		return nil, fmt.Errorf("more than %d authored pull requests", searchCap)
	}
	prs := make([]PRObs, 0, len(items))
	for _, it := range items {
		repo := it.repo()
		if repo == "" {
			continue
		}
		k := item.PRKey(repo, it.Number)
		if seen, ok := sw.open[k.String()]; ok {
			prs = append(prs, seen)
			continue
		}
		p, err := toItem(c, it, repo, k, prevPRs)
		if err != nil {
			return nil, err
		}
		if err := mergeState(c, &p); err != nil {
			return nil, err
		}
		if !merge[k.String()] {
			p.MergeState = ""
		}
		prs = append(prs, p)
	}
	return prs, nil
}

// LookupRefs re-reads just keys on GitHub into a copy of prev: after a step
// changed them (a branch deleted, or made again by an undo), so items say so
// without waiting for the next full sync (Court, 2026-10-20). RefsAt, the
// last full lookup, stays. The error says what failed.
func LookupRefs(ctx context.Context, r Runner, prev *GitHub, keys []item.Key, now time.Time) (*GitHub, error) {
	g := clone(prev)
	var rep RefreshReport
	var errs []string
	lookupRefs(rest{ctx, r}, g, keys, nil, sweep{}, now, &rep, func(f string, a ...any) { errs = append(errs, fmt.Sprintf(f, a...)) })
	if prev != nil {
		g.RefsAt = prev.RefsAt
	}
	if len(errs) > 0 {
		return g, errors.New(strings.Join(errs, "; "))
	}
	return g, nil
}

// lookupRefs works out each key's Ref. A key a fresh listing holds takes its
// Ref from there; the rest ask GitHub, a branch's repo once for all its
// branches. A key whose read failed for any reason but a 404 keeps its
// previous Ref; a rate limit stops the lookups.
func lookupRefs(c rest, g *GitHub, keys []item.Key, releases map[string]bool, sw sweep, now time.Time, rep *RefreshReport, fail func(string, ...any)) {
	anyOK, failed := false, 0
	set := func(k item.Key, ref Ref) {
		g.Refs[k.String()] = ref
		anyOK = true
	}
	// stop reports whether err ends this key's lookup; a rate limit ends them all.
	stop := func(k item.Key, err error) bool {
		if err == nil {
			return false
		}
		if rateLimited(err) {
			rep.RateLimited = true
		}
		failed++
		if failed <= 3 {
			fail("looking up %s: %v", k, err)
		}
		return true
	}
	repoInfo := map[string]restRepo{}
	repoGone := map[string]bool{}
	readRepo := func(repo string) (restRepo, bool, error) {
		lk := strings.ToLower(repo)
		if lr, ok := sw.repos[lk]; ok {
			return lr, true, nil
		}
		if lr, ok := repoInfo[lk]; ok {
			return lr, true, nil
		}
		if repoGone[lk] {
			return restRepo{}, false, nil
		}
		var lr restRepo
		err := c.get(repoPath(repo), &lr)
		if notFound(err) {
			repoGone[lk] = true
			return restRepo{}, false, nil
		}
		if err != nil {
			return restRepo{}, false, err
		}
		repoInfo[lk] = lr
		return lr, true, nil
	}

	branches := map[string][]item.Key{}
	var order []string
	for _, k := range keys {
		if rep.RateLimited {
			break
		}
		switch k.Kind {
		case item.KindRepo:
			lr, ok, err := readRepo(k.Repo())
			if stop(k, err) {
				continue
			}
			if !ok {
				set(k, Ref{Exists: false})
				continue
			}
			ref := Ref{Exists: true, Archived: lr.Archived, UpdatedAt: lr.PushedAt}
			if releases[k.String()] {
				var rel struct {
					PublishedAt time.Time `json:"published_at"`
				}
				err := c.get(repoPath(k.Repo())+"/releases/latest", &rel)
				if !notFound(err) && stop(k, err) {
					continue
				}
				ref.LatestRelease = rel.PublishedAt
			}
			set(k, ref)
		case item.KindPR:
			if p, ok := sw.open[k.String()]; ok {
				set(k, Ref{Exists: true, State: p.State, UpdatedAt: p.UpdatedAt})
				continue
			}
			var pr restPull
			err := c.get(fmt.Sprintf("%s/pulls/%d", repoPath(k.Repo()), k.Number), &pr)
			if notFound(err) {
				set(k, Ref{Exists: false})
				continue
			}
			if stop(k, err) {
				continue
			}
			st := strings.ToUpper(pr.State)
			if pr.MergedAt != nil {
				st = "MERGED"
			}
			set(k, Ref{Exists: true, State: st, UpdatedAt: pr.UpdatedAt})
		case item.KindIssue:
			if p, ok := sw.open[k.String()]; ok {
				set(k, Ref{Exists: true, State: p.State, UpdatedAt: p.UpdatedAt})
				continue
			}
			var is restIssue
			err := c.get(fmt.Sprintf("%s/issues/%d", repoPath(k.Repo()), k.Number), &is)
			// The issues endpoint answers a PR's number too; as an issue
			// key, that PR doesn't exist.
			if notFound(err) || (err == nil && is.PullRequest != nil) {
				set(k, Ref{Exists: false})
				continue
			}
			if stop(k, err) {
				continue
			}
			set(k, Ref{Exists: true, State: strings.ToUpper(is.State), UpdatedAt: is.UpdatedAt})
		case item.KindBranch:
			lk := strings.ToLower(k.Repo())
			if branches[lk] == nil {
				order = append(order, lk)
			}
			branches[lk] = append(branches[lk], k)
		}
	}
	for _, lk := range order {
		if rep.RateLimited {
			break
		}
		ks := branches[lk]
		lr, ok, err := readRepo(ks[0].Repo())
		if stop(ks[0], err) {
			continue
		}
		if !ok {
			for _, k := range ks {
				set(k, Ref{Exists: false})
			}
			continue
		}
		branchRef := func(tip string) Ref {
			if tip == "" {
				return Ref{Exists: false}
			}
			return Ref{Exists: true, Tip: tip, RepoID: lr.NodeID, Permission: lr.permission()}
		}
		type gitRef struct {
			Ref    string `json:"ref"`
			Object struct {
				SHA string `json:"sha"`
			} `json:"object"`
		}
		if len(ks) > branchListAbove {
			all, err := list[gitRef](c, repoPath(ks[0].Repo())+"/git/matching-refs/heads/?per_page=100")
			if empty(err) {
				all, err = nil, nil
			}
			if stop(ks[0], err) {
				continue
			}
			tips := map[string]string{}
			for _, r := range all {
				tips[strings.TrimPrefix(r.Ref, "refs/heads/")] = r.Object.SHA
			}
			for _, k := range ks {
				set(k, branchRef(tips[k.Branch]))
			}
			continue
		}
		for _, k := range ks {
			var r gitRef
			err := c.get(repoPath(k.Repo())+"/git/ref/heads/"+refPath(k.Branch), &r)
			if notFound(err) || empty(err) {
				set(k, Ref{Exists: false})
				continue
			}
			if stop(k, err) {
				if rep.RateLimited {
					break
				}
				continue
			}
			set(k, branchRef(r.Object.SHA))
		}
	}
	if failed > 3 {
		fail("looking up %d more items failed", failed-3)
	}
	if anyOK {
		g.RefsAt = now.UTC()
	}
}

// empty reports GitHub's 409 for a repository with no commits: it has no
// branches.
func empty(err error) bool {
	var ge *GhError
	return errors.As(err, &ge) && strings.Contains(ge.Stderr, "HTTP 409")
}
