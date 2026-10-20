package serve

import (
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/apply"
	"github.com/subaud-tools/casebook/internal/casebook/engine"
	"github.com/subaud-tools/casebook/internal/casebook/item"
	"github.com/subaud-tools/casebook/internal/casebook/propose"
)

// Index is the live item index: the engine's build over the GitHub cache,
// the snapshots and the decisions, rebuilt when the casebook repo's HEAD moves
// or a decision is made here.
type Index struct {
	mu      sync.RWMutex
	res     engine.Result
	byKey   map[string]engine.Item
	builtAt time.Time
	head    string
	gen     uint64 // bumped on every set: which build a cached count belongs to
	// Applied is each key casebook verified done since an observation (serve
	// sets it): such an item has left To apply before a sync sees it gone.
	// decided is when an item's current decision was made.
	Applied func(since time.Time, decided func(key string) time.Time) map[string]bool
	// Machine is this Mac: an item with a copy on another Mac isn't done
	// until that copy is gone, whatever ran here.
	Machine string
	// Verified is a key's verified steps that weren't undone, from every
	// job: a branch is done only when each of its copies is gone.
	Verified func(key string) []apply.JobStep
}

func (x *Index) set(r engine.Result, head string, at time.Time) {
	m := make(map[string]engine.Item, len(r.Items))
	for _, it := range r.Items {
		m[it.ID] = it
	}
	x.mu.Lock()
	x.res, x.byKey, x.head, x.builtAt = r, m, head, at
	x.gen++
	x.mu.Unlock()
}

// Head is the casebook repo commit the index was built from.
func (x *Index) Head() string {
	x.mu.RLock()
	defer x.mu.RUnlock()
	return x.head
}

// Item returns one item.
func (x *Index) Item(key string) (engine.Item, bool) {
	x.mu.RLock()
	defer x.mu.RUnlock()
	it, ok := x.byKey[key]
	return it, ok
}

// InAttention reports whether key is currently in the engine's attention set.
// Items whose earlier decision has expired and returned to attention (e.g.
// a wait that lapsed) are included. This uses the engine's own Attention()
// criteria: status new, due, drift, or conflict.
func (x *Index) InAttention(key string) bool {
	x.mu.RLock()
	defer x.mu.RUnlock()
	for _, it := range x.res.Attention() {
		if it.ID == key {
			return true
		}
	}
	return false
}

// Views of the attention list (casebook workbench spec §3.2).
const (
	ViewNew      = "new"      // undecided
	ViewDue      = "due"      // due, drift, conflict
	ViewProposed = "proposed" // a proposal is pending
	ViewAll      = "all"      // all attention
	// ViewToApply is the To apply section's list: decided items waiting to be
	// applied (spec §5.1). They aren't attention items; this view reads every
	// item.
	ViewToApply = "to-apply"
	// ViewTracked is every item casebook tracks, in key order: the Not now
	// picker searches it (with kind and q) for the PR, issue or repo a
	// condition names.
	ViewTracked = "tracked"
)

// Query filters a view.
type Query struct {
	View     string
	Kind     string
	Repo     string             // owner/name or owner
	Text     string             // substring of key or title
	Relation string             // incoming / outgoing / self (own)
	Bot      string             // "bot" or "human"
	Age      string             // casebook duration (<n>h, <n>d, <n>w); matches items older than the duration
	Rule     string             // rule id whose matched keys are in MatchSet
	MatchSet map[string]bool    // the keys a rule matched (Rule != ""): only those items; nil: no such filter
	Group    string             // a group's ID (GroupView.ID): only its items
	Open     map[string]bool    // the groups the page has open (open=): only their items; nil: every group's
	Flat     bool               // group=false: one list, newest first; items keep their Group and Groups still count
	Filtered bool               // filters=: every item, whatever its status, in MatchSet
	Ran      map[string]RunMark // ViewRun: each key a job ran on, and what happened (runMarks)
	Now      time.Time          // clock for the age filter; zero falls back to time.Now()
	Offset   int
	Limit    int
}

