// Package store is the casebook data repository: a git repo that holds decisions
// (items/), journals (journal/), machine snapshots (machines/), views and
// standing rules. The casebook binary is its only writer; history is linear.
package store

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/subaud-tools/casebook/internal/casebook/gitx"
	"github.com/subaud-tools/casebook/internal/casebook/item"
	"github.com/subaud-tools/casebook/internal/casebook/rules"
	tools "github.com/subaud-tools/tools-common"
)

// FormatVersion is the casebook repo format this binary reads and writes
// (casebook.toml format_version). Documented in internal/casebook/FORMAT.md.
const FormatVersion = 2

const readme = "# casebook\n\nThis repository is written by `casebook sync`. Views appear here after the first sync.\n"

// Repo is an open casebook data repository.
type Repo struct {
	Dir string
	// Version is the format_version read from casebook.toml when opened; Upgrade
	// raises it to FormatVersion.
	Version int

	// mu is the in-process half of casebook-data's lock (lock.go): a write
	// and its commit (Batch: Decide, WriteRule, DeleteRule, AppendRestore,
	// Commit, a sync's write phase) and Sync's rebase hold it exclusive,
	// serve's rebuild (Read) shared; a flock on LockPath() is the other
	// processes' half. Network steps (fetch, push) run outside it, so a
	// commit can land while a push waits on the remote, but never inside a
	// rebase or another commit. It is held per step and never while taking
	// another lock (serve/push.go documents the order).
	mu sync.RWMutex
}

type meta struct {
	FormatVersion int `toml:"format_version"`
}

// Init prepares dir as a casebook clone of remote. An existing clone at dir is
// opened. An empty remote is bootstrapped (casebook.toml, README.md, .gitignore
// and the example filters) and pushed.
func Init(ctx context.Context, dir, remote string) (*Repo, error) {
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		return Open(dir)
	}
	if err := tools.EnsureDir(filepath.Dir(dir)); err != nil {
		return nil, err
	}
	if _, err := gitx.Run(ctx, filepath.Dir(dir), "clone", "-q", remote, dir); err != nil {
		return nil, fmt.Errorf("clone casebook repo: %w", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "casebook.toml")); err == nil {
		return Open(dir)
	}
	if _, err := gitx.Run(ctx, dir, "symbolic-ref", "HEAD", "refs/heads/main"); err != nil {
		return nil, err
	}
	r := &Repo{Dir: dir, Version: FormatVersion}
	files, err := exampleFiles()
	if err != nil {
		return nil, err
	}
	ruleFiles, err := exampleRuleFiles(time.Now().UTC())
	if err != nil {
		return nil, err
	}
	maps.Copy(files, ruleFiles)
	files["casebook.toml"] = fmt.Appendf(nil, "# casebook data repository. Format: internal/casebook/FORMAT.md in subaud-tools/casebook.\nformat_version = %d\n", FormatVersion)
	files["README.md"] = []byte(readme)
	files[".gitignore"] = []byte(gitignore)
	for rel, b := range files {
		if _, err := r.WriteFile(rel, b); err != nil {
			return nil, err
		}
	}
	if _, err := r.Commit(ctx, "init casebook"); err != nil {
		return nil, err
	}
	if _, err := gitx.Run(ctx, dir, "push", "-q", "-u", "origin", "main"); err != nil {
		return nil, fmt.Errorf("push new casebook: %w", err)
	}
	return r, nil
}

// Open opens an existing casebook clone and checks its format version.
func Open(dir string) (*Repo, error) {
	b, err := os.ReadFile(filepath.Join(dir, "casebook.toml"))
	if err != nil {
		return nil, fmt.Errorf("not a casebook repo (%s): %w", dir, err)
	}
	var m meta
	if _, err := toml.Decode(string(b), &m); err != nil {
		return nil, fmt.Errorf("casebook.toml: %w", err)
	}
	if m.FormatVersion < 1 || m.FormatVersion > FormatVersion {
		return nil, fmt.Errorf("casebook.toml: format_version %d is not supported (max %d); update casebook", m.FormatVersion, FormatVersion)
	}
	return &Repo{Dir: dir, Version: m.FormatVersion}, nil
}

