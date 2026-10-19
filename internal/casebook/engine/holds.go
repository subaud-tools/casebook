package engine

import (
	"fmt"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/subaud-tools/casebook/internal/casebook/item"
	"github.com/subaud-tools/casebook/internal/casebook/observe"
)

// Hold kinds.
const (
	HoldWorktree     = "worktree"
	HoldCheckedOut   = "checked-out"
	HoldLongLived    = "long-lived"
	HoldArchived     = "archived"
	HoldMergeBlocked = "merge-blocked"
	HoldOtherMac     = "other-mac"
	HoldOpenPR       = "open-pr"
	HoldNothingHere  = "nothing-here" // made by apply.Build only
)

// Hold is one thing that stands in the way of an item's decision. Holds are
// worked out on every build from what casebook observes, never stored.
type Hold struct {
	Kind    string             `json:"kind"`
	Text    string             `json:"text"`          // plain words, shown everywhere
	Fix     string             `json:"fix,omitempty"` // what to do about it (item page)
	By      string             `json:"by,omitempty"`  // key of the item that causes it
	Stops   []item.Disposition `json:"stops"`
	Local   bool               `json:"local,omitempty"`  // stops only the local delete on Machine
	Remote  bool               `json:"remote,omitempty"` // stops only the GitHub delete
	Machine string             `json:"machine,omitempty"`
}

// Copy is one place a branch is: a Mac's clone, or GitHub.
type Copy struct {
	Machine  string `json:"machine,omitempty"` // "" = GitHub
	Path     string `json:"path,omitempty"`    // clone path
	Tip      string `json:"tip,omitempty"`
	Worktree string `json:"worktree,omitempty"` // worktree path it is checked out in
	Head     bool   `json:"head,omitempty"`     // checked out in the clone itself
	Absent   bool   `json:"absent,omitempty"`   // "not there"
	Landed   string `json:"landed,omitempty"`   // GitHub row: the item's LandedHow
}

// Stopped reports whether a hold stops disposition d for the whole item. A
// hold on only the local or only the GitHub delete doesn't.
func (it Item) Stopped(d item.Disposition) bool {
	for _, h := range it.Holds {
		if !h.Local && !h.Remote && slices.Contains(h.Stops, d) {
			return true
		}
	}
	return false
}

// GitHubCopy returns the branch's copy on GitHub when one is known to exist.
func (it Item) GitHubCopy() (Copy, bool) {
	for _, c := range it.Copies {
		if c.Machine == "" && !c.Absent && c.Tip != "" {
			return c, true
		}
	}
	return Copy{}, false
}

// wtUse is one linked worktree that has a branch checked out.
type wtUse struct {
	key     item.Key
	machine string
	path    string
	dirty   bool
}

// place is one clone on one machine.
type place struct{ machine, path string }

