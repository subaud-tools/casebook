package store

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/subaud-tools/tackle/internal/casebook/item"
	"github.com/subaud-tools/tackle/internal/casebook/rules"
	"github.com/subaud-tools/tackle/internal/casebook/testgit"
)

// TestInitSeedsExampleRules: a new casebook-data has the starter rules, on.
func TestInitSeedsExampleRules(t *testing.T) {
	r, _ := newStore(t)
	got, errs := r.Rules()
	if len(errs) != 0 || len(got) != len(rules.Examples()) {
		t.Fatalf("rules %d %v, want the %d examples", len(got), errs, len(rules.Examples()))
	}
	for _, ru := range got {
		if ru.Status != rules.StatusActive {
			t.Errorf("%s is %q, want active", ru.ID, ru.Status)
		}
	}
}

// TestTidySeedsExampleRulesOnce: an older repo gets the examples with its
// next write, in their own commit, without touching a rule it already has
// under an example's id; a deleted example never comes back.
func TestTidySeedsExampleRulesOnce(t *testing.T) {
	r, _ := newStore(t)
	testgit.Git(t, r.Dir, "rm", "-r", "-q", "rules")
	mine := rules.Rule{ID: "landed-branches", Name: "Mine", Status: rules.StatusDraft, Match: []rules.Condition{{Field: "kind", Op: "is", Value: "branch"}}, Propose: rules.RuleAction{Disposition: "keep"}}
	b, err := rules.Encode(mine)
	if err != nil {
		t.Fatal(err)
	}
	testgit.Commit(t, r.Dir, "rules/landed-branches.toml", string(b))
	if err := r.Decide(ctx, item.IssueKey("a/b", 1), dec(item.Keep, "court", time.Now())); err != nil {
		t.Fatal(err)
	}
	subj := strings.Split(testgit.Git(t, r.Dir, "log", "-2", "--format=%s"), "\n")
	if len(subj) != 2 || subj[1] != "add example rules" {
		t.Fatalf("log %q", subj)
	}
	kept, _ := r.ReadRule("landed-branches")
	if kept == nil || kept.Name != "Mine" {
		t.Fatalf("an existing rule under an example's id was replaced: %+v", kept)
	}
	if err := os.Remove(filepath.Join(r.Dir, "rules", "quiet-bot-prs.toml")); err != nil {
		t.Fatal(err)
	}
	testgit.Git(t, r.Dir, "commit", "-q", "-am", "delete quiet-bot-prs")
	if err := r.Decide(ctx, item.IssueKey("a/b", 2), dec(item.Keep, "court", time.Now())); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(r.Dir, "rules", "quiet-bot-prs.toml")); !os.IsNotExist(err) {
		t.Fatalf("a deleted example came back: %v", err)
	}
}

// shippedDormantRepos is rules/dormant-repos.toml as casebook 0.10 seeded it
// (Court's casebook-data has it unchanged).
const shippedDormantRepos = `# casebook standing rule. Format: internal/casebook/FORMAT.md in subaud-tools/tackle.
id = "dormant-repos"
name = "Repos not pushed in a year"
status = "active"
created_by = "casebook"
created_at = 2026-10-17T18:39:46.001425Z
edited_at = 2026-10-17T18:39:46.001425Z

[[match]]
  field = "kind"
  op = "is"
  value = "repo"

[[match]]
  field = "updated"
  op = "older-than"
  value = "52w"

[propose]
  disposition = "ignore"
  note = "not pushed in a year"
`

// olderRules puts r's rules/ as an older casebook left it: the shipped
// dormant-repos (or content in its place), landed-branches, quiet-bot-prs
// and .gitkeep, and no your-old-repos or your-old-forks.
func olderRules(t *testing.T, r *Repo, dormant string) {
	t.Helper()
	for _, id := range []string{"your-old-repos", "your-old-forks"} {
		if err := os.Remove(filepath.Join(r.Dir, "rules", id+".toml")); err != nil {
			t.Fatal(err)
		}
	}
	testgit.Git(t, r.Dir, "commit", "-q", "-am", "an older casebook's rules")
	testgit.Commit(t, r.Dir, "rules/dormant-repos.toml", dormant)
}