// Upgrade raises an older repo to FormatVersion with one commit ("upgrade
// casebook repo to format N"). Format 2 only adds optional decision fields, so
// no item file changes; older binaries refuse the repo afterwards. It does
// not push. A repo already at FormatVersion is left alone.
func (r *Repo) Upgrade(ctx context.Context) (bool, error) {
	if r.Version >= FormatVersion {
		return false, nil
	}
	b := fmt.Appendf(nil, "# casebook data repository. Format: internal/casebook/FORMAT.md in subaud-tools/casebook.\nformat_version = %d\n", FormatVersion)
	if _, err := r.Batch(ctx, fmt.Sprintf("upgrade casebook repo to format %d", FormatVersion), func() error {
		_, err := r.WriteFile("casebook.toml", b)
		return err
	}); err != nil {
		return false, err
	}
	r.Version = FormatVersion
	return true, nil
}

func (r *Repo) abs(rel string) string { return filepath.Join(r.Dir, filepath.FromSlash(rel)) }

// ReadFile reads a repo-relative file.
func (r *Repo) ReadFile(rel string) ([]byte, error) { return os.ReadFile(r.abs(rel)) }

// WriteFile writes a repo-relative file when its content differs.
func (r *Repo) WriteFile(rel string, b []byte) (bool, error) {
	if old, err := os.ReadFile(r.abs(rel)); err == nil && string(old) == string(b) {
		return false, nil
	}
	return true, tools.WriteFileAtomic(r.abs(rel), b, 0o644)
}

// AppendFile appends to a repo-relative file, creating it and its directory.
func (r *Repo) AppendFile(rel string, b []byte) error {
	p := r.abs(rel)
	if err := tools.EnsureDir(filepath.Dir(p)); err != nil {
		return err
	}
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

// Glob matches a slash pattern against the repo and returns sorted relative
// slash paths.
func (r *Repo) Glob(pattern string) ([]string, error) {
	m, err := filepath.Glob(r.abs(pattern))
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(m))
	for _, p := range m {
		rel, _ := filepath.Rel(r.Dir, p)
		out = append(out, filepath.ToSlash(rel))
	}
	sort.Strings(out)
	return out, nil
}

// Commit stages everything and commits it; false when nothing changed. A
// write meant to go in the same commit belongs in Batch, so another
// writer's commit can't take it first.
func (r *Repo) Commit(ctx context.Context, msg string) (bool, error) {
	return r.Batch(ctx, msg, nil)
}

// commit is Commit with casebook-data's lock held.
func (r *Repo) commit(ctx context.Context, msg string) (bool, error) {
	if _, err := gitx.Run(ctx, r.Dir, "add", "-A"); err != nil {
		return false, err
	}
	if _, err := gitx.Run(ctx, r.Dir, "diff", "--cached", "--quiet"); err == nil {
		return false, nil
	}
	if _, err := gitx.Run(ctx, r.Dir, "commit", "-q", "--no-verify", "-m", msg); err != nil {
		return false, err
	}
	return true, nil
}

// ReadDecision returns k's decision, or nil when there is none.
func (r *Repo) ReadDecision(k item.Key) (*item.Decision, error) {
	b, err := r.ReadFile(k.File())
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	d, err := item.DecodeDecision(b)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", k.File(), err)
	}
	return &d, nil
}

// Decisions reads every decision file, keyed by item key text. Unreadable
// files are returned as errors and skipped.
func (r *Repo) Decisions() (map[string]item.Decision, []error) {
	out := map[string]item.Decision{}
	var errs []error
	root := r.abs("items")
	_ = filepath.WalkDir(root, func(p string, de fs.DirEntry, err error) error {
		if err != nil || de.IsDir() {
			return nil //nolint:nilerr // best-effort walk: skip an unreadable entry, keep scanning
		}
		rel, _ := filepath.Rel(r.Dir, p)
		rel = filepath.ToSlash(rel)
		k, err := item.KeyFromFile(rel)
		if err != nil {
			errs = append(errs, err)
			return nil
		}
		d, err := r.ReadDecision(k)
		if err != nil {
			errs = append(errs, err)
			return nil
		}
		out[k.String()] = *d
		return nil
	})
	return out, errs
}

