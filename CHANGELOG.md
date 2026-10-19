# Changelog

All notable changes to `casebook` are documented here. Releases up to 0.14.0
were cut from github.com/subaud-tools/tackle and are headed with the tool's
name, as they were there. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions follow
[Semantic Versioning](https://semver.org/).

## 0.17.0

- Each item says what stands in the way of its decision: a branch in use by a worktree or checked out in its clone, a long-lived branch, an archived repo, a merge GitHub would refuse, a local copy only on the other Mac. Decide, review, run, `casebook show` and the agent all say it the same way.
- Rules no longer recommend closing a PR or issue in an archived repo, or deleting a long-lived branch.
- A branch's GitHub copy is deleted through GitHub's API, so it runs from either Mac; it is refused if it moved or hasn't landed, and undo makes it again at the same commit.
- Review removes a clean worktree decided Remove it before deleting its branch, keeps held items in a Held section, and lists the local copies that wait for the other Mac. An item is done when every copy is gone.
- Review tags what can't be undone, what is undone on GitHub, and every step that posts a public comment (with its text), and ticking several groups makes one review.
- `casebook sync` also records each clone's current branch and each open PR's merge status.

## 0.16.3

- A run's steps table puts why a step stopped on its own line, and a branch's repo above it: a long reason (a worktree path) had squeezed the key to one character wide.

## 0.16.2

- A long-lived branch (the repo's default, or one named main, master, dev, develop or staging) is never landed and never deleted, even by a job made before this release. A dev → main release PR used to make dev look landed.
- A branch that is checked out in a clone or worktree is never deleted; the step stops and says where it is checked out.
- A remote branch delete skips the repo's pre-push hooks, which check code being pushed (a delete pushes none).
- A merge is a squash: gh refuses to choose a method when nobody is at the keyboard.

## 0.16.1

- A group's button (and any decide of several items) records all its decisions in one commit: 1,757 landed branches now take under a second, not six minutes. Each item's history shows that commit, which lists every item it decided.

## 0.16.0

- Two more starter rules for a new casebook-data: **Quiet clean worktrees** (no changes, nothing unpushed, no activity for 3 days: remove it; undoable) and **Org repos not pushed in a year** (stop tracking it; an org's repos can't be archived from here). An existing casebook-data keeps its rules; add these from the rule editor if you want them.
- Accepting a group's recommendations redraws the page once, not once per item.
- The bar says "saving N" while decisions wait to be copied to casebook-data, and turns red ("offline", "push failed") only when a copy actually failed.
- A push that lost a race with another machine (GitHub's "cannot lock ref … expected …") is retried after a rebase instead of shown as "push failed".

## 0.15.1

- The release moves casebook.tools/dl/casebook/latest, so `casebook update`, `kempt update` and the installer find the newest version.

## 0.15.0

### Changed
- casebook lives in its own repository, github.com/subaud-tools/casebook, and downloads from casebook.tools. A casebook installed before 0.15.0 updates from tackle.tools and stays at 0.14.0: run `kempt update` or the casebook.tools installer once to move to casebook.tools.
- New `casebook.toml`, rule and filter files say their format is documented in subaud-tools/casebook. Files an older casebook wrote keep their old comment until casebook next rewrites them; nothing reads it.

## [casebook 0.14.0] - 2026-10-17

### Added
- A walkthrough the first time casebook opens, on the real page: the page pauses (nothing can be clicked and nothing live moves) while one control at a time is outlined with a short note, in the order casebook is used: decide, filters, rules, a decision button (on the first item in the list), review, the agent. Each step has next and skip (Esc skips). It decides nothing, and puts the page back as it found it. Once done or skipped it doesn't show again on its own; `g w` (listed in the `?` overlay) shows it again.

### Changed
- The page has three steps: decide · review · run (apply is gone). review lists the decisions waiting, grouped by what will happen; a group's button opens it: its title with its counts ("Delete 7 repos"), what it does ("Cannot be undone." in red when a step is permanent), "runs through <agent>", the exact commands, and one button named for the action. Pressing it runs it (a step that can't be undone asks first, naming each item) and the job opens in run. Leaving a group runs nothing. run lists the jobs running, then the finished ones, collapsed. The bar counts the decisions waiting in review and the jobs running.
- The agent the page is attached to runs a group's outward steps; there is no session menu. With no agent attached, review says "Open casebook from an agent to run this." and its button is off; a group that is all local needs none.
- There are no plans to approve or discard: opening a group plans exactly its items, reusing the plan casebook built for them, or replacing one that held any of them (an item is still in one job that hasn't finished). Plans left from before are reused or replaced the same way.
- Old `#/apply` links open review (`#/apply/<job>` opens the job in run); the strip after a decision says "waiting in review"; `g v` goes to review and `g r` to run.
- The browser probe keeps only checks that nothing runs without your click, that decisions aren't lost or doubled, and one end-to-end pass; it runs faster and no longer fails on slow runners.

## [casebook 0.13.0] - 2026-10-17

### Added
- The agent pane is a thin strip until there's a conversation in its thread; a click on it, a message arriving, or asking the agent opens it, and its › folds it back. A click is kept for the tab.
- What you're looking at always goes with a message: the ticked items, else the open item, else the open rule, else the list as it is narrowed ("list · 2 filters · rule x · search foo"), never thousands of keys. The agent reads it as `attached: list filters a,b · rule x · search "foo" · group none`.
- `casebook_attention` takes `rule` (a rule id: what it matches) and `group` (one group of the list: `none` is the not recommended), the parts of an attached list.
- "Not recommended yet" offers "ask agent to suggest rules" (the message carries its group of the list), and "ask agent to recommend these" when items in it, or in "Came back", are ticked.

### Changed
- Buttons that hand work to the agent say "agent", never the session's name: "ask agent to recommend these", "hand to agent". A recommendation reads "agent recommends" (a rule's, "‹rule› recommends"); the dock's header still names the session.

### Removed
- A group's "Look into N" and the left-open group's "Look into all N": at scale the agent is asked for rules, and one open item still has "Look into it".

## [casebook 0.12.0] - 2026-10-17

### Added
- A rule field for repos, `ownership`: `yours`, `org` or `fork` (on the page: yours, an org's, a fork). A fork under an org counts as the org's.
- Two starter rules, on: "Your old repos" (kind is repo; ownership is yours; archived is false; updated older-than 52w) recommends Archive it on GitHub, and "Your old forks" (kind is repo; ownership is fork; updated older-than 52w) recommends Delete it. Old repos in orgs have no starter rule; they are decided by hand.

### Changed
- The next write to an existing casebook-data replaces the shipped "Repos not pushed in a year" rule (`rules/dormant-repos.toml`) with "Your old repos" and "Your old forks", in one commit ("replace dormant-repos with your-old-repos and your-old-forks"), and the rebuild after it withdraws the old rule's "Stop tracking it" recommendations. This happens only when that file is still exactly as casebook shipped it: a dormant-repos you renamed, turned off, edited or added an exclusion to is left as it is, and a rule you already have named your-old-repos or your-old-forks is kept.

### Removed
- The `fork` rule field (true/false); use `ownership is fork`.

## [casebook 0.11.0] - 2026-10-17

### Added
- A plan says, for each group of steps, where it runs ("Runs here, on ‹machine›." or "Runs on GitHub, through ‹agent›.") and whether it can be undone ("Can be undone: undo makes the branch again at the same commit."; "No undo here: unarchive it on GitHub to reverse it."). serve sends it as each plan group's `undo` and each job step's `undo_note`.
- `GET /api/items?view=to-apply` groups the decided items by what will happen: group ids `‹disposition›|‹kind›`, labelled "Delete 30 branches", "Close 5 PRs", "Archive 10 repos", in kind order (repos, PRs, issues, branches, worktrees). The decision vocabulary names each kind (`noun`, `nouns`).
- The waiting strip's "apply" opens the group the decision joined (`#/apply?group=close|issue`).

### Changed
- apply is one list, grouped like decide, with no view chips: running jobs on top, each with a progress bar that moves as steps finish; then plans not approved yet and the decided items waiting, each group headed by its button ("Delete 3 branches…", or for the ticked items "Delete 1 branch…"); Done, collapsed, last. A group's button opens its plan in the middle pane with each item's exact command; nothing runs from the list. An item in a plan or a job leaves its group until that finishes or is discarded.
- A plan's button is "approve and run" in both lanes (the bar's primary "Approve and run").

### Removed
- apply's running, ready and done chips, its foot's "plan N" and "plan all N", and the overview's plan buttons.

## [casebook 0.10.0] - 2026-10-17

### Added
- After a decision that goes to apply, the next item opens and a strip says where it went for 6 seconds: "Closed it · waiting in apply · undo" ("apply" opens apply). A group's button says it for the lot ("Deleted all 3 · waiting in apply · undo"), and its undo takes them all back.
- `POST /api/decisions/undo` takes a list (`{items: [{key, expect, restore}]}`): one undo for one item or a batch, one rebuild. An item decided elsewhere since is left as it is and named in `errors`.

### Changed
- The item page reads what it is, then decide, then reading: kicker, title and one line of facts ("came back · ‹reason›" first when it came back); one fixed-height row of short decision buttons with "Look into it" last; then the recommendation's reason and source, the description, evidence and history. The page scrolls; nothing in it has its own scrollbar. The empty recommendation box and the fixed description box are gone.
- Each decision button is named for its decision, the recommended one marked "recommended", and its hover says what happens on GitHub and when ("Decides to close this issue. Nothing happens on GitHub until you run it in apply."; "Decides to keep it as it is. Nothing to run.").
- Pressing the recommended button accepts the recommendation; pressing another decides the item your way and counts against the rule or agent as decided differently.

### Removed
- The recommendation card's accept, change… and reject, and the `a` and `r` keys.

## [casebook 0.9.0] - 2026-10-17

### Added
- Two places, named once: the bar reads `decide · N` and `apply · N` (`g d` and `g a`). decide is one list of everything to decide: no view chips. Items that came back (due, drift, conflict) lead it in a "Came back" group, each row saying why, whether grouped or flat.
- Rules live in decide's list. Each rule's recommendations are a group headed by the rule: its name, "rule", its decision, its count and ⋯ (edit, turn off), with one button for the lot ("Delete all 30"). Under the filters, "+ rule" opens the rule editor beside the list (the list previews it; saving turns the rule on), and "rules N" lists every rule, off ones too, in the middle pane; a rule opens there read only, and the list narrows to it (`#/decide?rule=<id>`).
- With nothing open, the middle pane is a summary: how many to decide, how many came back, what each rule and agent recommends, how many are not recommended yet, and "discard all N" while agents recommend.
- Example rules arrive with the next write: Landed branches, Bot PRs quiet for 30 days, Repos not pushed in a year. Agents save rules on (`casebook_rule_save`).

### Changed
- Turning a rule off, editing it or deleting it withdraws the recommendations it no longer makes, at once, not on the next sync; an edited rule recommends anew in the same save.
- A recommendation decided another way counts against its rule as "decided differently", not as accepted.
- Old addresses still work: `#/attention…` and `#/rules/<id>` land on decide with the same filters, rule or flat choice.
- `casebook_open` opens an item or the front; it no longer takes `view`.

### Removed
- The Rules tab, the view chips (new, due, proposed) and the list's foot summary.

## [casebook 0.8.2] - 2026-10-17

### Fixed
- A sync without a GitHub refresh (the one pi runs after a session event) no longer writes this machine's branches with no landed state. Every branch read "unknown" until the next full sync, so landed-branch filters and rules matched nothing for most of each half hour. It now works landed out from the cached merged-PR lists, as a full sync does.

## [casebook 0.8.1] - 2026-10-17

### Fixed
- The page's tab icon and animated mark are drawn in casebook's rose, matching casebook.tools, instead of tackle's rust.

## [casebook 0.8.0] - 2026-10-17

### Added
- Saved filters on the Attention list: a row of chips under the views. Selecting one or more lists every item that matches all of them, whatever its status, newest first; the address keeps the selection (`#/attention?filters=outgoing-prs,quiet-14d`) and grouping applies as on any list. `+ filter` opens the editor in the middle pane, beside the list: its title, the name with save and cancel, then the conditions; each chip's menu edits or deletes it. While it is open the list is the preview: it shows the draft's matches live, newest first, faded, under "previewing a draft filter · N items" ("add a condition to preview" with none), and cancel or Esc puts the list back as it was. Save selects the new filter (`#/attention?filters=<id>`). A filter that doesn't validate shows as not valid, with serve's reason, and can be edited or deleted but not selected.
- Filters are files in casebook-data, `filters/<id>.toml`: a name and the rules' conditions. Five examples arrive with the next write: Outgoing PRs, Incoming, Not updated in 14 days, Unpushed commits, and Repos not pushed in a year. A deleted example never comes back.
- `GET /api/filters`, `POST /api/filters/save`, `POST /api/filters/delete`, and `filters=<id>,<id>` on `GET /api/items`; an unknown or invalid filter is refused by name. Each save or delete is one commit, pushed like a decision. `casebook_attention` takes `filters` and names the saved filters.
- Conditions read in plain words, in the filter editor and on the Rules page alike: "type is pull request", "opened by is someone else", "last activity within the last 14d", "unpushed commits is yes". One condition per field, OR within a field and AND between fields: a type, status or other fixed-value field ticks its values ("type is issue or pull request", saved as `in`), never free text; a text field's box shows a real example. The field chips are always shown above the conditions, grouped by the types each applies to, a chip's hint in its tooltip; clicking one adds its condition below, so the editor only grows downward. A field already used, or one the chosen types don't have, is greyed and says why. A new type condition starts with nothing ticked, and a condition with no value yet isn't previewed. Last activity and opened take a number and a unit ("more than 3 weeks ago", "within the last 2 days", saved as `3w`, `2d`) or a date ("before 2026-08-04", "on or after", saved as `YYYY-MM-DD`). Repository, owner, author and label are picked from what casebook has seen, each with how many items have it, or typed; several are "or" (saved as `in`). A `*` matches within one part of a name (`schuettc/*`, `*/hail`): typed, or offered first as you type an owner or a name several owners share. Validation, for rules too, refuses a field used twice ("condition 2: type is already used by condition 1") and a field the chosen types never have ("condition 2: unpushed commits doesn't apply to issues"). `GET /api/items` takes `match=` (a draft's conditions, as JSON) and lists what saving them as a filter would. `GET /api/rules/values?field=` lists a field's values casebook has seen, with their item counts. `GET /api/rules/vocabulary` carries each field's `label`, `help` and `value_labels`, and `operators` with their labels, and each field's `kinds` (the item types it applies to). Files keep the raw names.

### Changed
- `worktree` also matches worktree items: a worktree is `dirty` or `clean`; a branch is its worktree's, or `none`.
- `relation` is for pull requests and issues only; it never matches a repo (match repos with `fork`).
- `POST /api/rules/preview` returns its matches newest first, so a rule's match list is newest first too.
- The example "Repos not pushed in a year" is `kind is repo; updated older-than 365d`.

### Removed
- Rule and filter conditions that repeated another: `pushed` (use `updated`), `direction` (use `relation`), `has-decision` (use `status is-not new`) and `dirty` (use `worktree is dirty`). A file that names one is not valid ("unknown field"): edit it on the page.

## [casebook 0.7.0] - 2026-10-16

### Changed
- Module path is now github.com/subaud-tools/tackle; the source lives at github.com/subaud-tools/tackle.

## [casebook 0.6.0] - 2026-10-16

### Changed
- Every Attention list shows the most recently active items first: a pull request's or issue's last update on GitHub (a comment counts), a repo's last push, a branch's last commit. An issue a bot comments on every day comes back to the top each time.
- Groups are ordered by their newest item, not their size, and items are newest first in each group. Left open stays last and collapsed.
- "group by recommendation" switches the list between groups and one flat list, newest first, each row naming its recommendation, with no group buttons. The page remembers the choice and the address keeps it (`#/attention/new?flat`), so a bookmark opens either list. `GET /api/items` takes `group=false` for the flat order.
- The page opens on due; old links to the board or to waiting on you land on due. `casebook_next` goes through due, then new.

### Removed
- Age flags: the four policy rules (outgoing PR stale, incoming with no reply, unpushed commits, dormant repo), `policy.toml` and the `policy-hit` rule condition. The next write to casebook-data deletes `policy.toml` in one commit; an older casebook reads a missing file as its defaults. casebook-data's README loses its Flagged lane.
- The "waiting on you" view, its count, and `waiting` in `casebook_open` and `casebook_attention`. "Waiting" now means only a Not now decision.

## [casebook 0.5.0] - 2026-10-11

### Changed
- Attention's list is grouped by recommendation. Each group has a header (a checkbox for the whole group, the choice, the count) and its own buttons: "Close all 27 · Look into all 27 · Discard all 27", or "Close 3 · Look into 3 · Discard 3" for the items ticked in it. A group's buttons act on the whole group across every page, never on another group. Collapsed, a group is one line; ticking a collapsed group opens it. Items with no recommendation are a last group, "Not recommended yet", with "Ask ‹session› to recommend N". Left open is a group too, collapsed at first, with Look into.
- Each row shows the agent's reason under its title, and every row is one height.
- "Clear" is now "Discard": it throws away the agent's recommendation and nothing else.
- The summary ("36 items, 36 recommended", with "discard all N") is pinned to the bottom of the list.
- The list is 520px wide and collapses to a thin strip (it remembers which).
- The item page is wider. The agent's recommendation sits above the description at a fixed size, with accept, change… and reject; the choices wrap when the column is narrow. Moving between items, choosing a card, or an item having no recommendation moves nothing on the page.
- serve names the session behind each recommendation; the page says "tools-workspace/casebook recommends", not "pi recommends".

### Added
- « ‹ › » at the top of an open item: the previous or next item, and the previous or next group's first item, with "1 of 27 in Close it without merging". The `[` and `]` keys jump groups.

### Removed
- The board view. A link to it opens waiting on you; `casebook_open` no longer offers it.
- The kind, repo, relation, bot/human, age and rule chips (four did nothing). Search stays; agents' filters stay in the API.
- The generic "Decide N selected" button and its d key: ticked items act through their group's buttons.

## [casebook 0.4.8] - 2026-10-08

### Added
- "clear N recommendations" on the "N recommended · M not yet" line, when
  the view has any recommendations from an agent (N is the view's count,
  with its filters, every page of it). It opens a confirm: "Clear N
  recommendations in ‹view›? Their items go back to the agent to
  recommend again. Nothing is decided or rejected.", with clear and
  cancel. Each group in the list foot ("pi recommends Leave it open for
  474") offers "clear these N" too, for exactly that group, with the same
  confirm. After a clear the line and counts follow, and "ask ‹session›
  to recommend the rest" is offered again. A rule's recommendations are
  never cleared.
- `POST /api/proposals/withdraw`, with `{ids}` or a view and its filters
  (as `GET /api/items` takes them): it withdraws the pending agent
  recommendations (`pi:…`, `claude:…`; never `rule:…`) and answers
  `{withdrawn: n}`, the items that lost one. It publishes a `proposals`
  event with state `withdrawn` and the keys. `GET /api/items` says the
  view's count as `agent_recommended`.
- A proposal state, `withdrawn`: cleared to be made again, with no
  judgement. It isn't a rejection: neither a rule's track record nor the
  agent's since-summary counts it, and a withdrawn recommendation no
  longer shows on the page. `casebook_next` hands its item out again.
- The agent's guide says a proposal marked withdrawn was cleared to be
  made again, so the agent recommends afresh rather than repeating it.

## [casebook 0.4.7] - 2026-10-08

### Fixed
- A view, filter or search change made while the Attention list was
  loading is no longer dropped. The list used to skip a reload asked for
  while one was on its way, so it kept showing the old view (live events
  reload it often, so this happened in real use). Now one load is in flight
  and at most one is queued (the coalescing the dock and To apply use for
  sessions); the queued one asks with the view, filters and search as they
  are when it runs. A load whose query changed while it was on its way
  paints nothing, so an older view never shows over a newer one. A "show
  more" page that comes back after the list started loading again is not
  added to the new rows. The probe holds a list load and switches the view,
  and types a search, while it is held.

## [casebook 0.4.6] - 2026-10-07

### Changed
- "Look into it" is a card now, not a button under the cards: the last
  card in the grid, numbered after the decisions (6 on a pull request, 5
  on an issue), laid out like the others. It reads "‹session› checks its
  CI and recent activity, finds what's wrong, and comes back with a
  recommendation. Nothing is decided yet." It is the agent's, not a
  decision: an amber left edge and number line, like the recommendation
  card. Its number key picks it. It sends the same message as the button
  did, and decides nothing. While the session is looking, the card says
  "‹session› is looking into it" instead and can't be clicked. With no
  session attached it isn't there. The decision vocabulary's `look_into`
  carries the card's `label` ("Look into it") and its sentence (`says`,
  with a `{session}` hole) in place of the button's label.
- The agent's guide (`casebook_next`) says to look into an item blocked by
  something it can check, such as a failing CI check, with gh before
  recommending, to record what it finds with `casebook_evidence`, and not
  to recommend leaving an item open just because someone needs to look.

### Added
- "ask ‹session› to look into all N" beside each "agree with all N" in the
  list foot, when a session is attached. It sends that session one
  message naming the group's items, with all of them attached and
  `purpose: "look-into"` (the vocabulary's new `look_into.message_many`,
  with a `{keys}` hole). Every row of the group says "‹session› is looking
  into it" until the message settles; serve already marks every item a
  look-into message names.

### Fixed
- Clicking an item in the list loads it once. Before, the click loaded it
  and the address change that follows loaded it again, so it was fetched
  and drawn twice. Back, forward and a pasted item link still load the
  item they name.

## [casebook 0.4.5] - 2026-10-07

### Fixed
- A recommendation made for the item you have open now shows on it at
  once: its recommendation card, with the reason, and the "recommended"
  mark on the proposed choice. Before, the list row said "pi recommends
  …" while the open item showed nothing until you reopened it. The same
  goes for a recommendation accepted, changed or rejected elsewhere, and
  for one a rule makes. If you are mid-answer on that item (a closing
  comment typed, or the Not now picker open), it isn't redrawn under you:
  a quiet line reads "pi recommends ‹label› · show", and "show" redraws it.
- Every `proposals` live event now names the items its proposals are for
  (`keys`), and a rule's new proposals (propose once, or an active rule
  after a sync) publish one too, from `rule:<id>`.

### Added
- "ask ‹session› to look into it" under the cards of the item you have
  open, when a session is attached to the page. It decides nothing: it
  sends that session a normal message, with the item attached, asking it
  to check the item's CI, recent activity and anything blocking it, add
  what it finds as evidence and recommend what to do. Like any message, it
  waits for the end of the agent's turn.
- While that message is queued or being worked on, the item says
  "‹session› is looking into it" under its question, and its list row says
  so on one line, as the row's "pi recommends …" does. It goes when the
  agent answers, declines or fails the message; the evidence and
  recommendation it added show on the open item as they come. serve marks
  the item (`looking` on the item's view) from the message's purpose: the
  button posts it with `purpose: "look-into"`, stored on the message (a
  new `messages.purpose` column, schema version 4). A message you type
  with the same words is just a message.
- The decision vocabulary carries the button's words: `look_into` with
  its `label` ("ask {session} to look into it") and `message` ({key}
  filled in by the page).
- The recommending guide asks the agent, when asked to look into an item,
  to read its CI and recent activity with gh and record what it finds with
  casebook_evidence before recommending.

### Changed
- The recommendation card's head and the board's cards say "recommends",
  as the list's rows do: "pi recommends · Leave it open".
- New evidence for the item you have open shows on it at once (with the
  same "· show" line instead while you are mid-answer: "new evidence ·
  show").

## [casebook 0.4.4] - 2026-10-07

### Changed
- "Leave it open" (and "Keep it" for a branch, worktree or repository)
  keeps the item in your list. It moves to a "left open" group at the
  bottom of each Attention view it would be in (new; waiting on you when
  it is flagged; proposed; all), after the items that need a decision. A
  quiet divider reads "left open · N" with the group's own count, and each
  muted row reads "left open · <date>". The view's count leaves left-open
  items out. Opening one shows its decision and the cards as usual.
  Move-on after a decision skips them. A kept pull request or issue that
  has since closed or merged on GitHub drops out.
- Someone else's activity on a kept pull request or issue that is newer
  than the decision brings it back to the top, needing a decision, with
  "new activity since you left it open". It counts again, and
  `casebook_next` hands it out. `casebook_next` never hands out a quiet
  left-open item.
- "Not now" also comes back on someone else's newer activity, not only
  when its condition is met. The item says which: "its condition was met"
  or "new activity since Not now".
- The cards say so. Leave it open: "It stays open and stays in your list,
  at the bottom. It moves back up when someone replies or it changes."
  Keep it: "It stays as it is and stays in your list, at the bottom."
  Not now: "Hidden until a date or an event you pick, or until someone
  replies or it changes. Then it asks again."
- Someone else's activity is what the GitHub cache records: a pull
  request's or issue's last comment, when someone other than you wrote it
  (or, with no comments, its creation by someone else). The cache keeps no
  commits or reviews, so a push or a review alone doesn't bring an item
  back yet.
- An item's computed status can be `left-open`. `GET /api/items` adds
  `left_open` and `left_open_total` (the view's left-open group), and
  items carry `new_activity`. The board leaves left-open items off. The
  README board lists them in a "Left open" lane, and its summary counts
  them. Stop tracking it is unchanged. casebook-data's format is
  unchanged: this is how status is computed from the decisions you
  already have.

## [casebook 0.4.3] - 2026-10-07

- The same code as 0.4.2: it was tagged before the change listed under 0.4.4 had merged.

## [casebook 0.4.2] - 2026-10-07

### Fixed
- The page no longer replays the whole event log when it loads. It
  starts its live stream at the cursor its first summary carries
  (`GET /api/summary`'s new `cursor`), and everything it shows on load
  comes from its own first reads. On a machine whose log held 206,439
  events, an item took 24.6 s to show after a click; it now shows at
  once.
- A heartbeat no longer publishes a `sessions` event unless it changed
  what the page shows of the session: a new session, one crossing into
  or out of left, a new name or label, becoming or no longer being a
  worker, an end, a queued count. Sessions crossing into left are still
  announced by serve's watch, and the watch now also announces a
  delivery going stuck (or no longer stuck), which the page used to
  learn from the next heartbeat. About 40 live sessions used to publish
  one each every 30 s, and every one made each open page fetch the
  session list again (14,870 fetches for one click).
- The dock and To apply each fetch the session list with at most one
  request in flight and one queued, however many events arrive.
- `GET /api/sessions` answers only what the page uses: live sessions
  that are not subagent workers, plus any named by `?session=` (comma-
  separated: the dock's attached session, shown after it has left, and
  To apply's jobs' sessions). `?all=1` answers every known session.

### Changed
- serve prunes the event log when it starts and every hour, keeping the
  newest 10,000 events or the last 7 days of them, whichever is more.
  It used to drop week-old events only after a day of uptime. A page
  whose cursor is older than the oldest event kept hears a `gap` event
  first (the stream and `/api/state` both send it), and reloads all it
  shows.

## [casebook 0.4.1] - 2026-10-07

### Added
- The open item's key links to its page on GitHub (a pull request, an
  issue or a repository), in a new tab. serve builds the link from the
  key (the item's `url`). A branch or a worktree has no page, so its key
  stays plain text.
- Choosing "Close it" (an issue) or "Close it without merging" (a pull
  request) opens a closing-comment field under the cards. **close with
  this comment** (or ↵) decides with the text as the decision's note.
  **close without comment** decides with no note. Esc cancels. Nothing
  is decided until you press one of them. Number keys still pick the card.
  Selecting several items and agree with all work as before.
- Accepting a close recommendation on the open item (`a`, or the card's
  accept) opens the same closing-comment field, empty, and accepts from
  its buttons. `POST /api/proposals/accept` takes an optional `note`:
  Court's closing comment for an accepted close.

### Changed
- A close posts its decision's note as the closing comment, and nothing
  else. A close with no note now closes without a comment: the command
  has no `--comment` and the step doesn't post. It used to post
  "Closing.". casebook-data's format is unchanged.
- A recommendation's note (the agent's or a rule's reason, written to
  you) is never the closing comment. Accepting a close recommendation
  records no note unless you give the comment yourself: agree with all,
  accept N and an API accept close without a comment. The reason stays
  on the recommendation. Accepting any other recommendation keeps its
  note, as before (it is never posted).

## [casebook 0.4.0] - 2026-10-07

### Changed
- Deciding asks a question ("What should happen to this pull request?")
  and offers its answers as cards that say what each one does and when.
  One click decides; number keys pick a card; `u` undoes. After a
  decision the next undecided item opens. Selecting several items asks
  the same question with the same cards.
- wait and watch are one choice, "Not now". It offers conditions to pick
  (in 1 week, on a date, when a PR merges, when it goes quiet for 90
  days, ...). A PR, issue or repo is found by searching casebook's items
  or pasting a GitHub URL. Existing `watch` decisions read as Not now.
- The server holds all of this wording (`GET /api/decisions/vocabulary`):
  the page and the agent's guide read the same words.

### Added
- `casebook_next`: an agent works through the items that need a
  recommendation, one at a time, with a guide on how to recommend. A
  recommendation from it needs a one-line reason.
- Recommended items sort first. Attention shows "N recommended · M not
  yet" and can ask the attached session to recommend the rest.
  "agree with all N" accepts a group of matching recommendations; close,
  merge, archive and delete still only go to To apply.
- `POST /api/decisions/clear` removes a decision (undo).
- A Not now condition naming a PR, issue or repo that GitHub can't find
  brings the item back to attention, saying so, after the next sync.

## [casebook 0.3.1] - 2026-10-06

### Fixed
- A casebook serve restart no longer wakes every agent session on the
  machine. A session hears about a restart only when that restart
  interrupted messages in flight to it, and the notice says which ones
  ("casebook serve restarted while 2 messages to you were in flight (7,
  8)…"). Every other session hears nothing. The channel asks serve (the
  new, session-scoped `GET /api/agent/interrupted`), and when serve can't
  answer (an older serve, an error) it stays silent. The notice no longer
  mentions the page reopening in a new tab: that is about the browser, not
  the agent's work.

### Upgrading
- The fix is in the channel each agent session runs (`casebook channel`)
  and in serve. Sessions still running the 0.3.0 channel keep the old
  behaviour until they restart: every serve restart still wakes them. So a
  serve restart while 0.3.0 channels are running (including the one that
  picks up this release) wakes those sessions one last time; restart serve
  when few old sessions are left. Until serve restarts, a new channel finds
  an old serve that can't say what a restart interrupted, and stays silent.

## [casebook 0.3.0] - 2026-10-06

### Changed
- The page belongs to the agent session that opened it: `casebook_open` and
  `casebook serve` run by a session open it attached to that session, and
  it never sends anywhere else. With no session it asks which one, unless
  exactly one is here. pi-subagents workers are not offered; pi sessions
  show by name (`pi-casebook` 0.3.0 reports names and parent sessions).
- serve refuses (409) a page's message or batch into a thread that now
  belongs to another session, and the page drops a thread moved away.
- serve prunes sessions gone for 7 days that nothing refers to.

### Upgrading
- Restart casebook serve after installing (`casebook serve --stop`; the next
  `casebook_open` or `casebook serve` starts the new one). Neither kempt nor
  anything in casebook restarts a serve that is already running, and an old
  serve can't attach the page: until it restarts, `casebook_open` opens the
  page unattached and says a restart is needed. The working database moves
  to schema v3, which older casebook binaries refuse.

## [casebook 0.2.1] - 2026-10-01

### Fixed
- Git activity in temp folders is never journalled: `casebook hook`,
  `casebook record` and the spool drain at `casebook sync` drop events whose
  working directory, git dir or (for an agent's command) every action's
  directory is under a temp root (`os.TempDir()`, `$TMPDIR`, `/tmp`,
  `/var/folders`, and their `/private` real paths). Paths are compared by
  whole segments with symlinks resolved; a configured scan root is never
  temp. Copier and pytest checkouts, `tmp.*` clones, casebook's own probe
  homes and scratch clones made most of the journal. `casebook hooks adopt`
  refuses a temp clone. A temp folder doing real work is still journalled:
  a linked worktree whose git dir (or common dir) is in a configured root,
  and a push to a remote that isn't a local path or `file://` URL (a scratch
  clone's pre-push to GitHub, an agent's `git -C /tmp/x push`).

### Added
- `casebook prune --temp`: removes temp-folder events journalled before the
  fix. A dry run by default (per-file and total counts, the top temp
  prefixes, how many removed lines carry a repo and which, the derived
  records it would clean); `--apply` rewrites only
  this machine's journal files, keeping every other line byte for byte, and
  drops temp clones from its snapshot, under casebook-data's lock, in one
  commit that is then pushed. History is not rewritten. An apply that dies
  before its commit is committed under its own message by the next sync; a
  refused push keeps the commit, prints the report and says the next sync
  pushes it.

## [casebook 0.2.0] - 2026-10-01

### Added
- `casebook serve`: a local page for working through casebook's attention
  list, started on demand on loopback. Four sections:
  - **Attention**: views (waiting on you, new, due, proposed), a board view,
    the item with its evidence and history, decide one or many, and accept or
    reject the agent's proposals.
  - **The agent panel**: the attached session, threads with delivery state,
    a message box with the attached context, a batch tray, the agent's live
    progress line, and a waiting strip. Messages wait for the end of the
    agent's turn.
  - **Rules**: standing rules with a conditions editor, live match previews,
    exclusions and a draft/active lifecycle. Rules propose; they never
    decide. An agent can draft a rule; only the user activates it.
  - **To apply**: plans that show the exact command for every step, approval
    with an explicit session for outward steps, jobs with needs-you cards for
    public comments, restore records, verification, pause, resume and undo.
    A stale plan offers to sync first; an item is in at most one unfinished
    job.
- `casebook channel`: the agent side, over MCP, for Claude Code and pi
  (`pi-casebook` 0.2.0).
- The keyboard layer (`?` lists the keys), and clear states for a lost
  connection, a restarted server, and decisions waiting to be pushed.

### Changed
- A decision replies once it is committed; the push to casebook-data runs in
  the background. A failed push shows as `push failed · N queued` with its
  reason; plain offline stays `offline · N queued`.
- Writes to casebook-data take one lock shared by serve, the background sync
  and the CLI, so a commit never picks up another process's half-written
  files. casebook-data ignores casebook's temporary files.
- Agent-facing text names the configured user.
- The macOS binary is signed and notarized.