func inView(view string, it engine.Item, pending map[string]propose.Proposal) bool {
	switch view {
	case ViewNew:
		return it.Status == item.StatusNew
	case ViewDue:
		return cameBack(it)
	case ViewProposed:
		_, ok := pending[it.ID]
		return ok
	case ViewToApply:
		return it.Status == item.StatusToApply && it.Decision != nil
	}
	return true
}

// applied is Applied for this build (nil without one). The caller holds x.mu.
func (x *Index) applied() map[string]bool {
	if x.Applied == nil {
		return nil
	}
	done := x.Applied(x.builtAt, func(key string) time.Time {
		if it, ok := x.byKey[key]; ok && it.Decision != nil {
			return it.Decision.DecidedAt
		}
		return time.Time{}
	})
	for key := range done {
		it, ok := x.byKey[key]
		if !ok {
			continue
		}
		var steps []apply.JobStep
		if x.Verified != nil && it.Kind == item.KindBranch {
			steps = x.Verified(key)
		}
		if !copiesGone(it, x.Machine, steps) {
			delete(done, key)
		}
	}
	return done
}

// leftOpenInView reports whether an item left open belongs to an Attention
// view's left-open group: the view it would be in undecided (new),
// proposed when it has a proposal, and all. Due is for decisions that came back; To apply and tracked have no
// left-open group.
func leftOpenInView(view string, it engine.Item, pending map[string]propose.Proposal) bool {
	switch view {
	case ViewNew, ViewAll:
		return true
	case ViewProposed:
		_, ok := pending[it.ID]
		return ok
	}
	return false
}

// grouped reports whether view's items are grouped: the Attention views.
func grouped(view string) bool { return view != ViewToApply && view != ViewTracked && view != ViewRun }

// groupIn is it's group in q's view: run's from its mark, else groupOf.
func groupIn(q Query, it engine.Item, pending map[string]propose.Proposal) GroupView {
	if q.View == ViewRun {
		m := q.Ran[it.ID]
		m.Group, _ = runGroupFor(m, it.Status, false)
		return runGroupOf(m)
	}
	return groupOf(q.View, it, pending)
}

// ran is the items q.Ran names, in run's order: by group, then latest job
// first, then key.
// An item to apply again whose job has finished is left out (runGroupFor).
// The caller holds x.mu.
func (x *Index) ran(q Query) []engine.Item {
	var src []engine.Item
	group := map[string]string{}
	applied := x.applied()
	for _, it := range x.res.Items {
		m, ok := q.Ran[it.ID]
		if !ok {
			continue
		}
		toApply := inView(ViewToApply, it, nil) && !applied[it.ID]
		g, in := runGroupFor(m, it.Status, toApply)
		if !in {
			continue
		}
		group[it.ID] = g
		src = append(src, it)
	}
	sort.SliceStable(src, func(i, j int) bool {
		a, b := q.Ran[src[i].ID], q.Ran[src[j].ID]
		if oa, ob := runOrder(group[src[i].ID]), runOrder(group[src[j].ID]); oa != ob {
			return oa < ob
		}
		if a.Job != b.Job {
			return a.Job > b.Job
		}
		return src[i].ID < src[j].ID
	})
	return src
}

// groupOf is it's group in view, given the pending proposals: in To apply
// what will happen to it (applyGroupOf), none in tracked. The group's Total
// (and a To apply group's Label, which counts) is left to the caller.
func groupOf(view string, it engine.Item, pending map[string]propose.Proposal) GroupView {
	if view == ViewToApply {
		return applyGroupOf(it)
	}
	if !grouped(view) {
		return GroupView{}
	}
	if cameBack(it) {
		return GroupView{ID: GroupCameBack, Label: GroupCameBackLabel}
	}
	p, ok := pending[it.ID]
	if !ok {
		return GroupView{ID: GroupNone, Label: GroupNoneLabel}
	}
	d := item.Disposition(p.Disposition)
	if d == item.Watch {
		d = item.Wait
	}
	g := GroupView{Source: p.Source, Disposition: string(d), Label: string(d)}
	if c, i := choiceOf(it.Kind, d); i >= 0 {
		g.Label, g.Outward, g.Many = c.Label, c.Outward, c.Many
	}
	g.ID = g.Source + "|" + g.Disposition + "|" + g.Label
	return g
}

