package serve

import (
	"net/http"
	"testing"
	"time"
)

// A long-poll open across the end of a turn must still be woken by the next
// message: turnOver used to drop the session's waiter, stranding the open poll
// on a channel nothing could reach until its timeout.
func TestAMessageAfterTheTurnEndsWakesTheOpenPoll(t *testing.T) {
	r := newRig(t)
	th := r.attach(t, "s1")

	type polled struct {
		code int
		w    waited
	}
	done := make(chan polled, 1)
	go func() {
		var w waited
		code := r.do(t, "GET", "/api/agent/wait?session=s1&timeout=3", nil, &w)
		done <- polled{code, w}
	}()
	time.Sleep(80 * time.Millisecond) // the poll is open and waiting

	r.report(t, "s1", "turn_ended", "")
	time.Sleep(80 * time.Millisecond) // the poll woke, found nothing and waits again

	m := r.send(t, th, "right after the turn", false)
	select {
	case p := <-done:
		if p.code != http.StatusOK || len(p.w.Delivery.Messages) != 1 || p.w.Delivery.Messages[0].ID != m.ID {
			t.Fatalf("poll %d %+v, want the message", p.code, p.w)
		}
	case <-time.After(time.Second):
		t.Fatal("the open poll was not woken by the message; it waits for its timeout")
	}
}

// The waiters map holds only sessions with a poll open: each poll's entry
// goes when it returns, however it returns.
func TestWaitersHoldOnlyOpenPolls(t *testing.T) {
	r := newRig(t)
	th := r.attach(t, "s1")
	r.attach(t, "s2")
	waiting := func(session string) bool {
		r.s.mu.Lock()
		defer r.s.mu.Unlock()
		_, ok := r.s.waiters[session]
		return ok
	}

	// a poll that hands out a delivery
	r.send(t, th, "hello", false)
	var w waited
	if c := r.do(t, "GET", "/api/agent/wait?session=s1", nil, &w); c != http.StatusOK {
		t.Fatalf("wait %d", c)
	}
	// a poll that times out
	if c := r.do(t, "GET", "/api/agent/wait?session=s2&timeout=1", nil, nil); c != http.StatusNoContent {
		t.Fatalf("wait %d, want 204", c)
	}
	if waiting("s1") || waiting("s2") {
		t.Fatal("a returned poll left its waiter in the map")
	}

	// two polls open at once share one waiter; it stays until both return
	r.s.Wait = 500 * time.Millisecond
	first := make(chan int, 1)
	go func() { first <- r.do(t, "GET", "/api/agent/wait?session=s2", nil, nil) }()
	time.Sleep(80 * time.Millisecond)
	second := make(chan int, 1)
	go func() { second <- r.do(t, "GET", "/api/agent/wait?session=s2&timeout=2", nil, nil) }()
	<-first
	if !waiting("s2") {
		t.Fatal("the first poll's return removed the waiter the second still waits on")
	}
	<-second
	if waiting("s2") {
		t.Fatal("waiter left after both polls returned")
	}
}
