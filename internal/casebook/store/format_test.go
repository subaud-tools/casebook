package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/subaud-tools/casebook/internal/casebook/item"
	"github.com/subaud-tools/casebook/internal/casebook/testgit"
)

func TestInitWritesCurrentFormat(t *testing.T) {
	r, _ := newStore(t)
	b, _ := r.ReadFile("casebook.toml")
	if r.Version != FormatVersion || !strings.Contains(string(b), "format_version = 3") {
		t.Fatalf("version %d, casebook.toml %q", r.Version, b)
	}
}

func TestUpgradeFromFormat1(t *testing.T) {
	r, _ := newStore(t)
	if err := os.WriteFile(filepath.Join(r.Dir, "casebook.toml"), []byte("format_version = 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Commit(ctx, "pretend format 1"); err != nil {
		t.Fatal(err)
	}
	old, err := Open(r.Dir)
	if err != nil || old.Version != 1 {
		t.Fatalf("open v1: %+v %v", old, err)
	}
	up, err := old.Upgrade(ctx)
	if err != nil || !up || old.Version != FormatVersion {
		t.Fatalf("upgrade: %v %v %d", up, err, old.Version)
	}
	if got := testgit.Git(t, r.Dir, "log", "-1", "--format=%s"); got != "upgrade casebook repo to format 3" {
		t.Errorf("commit %q", got)
	}
	again, _ := Open(r.Dir)
	if up, err := again.Upgrade(ctx); up || err != nil {
		t.Errorf("second upgrade: %v %v", up, err)
	}
}

// TestUpgradeFromFormat2RenamesTheOldUserValue: a format 2 repo's "court" in
// decided_by (and a conflict's), a rule's created_by and an exclusion's by
// read "user" at format 3, in the upgrade's one commit; any other value, and
// "court" inside a note, stay as they were.
func TestUpgradeFromFormat2RenamesTheOldUserValue(t *testing.T) {
	r, _ := newStore(t)
	files := map[string]string{
		"casebook.toml": "format_version = 2\n",
		"items/issue/a/b/1.toml": "disposition = \"keep\"\nnote = \"court said\"\ndecided_by = \"court\"\ndecided_at = 2026-09-24T10:12:00Z\n\n" +
			"[conflict]\n  disposition = \"keep\"\n  decided_by = \"court\"\n  decided_at = 2026-09-24T10:11:00Z\n",
		"items/issue/a/b/2.toml": "disposition = \"keep\"\ndecided_by = \"alice\"\ndecided_at = 2026-09-24T10:12:00Z\n",
		"rules/mine.toml": "id = \"mine\"\nname = \"Mine\"\nstatus = \"draft\"\ncreated_by = \"court\"\ncreated_at = 2026-09-27T10:00:00Z\nedited_at = 2026-09-27T10:00:00Z\n\n" +
			"[[match]]\n  field = \"kind\"\n  op = \"is\"\n  value = \"branch\"\n\n[propose]\n  disposition = \"keep\"\n\n" +
			"[[exclude]]\n  key = \"branch:a/b@x\"\n  by = \"court\"\n  at = 2026-09-27T10:05:00Z\n",
	}
	for rel, s := range files {
		testgit.Commit(t, r.Dir, rel, s)
	}
	old, err := Open(r.Dir)
	if err != nil || old.Version != 2 {
		t.Fatalf("open v2: %+v %v", old, err)
	}
	before := testgit.Git(t, r.Dir, "rev-parse", "HEAD")
	up, err := old.Upgrade(ctx)
	if err != nil || !up || old.Version != 3 {
		t.Fatalf("upgrade: %v %v %d", up, err, old.Version)
	}
	if got := testgit.Git(t, r.Dir, "rev-list", "--count", before+"..HEAD"); got != "1" {
		t.Errorf("%s commits, want 1", got)
	}
	if got := testgit.Git(t, r.Dir, "log", "-1", "--format=%s"); got != "upgrade casebook repo to format 3" {
		t.Errorf("commit %q", got)
	}
	if b, _ := r.ReadFile("casebook.toml"); !strings.Contains(string(b), "format_version = 3") {
		t.Errorf("casebook.toml %q", b)
	}
	if got := testgit.Git(t, r.Dir, "status", "--porcelain"); got != "" {
		t.Errorf("left uncommitted: %q", got)
	}
	d, err := old.ReadDecision(item.IssueKey("a/b", 1))
	if err != nil || d.DecidedBy != "user" || d.Conflict == nil || d.Conflict.DecidedBy != "user" || d.Note != "court said" {
		t.Errorf("decision 1: %+v %v", d, err)
	}
	if d, err := old.ReadDecision(item.IssueKey("a/b", 2)); err != nil || d.DecidedBy != "alice" {
		t.Errorf("decision 2: %+v %v", d, err)
	}
	ru, err := old.ReadRule("mine")
	if err != nil || ru.CreatedBy != "user" || len(ru.Exclude) != 1 || ru.Exclude[0].By != "user" {
		t.Errorf("rule: %+v %v", ru, err)
	}
	again, _ := Open(r.Dir)
	if up, err := again.Upgrade(ctx); up || err != nil {
		t.Errorf("second upgrade: %v %v", up, err)
	}
}