// TestTidyReplacesTheShippedDormantReposRule: the next write deletes an
// unedited shipped dormant-repos and adds your-old-repos and your-old-forks
// (on), in one commit of those paths alone; a rule already under a new id
// is left as it is, and nothing comes back once replaced.
func TestTidyReplacesTheShippedDormantReposRule(t *testing.T) {
	r, _ := newStore(t)
	olderRules(t, r, shippedDormantRepos)
	if err := r.Decide(ctx, item.IssueKey("a/b", 1), dec(item.Keep, "court", time.Now())); err != nil {
		t.Fatal(err)
	}
	subj := strings.Split(testgit.Git(t, r.Dir, "log", "-2", "--format=%s"), "\n")
	if len(subj) != 2 || subj[1] != "replace dormant-repos with your-old-repos and your-old-forks" {
		t.Fatalf("log %q", subj)
	}
	files := strings.Fields(testgit.Git(t, r.Dir, "show", "--no-renames", "--name-only", "--format=", "HEAD~1"))
	if want := []string{"rules/dormant-repos.toml", "rules/your-old-forks.toml", "rules/your-old-repos.toml"}; !slices.Equal(files, want) {
		t.Fatalf("the replacement commit holds %v, want %v", files, want)
	}
	if _, err := os.Stat(filepath.Join(r.Dir, "rules", "dormant-repos.toml")); !os.IsNotExist(err) {
		t.Fatalf("dormant-repos is still there: %v", err)
	}
	for _, id := range []string{"your-old-repos", "your-old-forks"} {
		ru, err := r.ReadRule(id)
		if err != nil || ru == nil || ru.Status != rules.StatusActive || ru.CreatedBy != "casebook" {
			t.Fatalf("%s: %+v %v, want it on, by casebook", id, ru, err)
		}
	}
	if err := r.Decide(ctx, item.IssueKey("a/b", 2), dec(item.Keep, "court", time.Now())); err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(testgit.Git(t, r.Dir, "log", "--format=%s"), "replace dormant-repos"); n != 1 {
		t.Fatalf("replaced %d times", n)
	}

	// A rule of Court's under a new id stays his.
	r, _ = newStore(t)
	olderRules(t, r, shippedDormantRepos)
	mine := rules.Rule{ID: "your-old-forks", Name: "Mine", Status: rules.StatusDraft, Match: []rules.Condition{{Field: "kind", Op: "is", Value: "repo"}}, Propose: rules.RuleAction{Disposition: "keep"}}
	b, err := rules.Encode(mine)
	if err != nil {
		t.Fatal(err)
	}
	testgit.Commit(t, r.Dir, "rules/your-old-forks.toml", string(b))
	if err := r.Decide(ctx, item.IssueKey("a/b", 1), dec(item.Keep, "court", time.Now())); err != nil {
		t.Fatal(err)
	}
	if kept, _ := r.ReadRule("your-old-forks"); kept == nil || kept.Name != "Mine" {
		t.Fatalf("a rule under a new id was replaced: %+v", kept)
	}
	if ru, _ := r.ReadRule("your-old-repos"); ru == nil {
		t.Fatal("your-old-repos was not added")
	}
}

// TestTidyKeepsAnEditedDormantReposRule: a dormant-repos that is not the
// shipped one (renamed, turned off, another decision or note, another
// condition, an exclusion, written by someone else) is left as it is.
func TestTidyKeepsAnEditedDormantReposRule(t *testing.T) {
	for name, edit := range map[string]func(string) string{
		"renamed":           func(s string) string { return strings.Replace(s, "Repos not pushed in a year", "Old repos", 1) },
		"off":               func(s string) string { return strings.Replace(s, `"active"`, `"draft"`, 1) },
		"another decision":  func(s string) string { return strings.Replace(s, `"ignore"`, `"archive"`, 1) },
		"another note":      func(s string) string { return strings.Replace(s, "not pushed in a year\"", "old\"", 1) },
		"another condition": func(s string) string { return strings.Replace(s, `"52w"`, `"104w"`, 1) },
		"by pi":             func(s string) string { return strings.Replace(s, `created_by = "casebook"`, `created_by = "pi"`, 1) },
		"an exclusion": func(s string) string {
			return s + "\n[[exclude]]\n  key = \"repo:a/b\"\n  by = \"court\"\n  at = 2026-10-17T19:00:00Z\n"
		},
	} {
		t.Run(name, func(t *testing.T) {
			r, _ := newStore(t)
			content := edit(shippedDormantRepos)
			if content == shippedDormantRepos {
				t.Fatal("the edit changed nothing")
			}
			olderRules(t, r, content)
			if err := r.Decide(ctx, item.IssueKey("a/b", 1), dec(item.Keep, "court", time.Now())); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(filepath.Join(r.Dir, "rules", "dormant-repos.toml"))
			if err != nil || string(got) != content {
				t.Fatalf("dormant-repos changed: %v\n%s", err, got)
			}
			for _, id := range []string{"your-old-repos", "your-old-forks"} {
				if ru, _ := r.ReadRule(id); ru != nil {
					t.Fatalf("%s was added beside an edited dormant-repos", id)
				}
			}
		})
	}
}

// TestTwoMachinesReplaceDormantReposAndStillSync (review 2026-10-17): two
// machines that both replace the shipped dormant-repos before either syncs
// write the same files, so the sync after it goes through.
func TestTwoMachinesReplaceDormantReposAndStillSync(t *testing.T) {
	a, remote := newStore(t)
	olderRules(t, a, shippedDormantRepos)
	if _, err := a.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	b, err := Init(ctx, filepath.Join(t.TempDir(), "casebook-b"), remote)
	if err != nil {
		t.Fatal(err)
	}
	must(t, a.Decide(ctx, item.IssueKey("a/b", 1), dec(item.Keep, "court@a", time.Now())))
	time.Sleep(1100 * time.Millisecond) // the machines migrate a second apart
	must(t, b.Decide(ctx, item.IssueKey("a/b", 2), dec(item.Keep, "court@b", time.Now())))
	if _, err := a.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Sync(ctx); err != nil {
		t.Fatalf("b's sync after both migrated: %v", err)
	}
	for _, id := range []string{"your-old-repos", "your-old-forks"} {
		if ru, err := b.ReadRule(id); err != nil || ru == nil {
			t.Fatalf("%s: %+v %v", id, ru, err)
		}
	}
}
