// decide-list.ts — decide: one list of everything to decide, search, the
// filters, rules as groups, and the item, rule or summary in the middle
// pane.
//
// makeDecide(ctx) builds decide on the shared list pane (list-pane.ts): its
// own row is the rules (a chip per rule, "+ rule"), its tools "group by
// recommendation"; it fetches items from GET /api/items (view=all), and
// opens items in the reading column via renderItem() from item.ts. Each
// rule's recommendations are a group whose head is the rule (its name,
// "rule · its decision", its count, ⋯); "came back" leads.
//
// The Selection store is exported so the page's other parts bind to it
// without creating a second store.

import {
  createSelection,
  type Selection,
  h,
  ApiError,
  type KeyBinding,
} from '/_kit/kit.js';
import type {
  Condition,
  ItemsView,
  ItemView,
  ItemDetailView,
  DecideResult,
  AcceptResult,
  Committed,
  DecisionUndoResult,
  DecisionVocabView,
  GroupView,
  Message,
  FilterRow,
  FiltersView,
  RuleDetailView,
  RuleRow,
  RulesView,
  AttachedList,
} from './wire.d.ts';
import type { Ctx, Section } from './app.ts';
import { renderItem } from './item.ts';
import { getVocab, renderTicked } from './decide.ts';
import {
  pluralize,
  nextInView,
  MORE,
  recommendLine,
  lookIntoCard,
  navTargets,
  shortKey,
  standsLine,
  decideSummary,
  splitTicked,
  tickedWords,
  countWord,
  kindFromKey,
  decideRoute,
  doneWords,
  waitingStrip,
  applyGroupLink,
} from './decide-math.ts';
import { decideQuery, flatFor } from './router-helpers.ts';
import { groupKeys } from './key-layer.ts';
import { showChoiceError } from './choices.ts';
import { lookingLine } from './sessions.ts';
import { coalesced } from './coalesce.ts';
import { openDiscardSheet } from './proposals.ts';
import { filterEditor, renderFilter, type FilterEditor } from './filters.ts';
import {
  makeRuleRow,
  ruleEditor,
  ruleMenu,
  toggleRule,
} from './rule-editor.ts';
import { PREVIEW_DEBOUNCE_MS, renderRule } from './rules.ts';
import { parseFilterIds, filterLabel } from './filters-text.ts';
import {
  makePane,
  setHashQuery,
  type Pane,
  type PaneGroup,
} from './list-pane.ts';
import { paneQuery, paneParams } from './list-pane-text.ts';
import { makeObs } from './obs.ts';

// STRIP_MS is how long the strip after an outward decision ("Closed it ·
// waiting in apply · undo") shows.
export const STRIP_MS = 6000;

// SUGGEST_RULES is what the not-recommended group's "ask agent to suggest
// rules" sends the dock's session, with the list's not recommended group
// attached (its filters, rule and search): at volume the agent is asked
// for rules, not item by item (spec point 10). A normal message, delivered
// when its turn ends.
export const SUGGEST_RULES =
  'Please suggest rules for the items in the attached list: look at what they have in common and draft rules (casebook_rule_save) that would recommend a decision for many of them at once. Recommend nothing item by item.';

// PAGE_SIZE is the number of items fetched per page. The kit is tested to 500
// rendered rows; we paginate at 200 to stay safe.
const PAGE_SIZE = 200;

// Shared selection store.
export const selection: Selection = createSelection();

// The list has no field filter chips (Court, 2026-10-10: search only);
// serve's filter parameters stay, for agents' tools. Saved filters
// (filters.ts) are the chip row at the top; there are no view chips: decide
// is one list (view=all).

// State for the selected saved filters or rule and the search text. With
// filters selected the list is every item matching all of them, whatever
// its status.
interface Filters {
  filters: string[];
  // rule is the selected rule (the list shows its matches), or null.
  rule: string | null;
  q: string;
}

function emptyFilters(): Filters {
  return { filters: [], rule: null, q: '' };
}

// LEFT_OPEN is the left-open group's id among the groups' (collapsed).
const LEFT_OPEN = 'left-open';

// GROUPING is where the list's "group by recommendation" switch is kept
// ('flat' or 'grouped'); the list starts grouped.
const GROUPING = 'casebook.grouping';

function storedFlat(): boolean {
  try {
    return localStorage.getItem(GROUPING) === 'flat';
  } catch {
    return false;
  }
}

function storeFlat(flat: boolean): void {
  try {
    localStorage.setItem(GROUPING, flat ? 'flat' : 'grouped');
  } catch {
    // storage refused: the address still keeps the choice
  }
}

// isLeftOpen: a kept item still open, in a view's left-open group.
function isLeftOpen(it: ItemView): boolean {
  return it.status === 'left-open';
}

