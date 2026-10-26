package deliver

import (
	"testing"
	"time"
)

// state reads one message's state and delivery.
func state(t *testing.T, q *Queue, id int64) (string, int64) {
	t.Helper()
	m, err := q.Message(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return string(m.State), m.DeliveryID
}

func TestNextLeavesItsMessagesSent(t *testing.T) {
	q, _ := newQueue(t)
	th := thread(t, q, "s1")
	m := post(t, q, th, "one", false)
	d, err := q.Next(ctx, "s1")
	if err != nil || d == nil {
		t.Fatalf("next %+v %v", d, err)
	}
	if st, did := state(t, q, m.ID); st != "sent" || did != d.ID {
		t.Fatalf("after Next: %s in delivery %d, want sent in %d", st, did, d.ID)
	}
}

func TestReleaseLandsSentAndWorkingOnNoReply(t *testing.T) {
	q, _ := newQueue(t)
	th := thread(t, q, "s1")
	m1 := post(t, q, th, "one", false)
	m2 := post(t, q, th, "two", false)
	d, _ := q.Next(ctx, "s1")
	if _, _, err := q.Reply(ctx, "s1", []int64{m2.ID}, "working", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := q.DB.ExecContext(ctx, "UPDATE messages SET state = 'sent' WHERE id = ?", m1.ID); err != nil {
		t.Fatal(err)
	}
	if err := q.Release(ctx, d.ID); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{m1.ID, m2.ID} {
		if st, _ := state(t, q, id); st != "no_reply" {
			t.Errorf("message %d after release: %s, want no_reply", id, st)
		}
	}
}

func TestMoveRequeuesAsSentInTheirOldOrder(t *testing.T) {
	q, c := newQueue(t)
	_ = q.Touch(ctx, Session{ID: "s2"})
	th := thread(t, q, "s1")
	m1 := post(t, q, th, "one", false)
	c.add(time.Minute)
	m2 := post(t, q, th, "two", false)
	d, _ := q.Next(ctx, "s1")
	if err := q.MoveDelivery(ctx, d.ID, "s2"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{m1.ID, m2.ID} {
		if st, did := state(t, q, id); st != "sent" || did != 0 {
			t.Errorf("message %d after move: %s in delivery %d, want sent in none", id, st, did)
		}
	}
	if d2, _ := q.Next(ctx, "s2"); d2 == nil || len(d2.Messages) != 2 || d2.Messages[0].ID != m1.ID || d2.Messages[1].ID != m2.ID {
		t.Fatalf("delivery on s2 %+v, want m1 then m2", d2)
	}
}

func TestMoveSessionRequeuesAsSent(t *testing.T) {
	q, _ := newQueue(t)
	_ = q.Touch(ctx, Session{ID: "s2"})
	th := thread(t, q, "s1")
	m := post(t, q, th, "one", false)
	_, _ = q.Next(ctx, "s1")
	if _, _, err := q.MoveSession(ctx, "s1", "s2"); err != nil {
		t.Fatal(err)
	}
	if st, did := state(t, q, m.ID); st != "sent" || did != 0 {
		t.Fatalf("after move: %s in delivery %d, want sent in none", st, did)
	}
}

func TestRestartRequeuesAsSentInTheirOldOrder(t *testing.T) {
	q, c := newQueue(t)
	th := thread(t, q, "s1")
	m1 := post(t, q, th, "one", false)
	c.add(time.Minute)
	m2 := post(t, q, th, "two", false)
	d, _ := q.Next(ctx, "s1")
	c.add(time.Minute)
	m3 := post(t, q, th, "three, queued behind", false)
	ins, err := q.Interrupt(ctx)
	if err != nil || len(ins) != 1 || len(ins[0].Messages) != 2 {
		t.Fatalf("interrupt %+v %v", ins, err)
	}
	if got, _ := q.Delivery(ctx, d.ID); got.State != Stopped {
		t.Fatalf("delivery %s, want %s", got.State, Stopped)
	}
	for _, id := range []int64{m1.ID, m2.ID} {
		if st, did := state(t, q, id); st != "sent" || did != 0 {
			t.Errorf("message %d after restart: %s in delivery %d, want sent in none", id, st, did)
		}
	}
	d2, _ := q.Next(ctx, "s1")
	if d2 == nil || len(ids(d2.Messages)) != 3 || d2.Messages[0].ID != m1.ID || d2.Messages[1].ID != m2.ID || d2.Messages[2].ID != m3.ID {
		t.Fatalf("delivery after restart %+v, want m1, m2, m3", d2)
	}
}

func TestResendTakesNoReplyToSent(t *testing.T) {
	q, _ := newQueue(t)
	th := thread(t, q, "s1")
	m1 := post(t, q, th, "one", false)
	m2 := post(t, q, th, "two", false)
	d, _ := q.Next(ctx, "s1")
	if _, _, err := q.Reply(ctx, "s1", []int64{m1.ID}, "answered", "done"); err != nil {
		t.Fatal(err)
	}
	if err := q.Release(ctx, d.ID); err != nil {
		t.Fatal(err)
	}
	if n, err := q.Resend(ctx, []int64{m1.ID, m2.ID}); err != nil || n != 1 {
		t.Fatalf("resend %d %v, want 1", n, err)
	}
	if st, did := state(t, q, m2.ID); st != "sent" || did != 0 {
		t.Fatalf("m2 after resend: %s in delivery %d, want sent in none", st, did)
	}
	if st, _ := state(t, q, m1.ID); st != "answered" {
		t.Fatalf("m1 after resend: %s, want answered", st)
	}
}
