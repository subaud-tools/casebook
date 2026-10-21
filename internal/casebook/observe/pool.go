package observe

import (
	"context"
	"strings"
	"sync"
	"time"
)

// poolSize is how many gh calls run at once (Court, 2026-10-20). One call at
// a time made a full refresh about 640 calls of half a second each, 6½
// minutes holding the sync lock. 8 brings that under a minute while staying
// far below the concurrency GitHub's secondary rate limits punish, and keeps
// only a handful of gh processes alive at once.
const poolSize = 8

// GitHub allows 30 search requests a minute (search/issues).
const (
	searchesPerWindow = 30
	searchWindow      = time.Minute
)

// limiter runs gh calls through a pool of slots. Search runs one at a time,
// no more than 30 a minute. Once GitHub answers with a rate limit, no call
// starts: each returns a rate-limit error of its own, and the calls already
// running finish.
type limiter struct {
	r     Runner
	slots chan struct{}

	search   sync.Mutex  // one search at a time
	searches []time.Time // the latest searches' starts, oldest first
	now      func() time.Time
	wait     func(context.Context, time.Duration) error

	mu      sync.Mutex
	tripped bool
}

func newLimiter(r Runner, size int) *limiter {
	return &limiter{r: r, slots: make(chan struct{}, size), now: time.Now, wait: sleep}
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// errNotStarted is a call refused after a rate limit; rateLimited knows it.
var errNotStarted = &GhError{Code: -1, Stderr: "rate limit reached earlier in this refresh; not asked"}

// Gh runs one gh call when a slot is free.
func (l *limiter) Gh(ctx context.Context, args ...string) ([]byte, error) {
	if isSearch(args) {
		l.search.Lock()
		defer l.search.Unlock()
		if err := l.searchTurn(ctx); err != nil {
			return nil, err
		}
	}
	select {
	case l.slots <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-l.slots }()
	if l.limited() {
		return nil, errNotStarted
	}
	out, err := l.r.Gh(ctx, args...)
	if rateLimited(err) {
		// Tripped before the slot is given back, so a call waiting for it
		// sees the limit.
		l.mu.Lock()
		l.tripped = true
		l.mu.Unlock()
	}
	return out, err
}

// limited reports whether GitHub has answered with a rate limit.
func (l *limiter) limited() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.tripped
}

// searchTurn waits until a search may start without passing 30 in a minute,
// and records its start. The caller holds l.search.
func (l *limiter) searchTurn(ctx context.Context) error {
	if l.limited() {
		return nil // refused in Gh, no need to wait for it
	}
	if len(l.searches) == searchesPerWindow {
		if d := l.searches[0].Add(searchWindow).Sub(l.now()); d > 0 {
			if err := l.wait(ctx, d); err != nil {
				return err
			}
		}
		l.searches = l.searches[1:]
	}
	l.searches = append(l.searches, l.now())
	return nil
}

func isSearch(args []string) bool {
	for _, a := range args {
		if strings.HasPrefix(a, "search/") {
			return true
		}
	}
	return false
}

// each runs f(0) … f(n-1) at once and waits for them all; the limiter bounds
// their gh calls. Each f writes only its own result slot, and the caller
// merges the slots in order, so the result never depends on which call
// finished first.
func each(n int, f func(i int)) {
	var wg sync.WaitGroup
	for i := range n {
		wg.Go(func() { f(i) })
	}
	wg.Wait()
}

// firstErr is the first error in order, as a serial run would have stopped
// at.
func firstErr(errs []error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}