// applyGroupOf is a decided item's group in To apply: what will happen to
// it, ID "<disposition>|<kind>". Its Label is ApplyLabel once counted.
func applyGroupOf(it engine.Item) GroupView {
	if it.Decision == nil {
		return GroupView{}
	}
	d := it.Decision.Disposition
	g := GroupView{ID: string(d) + "|" + string(it.Kind), Disposition: string(d), Outward: true}
	if c, i := choiceOf(it.Kind, d); i >= 0 {
		g.Outward, g.Many = c.Outward, c.Many
	}
	return g
}

// kindOrder is the order To apply lists its groups' kinds in.
var kindOrder = []item.Kind{item.KindRepo, item.KindPR, item.KindIssue, item.KindBranch, item.KindWorktree}

// applyGroupsInOrder labels To apply's groups with their counts and orders
// them by kind (kindOrder), then by the kind's choice order.
func applyGroupsInOrder(gs []GroupView) {
	place := func(g GroupView) (int, int) {
		d, k, _ := strings.Cut(g.ID, "|")
		_, c := choiceOf(item.Kind(k), item.Disposition(d))
		return slices.Index(kindOrder, item.Kind(k)), c
	}
	for i := range gs {
		d, k, _ := strings.Cut(gs[i].ID, "|")
		gs[i].Label = item.ApplyLabel(item.Kind(k), item.Disposition(d), gs[i].Total)
	}
	sort.SliceStable(gs, func(i, j int) bool {
		ki, ci := place(gs[i])
		kj, cj := place(gs[j])
		if ki != kj {
			return ki < kj
		}
		return ci < cj
	})
}

// cameBack reports whether it was decided and came back for a decision:
// due, drift or conflict.
func cameBack(it engine.Item) bool {
	return it.Status == item.StatusDue || it.Status == item.StatusDrift || it.Status == item.StatusConflict
}

// choiceOf is d's choice for kind k and its place among k's choices; -1
// when k offers no such choice.
func choiceOf(k item.Kind, d item.Disposition) (item.Choice, int) {
	for i, c := range item.Choices(k) {
		if c.Disposition == d {
			return c, i
		}
	}
	return item.Choice{}, -1
}

// matches reports whether it, in the group named group (its GroupView.ID,
// "" for none), passes q's filters.
func matches(q Query, it engine.Item, group string) bool {
	if q.Group != "" && group != q.Group {
		return false
	}
	if q.Open != nil && !q.Open[group] {
		return false
	}
	if q.Kind != "" && string(it.Kind) != q.Kind {
		return false
	}
	if q.Repo != "" && it.Repo != strings.ToLower(q.Repo) && !strings.HasPrefix(it.Repo, strings.ToLower(q.Repo)+"/") {
		return false
	}
	if q.Text != "" {
		t := strings.ToLower(q.Text)
		if !strings.Contains(strings.ToLower(it.ID), t) && !strings.Contains(strings.ToLower(it.Title), t) {
			return false
		}
	}
	if q.Relation != "" {
		// The engine stores relation as "incoming", "outgoing", "own", and
		// relation aliases (e.g. "fork-of:X"). Map "self" → "own" for the
		// query convenience the brief names.
		want := q.Relation
		if want == "self" {
			want = "own"
		}
		if it.Relation != want {
			return false
		}
	}
	if q.Bot != "" {
		switch q.Bot {
		case "bot":
			if !it.AuthorIsBot {
				return false
			}
		case "human":
			if it.AuthorIsBot {
				return false
			}
		}
	}
	if q.Age != "" {
		d, err := item.ParseDuration(strings.TrimSpace(q.Age))
		if err != nil || d <= 0 {
			// Unparseable age: exclude all items (strict: bad filter, no results).
			return false
		}
		if it.CreatedAt.IsZero() {
			return false
		}
		now := q.Now
		if now.IsZero() {
			now = time.Now()
		}
		threshold := now.Add(-d)
		if !it.CreatedAt.Before(threshold) {
			return false
		}
	}
	if q.MatchSet != nil {
		if !q.MatchSet[it.ID] {
			return false
		}
	}
	return true
}