export function makeDecide(ctx: Ctx): Section {
  const readEl = h('div', { class: 'kit-read' });
  let offset = 0;
  let totalItems = 0;
  let loadedItems: ItemView[] = [];
  const filters = emptyFilters();
  // flat: the list is one list, newest first, with no group heads
  // ("group by recommendation" off). The address and the page keep it.
  let flat = storedFlat();
  // reloading: a first-page load is on its way; loadingMore: a next page
  // is. loads counts the first-page loads started, so a next page asked
  // for before one started is not added to the rows it replaced.
  let reloading = false;
  let loadingMore = false;
  let loads = 0;
  let totalItemsForView = 0; // updated after every load
  // The view's groups (serve's order and counts, every page) and the ones
  // Court opened (in memory only). Every group starts collapsed (Court,
  // 2026-10-17: what's waiting reads as a list of groups); serve sends the
  // rows of the open ones alone (open=), so j and k pass over the rest.
  let groups: GroupView[] = [];
  const opened = new Set<string>();
  // What the page knows of each item it has seen in a group (loaded rows
  // and a group fetched whole): its group and its pending proposal's id.
  // A ticked item on a page not loaded is counted and acted on from here.
  const groupOfKey = new Map<string, string>();
  const proposalOfKey = new Map<string, number>();
  // Every item the page has seen (loaded rows and a group fetched whole):
  // a ticked item on a page not loaded shows in the middle pane from here.
  const itemOfKey = new Map<string, ItemView>();
  // The view's left-open group (kept items still open: they need no
  // decision, so the view's count and move-on leave them out). It is the
  // last group, once every page of the items that need a decision is
  // loaded; shown is what the list renders.
  let leftOpen: ItemView[] = [];
  let leftOpenTotal = 0;
  let shown: ItemView[] = [];
  // currentOpenKey is the key of the item currently shown in the reading
  // column.
  let currentOpenKey: string | null = null;
  // The detail the reading column shows (its item is currentOpenKey).
  let shownDetail: ItemDetailView | null = null;
  // lastOrder is the view's keys as the list last loaded them: the order the
  // next undecided item is found in after a decision (reload() empties
  // loadedItems while it waits, so a decision mid-reload reads this).
  let lastOrder: string[] = [];
  // deciding is the key this tab is deciding now (one at a time).
  let deciding: string | null = null;
  // lastUndo is the last decision made in this tab (one item, or a group's
  // items), for u and the strip's undo: per item, the decision it had
  // before (null: none) and the one this tab's decide or accept committed
  // (serve's reply), which undo expects to find.
  let lastUndo: {
    key: string;
    prev: Committed | null;
    expect: Committed;
  }[] = [];
  // serve's decision vocabulary (the groups' buttons, the summary, the
  // recommendation line); null until it loads.
  let vocab: DecisionVocabView | null = null;
  // syncingOpen: the list's open row is being moved to the open item (no
  // onOpen for it).
  let syncingOpen = false;

  // ---- the summary: the middle pane with nothing open ---------------------

  // renderReadEmpty is the summary that orients (serve's words): how many to
  // decide, how many came back, what each rule and agent recommends, and
  // how many are not recommended yet; "discard all N" while agents
  // recommend.
  //
  // Until the vocabulary is in, only the prompt: the summary's words are
  // serve's (and the list's state it counts is set up after this first
  // paint).
  const discardAllBtn = h('button', {
    class: 'kit-btn cb-discard-all',
    type: 'button',
    hidden: true,
    onclick() {
      discardView();
    },
  }) as HTMLButtonElement;
  function renderReadEmpty(): HTMLElement {
    const prompt = h(
      'p',
      { class: 'cb-read-empty-prompt' },
      'Select an item to see it here.',
    );
    if (!vocab)
      return h(
        'div',
        { class: 'cb-read-empty', 'data-testid': 'decide-summary' },
        prompt,
      );
    const [head, ...rest] = decideSummary(
      groups,
      totalItemsForView,
      ruleRows,
      vocab,
    );
    discardAllBtn.hidden = viewRecs === 0 || !vocab || draft !== null;
    if (vocab)
      discardAllBtn.textContent = vocab.discard_all.replaceAll(
        '{n}',
        String(viewRecs),
      );
    // At volume the agent is asked for rules, not item by item: "ask agent
    // to suggest rules" for the not recommended, with a session attached
    // (not while filtered: the list then holds decided items too).
    const t = ctx.dockTarget();
    const none = groups.some((g) => g.id === 'none' && g.total > 0);
    const suggest =
      t && none && !filtered()
        ? asked === askedKey(t.id)
          ? h('span', { class: 'cb-group-note' }, vocab.asked)
          : h(
              'button',
              {
                type: 'button',
                class: 'kit-btn cb-suggest-rules',
                onclick() {
                  void askRules();
                },
              },
              vocab.suggest_rules,
            )
        : null;
    return h(
      'div',
      { class: 'cb-read-empty', 'data-testid': 'decide-summary' },
      h('p', { class: 'cb-read-empty-count' }, head ?? ''),
      h(
        'ul',
        { class: 'cb-summary-lines' },
        ...rest.map((l) => h('li', null, l)),
      ),
      discardAllBtn,
      suggest,
      prompt,
    );
  }

  // Update the summary (if it is showing).
  function updateReadEmptyCount(): void {
    const old = readEl.querySelector<HTMLElement>(
      ':scope > [data-testid="decide-summary"]',
    );
    if (old) old.replaceWith(renderReadEmpty());
  }

  // feedAttached tells the composer what goes with the next message: the
  // selection's keys; else the open item; else the open rule (its document,
  // or the editor on it); else the list as it is narrowed (listAttached).
  //
  // Only while Attention is the active section: a live decided/proposals
  // event can change the selection while another section is shown, and that
  // section's context (a rule, a job) must not be overwritten.
  let active = false;
  function feedAttached(): void {
    if (!active) return;
    const ids = selection.ids();
    if (ids.length > 0) ctx.setAttached({ keys: ids });
    else if (currentOpenKey) ctx.setAttached({ open: currentOpenKey });
    // A draft previewing is what the list shows: its conditions go (and,
    // editing a rule, which rule).
    else if (draft !== null && editing === 'rule' && editingId)
      ctx.setAttached({ rule: editingId, list: listAttached() });
    else if (draft === null && filters.rule)
      ctx.setAttached({ rule: filters.rule });
    else ctx.setAttached({ list: listAttached() });
  }

  // listAttached is the list as it is narrowed (a draft's conditions, or
  // its saved filters and rule; its search; group, one group of it), not
  // its keys: what casebook_attention takes.
  function listAttached(group = ''): AttachedList {
    const l: AttachedList = {};
    // A draft lists what it matches, as buildQuery asks for it.
    if (draft !== null) l.match = JSON.stringify(draft);
    else if (filters.filters.length) l.filters = [...filters.filters];
    if (draft === null && filters.rule) l.rule = filters.rule;
    if (filters.q) l.q = filters.q;
    if (group) l.group = group;
    return l;
  }

  // Show the empty reading-column state (replaces any open item detail).
  function showReadEmpty(): void {
    tickedOn = false;
    currentOpenKey = null;
    shownDetail = null;
    // A selected rule shows in the middle pane until an item is opened;
    // so does a selected filter (the one last clicked, else the last
    // selected), or one that doesn't validate, clicked to fix.
    const rr =
      filters.rule && draft === null
        ? ruleRows.find((r) => r.rule.id === filters.rule)
        : undefined;
    const fr = draft === null && !filters.rule ? filterShown() : undefined;
    readEl.replaceChildren(renderReadEmpty());
    if (rr) void showRuleDoc(rr);
    else if (fr) showFilterDoc(fr);
    feedAttached();
  }

  // shownFilter is the filter chip last clicked: the middle pane shows it
  // while it is selected (or, not valid, until another is clicked).
  let shownFilter: string | null = null;
  function filterShown(): FilterRow | undefined {
    const sel = filters.filters;
    const clicked = filterRows.find((r) => r.filter.id === shownFilter);
    if (clicked && (clicked.invalid || sel.includes(clicked.filter.id)))
      return clicked;
    const last = sel[sel.length - 1];
    return filterRows.find((r) => r.filter.id === last);
  }
  // showFilterDoc puts a filter in the middle pane, read only, with edit,
  // make a rule and delete.
  function showFilterDoc(fr: FilterRow): void {
    const id = fr.filter.id;
    readEl.replaceChildren(
      renderFilter(ctx, fr, {
        onEdit() {
          openFilterEditor(fr);
        },
        onMakeRule() {
          openRuleEditor(null, {
            name: fr.filter.name,
            match: fr.filter.match ?? [],
          });
        },
        onDeleted() {
          if (shownFilter === id) shownFilter = null;
          filterRows = filterRows.filter((r) => r.filter.id !== id);
          if (filters.filters.includes(id))
            selectFilters(filters.filters.filter((x) => x !== id));
          else showReadEmpty();
          void loadFilters();
        },
      }),
    );
  }

  // showRuleDoc puts the selected rule in the middle pane, read only, with
  // edit and turn on / off.
  let ruleDocSeq = 0;
  async function showRuleDoc(rr: RuleRow): Promise<void> {
    const mine = ++ruleDocSeq;
    let d: RuleDetailView;
    try {
      d = await ctx.api.get<RuleDetailView>('/rule', { id: rr.rule.id });
    } catch {
      return;
    }
    if (mine !== ruleDocSeq || filters.rule !== rr.rule.id || draft !== null)
      return;
    if (currentOpenKey) return;
    readEl.replaceChildren(
      renderRule(ctx, d, {
        onEdit() {
          openRuleEditor(rr, null);
        },
        async onToggle() {
          await toggleRule(ctx, rr);
          await loadRules();
          showReadEmpty();
          void reload();
        },
        onChanged() {
          void loadRules().then(() => void reload());
        },
      }),
    );
  }

  // Initialise the reading column with the empty state so it is never blank
  // (nothing is selected yet: the filters and rules aren't loaded).
  readEl.replaceChildren(renderReadEmpty());

  // ---- the list: the shared pane --------------------------------------------

  const pane: Pane<ItemView> = makePane<ItemView>(ctx, 'decide', selection, {
    row(it: ItemView) {
      const st = standsLine(vocab, it, flat);
      return {
        id: it.key,
        key: it.key,
        title: it.title || undefined,
        stands: st.text,
        tone: it.new_activity && st.tone === 'muted' ? 'signal' : st.tone,
        // A draft filter's preview is only to look at.
        selectable: draft === null,
      };
    },
    groupOf: (it: ItemView) =>
      isLeftOpen(it) ? LEFT_OPEN : flat ? '' : it.group,
    onOpen(it: ItemView) {
      if (syncingOpen || draft !== null) return;
      // Navigate to the item's hash URL and load the detail.
      ctx.route.go('item', it.key);
      void openDetail(it.key);
    },
    onQuery(q, clicked) {
      if (clicked !== undefined) {
        // A chip clicked while an editor is open ends it first.
        if (draft !== null) closeFilterEditor(false);
        shownFilter = q.filters.includes(clicked) ? clicked : null;
        selectFilters(q.filters);
        return;
      }
      filters.q = q.q;
      // The list's address keeps its search (an item's doesn't).
      if (ctx.route.current().section === 'decide' && draft === null)
        setHashQuery(listQuery());
      void reload();
    },
    onToggle(id: string) {
      // Opening a group asks serve for its rows (the left-open group's come
      // with every load); closing one drops them.
      if (opened.has(id)) opened.delete(id);
      else opened.add(id);
      if (id === LEFT_OPEN) {
        setRows();
        markOpenRow();
      } else void reload();
    },
    onTickGroup(id: string) {
      const g = groups.find((x) => x.id === id);
      if (g && draft === null) void tickGroup(g);
    },
    tickedIn: (id: string) =>
      selection.ids().filter((k) => groupOfKey.get(k) === id),
    onMore() {
      void loadMore();
    },
    onFilterOpen(row) {
      if (draft !== null) closeFilterEditor(true);
      shownFilter = row.filter.id;
      // A selected rule has the middle pane: drop it so the filter shows.
      if (filters.rule) selectRule(null);
      else {
        if (currentOpenKey) goList();
        showReadEmpty();
      }
    },
    onFilterNew() {
      openFilterEditor(null);
    },
  });
  const handle = pane.handle;
  // How old the observations are, at the foot of the list (obs.ts).
  const obs = makeObs(ctx, (text, state) => pane.setObs(text, state));
  void obs.load();

  // "group by recommendation": on, the list's groups with their heads and
  // buttons; off, one list newest first, each row naming its
  // recommendation. It sits under the view chips; the address keeps it.
  const groupSwitch = h(
    'button',
    {
      type: 'button',
      class: 'kit-chip cb-group-switch',
      role: 'switch',
      onclick() {
        flat = !flat;
        storeFlat(flat);
        paintSwitch();
        // While a filter is being built the list is its preview: regroup it
        // in place (a new address would close the editor and lose the draft).
        if (draft === null) goList();
        void reload();
      },
    },
    'group by recommendation',
  );
  function paintSwitch(): void {
    groupSwitch.setAttribute('aria-checked', String(!flat));
    groupSwitch.classList.toggle('on', !flat);
  }
  paintSwitch();

  // ---- saved filters ---------------------------------------------------------

  // filterRows are serve's saved filters (GET /api/filters).
  let filterRows: FilterRow[] = [];

  // ---- rules: a chip per rule under the filters ------------------------------

  // ruleRows are serve's rules (GET /api/rules), off ones too: their names
  // head their groups, and each is a chip.
  let ruleRows: RuleRow[] = [];
  const ruleRow = makeRuleRow(ctx, {
    onSelect(id) {
      // A chip clicked while an editor is open ends it first.
      if (draft !== null) closeFilterEditor(false);
      selectRule(id);
    },
    onNew() {
      openRuleEditor(null, null);
    },
  });
  async function loadRules(): Promise<void> {
    try {
      const v = await ctx.api.get<RulesView>('/rules');
      ruleRows = v.rules ?? [];
      paintRules();
      // A rule named by the address (#/decide?rule=<id>) shows once the
      // rules are in.
      if (
        filters.rule &&
        currentOpenKey === null &&
        draft === null &&
        !readEl.querySelector('.cb-rule')
      )
        showReadEmpty();
    } catch {
      // non-fatal: the chips stay as they were
    }
  }
  function paintRules(): void {
    ruleRow.paint(ruleRows, draft !== null ? null : filters.rule);
    // The groups' headers name their rules.
    paintAll();
  }
  // selectRule makes id the selection (null: back to everything): the list
  // shows the rule's matches, the middle pane the rule.
  function selectRule(id: string | null): void {
    filters.rule = id;
    if (id) filters.filters = [];
    pane.setFilterError(null);
    paintFilters();
    paintRules();
    showReadEmpty();
    goList();
    void reload();
  }

  // ---- the filter editor beside the list ------------------------------------

  // While the editor is open (the middle pane), the list on the left is its
  // preview: draft is its conditions (null: no editor), listed faded, newest
  // first, with "previewing a draft filter · N items" beside the switch; the
  // view and filter chips show unselected, and rows, ticks and group buttons
  // wait. before is what the list showed when it opened, for cancel.
  let draft: Condition[] | null = null;
  let editor: FilterEditor | null = null;
  let editingId: string | null = null; // the edited filter's id ('' new)
  let draftHash = ''; // the address while the editor is open
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let before: {
    filters: string[];
    rule: string | null;
    scroll: number;
    offset: number;
    totalItems: number;
    loadedItems: ItemView[];
    leftOpen: ItemView[];
    leftOpenTotal: number;
    groups: GroupView[];
    viewRecs: number;
    lastOrder: string[];
    paintedQuery: string;
  } | null = null;
  const previewLine = h('span', { class: 'cb-preview-line', hidden: true });
  const rowsScroller = () => handle.el.querySelector<HTMLElement>('.kit-rows');

  function paintPreviewLine(text: string | null): void {
    previewLine.hidden = text === null;
    previewLine.textContent = text ?? '';
  }

  function openRuleEditor(
    row: RuleRow | null,
    seed: { name: string; match: Condition[] } | null,
  ): void {
    openEditor(
      row ? row.rule.id : '',
      row?.rule.match ?? seed?.match ?? [],
      (hooks) => ruleEditor(ctx, row, seed, hooks),
      (id) => {
        void loadRules().then(() => selectRule(id));
      },
      'rule',
    );
  }

  function openFilterEditor(row: FilterRow | null): void {
    openEditor(
      row ? row.filter.id : '',
      row?.filter.match ?? [],
      (hooks) => filterEditor(ctx, row, hooks),
      (id) => {
        filters.filters = [id];
        filters.rule = null;
        void loadFilters();
        goList();
        void reload();
      },
      'filter',
    );
  }

  // editing is what the editor makes ("filter" or "rule"), for the preview
  // line.
  let editing: 'filter' | 'rule' = 'filter';

  function openEditor(
    id: string,
    start: Condition[],
    make: (hooks: {
      onDraft(match: Condition[]): void;
      onSaved(id: string): void;
      onCancel(): void;
    }) => FilterEditor,
    saved: (id: string) => void,
    kind: 'filter' | 'rule',
  ): void {
    editing = kind;
    if (draftTimer !== null) clearTimeout(draftTimer);
    if (!before) {
      before = {
        filters: [...filters.filters],
        rule: filters.rule,
        scroll: rowsScroller()?.scrollTop ?? 0,
        offset,
        totalItems,
        loadedItems,
        leftOpen,
        leftOpenTotal,
        groups,
        viewRecs,
        lastOrder,
        paintedQuery,
      };
    }
    // Opening the editor closes an open item, as clicking away does.
    if (currentOpenKey) goList();
    showReadEmpty();
    editingId = id;
    draft = start.map((c) => ({ ...c })).filter((c) => c.value.trim() !== '');
    draftHash = location.hash;
    editor = make({
      onDraft(match) {
        // An unfinished condition (no value yet) waits: it isn't previewed.
        draft = match.filter((c) => c.value.trim() !== '');
        if (draftTimer !== null) clearTimeout(draftTimer);
        draftTimer = setTimeout(() => {
          draftTimer = null;
          void reload();
        }, PREVIEW_DEBOUNCE_MS);
      },
      onSaved(id) {
        closeFilterEditor(false);
        saved(id);
      },
      onCancel() {
        closeFilterEditor(true);
      },
    });
    readEl.replaceChildren(editor.el);
    document.addEventListener('keydown', onEditorEsc);
    handle.el.classList.add('cb-previewing');
    pane.setFilters(filterRows, []);
    pane.setFilterError(null);
    paintRules();
    paintAll();
    void reload();
    editor.el.querySelector<HTMLElement>('.cb-filter-name')?.focus();
  }

  // Esc cancels the editor, unless a menu or the dropdown has it.
  function onEditorEsc(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
    if (draft === null) return;
    e.preventDefault();
    closeFilterEditor(true);
  }

  // closeFilterEditor ends the preview. restore (cancel) puts back the list
  // as it was, its rows and scroll; otherwise the caller says what the list
  // shows next.
  function closeFilterEditor(restore: boolean): void {
    if (draft === null) return;
    if (draftTimer !== null) clearTimeout(draftTimer);
    draftTimer = null;
    draft = null;
    editor = null;
    editingId = null;
    document.removeEventListener('keydown', onEditorEsc);
    handle.el.classList.remove('cb-previewing');
    paintPreviewLine(null);
    showReadEmpty();
    const b = before;
    before = null;
    if (!restore || !b) {
      paintAll();
      return;
    }
    filters.filters = b.filters;
    filters.rule = b.rule;
    paintFilters();
    paintRules();
    offset = b.offset;
    totalItems = b.totalItems;
    totalItemsForView = b.totalItems;
    loadedItems = b.loadedItems;
    leftOpen = b.leftOpen;
    leftOpenTotal = b.leftOpenTotal;
    groups = b.groups;
    viewRecs = b.viewRecs;
    lastOrder = b.lastOrder;
    paintedQuery = b.paintedQuery;
    setRows();
    updateFoot();
    updateReadEmptyCount();
    const sc = rowsScroller();
    if (sc) sc.scrollTop = b.scroll;
    if (location.hash !== draftHash) goList();
    void reload();
  }
  function filtered(): boolean {
    return filters.filters.length > 0 || filters.rule !== null;
  }
  function paintFilters(): void {
    pane.setFilters(filterRows, draft !== null ? [] : filters.filters);
  }
  async function loadFilters(): Promise<void> {
    try {
      const v = await ctx.api.get<FiltersView>('/filters');
      filterRows = v.filters ?? [];
      paintFilters();
      paintRail();
      // The middle pane shows the selected filter as saved (one just
      // saved, too), unless an item, a rule or an editor has it.
      if (draft === null && !currentOpenKey && !filters.rule) showReadEmpty();
    } catch {
      // non-fatal: the chips stay as they were
    }
  }
  // goList puts the list's state in the address: the view, or the
  // selected filters, and flat.
  function goList(): void {
    ctx.route.go('decide', '', listQuery());
  }
  // listQuery is the list's address query.
  function listQuery(): string {
    return decideQuery({
      flat,
      filters: filters.filters,
      rule: filters.rule ?? '',
      q: filters.q,
    });
  }
  // selectFilters makes ids the selection (none: back to the view).
  function selectFilters(ids: string[]): void {
    filters.filters = ids;
    if (ids.length) filters.rule = null;
    paintRules();
    showReadEmpty();
    pane.setFilterError(null);
    paintFilters();
    goList();
    void reload();
  }

  pane.ownRow.append(ruleRow.el);
  pane.tools.append(groupSwitch, previewLine);
  void loadFilters();
  void loadRules();

  // paintRail writes the rail's view and count.
  function paintRail(): void {
    pane.setRail(`${viewLabel()} \u00b7 ${totalItemsForView}`);
  }

  // ---- API ------------------------------------------------------------------

  function buildQuery(pageOffset: number): Record<string, string> {
    // A draft filter (the editor's) lists what saving it would; saved
    // filters list every item matching all of them: no view.
    const p: Record<string, string> =
      draft !== null
        ? { match: JSON.stringify(draft) }
        : filters.rule
          ? { view: 'all', rule: filters.rule }
          : { view: 'all' };
    Object.assign(
      p,
      paneParams({
        filters: draft === null && !filters.rule ? filters.filters : [],
        q: filters.q,
      }),
    );
    p['offset'] = String(pageOffset);
    p['limit'] = String(PAGE_SIZE);
    if (flat) p['group'] = 'false';
    else
      p['open'] = JSON.stringify([...opened].filter((id) => id !== LEFT_OPEN));
    return p;
  }

  // reload loads the list's first page for the view and search as they
  // are when it runs. Coalesced (coalesce.ts): one load in flight and at
  // most one queued, so a view or search change made while a
  // load is on its way runs once that load ends, never dropped (casebook
  // 0.4.7: it was, and the list kept the old view). A load whose query
  // changed while it was on its way paints nothing: the newer query's load
  // paints.
  const reloadQueued = coalesced(reloadNow);
  // reload: a load that changes what is shown (a search, a filter, a rule)
  // turns the middle's buttons off at once, until the new list and its
  // ticked document are drawn; a tick it hides is then dropped.
  function reload(): Promise<void> {
    if (viewKey() !== shownView) {
      viewPending = true;
      freezeMid();
    }
    return reloadQueued();
  }

  // inView is every key the current view is known to hold (its loaded rows,
  // and the pages a whole-group tick fetched), for shownView: ticks only
  // ever cover these. viewPending: the view changed and its list isn't in.
  let inView = new Set<string>();
  let shownView = '';
  let viewPending = false;
  const viewKey = (): string => JSON.stringify(viewFilters());

  // freezeMid turns every button in the middle pane off.
  function freezeMid(): void {
    for (const b of readEl.querySelectorAll<HTMLButtonElement>('button'))
      b.disabled = true;
  }

  // settleShown works out what the view just loaded shows, and drops a tick
  // it doesn't: a tick off the loaded rows is looked for in the view's every
  // page. It reports whether the query is still the one asked.
  async function settleShown(asked: string): Promise<boolean> {
    const view = viewKey();
    const next = new Set([...loadedItems, ...leftOpen].map((it) => it.key));
    const off = selection.ids().filter((k) => !next.has(k));
    if (off.length) {
      try {
        const want = new Set(off);
        for (let at = 0, total = Infinity; at < total;) {
          const data = await ctx.api.get<ItemsView>('/items', {
            ...viewFilters(),
            group: 'false',
            offset: String(at),
            limit: '500',
          });
          const got = data.items ?? [];
          total = data.total;
          if (!got.length) break;
          at += got.length;
          for (const it of got) if (want.has(it.key)) next.add(it.key);
        }
      } catch {
        // not known to be shown: dropped
      }
      if (queryKey() !== asked) return false;
    }
    inView = next;
    shownView = view;
    viewPending = false;
    const gone = selection.ids().filter((k) => !inView.has(k));
    if (gone.length) selection.deselect(gone);
    return true;
  }

  // queryKey is a load's query, comparable (the page offset aside).
  function queryKey(): string {
    return JSON.stringify(buildQuery(0));
  }

  // paintedQuery is the query the rows were last loaded for: reloading it
  // keeps every page the list had (a nav button or "show more" may have
  // loaded one), a new view or search starts at one page. The pages are
  // asked for one at a time, PAGE_SIZE each (serve caps a page's limit),
  // and the rows painted once they are all in.
  let paintedQuery = '';
  async function reloadNow(): Promise<void> {
    reloading = true;
    loads++;
    // The list's narrowing may have changed (a search, a filter, a rule):
    // what goes with a message follows it.
    feedAttached();
    const asked = queryKey();
    const want =
      asked === paintedQuery ? Math.max(offset, PAGE_SIZE) : PAGE_SIZE;
    try {
      offset = 0;
      loadedItems = [];
      const data = await ctx.api.get<ItemsView>('/items', buildQuery(0));
      const items = data.items ?? [];
      const seen = new Set(items.map((it) => it.key));
      // at is the offset of the next page, the rows serve sent so far.
      let at = items.length;
      while (at < want && at < data.total && queryKey() === asked) {
        const q = buildQuery(at);
        q['limit'] = String(Math.min(PAGE_SIZE, want - at));
        const page = (await ctx.api.get<ItemsView>('/items', q)).items ?? [];
        if (page.length === 0) break;
        at += page.length;
        // A row that moved down a page while they loaded is not listed twice.
        for (const it of page) {
          if (seen.has(it.key)) continue;
          seen.add(it.key);
          items.push(it);
        }
      }
      if (queryKey() !== asked) {
        // Every change to the query asks for a reload; this one makes sure.
        void reload();
        return;
      }
      totalItems = data.total;
      totalItemsForView = viewTotal(data);
      loadedItems = items;
      leftOpen = data.left_open ?? [];
      leftOpenTotal = data.left_open_total ?? 0;
      groups = data.groups ?? [];
      viewRecs = data.agent_recommended ?? 0;
      know(loadedItems);
      lastOrder = loadedItems.map((it) => it.key);
      offset = loadedItems.length;
      paintedQuery = asked;
      if (!(await settleShown(asked))) {
        void reload();
        return;
      }
      pane.setFilterError(null);
      if (draft !== null) {
        editor?.showError(null);
        paintPreviewLine(
          draft.length
            ? `previewing a draft ${editing} \u00b7 ${pluralize(viewTotal(data), 'item')}`
            : 'add a condition to preview',
        );
      }
      setRows();
      markOpenRow();
      updateFoot();
      updateReadEmptyCount();
      if (tickedOn && selection.ids().length) showTicked();
    } catch (err) {
      // A selection serve refuses (a filter deleted elsewhere, or one that
      // doesn't validate) says why, by name, and lists nothing: never the
      // list unfiltered. Anything else is non-fatal: the list stays as-is.
      const refused = err instanceof ApiError && err.status === 400;
      if (draft !== null && refused) {
        editor?.showError(err);
        paintPreviewLine(`previewing a draft ${editing} \u00b7 not valid yet`);
      } else if (filtered() && refused) {
        pane.setFilterError(err.message);
      }
      if (!refused) {
        // The list stays as it was, and so does what it shows.
        shownView = viewKey();
        viewPending = false;
        if (tickedOn && selection.ids().length) showTicked();
      }
      if ((draft !== null || filtered()) && refused) {
        totalItems = 0;
        totalItemsForView = 0;
        loadedItems = [];
        leftOpen = [];
        leftOpenTotal = 0;
        groups = [];
        viewRecs = 0;
        lastOrder = [];
        offset = 0;
        paintedQuery = asked;
        // Nothing is shown, so nothing stays ticked.
        inView = new Set();
        shownView = viewKey();
        viewPending = false;
        selection.clear();
        setRows();
        updateFoot();
        updateReadEmptyCount();
      }
    } finally {
      reloading = false;
    }
  }

  // viewTotal is how many the view holds: grouped, every group's count
  // (serve's total is the open groups' rows, what the pages go through).
  function viewTotal(data: ItemsView): number {
    if (flat || !data.groups?.length) return data.total;
    return data.groups.reduce((n, g) => n + g.total, 0);
  }

  // loadMore adds the next page ("show more"). Not while the first page is
  // loading (it starts the rows again); a page that comes back after a
  // first-page load started is not added (the rows it followed are gone).
  async function loadMore(): Promise<void> {
    if (reloading || loadingMore || offset >= totalItems) return;
    loadingMore = true;
    const mine = loads;
    try {
      const data = await ctx.api.get<ItemsView>('/items', buildQuery(offset));
      if (mine !== loads) return;
      const next = data.items ?? [];
      loadedItems = [...loadedItems, ...next];
      leftOpen = data.left_open ?? [];
      leftOpenTotal = data.left_open_total ?? 0;
      groups = data.groups ?? [];
      viewRecs = data.agent_recommended ?? 0;
      know(next);
      for (const it of next) inView.add(it.key);
      lastOrder = loadedItems.map((it) => it.key);
      offset = loadedItems.length;
      totalItems = data.total;
      totalItemsForView = viewTotal(data);
      setRows();
      markOpenRow();
      updateFoot();
    } catch {
      // non-fatal
    } finally {
      loadingMore = false;
    }
  }

  // setRows renders the items that need a decision under their groups'
  // heads (a collapsed group's head alone; flat, every loaded row and no
  // heads), and, once every page of them is loaded, the left-open group
  // last: its head and (expanded) its muted rows.
  function setRows(): void {
    const withLeft = offset >= totalItems && leftOpenTotal > 0;
    const gs: PaneGroup[] = flat ? [] : groups.map(paneGroup);
    if (withLeft)
      gs.push({
        id: LEFT_OPEN,
        label: vocab?.left_open ?? '',
        n: leftOpenTotal,
        box: false,
      });
    shown = pane.setRows(
      withLeft ? [...loadedItems, ...leftOpen] : loadedItems,
      gs,
      opened,
    );
    const rowEls = handle.el.querySelectorAll<HTMLElement>(
      '.kit-rows > .kit-row',
    );
    shown.forEach((it, i) => {
      if (isLeftOpen(it)) rowEls[i]?.classList.add('cb-left-open');
    });
    paintRail();
    refreshNav();
  }

  // ---- « ‹ › »: the open item's place in the list ---------------------------

  // navOrder is the list's loaded rows in group order: serve sends only the
  // open groups' rows (openNeighbour opens a collapsed one to move into),
  // the left-open group last once every page is loaded. Flat, the rows are
  // one group (the view).
  function navOrder(): { key: string; group: string }[] {
    const rows = loadedItems.map((it) => ({
      key: it.key,
      group: flat ? '' : it.group,
    }));
    if (offset >= totalItems && leftOpenTotal > 0)
      rows.push(...leftOpen.map((it) => ({ key: it.key, group: LEFT_OPEN })));
    return rows;
  }

  // navGroups is the view's groups, the left-open group's with them. Flat,
  // the view is one group.
  function navGroups(): GroupView[] {
    const listed: GroupView[] = flat
      ? [
          {
            id: '',
            source: '',
            disposition: '',
            label: viewLabel(),
            outward: false,
            many: '',
            total: totalItems,
          },
        ]
      : groups;
    return [
      ...listed,
      {
        id: LEFT_OPEN,
        source: '',
        disposition: '',
        label: vocab?.left_open ?? '',
        outward: false,
        many: '',
        total: leftOpenTotal,
      },
    ];
  }

  type NavWhich = 'prevGroup' | 'prev' | 'next' | 'nextGroup';

  // renderNav is the open item's « ‹ › » row: its place in its group, and
  // a button to the group before, the item before, the item after and the
  // group after, each naming where it goes (disabled where there is
  // none). Null when key is not in the list's rows.
  function renderNav(key: string): HTMLElement | null {
    if (!vocab) return null;
    const words = vocab.nav;
    const n = navTargets(navOrder(), navGroups(), key);
    if (!n.pos) return null;
    // More pages: what comes after may be on one not loaded yet.
    const more = offset < totalItems;
    const labelOf = (k: string): string => {
      const g = navOrder().find((r) => r.key === k)?.group ?? '';
      return navGroups().find((x) => x.id === g)?.label ?? '';
    };
    const button = (
      which: NavWhich,
      glyph: string,
      tip: string,
      target: string | undefined,
      name: (k: string) => string,
      later: boolean,
    ): HTMLElement =>
      h(
        'button',
        {
          type: 'button',
          class: 'cb-nav-b',
          dataset: {
            nav:
              which === 'prevGroup'
                ? 'prev-group'
                : which === 'nextGroup'
                  ? 'next-group'
                  : which,
          },
          disabled: !target && !later,
          title: tip.replaceAll(
            '{target}',
            target ? name(target) : later ? words.later : words.none,
          ),
          onclick() {
            void navGo(which);
          },
        },
        glyph,
      );
    const pos = words.position
      .replaceAll('{pos}', String(n.pos))
      .replaceAll('{total}', String(n.total))
      .replaceAll('{group}', n.label);
    return h(
      'nav',
      { class: 'cb-nav' },
      button(
        'prevGroup',
        '\u00ab',
        words.prev_group,
        n.prevGroup,
        labelOf,
        false,
      ),
      button('prev', '\u2039', words.prev_item, n.prev, shortKey, false),
      h('span', { class: 'cb-nav-pos' }, pos),
      button('next', '\u203a', words.next_item, n.next, shortKey, more),
      button(
        'nextGroup',
        '\u00bb',
        words.next_group,
        n.nextGroup,
        labelOf,
        more,
      ),
    );
  }

  // refreshNav puts the open item's « ‹ › » row in place again (the list
  // changed), or takes it away when the item is no longer in the rows.
  function refreshNav(): void {
    const doc = readEl.querySelector<HTMLElement>('.cb-item-doc');
    if (!doc || !currentOpenKey || shownDetail?.item.key !== currentOpenKey)
      return;
    const nav = renderNav(currentOpenKey);
    const old = doc.querySelector(':scope > .cb-nav');
    if (old && nav) old.replaceWith(nav);
    else if (nav) doc.prepend(nav);
    else old?.remove();
  }

  // navGo opens which of the open item's targets: past the loaded rows,
  // the next page loads first. A target in a collapsed group expands it.
  async function navGo(which: NavWhich): Promise<void> {
    const key = currentOpenKey;
    if (!key) return;
    const ahead = which === 'next' || which === 'nextGroup';
    // Groups start collapsed and serve sends only the open ones' rows: a
    // move out of key's group into a collapsed neighbour (in serve's order)
    // opens it and loads its rows first, so the move lands there and not in
    // the next open group after it.
    if (
      which === 'nextGroup' ||
      which === 'prevGroup' ||
      atGroupEdge(key, ahead)
    )
      await openNeighbour(key, ahead);
    if (currentOpenKey !== key) return;
    let target = navTargets(navOrder(), navGroups(), key)[which];
    while (!target && ahead && offset < totalItems) {
      const before = offset;
      if (reloading) await reload();
      else await loadMore();
      if (currentOpenKey !== key) return;
      target = navTargets(navOrder(), navGroups(), key)[which];
      if (!target && offset === before && !reloading) break;
    }
    if (!target || currentOpenKey !== key) return;
    const group = navOrder().find((r) => r.key === target)?.group ?? '';
    if (!opened.has(group)) {
      opened.add(group);
      setRows();
    }
    openKey(target);
  }

  // atGroupEdge: key is its group's last row (ahead: every one of its rows
  // loaded) or first row, so › or ‹ leaves the group.
  function atGroupEdge(key: string, ahead: boolean): boolean {
    const order = navOrder();
    const i = order.findIndex((r) => r.key === key);
    if (i < 0) return false;
    const g = order[i].group;
    if (!ahead) return i === 0 || order[i - 1].group !== g;
    if (i + 1 < order.length && order[i + 1].group === g) return false;
    const total = navGroups().find((x) => x.id === g)?.total ?? 0;
    return order.filter((r) => r.group === g).length >= total;
  }

  // openNeighbour opens the group next to key's (after it ahead, else
  // before) in serve's order when it is collapsed and has items, and loads
  // its rows. false when the neighbour is open, empty or there is none.
  async function openNeighbour(key: string, ahead: boolean): Promise<boolean> {
    if (flat) return false;
    const cur = navOrder().find((r) => r.key === key)?.group;
    if (cur === undefined) return false;
    const gs = navGroups();
    const at = gs.findIndex((g) => g.id === cur);
    if (at < 0) return false;
    for (
      let i = at + (ahead ? 1 : -1);
      i >= 0 && i < gs.length;
      i += ahead ? 1 : -1
    ) {
      const g = gs[i];
      if (g.total <= 0 || (g.id === LEFT_OPEN && offset < totalItems)) continue;
      if (opened.has(g.id)) return false;
      opened.add(g.id);
      if (g.id === LEFT_OPEN) setRows();
      else await reload();
      return true;
    }
    return false;
  }

  // ---- the groups ------------------------------------------------------------

  // know records the group and the pending proposal of each item.
  function know(items: ItemView[]): void {
    for (const it of items) {
      itemOfKey.set(it.key, it);
      if (!it.group) continue;
      groupOfKey.set(it.key, it.group);
      if (it.proposal?.state === 'pending')
        proposalOfKey.set(it.key, it.proposal.id);
      else proposalOfKey.delete(it.key);
    }
  }

  // tickedIn is the ticked items of group g (on any page).
  function tickedIn(g: GroupView): string[] {
    return selection.ids().filter((k) => groupOfKey.get(k) === g.id);
  }

  // paneGroup is a group's head: a rule's is headed by the rule (its name,
  // "rule · its decision", its count and ⋯: edit, turn off).
  function paneGroup(g: GroupView): PaneGroup {
    const ruleId = g.source.startsWith('rule:') ? g.source.slice(5) : '';
    const rr = ruleId ? ruleRows.find((r) => r.rule.id === ruleId) : undefined;
    const more = rr
      ? ruleMenu(rr, {
          onEdit: () => openRuleEditor(rr, null),
          onToggle: () =>
            void toggleRule(ctx, rr)
              .then(() => loadRules())
              .then(() => reload())
              .catch((err: unknown) =>
                showReadError(err instanceof Error ? err.message : String(err)),
              ),
        })
      : null;
    return {
      id: g.id,
      label: ruleId ? rr?.rule.name || ruleId : g.label,
      tag: ruleId ? `rule \u00b7 ${g.label}` : undefined,
      n: g.total,
      box: true,
      more,
      data: { d: g.disposition, ...(ruleId ? { rule: ruleId } : {}) },
    };
  }

  function paintAll(): void {
    pane.paintHeads();
  }

  // groupFilters is the view and its filters as GET /api/items and
  // /proposals/withdraw take them, narrowed to group g.
  function groupFilters(g: GroupView): Record<string, string> {
    return { ...viewFilters(), group: g.id };
  }

  // fetchGroup is every item of group g, every page (the filters apply).
  async function fetchGroup(g: GroupView): Promise<ItemView[]> {
    const out: ItemView[] = [];
    for (let total = Infinity; out.length < total;) {
      const data = await ctx.api.get<ItemsView>('/items', {
        ...groupFilters(g),
        offset: String(out.length),
        limit: String(PAGE_SIZE),
      });
      const got = data.items ?? [];
      out.push(...got);
      total = data.total;
      if (!got.length) break;
    }
    know(out);
    return out;
  }

  // tickGroup ticks every item of g (every page), or, all ticked, unticks
  // them. Ticking a collapsed group expands it: its buttons act on what
  // is ticked, and its rows show what that is.
  async function tickGroup(g: GroupView): Promise<void> {
    const ticked = tickedIn(g);
    if (ticked.length >= g.total) {
      selection.deselect(ticked);
      return;
    }
    try {
      const items = await fetchGroup(g);
      for (const it of items) inView.add(it.key);
      selection.all(items.map((it) => it.key));
      if (!opened.has(g.id)) {
        opened.add(g.id);
        void reload();
      }
    } catch (err) {
      showReadError(err instanceof Error ? err.message : String(err));
    }
  }

  // lookInto sends the attached session one message naming keys, all of
  // them attached, with the look-into purpose (serve marks each while it is
  // underway, and the rows say so). It decides nothing.
  async function lookInto(keys: string[]): Promise<void> {
    if (!ctx.dockTarget() || !vocab) return;
    try {
      if (!keys.length) return;
      const message = vocab.look_into.message_many.replaceAll(
        '{keys}',
        keys.join(', '),
      );
      const t = ctx.dockTarget();
      const why = await ctx.askSession(message, { keys }, 'look-into');
      if (why) {
        showReadError(why);
        return;
      }
      if (t) for (const k of keys) lookedInto.add(`${t.id}\n${k}`);
      await reload();
      if (tickedOn) showTicked();
    } catch (err) {
      showReadError(err instanceof Error ? err.message : String(err));
    }
  }

  // ---- what is ticked: the middle pane ---------------------------------------

  // tickedOn: the middle pane shows the ticked items (it waits to show the
  // open item until none is ticked).
  let tickedOn = false;

  // tickedItems is every ticked item as the page knows it.
  function tickedItems(): ItemView[] {
    return selection
      .ids()
      .filter((k) => inView.has(k))
      .map((k) => itemOfKey.get(k) ?? ({ key: k } as ItemView));
  }

  // groupName is a group's name as its head shows it: its rule's name, else
  // its label.
  function groupName(g: GroupView): string {
    const ruleId = g.source.startsWith('rule:') ? g.source.slice(5) : '';
    if (!ruleId) return g.label;
    return ruleRows.find((r) => r.rule.id === ruleId)?.rule.name || ruleId;
  }

  // tickedWhere is the group the ticks are in, by name, or how many groups.
  function tickedWhere(keys: string[]): string {
    const ids = [...new Set(keys.map((k) => groupOfKey.get(k) ?? ''))];
    const g = ids.length === 1 ? groups.find((x) => x.id === ids[0]) : null;
    if (g) return groupName(g);
    if (ids.length === 1 && ids[0] === LEFT_OPEN) return vocab?.left_open ?? '';
    return `${ids.length} groups`;
  }

  // showTicked puts the ticked items in the middle pane: the decision
  // buttons for all of them, "ask agent to recommend these" (with a session
  // attached) and "discard N" (when an agent recommends every one).
  function showTicked(): void {
    if (!vocab || draft !== null) return;
    tickedOn = true;
    const items = tickedItems();
    const keys = items.map((it) => it.key);
    readEl.replaceChildren(
      renderTicked(
        ctx,
        items,
        tickedWords(vocab, items, tickedWhere(keys)),
        decideTicked,
        tickedExtra(items),
      ),
    );
    // The view is changing: nothing acts until its list is in.
    if (viewPending) freezeMid();
  }

  function tickedExtra(items: ItemView[]): HTMLElement[] {
    const out: HTMLElement[] = [];
    const t = ctx.dockTarget();
    const keys = items.map((it) => it.key);
    if (!vocab) return out;
    if (t) {
      const looked = keys.every(
        (k) => !!itemOfKey.get(k)?.looking || lookedInto.has(`${t.id}\n${k}`),
      );
      out.push(
        h(
          'button',
          {
            type: 'button',
            class: 'kit-btn cb-ticked-ask',
            disabled: looked,
            onclick() {
              // What is ticked and shown as Court presses.
              if (viewPending) return;
              void lookInto(tickedItems().map((it) => it.key));
            },
          },
          vocab.recommend_these,
        ),
      );
    }
    const ids = items
      .map((it) => it.proposal)
      .filter((p) => p?.state === 'pending' && !p.source.startsWith('rule:'))
      .map((p) => p?.id ?? 0);
    if (ids.length && ids.length === items.length) {
      const words = vocab;
      out.push(
        h(
          'button',
          {
            type: 'button',
            class: 'kit-btn cb-ticked-discard',
            onclick() {
              // What is ticked and shown as Court presses.
              if (viewPending) return;
              const now = tickedItems()
                .map((it) => it.proposal)
                .filter(
                  (p) =>
                    p?.state === 'pending' && !p.source.startsWith('rule:'),
                )
                .map((p) => p?.id ?? 0);
              if (!now.length) return;
              openDiscardSheet(
                ctx,
                words,
                now.length,
                discardWhere(),
                { ids: now },
                discarded,
              );
            },
          },
          vocab.discard_many.replaceAll('{n}', String(ids.length)),
        ),
      );
    }
    return out;
  }

  // tickedDone is what deciding the ticked items did, in serve's words
  // ("Deleted all 3"), for the strip.
  function tickedDone(d: string, keys: string[]): string {
    if (!vocab) return '';
    const ids = [...new Set(keys.map((k) => groupOfKey.get(k) ?? ''))];
    const g = ids.length === 1 ? groups.find((x) => x.id === ids[0]) : null;
    if (g) {
      const w = doneWords(vocab, d, {
        label: g.label,
        total: g.total,
        ticked: keys.length,
      });
      if (w) return w;
    }
    if (keys.length === 1) return doneWords(vocab, d, { key: keys[0] });
    const c = (vocab.kinds ?? [])
      .find((k) => k.kind === kindFromKey(keys[0] ?? ''))
      ?.choices?.find((x) => x.disposition === d);
    return c
      ? c.done_many.replaceAll(
          '{n}',
          countWord(keys.length, keys.length, vocab.count_words),
        )
      : '';
  }

  // decideTicked decides every ticked item (every page): a pending
  // recommendation of exactly this decision is accepted, every other item
  // decided. An outward one says where it went (the strip, whose undo takes
  // them all back). The open item, if it was one of them, moves on.
  async function decideTicked(d: string, until?: string): Promise<void> {
    if (deciding || !vocab || viewPending) return;
    const items = tickedItems();
    const keys = items.map((it) => it.key);
    if (!keys.length) return;
    const { accept, decide } = splitTicked(items, d, until ?? '');
    const open = currentOpenKey;
    deciding = '\u0000ticked';
    try {
      const order = await orderFor(open);
      const made: Record<string, Committed> = {};
      const previous: Record<string, Committed> = {};
      const errs: string[] = [];
      if (accept.length) {
        const r = await ctx.api.post<AcceptResult>('/proposals/accept', {
          ids: accept,
        });
        Object.assign(made, r.decisions ?? {});
        Object.assign(previous, r.previous ?? {});
        errs.push(...(r.errors ?? []));
      }
      if (decide.length) {
        const body: Record<string, unknown> = { keys: decide, disposition: d };
        if (until) body['until'] = until;
        const r = await ctx.api.post<DecideResult>('/decide', body);
        Object.assign(made, r.decisions ?? {});
        Object.assign(previous, r.previous ?? {});
        errs.push(...(r.errors ?? []));
      }
      const decided = Object.keys(made);
      if (!decided.length) {
        showReadError(errs.join('; ') || 'nothing was decided');
        return;
      }
      lastUndo = decided.map((key) => ({
        key,
        prev: previous[key] ?? null,
        expect: made[key],
      }));
      const done = tickedDone(d, keys);
      selection.deselect(keys);
      if (outwardChoice(keys[0], d))
        waited(done, applyGroupLink(d, decided[0]));
      else hideStrip();
      if (open && decided.includes(open)) await moveOn(open, order);
      else void reload();
      if (errs.length) showReadError(errs.join('; '));
    } catch (err) {
      showReadError(err instanceof Error ? err.message : String(err));
    } finally {
      deciding = null;
    }
  }

  function updateFoot(): void {
    pane.setMore(Math.min(PAGE_SIZE, totalItems - offset));
  }

  // markOpenRow moves the list's open row to the item the reading column
  // shows (the next item move-on opened goes through the route, not a click
  // on its row). Nothing when the row already is the open one, so a reload
  // leaves the cursor where it was.
  function markOpenRow(): void {
    if (!currentOpenKey) return;
    const i = shown.findIndex((it) => it.key === currentOpenKey);
    if (i < 0) return;
    const rowEl = handle.el.querySelectorAll('.kit-rows > .kit-row')[i];
    if (rowEl?.classList.contains('open')) return;
    syncingOpen = true;
    try {
      handle.open(i);
    } finally {
      syncingOpen = false;
    }
  }

  // ---- recommendations: ask, discard ----------------------------------------

  // asked is the session this page asked to suggest rules and the list it
  // asked about: the not-recommended group's ask gives way to "asked
  // agent" for that list, so one click sends one message; another search
  // or filter is another list, and the offer is back.
  let asked = '';
  const askedKey = (session: string): string =>
    `${session}\n${JSON.stringify(listAttached('none'))}`;
  // lookedInto is each session\nkey this page asked to recommend: a row
  // not loaded (past the first pages) still counts as underway.
  const lookedInto = new Set<string>();
  ctx.onDockTarget(() => {
    updateReadEmptyCount();
    if (tickedOn) showTicked();
  });

  async function askRules(): Promise<void> {
    const t = ctx.dockTarget();
    if (!t) return;
    const why = await ctx.askSession(SUGGEST_RULES, {
      list: listAttached('none'),
    });
    if (why) showReadError(why);
    else {
      asked = askedKey(t.id);
      updateReadEmptyCount();
    }
  }

  // viewRecs is the view's agent recommendations (serve's count, every
  // page, the filters applied): what "discard all N" withdraws.
  let viewRecs = 0;

  // viewFilters is the view and its filters as /proposals/withdraw takes
  // them (the list's query without its page).
  function viewFilters(): Record<string, string> {
    const p = buildQuery(0);
    delete p['offset'];
    delete p['limit'];
    delete p['open'];
    return p;
  }

  // discarded follows a discard: the list is read again, and the offer to
  // ask the session to recommend the rest is made anew.
  function discarded(): void {
    asked = '';
    void reload();
  }

  // discardView confirms, then withdraws every agent recommendation in the
  // view and its filters (every page, not only the loaded rows).
  function discardView(): void {
    if (viewRecs === 0 || !vocab) return;
    openDiscardSheet(
      ctx,
      vocab,
      viewRecs,
      discardWhere(),
      viewFilters(),
      discarded,
    );
  }

  async function openDetail(key: string): Promise<void> {
    tickedOn = false;
    currentOpenKey = key;
    markOpenRow();
    feedAttached();
    try {
      const detail = await ctx.api.get<ItemDetailView>('/item', { key });
      // Another item opened meanwhile: this answer is no longer shown.
      if (currentOpenKey !== key) return;
      paintDetail(key, detail);
    } catch {
      // non-fatal; leave the reading column
    }
  }

  // ruleNameOf is a rule source's rule name ('' for an agent's).
  function ruleNameOf(source: string): string {
    if (!source.startsWith('rule:')) return '';
    const id = source.slice(5);
    return ruleRows.find((r) => r.rule.id === id)?.rule.name || id;
  }

  // paintDetail renders detail (key's) in the reading column.
  function paintDetail(key: string, detail: ItemDetailView): void {
    shownDetail = detail;
    // What is ticked has the middle pane: the item waits for it to go.
    if (tickedOn) return;
    const el = renderItem(ctx, detail, {
      decide: (d, until, note) => void decideOpen(key, d, until, note),
      cardsReady: () => renderAsk(),
      nav: renderNav(key),
      sourceName: ruleNameOf,
    });
    readEl.replaceChildren(el);
    renderAsk();
  }

  // ---- ask the session to look into it ------------------------------------

  // renderAsk puts "Look into it" in the open item's card grid, the last
  // card, numbered after the decisions (its number key picks it): only
  // with a session attached. It decides nothing: it sends the session
  // serve's message about the item (the vocabulary's look_into), with the
  // look-into purpose. While a session is looking into the item the card
  // says so in place of its sentence and can't be clicked.
  let askingKey = '';
  function renderAsk(): void {
    const grid = readEl.querySelector<HTMLElement>('.cb-decide .cb-choices');
    const old = grid?.querySelector('.cb-look-card');
    const key = currentOpenKey;
    const t = ctx.dockTarget();
    const words = vocab?.look_into;
    if (
      !grid ||
      !grid.dataset.cards ||
      !key ||
      !t ||
      !words ||
      shownDetail?.item.key !== key
    ) {
      old?.remove();
      return;
    }
    const w = lookIntoCard(words, t.name, key);
    const looking = lookingLine(shownDetail.item.looking);
    const n = Number(grid.dataset.cards) + 1;
    const card = h(
      'button',
      {
        type: 'button',
        class: 'kit-btn cb-choice cb-look-card' + (looking ? ' looking' : ''),
        title: looking || w.says,
        dataset: { n: String(n) },
        disabled: !!looking || askingKey === key,
        async onclick() {
          if (card.disabled) return;
          const wrap = grid.closest<HTMLElement>('.cb-choices-wrap');
          if (wrap) showChoiceError(wrap, '');
          askingKey = key;
          card.disabled = true;
          const why = await ctx.askSession(
            w.message,
            { keys: [key] },
            'look-into',
          );
          askingKey = '';
          if (why) {
            card.disabled = false;
            if (wrap) showChoiceError(wrap, why);
          } else void refreshLooking(key);
        },
      },
      h('span', { class: 'cb-choice-mark' }),
      h('span', { class: 'cb-choice-label' }, w.label),
    ) as HTMLButtonElement;
    if (old) old.replaceWith(card);
    else grid.append(card);
  }
  ctx.onDockTarget(() => renderAsk());

  // refreshLooking reads whether a session is looking into key (the open
  // item) and shows it in place, first in the reading, without re-rendering
  // the item (Court may be mid-input on it).
  let lookingSeq = 0;
  async function refreshLooking(key: string): Promise<void> {
    const mine = ++lookingSeq;
    let detail: ItemDetailView;
    try {
      detail = await ctx.api.get<ItemDetailView>('/item', { key });
    } catch {
      return;
    }
    if (mine !== lookingSeq || currentOpenKey !== key) return;
    if (shownDetail?.item.key !== key) return;
    shownDetail = {
      ...shownDetail,
      item: { ...shownDetail.item, looking: detail.item.looking },
    };
    const says = lookingLine(detail.item.looking);
    const el = readEl.querySelector<HTMLElement>('.cb-looking');
    if (el) {
      el.textContent = says;
      el.hidden = !says;
    }
    renderAsk();
  }

  // lookingShown: the open item or a shown row says a session is looking
  // into it (a message settling may take that away).
  function lookingShown(): boolean {
    return !!shownDetail?.item.looking || shown.some((it) => !!it.looking);
  }

  // lookingMayHaveChanged: a message moved (posted, answered, declined,
  // failed; a turn ended): the open item's marker and the rows' follow.
  function lookingMayHaveChanged(): void {
    if (currentOpenKey) void refreshLooking(currentOpenKey);
    void reload();
  }

  // midInput: Court is in the middle of answering the open item: its
  // closing-comment field is open with text typed, or its Not now picker
  // is open. A re-render then would wipe what he is doing.
  function midInput(): boolean {
    const comment = readEl.querySelector<HTMLElement>('.cb-close-comment');
    const typed =
      comment?.querySelector<HTMLInputElement>('input')?.value ?? '';
    if (comment && !comment.hidden && typed !== '') return true;
    const notNow = readEl.querySelector<HTMLElement>('.cb-notnow');
    return !!notNow && !notNow.hidden;
  }

  // proposalsChanged: a proposal for the open item came, or went (a live
  // "proposals" event naming key), or evidence for it came (why). The item re-renders, so its
  // recommendation and the "recommended" mark appear or go; while Court is
  // mid-input it doesn't, and a quiet line first in the reading says what
  // changed, with "show" to re-render.
  let freshSeq = 0;
  async function proposalsChanged(
    key: string,
    why: 'proposals' | 'evidence' = 'proposals',
  ): Promise<void> {
    const mine = ++freshSeq;
    let detail: ItemDetailView;
    try {
      detail = await ctx.api.get<ItemDetailView>('/item', { key });
    } catch {
      return;
    }
    // Only the newest answer, and only for the item still open (and not
    // one this tab is deciding: it moves on).
    if (mine !== freshSeq || currentOpenKey !== key || deciding === key) return;
    if (!midInput()) {
      paintDetail(key, detail);
      return;
    }
    const p = detail.item.proposal;
    const says =
      why === 'evidence'
        ? 'new evidence'
        : p && p.state === 'pending' && vocab
          ? recommendLine(
              vocab,
              key,
              p.source,
              p.disposition,
              ruleNameOf(p.source),
            )
          : 'the recommendation changed';
    const show = h(
      'button',
      {
        type: 'button',
        class: 'cb-link cb-rec-show',
        onclick: () => void openDetail(key),
      },
      'show',
    );
    const line = h(
      'p',
      { class: 'cb-rec-fresh' },
      h('span', { class: 'cb-rec-fresh-says' }, says),
      ' \u00b7 ',
      show,
    );
    const old = readEl.querySelector('.cb-rec-fresh');
    if (old) old.replaceWith(line);
    else readEl.querySelector('.cb-reading')?.prepend(line);
  }

  // ---- the decide step: decide, move on, undo ------------------------------

  // viewLabel is what the list shows, by name: the rule or the filters it
  // is narrowed to, else everything "to decide".
  function viewLabel(): string {
    if (filters.rule) {
      const rr = ruleRows.find((r) => r.rule.id === filters.rule);
      return `rule ${rr?.rule.name || filters.rule}`;
    }
    if (filtered()) return filterLabel(filterRows, filters.filters);
    return 'to decide';
  }

  // discardWhere is where a discard's confirm says the recommendations are:
  // the rule or filters the list is narrowed to, else "the list".
  function discardWhere(): string {
    return filtered() ? viewLabel() : 'the list';
  }

  // showReadError shows serve's message in the reading column: on the open
  // item's cards, else under the summary.
  function showReadError(message: string): void {
    if (readEl.querySelector('.cb-choice-err')) {
      showChoiceError(readEl, message);
      return;
    }
    readEl.firstElementChild?.append(
      h('p', { class: 'cb-choice-err' }, message),
    );
  }

  // showDone is the reading column when the view has nothing left.
  function showDone(): void {
    currentOpenKey = null;
    shownDetail = null;
    readEl.replaceChildren(
      h(
        'div',
        { class: 'cb-read-empty' },
        h(
          'p',
          { class: 'cb-read-done' },
          filtered()
            ? `Nothing left in ${viewLabel()}.`
            : 'Nothing left to decide.',
        ),
      ),
    );
    feedAttached();
  }

  // openKey opens key in the reading column (and the URL), as a click does.
  // When the URL already names key (the summary after its decision keeps
  // it), no route change comes, so it opens here.
  function openKey(key: string): void {
    const before = location.hash;
    ctx.route.go('item', key);
    if (location.hash === before) {
      void openDetail(key);
      void reload();
    }
  }

  // remember records a decision this tab made on key, for u: the decision
  // it had before, and the one serve's reply says the decide or accept
  // committed. With no such reply, u does nothing rather than guess.
  function remember(
    key: string,
    made: Record<string, Committed> | null,
    previous: Record<string, Committed> | null,
  ): void {
    const expect = made?.[key];
    lastUndo = expect ? [{ key, prev: previous?.[key] ?? null, expect }] : [];
  }

  // ---- the strip: where an outward decision went --------------------------

  // The strip after an outward decision, over the middle pane's foot: what
  // it did, "waiting in apply" (apply links to where it went) and undo, in
  // serve's words; for STRIP_MS, or until the next one.
  const strip = h('div', {
    class: 'cb-strip',
    role: 'status',
    hidden: true,
  });
  let stripTimer: ReturnType<typeof setTimeout> | null = null;
  function hideStrip(): void {
    if (stripTimer) clearTimeout(stripTimer);
    stripTimer = null;
    strip.hidden = true;
  }
  function showStrip(text: string, groupLink: string, undo: () => void): void {
    if (!vocab) return;
    strip.replaceChildren(
      ...waitingStrip(vocab.waiting, text).map((part) =>
        typeof part === 'string'
          ? part
          : 'link' in part
            ? h('a', { href: groupLink, class: 'cb-strip-apply' }, part.link)
            : h(
                'button',
                {
                  type: 'button',
                  class: 'cb-link cb-strip-undo',
                  onclick() {
                    hideStrip();
                    undo();
                  },
                },
                part.button,
              ),
      ),
    );
    if (!strip.isConnected) document.body.append(strip);
    // Over the middle pane, centred at its foot.
    const r = readEl.getBoundingClientRect();
    strip.style.left = `${Math.round(r.left + r.width / 2)}px`;
    strip.hidden = false;
    if (stripTimer) clearTimeout(stripTimer);
    stripTimer = setTimeout(hideStrip, STRIP_MS);
  }

  // waited shows the strip for an outward decision: done, in serve's words
  // ("Closed it", "Deleted all 3"); its apply links to the group the
  // decision joined (link). Undo takes back what lastUndo holds.
  function waited(done: string, link: string): void {
    if (done) showStrip(done, link, () => void undo());
  }

  // outwardChoice: d is a choice that only goes to apply for key's kind.
  function outwardChoice(key: string, d: string): boolean {
    const kind = key.slice(0, key.indexOf(':'));
    return !!vocab?.kinds
      ?.find((k) => k.kind === kind)
      ?.choices?.find((c) => c.disposition === d)?.outward;
  }

  // orderFor is the view's order to move on from key in: the list's rows,
  // or, when key is on a page the list no longer holds (opening an item
  // reloads the first page), the view fetched a page at a time up to key.
  async function orderFor(key: string | null): Promise<string[]> {
    if (!key || lastOrder.includes(key)) return [...lastOrder];
    const keys: string[] = [];
    try {
      for (let total = Infinity; keys.length < total;) {
        const data = await ctx.api.get<ItemsView>(
          '/items',
          buildQuery(keys.length),
        );
        const got = (data.items ?? []).map((it) => it.key);
        keys.push(...got);
        total = Math.min(total, data.total);
        if (!got.length || got.includes(key)) break;
      }
    } catch {
      return [...lastOrder];
    }
    return keys.includes(key) ? keys : [...lastOrder];
  }

  // moveOn opens the next undecided item in the view's order (order: the
  // view's keys when key was decided), or the view's summary when none is
  // left. The undecided ones are the view as serve lists it now, fetched a
  // page at a time until the next one is known (at most the view's total),
  // so an item decided elsewhere meanwhile is passed over, none is skipped,
  // and an item on a later page is found before wrapping to the first.
  async function moveOn(key: string, order: string[]): Promise<void> {
    const fresh: string[] = [];
    let next: string | null | typeof MORE = MORE;
    try {
      for (let total = Infinity; next === MORE;) {
        const data = await ctx.api.get<ItemsView>(
          '/items',
          buildQuery(fresh.length),
        );
        const got = (data.items ?? []).map((it) => it.key);
        fresh.push(...got);
        total = Math.min(total, data.total);
        const complete = got.length === 0 || fresh.length >= total;
        next = nextInView(order, key, fresh, complete);
      }
    } catch {
      if (key) void openDetail(key);
      return;
    }
    // Court opened something else meanwhile: leave it open.
    if ((currentOpenKey ?? '') !== key) return;
    if (next) openKey(next);
    else {
      showDone();
      void reload();
    }
  }

  // decideOpen decides the open item (a button, a number key) and moves
  // on. The recommended choice accepts its recommendation; another settles
  // it as decided differently (it counts against its rule or agent); with
  // none it is a plain decide. An outward one says where it went (the
  // strip).
  async function decideOpen(
    key: string,
    disposition: string,
    until?: string,
    note?: string,
  ): Promise<void> {
    if (deciding) return;
    deciding = key;
    const order = await orderFor(key);
    // The item's recommendation as serve has it now: one may have come (or
    // gone) while Court was typing a closing comment or picking a Not now,
    // and the decision must count for or against it.
    let p = shownProposal();
    try {
      const now = await ctx.api.get<ItemDetailView>('/item', { key });
      const fresh = now.item.proposal;
      p = fresh && fresh.state === 'pending' ? fresh : null;
    } catch {
      // keep what the page shows
    }
    const route = decideRoute(
      p && p.key === key ? p : null,
      disposition,
      until,
    );
    try {
      let made: Record<string, Committed> | null = null;
      let previous: Record<string, Committed> | null = null;
      if (route.path === 'accept') {
        const body: Record<string, unknown> = { ids: [route.id] };
        // A close's closing comment ('' or none: it closes without one).
        if (note) body['note'] = note;
        const r = await ctx.api.post<AcceptResult>('/proposals/accept', body);
        if (!r.accepted) {
          showReadError((r.errors ?? []).join('; ') || 'nothing was decided');
          return;
        }
        made = r.decisions;
        previous = r.previous;
      } else {
        const payload: Record<string, unknown> =
          route.path === 'change'
            ? { id: route.id, disposition }
            : { keys: [key], disposition };
        if (until) payload['until'] = until;
        if (note) payload['note'] = note;
        const r = await ctx.api.post<DecideResult>(
          route.path === 'change' ? '/proposals/change' : '/decide',
          payload,
        );
        if (!(r.decided_keys ?? []).length) {
          showReadError((r.errors ?? []).join('; ') || 'nothing was decided');
          return;
        }
        made = r.decisions;
        previous = r.previous;
      }
      selection.deselect([key]);
      remember(key, made, previous);
      if (outwardChoice(key, disposition) && vocab)
        waited(
          doneWords(vocab, disposition, { key }),
          applyGroupLink(disposition, key),
        );
      else hideStrip();
      await moveOn(key, order);
    } catch (err) {
      showReadError(err instanceof Error ? err.message : String(err));
    } finally {
      deciding = null;
    }
  }

  // undo takes back the last decisions this tab made, in one step serve
  // checks: per item, it restores the decision the item had before (or
  // clears it when it had none) only while the item's decision is still the
  // one this tab committed. serve refuses one decided since (409 when
  // nothing is undone); its message shows.
  async function undo(): Promise<void> {
    const u = lastUndo;
    if (!u.length || deciding) return;
    deciding = u[0].key;
    lastUndo = [];
    hideStrip();
    try {
      const r = await ctx.api.post<DecisionUndoResult>('/decisions/undo', {
        items: u.map((x) => ({
          key: x.key,
          expect: x.expect,
          restore: x.prev
            ? {
                disposition: x.prev.disposition,
                until: x.prev.until ?? '',
                note: x.prev.note ?? '',
              }
            : null,
        })),
      });
      if (u.length === 1) openKey(u[0].key);
      else void reload();
      const errs = r.errors ?? [];
      if (errs.length) showReadError(errs.join('; '));
    } catch (err) {
      // A refusal stands: these decisions can't be undone any more.
      showReadError(err instanceof Error ? err.message : String(err));
    } finally {
      deciding = null;
    }
  }

  // ---- section wiring -------------------------------------------------------

  void reload();

  // Ticked items show in the middle pane with their buttons; unticking them
  // all brings back the open item, or the summary. The groups' heads count
  // the ticks.
  selection.onChange(() => {
    paintAll();
    feedAttached();
    if (selection.ids().length) showTicked();
    else if (tickedOn) {
      tickedOn = false;
      if (currentOpenKey) void openDetail(currentOpenKey);
      else showReadEmpty();
    }
  });

  // shownProposal is the pending proposal the reading column shows: what
  // the decision buttons are pressed against. Not the list's row (the list
  // may be reloading, its rows gone until the answer comes).
  function shownProposal() {
    const d = shownDetail;
    if (!d || d.item.key !== currentOpenKey) return null;
    const p = d.item.proposal;
    return p && p.state === 'pending' ? p : null;
  }

  // u undoes the last decision this tab made; 1..9 pick the open item's
  // nth button (a click on it: Not now opens its conditions).
  const undoKey: KeyBinding = {
    keys: 'u',
    label: 'undo the last decision',
    group: 'page',
    run() {
      if (!lastUndo.length) return false;
      void undo();
    },
  };
  const choiceKeys: KeyBinding[] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    keys: String(n),
    label: `pick choice ${n}`,
    group: 'page',
    run() {
      if (!currentOpenKey) return false;
      const card = readEl.querySelectorAll<HTMLElement>(
        '.cb-choices .cb-choice',
      )[n - 1];
      if (!card) return false;
      card.click();
    },
  }));

  // [ and ] open the first item of the group before or after the open
  // item's (« and »).
  const jumpKeys: KeyBinding[] = groupKeys((d) => {
    if (!currentOpenKey) return;
    void navGo(d < 0 ? 'prevGroup' : 'nextGroup');
  });

  const listKeys: KeyBinding[] = [undoKey, ...choiceKeys, ...jumpKeys];

  // The vocabulary words the groups' buttons and the summary.
  void getVocab(ctx)
    .then((v) => {
      vocab = v;
      setRows();
      updateFoot();
      renderAsk();
    })
    .catch(() => {});

  // ---- show(sub, query) -- router hook -------------------------------------

  function show(sub: string, query: string): void {
    // The filter editor keeps the address it opened on; any other address
    // closes it (the address names what the list shows).
    if (draft !== null) {
      if (location.hash === draftHash) return;
      closeFilterEditor(false);
    }
    // Becoming active: the composer shows Attention's selection or open item.
    const wasActive = active;
    active = true;
    feedAttached();
    // The list's address names its search (#/decide?q=…); an item's
    // address keeps the search the list has.
    if (!sub) {
      const urlQ = paneQuery(query).q;
      if (urlQ !== filters.q) {
        filters.q = urlQ;
        pane.setSearch(urlQ);
      }
    }
    const params = new URLSearchParams(query);
    const ids = sub ? [] : parseFilterIds(params.get('filters'));
    const ruleId = sub ? '' : (params.get('rule') ?? '');
    if (sub) {
      // An item key from a #/item/<key> link. The list keeps the filters
      // or rule it shows.
      // A row click opens its item itself, then moves the hash here: the
      // item is already open (or loading), so it isn't loaded twice. A
      // different key (back, forward, a pasted link), or coming back from
      // another section, loads it.
      if (!wasActive || sub !== currentOpenKey) void openDetail(sub);
      void reload();
    } else if (ruleId) {
      // A rule (#/decide?rule=<id>): the list is its matches.
      flat = flatFor(true, query, storedFlat());
      storeFlat(flat);
      paintSwitch();
      filters.rule = ruleId;
      filters.filters = [];
      paintFilters();
      paintRules();
      showReadEmpty();
      void reload();
    } else if (ids.length) {
      filters.rule = null;
      paintRules();
      // Saved filters (#/decide?filters=a,b): the address names the list,
      // so it says whether it is flat.
      flat = flatFor(true, query, storedFlat());
      storeFlat(flat);
      paintSwitch();
      filters.filters = ids;
      paintFilters();
      showReadEmpty();
      void reload();
    } else {
      // Everything to decide (#/decide): an address with a query says
      // whether the list is flat; a bare one keeps the stored choice.
      flat = flatFor(query !== '', query, storedFlat());
      storeFlat(flat);
      paintSwitch();
      if (filtered()) {
        filters.filters = [];
        filters.rule = null;
        pane.setFilterError(null);
        paintFilters();
        paintRules();
      }
      showReadEmpty();
      void reload();
      // "+ filter" on review or run lands here (#/decide?new=filter): the
      // editor opens on the list.
      if (params.get('new') === 'filter') {
        setHashQuery(listQuery());
        openFilterEditor(null);
      }
    }
  }

  return {
    id: 'decide',
    list: handle.el,
    read: readEl,
    show,
    hide() {
      active = false;
      // Leaving decide clears its ticks: a tick covers only what is shown.
      selection.clear();
    },
    // The list's keys (j k o ↵ x ⇧x, / its search) come from the kit, bound
    // to this list while it shows.
    listKeys: () => ({ nav: handle, selects: true }),
    keys: () => listKeys,
    onLive(type: string, data: unknown) {
      obs.onLive(type, data);
      if (type === 'gap') {
        // Events this page never heard were pruned: reload all it shows
        // (the rules, the list, and the open item).
        void loadRules();
        void reload();
        if (currentOpenKey && currentOpenKey !== deciding) {
          void openDetail(currentOpenKey);
        }
      } else if (type === 'index') {
        // One reload per index event (the summary follows the list).
        void reload();
      } else if (type === 'decided') {
        // A live decided event can originate from the CLI or another client.
        // Deselect the decided keys so the bar's "Decide N" doesn't include
        // items that are already gone (the server's payload shape is
        // {keys: string[], disposition, by, proposed_by}).
        const decidedPayload = data as { keys?: string[] };
        const decidedKeys = decidedPayload?.keys ?? [];
        if (decidedKeys.length > 0) {
          selection.deselect(decidedKeys);
        }
        // The open item decided elsewhere: show its decision (not while this
        // tab is deciding it, which moves on).
        if (
          currentOpenKey &&
          currentOpenKey !== deciding &&
          decidedKeys.includes(currentOpenKey)
        ) {
          void openDetail(currentOpenKey);
        }
        void reload();
      } else if (type === 'proposals') {
        // proposals event: an agent's or a rule's new pending proposals, or
        // proposals accepted, rejected or changed. Payload shape:
        // {ids: number[], keys: string[], state: string, source?: string};
        // keys are the items the proposals are for.
        const propPayload = data as {
          ids?: number[];
          keys?: string[];
          state?: string;
        };
        const propKeys = propPayload?.keys ?? [];
        const propState = propPayload?.state ?? '';

        // When proposals are settled (accepted, rejected, changed), deselect
        // their items so the selection count stays correct.
        if (propState !== 'pending' && propKeys.length > 0) {
          selection.deselect(propKeys);
        }
        // The open item's recommendation came or went, in any state: by
        // keys, as the open item may not be on the loaded page.
        if (
          currentOpenKey &&
          currentOpenKey !== deciding &&
          propKeys.includes(currentOpenKey)
        ) {
          void proposalsChanged(currentOpenKey);
        }

        void reload();
      } else if (type === 'rules') {
        // A rule saved, turned on or off, excluded from (this tab or
        // another): the rule row, the groups' headers and an open rule
        // follow.
        void loadRules().then(() => {
          if (filters.rule && !currentOpenKey && draft === null && active)
            showReadEmpty();
        });
      } else if (type === 'filters') {
        // A filter saved or deleted (this tab or another): the chips, and a
        // filtered list, follow.
        void loadFilters().then(() => {
          if (filtered()) void reload();
        });
      } else if (type === 'evidence') {
        // New evidence for the open item: shown as a recommendation is.
        const key = (data as { key?: string })?.key ?? '';
        if (
          currentOpenKey &&
          currentOpenKey !== deciding &&
          key === currentOpenKey
        )
          void proposalsChanged(currentOpenKey, 'evidence');
      } else if (type === 'message') {
        // Court's message posted (this tab or another): an ask to look into
        // an item marks it.
        const keys = (data as Message | null)?.attached?.keys ?? [];
        if (
          keys.some(
            (k) => k === currentOpenKey || shown.some((it) => it.key === k),
          )
        )
          lookingMayHaveChanged();
      } else if (
        type === 'messages' ||
        type === 'settled' ||
        type === 'delivery' ||
        type === 'interrupted'
      ) {
        // A message settled (or a turn ended): a marker may go.
        if (lookingShown()) lookingMayHaveChanged();
      }
    },
    primary() {
      return null;
    },
  };
}
