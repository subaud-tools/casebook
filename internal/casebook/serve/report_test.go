package serve

import (
	"net/http"
	"regexp"
	"testing"
)

// reported is a wait whose delivery carries its report token.
type reported struct {
	Delivery struct {
		ID   int64 `json:"id"`
		Held bool  `json:"held"`
	} `json:"delivery"`
	Report string `json:"report"`
}

// handOver sends body to session s1's thread and takes it with a wait.
func (r *rig) handOver(t *testing.T, th int64, body string) (message, reported) {
	t.Helper()
	m := r.send(t, th, body, false)
	var w reported
	if c := r.do(t, "GET", "/api/agent/wait?session=s1", nil, &w); c != http.StatusOK || w.Delivery.ID == 0 {
		t.Fatalf("wait %d %+v", c, w)
	}
	return m, w
}

func (r *rig) report(t *testing.T, session, event, token string) {
	t.Helper()
	if c := r.do(t, "POST", "/api/agent/report", map[string]any{"session": session, "event": event, "token": token}, nil); c >= 300 {
		t.Fatalf("report %s %s: %d", event, token, c)
	}
}

func (r *rig) stateOf(t *testing.T, id int64) string {
	t.Helper()
	m, err := r.s.Queue.Message(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return string(m.State)
}

func TestADeliveredMessageStaysSentUntilItLands(t *testing.T) {
	r := newRig(t)
	th := r.attach(t, "s1")
	m, w := r.handOver(t, th, "check CI")
	if st := r.stateOf(t, m.ID); st != "sent" {
		t.Fatalf("after the wait: %s, want sent", st)
	}
	if !regexp.MustCompile(`^[0-9a-f]{16}$`).MatchString(w.Report) {
		t.Fatalf("report token %q, want 16 hex characters", w.Report)
	}
	r.report(t, "s1", "landed", w.Report)
	if st := r.stateOf(t, m.ID); st != "with_agent" {
		t.Fatalf("after landed: %s, want with_agent", st)
	}
}

func TestALateLandedLeavesAWorkingMessageWorking(t *testing.T) {
	r := newRig(t)
	th := r.attach(t, "s1")
	m, w := r.handOver(t, th, "check CI")
	r.do(t, "POST", "/api/agent/reply", map[string]any{"session": "s1", "ids": []int64{m.ID}, "state": "working"}, nil)
	r.report(t, "s1", "landed", w.Report)
	if st := r.stateOf(t, m.ID); st != "working" {
		t.Fatalf("after a late landed: %s, want working", st)
	}
}

func TestHeldMarksTheDeliveryAndLandedClearsIt(t *testing.T) {
	r := newRig(t)
	th := r.attach(t, "s1")
	m, w := r.handOver(t, th, "check CI")
	r.report(t, "s1", "held", w.Report)
	d, _ := r.s.Queue.Delivery(ctx, w.Delivery.ID)
	if !d.Held || r.stateOf(t, m.ID) != "sent" {
		t.Fatalf("after held: held %v, message %s; want held and sent", d.Held, r.stateOf(t, m.ID))
	}
	r.report(t, "s1", "landed", w.Report)
	if d, _ := r.s.Queue.Delivery(ctx, w.Delivery.ID); d.Held {
		t.Fatal("still held after landed")
	}
}

func TestTurnEndedEndsALandedDeliveryAndSendsTheNext(t *testing.T) {
	r := newRig(t)
	th := r.attach(t, "s1")
	m1 := r.send(t, th, "one", false)
	m2 := r.send(t, th, "two", false)
	m3 := r.send(t, th, "three", false)
	var w reported
	r.do(t, "GET", "/api/agent/wait?session=s1", nil, &w)
	r.report(t, "s1", "landed", w.Report)
	r.do(t, "POST", "/api/agent/reply", map[string]any{"session": "s1", "ids": []int64{m2.ID}, "state": "working"}, nil)
	r.do(t, "POST", "/api/agent/reply", map[string]any{"session": "s1", "ids": []int64{m3.ID}, "state": "answered", "text": "done"}, nil)
	queued := r.send(t, th, "sent mid-turn", false)
	r.report(t, "s1", "turn_ended", "")
	for id, want := range map[int64]string{m1.ID: "no_reply", m2.ID: "no_reply", m3.ID: "answered"} {
		if st := r.stateOf(t, id); st != want {
			t.Errorf("message %d after turn_ended: %s, want %s", id, st, want)
		}
	}
	if d, _ := r.s.Queue.Delivery(ctx, w.Delivery.ID); d.State != "done" {
		t.Fatalf("delivery %s, want done", d.State)
	}
	var next waited
	if c := r.do(t, "GET", "/api/agent/wait?session=s1&timeout=1", nil, &next); c != http.StatusOK || len(next.Delivery.Messages) != 1 || next.Delivery.Messages[0].ID != queued.ID {
		t.Fatalf("next delivery %d %+v, want the queued message", c, next)
	}
}

func TestTurnEndedBeforeLandedLeavesTheDeliveryInFlight(t *testing.T) {
	r := newRig(t)
	th := r.attach(t, "s1")
	m, w := r.handOver(t, th, "check CI")
	r.report(t, "s1", "turn_ended", "")
	if d, _ := r.s.Queue.Delivery(ctx, w.Delivery.ID); d.State != "inflight" || r.stateOf(t, m.ID) != "sent" {
		t.Fatalf("delivery %s, message %s; want inflight and sent", d.State, r.stateOf(t, m.ID))
	}
}

func TestAnotherSessionsTokenMovesNothing(t *testing.T) {
	r := newRig(t)
	th := r.attach(t, "s1")
	r.attach(t, "s2")
	m, w := r.handOver(t, th, "check CI")
	r.report(t, "s2", "landed", w.Report)
	r.report(t, "s2", "held", w.Report)
	if d, _ := r.s.Queue.Delivery(ctx, w.Delivery.ID); d.Held || r.stateOf(t, m.ID) != "sent" {
		t.Fatalf("s2's report moved s1's delivery: held %v, message %s", d.Held, r.stateOf(t, m.ID))
	}
}

func TestTheSettledBridgeEndsAShownDelivery(t *testing.T) {
	r := newRig(t)
	th := r.attach(t, "s1")
	m, w := r.handOver(t, th, "check CI")
	r.do(t, "POST", "/api/agent/settled", map[string]any{"session": "s1", "shown": []int64{w.Delivery.ID}}, nil)
	if d, _ := r.s.Queue.Delivery(ctx, w.Delivery.ID); d.State != "done" || r.stateOf(t, m.ID) != "no_reply" {
		t.Fatalf("delivery %s, message %s; want done and no_reply", d.State, r.stateOf(t, m.ID))
	}
}