// Decide validates d, writes k's decision file and commits it. It does not
// push; call Sync.
func (r *Repo) Decide(ctx context.Context, k item.Key, d item.Decision) error {
	return r.DecideAll(ctx, []Decided{{Key: k, Decision: d}})
}

// Decided is one decision to record.
type Decided struct {
	Key      item.Key
	Decision item.Decision
}

// DecideAll validates every decision, writes their files and commits them
// in one commit (Court, 2026-10-18: a group of 1,757 took six minutes at a
// commit each). Nothing is written when one doesn't validate. It does not
// push; call Sync.
func (r *Repo) DecideAll(ctx context.Context, ds []Decided) error {
	if len(ds) == 0 {
		return nil
	}
	files := make([][]byte, len(ds))
	for i, x := range ds {
		if err := x.Decision.Validate(x.Key.Kind); err != nil {
			return fmt.Errorf("%s: %w", x.Key, err)
		}
		b, err := item.EncodeDecision(x.Decision)
		if err != nil {
			return err
		}
		files[i] = b
	}
	_, err := r.Batch(ctx, decideMessage(ds), func() error {
		for i, x := range ds {
			if err := r.writeUnsynced(x.Key.File(), files[i]); err != nil {
				return err
			}
		}
		return nil
	})
	return err
}

// writeUnsynced writes rel whole (a temp file renamed over it, so a reader
// never sees half of it) without flushing it to disk first: the commit that
// follows records it, and git doesn't flush its commits either, so a flush
// per file (about 4ms each on macOS) bought nothing and made a group of
// 2,000 decisions take 8 seconds.
func (r *Repo) writeUnsynced(rel string, b []byte) error {
	p := r.abs(rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), "."+filepath.Base(p)+"-*.tmp")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), p)
}

// decideMessage is the commit message: one decision names its item; several
// say how many and what, then list the items, one a line.
func decideMessage(ds []Decided) string {
	d := ds[0].Decision
	note := ""
	same := true
	for _, x := range ds[1:] {
		y := x.Decision
		same = same && y.Disposition == d.Disposition && y.Note == d.Note && y.DecidedBy == d.DecidedBy
	}
	if same && d.Note != "" {
		n := strings.ReplaceAll(d.Note, "\n", " ")
		if rs := []rune(n); len(rs) > 72 {
			n = string(rs[:72]) + "\u2026"
		}
		note = fmt.Sprintf(" (%q)", n)
	}
	if len(ds) == 1 {
		return fmt.Sprintf("decide %s \u2192 %s%s by %s", ds[0].Key, d.Disposition, note, d.DecidedBy)
	}
	var b strings.Builder
	if same {
		fmt.Fprintf(&b, "decide %d items \u2192 %s%s by %s\n", len(ds), d.Disposition, note, d.DecidedBy)
	} else {
		fmt.Fprintf(&b, "decide %d items by %s\n", len(ds), d.DecidedBy)
	}
	for _, x := range ds {
		fmt.Fprintf(&b, "\n%s \u2192 %s", x.Key, x.Decision.Disposition)
	}
	return b.String()
}

// LogEntry is one commit touching a file.
type LogEntry struct {
	Commit  string
	Time    time.Time
	Subject string
}

// Log lists the commits touching rel, newest first.
func (r *Repo) Log(ctx context.Context, rel string) ([]LogEntry, error) {
	out, err := gitx.Run(ctx, r.Dir, "log", "--format=%h%x09%cI%x09%s", "--", rel)
	if err != nil || out == "" {
		return nil, err
	}
	var log []LogEntry
	for _, line := range strings.Split(out, "\n") {
		f := strings.SplitN(line, "\t", 3)
		if len(f) != 3 {
			continue
		}
		at, _ := time.Parse(time.RFC3339, f[1])
		log = append(log, LogEntry{Commit: f[0], Time: at, Subject: f[2]})
	}
	return log, nil
}