// holds works out what stands in the way of it's decision, and the keys
// that must run first in the same job.
func (b *builder) holds(it *Item) ([]Hold, []string) {
	var hs []Hold
	var needs []string
	switch it.Kind {
	case item.KindBranch:
		def := ""
		if r, ok := b.f.repos[item.RepoKey(it.Repo).String()]; ok {
			def = r.DefaultBranch
		}
		if observe.LongLived(it.Key.Branch, def) || b.longLived[it.ID] {
			hs = append(hs, Hold{Kind: HoldLongLived, Text: it.Key.Branch + " is a long-lived branch: casebook never deletes it",
				Fix: "Decide it again: Keep it or Stop tracking it.", Stops: []item.Disposition{item.Delete}})
		}
		for _, u := range b.branchUses[it.ID] {
			name := filepath.Base(u.path)
			h := Hold{Kind: HoldWorktree, By: u.key.String(), Stops: []item.Disposition{item.Delete}, Local: true, Machine: u.machine}
			if u.dirty {
				h.Text = fmt.Sprintf("in use by worktree %s on %s, which has uncommitted changes", name, u.machine)
				h.Fix = "Commit or discard its changes, then decide that worktree Remove it."
			} else {
				if wt := b.items[u.key.String()]; wt != nil && wt.Status == item.StatusToApply && wt.Decision != nil && wt.Decision.Disposition == item.Delete {
					needs = append(needs, u.key.String())
					continue
				}
				h.Text = fmt.Sprintf("in use by worktree %s on %s", name, u.machine)
				h.Fix = "Decide that worktree Remove it and review removes it first, then deletes this branch."
			}
			hs = append(hs, h)
		}
		for _, p := range b.branchHeads[it.ID] {
			hs = append(hs, Hold{Kind: HoldCheckedOut, Text: fmt.Sprintf("checked out in the clone itself (%s) on %s", p.path, p.machine),
				Fix: "Switch that clone to another branch.", Stops: []item.Disposition{item.Delete}, Local: true, Machine: p.machine})
		}
		hs = append(hs, b.otherMac(it)...)
		prs := b.branchPRs[it.ID]
		sort.Ints(prs)
		for _, n := range prs {
			hs = append(hs, Hold{Kind: HoldOpenPR, Text: fmt.Sprintf("open PR #%d uses this branch: deleting it on GitHub closes that PR", n),
				Fix: fmt.Sprintf("Merge or close PR #%d first, or decide this again.", n), By: item.PRKey(it.Repo, n).String(),
				Stops: []item.Disposition{item.Delete}, Remote: true})
		}
	case item.KindPR, item.KindIssue:
		if r, ok := b.f.repos[item.RepoKey(it.Repo).String()]; ok && r.Archived {
			hs = append(hs, Hold{Kind: HoldArchived, Text: r.Repo + " is archived: GitHub refuses any change to it",
				Fix: "Unarchive it on GitHub, or decide this again.", Stops: []item.Disposition{item.Close, item.Merge}})
		}
		if it.Kind == item.KindPR {
			if text, fix := mergeBlocked(b.f.prs[it.ID].MergeState); text != "" {
				hs = append(hs, Hold{Kind: HoldMergeBlocked, Text: text, Fix: fix, Stops: []item.Disposition{item.Merge}})
			}
		}
	case item.KindWorktree:
		hs = append(hs, b.otherMac(it)...)
	}
	return hs, needs
}

func mergeBlocked(state string) (text, fix string) {
	switch state {
	case "BEHIND":
		return "merge blocked: the PR is behind its base branch", "Update the branch on GitHub, then sync."
	case "BLOCKED":
		return "merge blocked: a required check or review is missing", "Get the check or review on GitHub, then sync."
	case "DIRTY":
		return "merge blocked: the PR has conflicts with its base branch", "Resolve the conflicts on GitHub, then sync."
	}
	return "", ""
}

// otherMac holds the local delete of an item whose local copies are all on
// machines other than this one: one hold per machine.
func (b *builder) otherMac(it *Item) []Hold {
	if b.in.Machine == "" || len(it.Locations) == 0 {
		return nil
	}
	var others []string
	for _, l := range it.Locations {
		m, _, _ := strings.Cut(l, ":")
		if m == b.in.Machine {
			return nil
		}
		if !slices.Contains(others, m) {
			others = append(others, m)
		}
	}
	sort.Strings(others)
	var hs []Hold
	for _, m := range others {
		hs = append(hs, Hold{Kind: HoldOtherMac, Text: "its local copy is only on " + m, Fix: "Review it on " + m + ": its local copy is deleted there.",
			Stops: []item.Disposition{item.Delete}, Local: true, Machine: m})
	}
	return hs
}

// copies lists where a branch is: one row per machine with a snapshot, in
// machine order, then GitHub.
func (b *builder) copies(it *Item) []Copy {
	if it.Kind != item.KindBranch {
		return nil
	}
	machines := make([]string, 0, len(b.snaps))
	for m := range b.snaps {
		machines = append(machines, m)
	}
	sort.Strings(machines)
	var out []Copy
	for _, m := range machines {
		if c, ok := b.branchCopies[it.ID][m]; ok {
			out = append(out, c)
		} else {
			out = append(out, Copy{Machine: m, Absent: true})
		}
	}
	gh := Copy{Landed: it.LandedHow}
	if r, ok := b.in.GitHub.Refs[it.ID]; ok {
		gh.Tip, gh.Absent = r.Tip, !r.Exists
	}
	if gh.Tip == "" && !gh.Absent {
		gh.Tip = b.remoteTips[it.ID]
	}
	if gh.Tip == "" {
		gh.Absent = true
	}
	if gh.Absent {
		gh.Tip = ""
	}
	return append(out, gh)
}