// listed is every item q's view lists (every page), each with its group,
// and the view's groups in the order it lists them. An Attention view's
// items are newest first (engine.NewerFirst) after the items that came
// back, and its groups go by their newest item, "Came back" first; To
// apply keeps key order and its groups go by kind, then choice
// (applyGroupsInOrder); tracked keeps key order. The caller holds x.mu.
func (x *Index) listed(q Query, pending map[string]propose.Proposal) ([]ItemView, []GroupView) {
	src := x.res.Items
	cameBackFirst := func() {
		// What came back leads, grouped (its group is listed first) or flat.
		sort.SliceStable(src, func(i, j int) bool {
			if a, b := cameBack(src[i]), cameBack(src[j]); a != b {
				return a
			}
			return engine.NewerFirst(src[i], src[j])
		})
	}
	switch {
	case q.Filtered:
		// Narrowed by filters or a rule: what came back still leads.
		src = slices.Clone(x.res.Items)
		cameBackFirst()
	case q.View == ViewRun:
		src = x.ran(q)
	case grouped(q.View):
		src = slices.Clone(x.res.Attention())
		cameBackFirst()
	}
	var out []ItemView
	groups := map[string]*GroupView{}
	var gs []string
	var done map[string]bool
	if q.View == ViewToApply && !q.Filtered {
		done = x.applied()
	}
	for _, it := range src {
		if !q.Filtered && q.View != ViewRun && !inView(q.View, it, pending) || done[it.ID] {
			continue
		}
		g := groupIn(q, it, pending)
		if !matches(q, it, g.ID) {
			continue
		}
		var prop *propose.Proposal
		if p, ok := pending[it.ID]; ok {
			prop = &p
		}
		v := newItemView(it, prop)
		v.Group = g.ID
		if m, ok := q.Ran[it.ID]; ok && q.View == ViewRun {
			m.Group = g.ID
			v.Ran = &m
		}
		out = append(out, v)
		if g.ID == "" {
			continue
		}
		if groups[g.ID] == nil {
			groups[g.ID] = &g
			gs = append(gs, g.ID)
		}
		groups[g.ID].Total++
	}
	views := make([]GroupView, 0, len(gs))
	for _, id := range gs {
		views = append(views, *groups[id])
	}
	if q.View == ViewToApply {
		applyGroupsInOrder(views)
	}
	return out, views
}

// List returns the page of items in a view and the view's total. An
// Attention view lists its items group by group (Groups' order), newest
// first in each; with q.Flat, newest first across its groups. To apply
// lists group by group too, in key order in each; tracked keeps key order.
func (x *Index) List(q Query, pending map[string]propose.Proposal) ([]ItemView, int) {
	x.mu.RLock()
	defer x.mu.RUnlock()
	out, gs := x.listed(q, pending)
	if (grouped(q.View) || q.View == ViewToApply || q.View == ViewRun) && !q.Flat {
		order := make(map[string]int, len(gs))
		for i, g := range gs {
			order[g.ID] = i
		}
		sort.SliceStable(out, func(i, j int) bool { return order[out[i].Group] < order[out[j].Group] })
	}
	return pageOf(out, q)
}

// Groups is an Attention or To apply view's groups with their counts over
// every page (q's filters apply, a group filter aside; not its Offset and
// Limit), in the order List lists them. Tracked has none.
func (x *Index) Groups(q Query, pending map[string]propose.Proposal) []GroupView {
	x.mu.RLock()
	defer x.mu.RUnlock()
	q.Group, q.Open = "", nil
	_, gs := x.listed(q, pending)
	return gs
}