// Validate checks every decision file.
func (r *Repo) Validate() []error {
	var errs []error
	root := r.abs("items")
	_ = filepath.WalkDir(root, func(p string, de fs.DirEntry, err error) error {
		if err != nil || de.IsDir() {
			return nil //nolint:nilerr // best-effort walk: skip an unreadable entry, keep scanning
		}
		rel, _ := filepath.Rel(r.Dir, p)
		rel = filepath.ToSlash(rel)
		k, err := item.KeyFromFile(rel)
		if err != nil {
			errs = append(errs, err)
			return nil
		}
		d, err := r.ReadDecision(k)
		if err != nil {
			errs = append(errs, err)
			return nil
		}
		if err := d.Validate(k.Kind); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", rel, err))
		}
		return nil
	})
	return errs
}

// Rules reads every rules/*.toml file. Parse errors are collected in errs and
// those files are skipped.
// RuleFileError is a rules/<id>.toml that can't be read as a rule. It keeps
// the id, so the rule is still listed (as invalid) rather than dropped.
type RuleFileError struct {
	ID  string
	Err error
}

func (e *RuleFileError) Error() string { return "rules/" + e.ID + ".toml: " + e.Err.Error() }
func (e *RuleFileError) Unwrap() error { return e.Err }

func (r *Repo) Rules() ([]rules.Rule, []error) {
	paths, err := r.Glob("rules/*.toml")
	if err != nil {
		return nil, []error{err}
	}
	var out []rules.Rule
	var errs []error
	for _, rel := range paths {
		b, err := r.ReadFile(rel)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", rel, err))
			continue
		}
		ru, err := rules.Decode(b)
		if err != nil {
			id := strings.TrimSuffix(strings.TrimPrefix(rel, "rules/"), ".toml")
			errs = append(errs, &RuleFileError{ID: id, Err: err})
			continue
		}
		out = append(out, ru)
	}
	return out, errs
}

// ReadRule reads a single rule by id. Returns nil, nil when the file is absent.
func (r *Repo) ReadRule(id string) (*rules.Rule, error) {
	if !rules.ValidID(id) {
		return nil, fmt.Errorf("invalid rule id %q", id)
	}
	b, err := r.ReadFile("rules/" + id + ".toml")
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	ru, err := rules.Decode(b)
	if err != nil {
		return nil, &RuleFileError{ID: id, Err: err}
	}
	return &ru, nil
}

// WriteRule writes ru as rules/<id>.toml and commits with msg. It does not
// push; call Sync to propagate the change. An active rule must be valid; a
// draft only well-formed (so an invalid rule can be deactivated, and a new
// one saved before it is complete).
func (r *Repo) WriteRule(ctx context.Context, ru rules.Rule, msg string) error {
	check := ru.ValidateStructure
	if ru.Status == rules.StatusActive {
		check = ru.Validate
	}
	if err := check(); err != nil {
		return err
	}
	b, err := rules.Encode(ru)
	if err != nil {
		return err
	}
	_, err = r.Batch(ctx, msg, func() error {
		_, err := r.WriteFile("rules/"+ru.ID+".toml", b)
		return err
	})
	return err
}

// DeleteRule removes the rules/<id>.toml file and commits with msg.
func (r *Repo) DeleteRule(ctx context.Context, id, msg string) error {
	if !rules.ValidID(id) {
		return fmt.Errorf("invalid rule id %q", id)
	}
	rel := "rules/" + id + ".toml"
	p := filepath.Join(r.Dir, filepath.FromSlash(rel))
	_, err := r.Batch(ctx, msg, func() error {
		if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("delete rule %q: %w", id, err)
		}
		return nil
	})
	return err
}
