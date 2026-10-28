package serve

import (
	"flag"
	"testing"

	"github.com/subaud-tools/tools-common/wiregen"
)

// updateWire rewrites web/wire.d.ts instead of asserting it. `go test ./internal/casebook/serve/ -run TestTheWireTypeIsCommitted -update`.
var updateWire = flag.Bool("update", false, "rewrite internal/casebook/web/wire.d.ts from the Go structs")

// wireRoots is THE CONTRACT: every view struct the browser reads off the
// casebook page API and the agent API. Adding a struct here is how a new
// endpoint's payload becomes a type the browser cannot silently disagree with.
//
// The order is the order they are emitted in: summary first (the page's first
// read), then list/item views, then mutation results, then agent views.
var wireRoots = []any{
	ValuesView{},
	SummaryView{},
	ItemsView{},
	GroupView{},
	ItemDetailView{},
	DecideResult{},
	AcceptResult{},
	RejectResult{},
	WithdrawResult{},
	SessionsView{},
	DeliveryView{},
	ThreadsView{},
	MessagesView{},
	SendBatchResult{},
	ResendResult{},
	WaitView{},
	ReplyResult{},
	ProposeResult{},
	StatusView{},
	NextView{},
	InterruptedView{},
	OpenResult{},
	SettledResult{},
	ReportResult{},
	RulesView{},
	RuleRow{},
	FiltersView{},
	FilterRow{},
	RuleDetailView{},
	MatchPreview{},
	ReasonCount{},
	RepoGroup{},
	MatchRow{},
	VocabularyView{},
	DecisionVocabView{},
	ClearResult{},
	DecisionUndoResult{},
	JobStepResult{},
	JobAskResult{},
	PlanView{},
	JobView{},
	JobsView{},
	NeedsYouView{},
	AnswerResult{},
	UndoResult{},
	SyncView{},
	SyncEvent{},
	PushEvent{},
	SessionProgressView{},
}

const wirePath = "../web/wire.d.ts"

// The committed web/wire.d.ts matches the structs' json tags (tools-common's
// wiregen), so the page cannot silently disagree with the API.
func TestTheWireTypeIsCommitted(t *testing.T) {
	if err := wiregen.CheckCommitted(wirePath, wireRoots, wiregen.Options{
		Header:     wireHeader,
		Regenerate: "go test ./internal/casebook/serve/ -run TestTheWireTypeIsCommitted -update",
	}, *updateWire); err != nil {
		t.Fatal(err)
	}
}

const wireHeader = `// wire.d.ts — THE GO↔JS CONTRACT, GENERATED. DO NOT EDIT.
//
// Written by internal/casebook/serve/wire_test.go from the json tags of every
// view struct returned by the casebook page API and agent API. Adding a struct
// to wireRoots is how a new endpoint's payload becomes a type the browser
// cannot silently disagree with. A named string type with a Values() method
// is an enum and is declared as a union of those values.
//
// Regenerate with ` + "`go test ./internal/casebook/serve/ -run TestTheWireTypeIsCommitted -update`" + ` and commit.
// Drift fails ` + "`just verify`" + ` (Go-only, always run in CI and the pre-push hook).
//
// READING THE OPTIONALITY:
//
//   - ` + "`x?: T`" + ` — the Go field carries ` + "`omitempty`" + ` or ` + "`omitzero`" + `, so the key is ABSENT from
//     the payload when it is the zero value.
//   - ` + "`x: T[] | null`" + ` — no ` + "`omitempty`" + `, so a nil slice is serialized as JSON
//     ` + "`null`" + `. The type says so rather than promising an array.
//   - a ` + "`time.Time`" + ` is a string (RFC3339). It is not a shape on the wire.
`