// Keys is every key q's view lists (every page; q's Offset and Limit don't
// apply), the left-open group aside.
func (x *Index) Keys(q Query, pending map[string]propose.Proposal) []string {
	x.mu.RLock()
	defer x.mu.RUnlock()
	src := x.res.Attention()
	if q.Filtered || q.View == ViewToApply || q.View == ViewTracked {
		src = x.res.Items
	}
	if q.View == ViewRun {
		src = x.ran(q)
	}
	var out []string
	var done map[string]bool
	if q.View == ViewToApply && !q.Filtered {
		done = x.applied()
	}
	for _, it := range src {
		if (q.Filtered || q.View == ViewRun || inView(q.View, it, pending)) && !done[it.ID] && matches(q, it, groupIn(q, it, pending).ID) {
			out = append(out, it.ID)
		}
	}
	sort.Strings(out)
	return out
}

// LeftOpen returns the page of an Attention view's left-open group (q's
// filters apply; its Offset and Limit page the group) and the group's
// total: the kept items still open that the view would list, newest first.
// They need no decision, so List and Counts leave them out.
func (x *Index) LeftOpen(q Query, pending map[string]propose.Proposal) ([]ItemView, int) {
	// A filtered list lists its kept items with the rest: no left-open group.
	if q.Filtered || q.View == ViewToApply || q.View == ViewTracked || q.View == ViewRun {
		return nil, 0
	}
	x.mu.RLock()
	defer x.mu.RUnlock()
	var out []ItemView
	for _, it := range x.res.LeftOpen() {
		// The left-open group is no group: a group filter leaves it empty.
		if !leftOpenInView(q.View, it, pending) || !matches(q, it, "") {
			continue
		}
		var prop *propose.Proposal
		if p, ok := pending[it.ID]; ok {
			prop = &p
		}
		out = append(out, newItemView(it, prop))
	}
	sort.SliceStable(out, func(i, j int) bool { return engine.NewerFirst(out[i].Item, out[j].Item) })
	return pageOf(out, q)
}

// pageOf cuts out q's page of out and returns it with out's length.
func pageOf(out []ItemView, q Query) ([]ItemView, int) {
	total := len(out)
	if q.Limit <= 0 || q.Limit > 500 {
		q.Limit = 200
	}
	if q.Offset > total {
		q.Offset = total
	}
	end := min(q.Offset+q.Limit, total)
	return out[q.Offset:end], total
}

// Counts returns each view's size.
func (x *Index) Counts(pending map[string]propose.Proposal) map[string]int {
	x.mu.RLock()
	defer x.mu.RUnlock()
	c := map[string]int{}
	for _, it := range x.res.Attention() {
		for _, v := range []string{ViewNew, ViewDue, ViewProposed, ViewAll} {
			if inView(v, it, pending) {
				c[v]++
			}
		}
	}
	done := x.applied()
	for _, it := range x.res.Items {
		if inView(ViewToApply, it, pending) && !done[it.ID] {
			c[ViewToApply]++
		}
	}
	return c
}

// Notices are the engine's notices (unreachable owners and the like).
func (x *Index) Notices() []string {
	x.mu.RLock()
	defer x.mu.RUnlock()
	return x.res.Notices
}

// Result returns the current engine.Result. Callers that need to evaluate
// rules against the live index use this to get a consistent snapshot.
func (x *Index) Result() engine.Result {
	x.mu.RLock()
	defer x.mu.RUnlock()
	return x.res
}

// Gen is the index's build number: it changes whenever the index does.
func (x *Index) Gen() uint64 {
	x.mu.RLock()
	defer x.mu.RUnlock()
	return x.gen
}

// BuiltAt is when the index was last built.
func (x *Index) BuiltAt() time.Time {
	x.mu.RLock()
	defer x.mu.RUnlock()
	return x.builtAt
}
