package deliver

import "testing"

// replies are the agent's reply rows in a thread.
func replies(t *testing.T, q *Queue, th Thread) []Message {
	t.Helper()
	all, err := q.Messages(ctx, th.ID)
	if err != nil {
		t.Fatal(err)
	}
	var out []Message
	for _, m := range all {
		if m.State == AgentReply {
			out = append(out, m)
		}
	}
	return out
}

func TestWorkingSetsTheLineAndAddsNoThreadRow(t *testing.T) {
	q, _ := newQueue(t)
	th := thread(t, q, "s1")
	m1 := post(t, q, th, "one", false)
	d, _ := q.Next(ctx, "s1")
	if _, err := q.Landed(ctx, "s1", d.Token); err != nil {
		t.Fatal(err)
	}
	m3 := post(t, q, th, "three", false)
	if _, err := q.DB.ExecContext(ctx, "UPDATE messages SET delivery_id = ? WHERE id = ?", d.ID, m3.ID); err != nil {
		t.Fatal(err)
	}
	// m1 is with the agent; m3 is in the delivery, still sent.
	for _, c := range []struct {
		id   int64
		line string
	}{{m1.ID, "reading the PRs"}, {m1.ID, "checking CI on #671"}, {m3.ID, "on it"}} {
		if _, skipped, err := q.Reply(ctx, "s1", []int64{c.id}, Working, c.line); err != nil || len(skipped) != 0 {
			t.Fatalf("working %d: %v %v", c.id, skipped, err)
		}
		got, _ := q.Message(ctx, c.id)
		if got.State != Working || got.Line != c.line {
			t.Fatalf("message %d: %s %q, want working %q", c.id, got.State, got.Line, c.line)
		}
	}
	if rs := replies(t, q, th); len(rs) != 0 {
		t.Fatalf("working added thread rows: %+v", rs)
	}
}

func TestDeclinedAndFailedSettleWithTheirText(t *testing.T) {
	q, _ := newQueue(t)
	th := thread(t, q, "s1")
	m1 := post(t, q, th, "one", false)
	m2 := post(t, q, th, "two", false)
	_, _ = q.Next(ctx, "s1")
	_, _, _ = q.Reply(ctx, "s1", []int64{m1.ID}, Working, "looking")
	for _, c := range []struct {
		id    int64
		state ThreadState
		text  string
	}{{m1.ID, Declined, "won't: it is Court's call"}, {m2.ID, Failed, "couldn't: gh is logged out"}} {
		if _, _, err := q.Reply(ctx, "s1", []int64{c.id}, c.state, c.text); err != nil {
			t.Fatal(err)
		}
		got, _ := q.Message(ctx, c.id)
		if got.State != c.state || got.SettledAt.IsZero() || got.Line != "" {
			t.Fatalf("message %d: %s settled %v line %q, want %s settled, no line", c.id, got.State, got.SettledAt, got.Line, c.state)
		}
	}
	rs := replies(t, q, th)
	if len(rs) != 2 || rs[0].Body != "won't: it is Court's call" || rs[0].ReplyTo != m1.ID || rs[1].Body != "couldn't: gh is logged out" {
		t.Fatalf("replies %+v", rs)
	}
}

func TestAnsweredAfterDeclinedIsSkipped(t *testing.T) {
	q, _ := newQueue(t)
	th := thread(t, q, "s1")
	m := post(t, q, th, "one", false)
	_, _ = q.Next(ctx, "s1")
	_, _, _ = q.Reply(ctx, "s1", []int64{m.ID}, Declined, "no")
	touched, skipped, err := q.Reply(ctx, "s1", []int64{m.ID}, Answered, "yes after all")
	if err != nil || len(touched) != 0 || len(skipped) != 1 || skipped[0].Reason != "already declined" {
		t.Fatalf("touched %v skipped %+v %v, want skipped already declined", touched, skipped, err)
	}
	if got, _ := q.Message(ctx, m.ID); got.State != Declined {
		t.Fatalf("state %s, want declined", got.State)
	}
}

func TestWorkingOnNoReplyIsSkippedAndAnsweredAccepted(t *testing.T) {
	q, _ := newQueue(t)
	th := thread(t, q, "s1")
	m := post(t, q, th, "one", false)
	d, _ := q.Next(ctx, "s1")
	_, _ = q.Landed(ctx, "s1", d.Token)
	_, _ = q.TurnEnded(ctx, "s1")
	if _, skipped, err := q.Reply(ctx, "s1", []int64{m.ID}, Working, "late"); err != nil || len(skipped) != 1 {
		t.Fatalf("working on no_reply: skipped %+v %v", skipped, err)
	}
	if got, _ := q.Message(ctx, m.ID); got.State != NoReply || got.Line != "" {
		t.Fatalf("state %s line %q, want no_reply with no line", got.State, got.Line)
	}
	if touched, _, err := q.Reply(ctx, "s1", []int64{m.ID}, Answered, "late answer"); err != nil || len(touched) != 1 {
		t.Fatalf("late answer touched %v %v", touched, err)
	}
	if got, _ := q.Message(ctx, m.ID); got.State != Answered {
		t.Fatalf("state %s, want answered", got.State)
	}
}

func TestAReplyToOneSentMessageBringsTheDeliveryToTheAgent(t *testing.T) {
	q, _ := newQueue(t)
	th := thread(t, q, "s1")
	m1 := post(t, q, th, "one", false)
	m2 := post(t, q, th, "two", false)
	d, _ := q.Next(ctx, "s1")
	if _, _, err := q.Reply(ctx, "s1", []int64{m1.ID}, Answered, "done"); err != nil {
		t.Fatal(err)
	}
	if got, _ := q.Message(ctx, m2.ID); got.State != WithAgent {
		t.Fatalf("m2 %s, want with_agent", got.State)
	}
	if got, _ := q.Delivery(ctx, d.ID); got.ShownAt.IsZero() {
		t.Fatal("delivery not shown")
	}
}

func TestReceivedFromAnOldChannelLands(t *testing.T) {
	q, _ := newQueue(t)
	th := thread(t, q, "s1")
	m := post(t, q, th, "one", false)
	_, _ = q.Next(ctx, "s1")
	if _, _, err := q.Reply(ctx, "s1", []int64{m.ID}, "received", ""); err != nil {
		t.Fatal(err)
	}
	if got, _ := q.Message(ctx, m.ID); got.State != WithAgent {
		t.Fatalf("state %s, want with_agent", got.State)
	}
}
