package serve

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/subaud-tools/casebook/internal/casebook/apply"
	"github.com/subaud-tools/casebook/internal/casebook/config"
	"github.com/subaud-tools/casebook/internal/casebook/engine"
	"github.com/subaud-tools/casebook/internal/casebook/item"
	"github.com/subaud-tools/casebook/internal/casebook/observe"
)

// doneUntilObserved is each verified item still to keep out of review: one
// casebook verified done after GitHub was last read for its owner (read), so
// the index, built from that read, still shows it waiting. An owner never
// read goes by the index's build time. Its steps must all have verified
// after its current decision (decided): one decided again since waits.
func doneUntilObserved(verified map[string]apply.Verified, read func(owner string) (time.Time, bool), decided func(key string) time.Time, built time.Time) map[string]bool {
	out := map[string]bool{}
	for key, at := range verified {
		seen, ok := read(ownerOf(key))
		if !ok {
			seen = built
		}
		if at.Last.After(seen) && at.First.After(decided(key)) {
			out[key] = true
		}
	}
	return out
}

// ownerOf is a key's owner, lower case: "repo:o/r", "pr:o/r#4",
// "branch:o/r@b" → "o".
func ownerOf(key string) string {
	rest := key[strings.IndexByte(key, ':')+1:]
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		rest = rest[:i]
	}
	return strings.ToLower(rest)
}

// ownerReads is when GitHub was last read for each owner, from the GitHub
// cache, read again only when the file changes.
type ownerReads struct {
	mu    sync.Mutex
	mod   time.Time
	reads map[string]time.Time
}

func (o *ownerReads) get() map[string]time.Time {
	o.mu.Lock()
	defer o.mu.Unlock()
	path := config.CachePath()
	fi, err := os.Stat(path)
	if err != nil {
		return nil
	}
	if o.reads != nil && fi.ModTime().Equal(o.mod) {
		return o.reads
	}
	gh, err := observe.LoadGitHub(path)
	if err != nil || gh == nil {
		return o.reads
	}
	m := map[string]time.Time{}
	for login, ow := range gh.Owners {
		if !ow.FetchedAt.IsZero() {
			m[strings.ToLower(login)] = ow.FetchedAt
		}
	}
	o.mod, o.reads = fi.ModTime(), m
	return m
}

// applied is Index.Applied: what casebook verified done that the index's
// GitHub read hasn't seen yet.
func (s *Server) applied(built time.Time, decided func(key string) time.Time) map[string]bool {
	reads := s.reads.get()
	oldest := built
	for _, at := range reads {
		if at.Before(oldest) {
			oldest = at
		}
	}
	verified, err := s.Apply.VerifiedSince(context.Background(), oldest)
	if err != nil {
		return nil
	}
	return doneUntilObserved(verified, func(owner string) (time.Time, bool) {
		at, ok := reads[owner]
		return at, ok
	}, decided, built)
}

// copiesGone reports whether every copy of branch item it is gone, as far
// as this Mac can tell: no local copy on another Mac, each local copy here
// deleted by a step verified since its decision (or no longer there), and
// the GitHub copy gone or deleted by such a step. steps are its verified
// steps. Other kinds: no local copy on another Mac.
func copiesGone(it engine.Item, machine string, steps []apply.JobStep) bool {
	if otherCopies(it, machine) {
		return false
	}
	if it.Kind != item.KindBranch {
		return true
	}
	var decided time.Time
	if it.Decision != nil {
		decided = it.Decision.DecidedAt
	}
	deleted, github := map[string]bool{}, false
	for _, st := range steps {
		if !st.VerifiedAt.After(decided) {
			continue
		}
		switch st.Action {
		case "branch-delete-local":
			if dir, ok := apply.LocalDeleteDir(st.Command); ok {
				deleted[dir] = true
			}
		case "branch-delete-remote":
			github = true
		}
	}
	absentHere := false
	for _, c := range it.Copies {
		if c.Machine == machine && c.Absent {
			absentHere = true
		}
	}
	for _, loc := range it.Locations {
		if _, path, _ := strings.Cut(loc, ":"); !deleted[path] && !absentHere {
			return false
		}
	}
	if _, ok := it.GitHubCopy(); ok && !github {
		return false
	}
	return true
}

// otherCopies reports whether it has a local copy on a Mac other than
// machine: its steps here can't make it done.
func otherCopies(it engine.Item, machine string) bool {
	for _, loc := range it.Locations {
		if m, _, _ := strings.Cut(loc, ":"); m != machine {
			return true
		}
	}
	return false
}

// doneHow says how a done item got done, in the page's words: casebook's job
// and when it was verified, or found already so with nothing run. Not done:
// "".
func doneHow(status string, job int64, verified time.Time, loc *time.Location) string {
	if status != "done" {
		return ""
	}
	if job == 0 {
		return "found so, nothing ran"
	}
	return fmt.Sprintf("by job #%d, verified %s", job, verified.In(loc).Format("Jan 2 15:04"))
}

// verifyStep reads GitHub for a reported step and records verified or failed
// (drift); false when the read was inconclusive (the step stays reported).
func (s *Server) verifyStep(ctx context.Context, jobID int64, step apply.JobStep) bool {
	verState := apply.Verify(step, apply.ObserveGh(ctx, step, s.App.Gh))
	if verState == apply.StepReported {
		return false
	}
	detail := ""
	if verState == apply.StepFailed {
		detail = apply.DetailDrift
	}
	if err := s.Apply.SetStepState(ctx, step.ID, verState, detail); err != nil {
		return true
	}
	s.publish(ctx, "step", map[string]any{"id": step.ID, "job_id": jobID, "state": verState})
	if verState == apply.StepVerified {
		// Done: the item leaves To apply now, and the counts say so.
		pending, _ := s.Props.Pending(ctx)
		s.publish(ctx, "index", map[string]any{"counts": s.Index.Counts(pending), "head": s.Index.Head()})
	}
	return true
}

// verifyLater reads again, every VerifyRetry (3s) up to six times, until
// the read is conclusive; then settles the job. Serve stopping ends it.
func (s *Server) verifyLater(jobID int64, step apply.JobStep) {
	every := s.VerifyRetry
	if every <= 0 {
		every = 3 * time.Second
	}
	ctx := s.life
	if ctx == nil {
		ctx = context.Background()
	}
	go func() {
		for range 6 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(every):
			}
			if s.verifyStep(ctx, jobID, step) {
				s.settleJob(ctx, jobID)
				return
			}
		}
	}()
}

// verifyReported reads GitHub again for every reported step of a job that
// hasn't finished, in the background.
func (s *Server) verifyReported(ctx context.Context) {
	jobs, err := s.Apply.List(ctx)
	if err != nil {
		return
	}
	for _, j := range jobs {
		if j.State != apply.JobRunning && j.State != apply.JobApproved && j.State != apply.JobPaused {
			continue
		}
		for _, st := range j.Steps {
			if st.State == apply.StepReported {
				s.verifyLater(j.ID, st)
			}
		}
	}
}
