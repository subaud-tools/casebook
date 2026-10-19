package rules

// Examples are the starter rules a new casebook-data gets, on (Court,
// 2026-10-17: examples start on; a rule is on once saved). They are ordinary
// files from then on: edited, turned off or deleted like any other.
func Examples() []Rule {
	out := []Rule{
		{
			ID:   "landed-branches",
			Name: "Landed branches",
			Match: []Condition{
				{Field: "kind", Op: "is", Value: "branch"},
				{Field: "landed", Op: "is", Value: "all-machines"},
				{Field: "unpushed", Op: "is", Value: "false"},
			},
			Propose: RuleAction{Disposition: "delete", Note: "landed {how}; nothing unpushed"},
		},
		{
			ID:   "quiet-bot-prs",
			Name: "Bot PRs quiet for 30 days",
			Match: []Condition{
				{Field: "kind", Op: "is", Value: "pr"},
				{Field: "bot", Op: "is", Value: "true"},
				{Field: "updated", Op: "older-than", Value: "30d"},
			},
			Propose: RuleAction{Disposition: "close", Note: "a bot's PR with no activity for 30 days"},
		},
		{
			ID:   "your-old-repos",
			Name: "Your old repos",
			Match: []Condition{
				{Field: "kind", Op: "is", Value: "repo"},
				{Field: "ownership", Op: "is", Value: "yours"},
				{Field: "archived", Op: "is", Value: "false"},
				{Field: "updated", Op: "older-than", Value: "52w"},
			},
			Propose: RuleAction{Disposition: "archive", Note: "yours, not pushed in a year"},
		},
		{
			ID:   "your-old-forks",
			Name: "Your old forks",
			Match: []Condition{
				{Field: "kind", Op: "is", Value: "repo"},
				{Field: "ownership", Op: "is", Value: "fork"},
				{Field: "updated", Op: "older-than", Value: "52w"},
			},
			Propose: RuleAction{Disposition: "delete", Note: "a fork, not pushed in a year"},
		},
		{
			// Nothing in it is lost: no changes, nothing unpushed; removing
			// it can be undone (Court, 2026-10-18).
			ID:   "quiet-clean-worktrees",
			Name: "Quiet clean worktrees",
			Match: []Condition{
				{Field: "kind", Op: "is", Value: "worktree"},
				{Field: "worktree", Op: "is", Value: "clean"},
				{Field: "unpushed", Op: "is", Value: "false"},
				{Field: "updated", Op: "older-than", Value: "3d"},
			},
			Propose: RuleAction{Disposition: "delete", Note: "clean, nothing unpushed, no activity for 3 days"},
		},
		{
			// An org's repos can't be archived from here: stop asking.
			ID:   "old-org-repos",
			Name: "Org repos not pushed in a year",
			Match: []Condition{
				{Field: "kind", Op: "is", Value: "repo"},
				{Field: "ownership", Op: "is", Value: "org"},
				{Field: "updated", Op: "older-than", Value: "52w"},
			},
			Propose: RuleAction{Disposition: "ignore", Note: "an org's repo, not pushed in a year"},
		},
	}
	for i := range out {
		out[i].Status = StatusActive
		out[i].CreatedBy = "casebook"
	}
	return out
}

// ShippedDormantRepos is the starter rule casebook 0.10 and 0.11 seeded in
// place of your-old-repos and your-old-forks; casebook-data that still has
// it unedited has it replaced by them once.
func ShippedDormantRepos() Rule {
	return Rule{
		ID:        "dormant-repos",
		Name:      "Repos not pushed in a year",
		Status:    StatusActive,
		CreatedBy: "casebook",
		Match: []Condition{
			{Field: "kind", Op: "is", Value: "repo"},
			{Field: "updated", Op: "older-than", Value: "52w"},
		},
		Propose: RuleAction{Disposition: "ignore", Note: "not pushed in a year"},
	}
}
