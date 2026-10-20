// list-pane.ts — the list pane decide, review and run share (spec: one
// frame). Top to bottom, every line at a fixed height: the saved filters,
// the search, the tab's own row (decide's rules, run's running jobs,
// nothing on review), the tab's tools; then the groups, each a 32px head
// (caret, checkbox, label, tag, "N ticked · untick", count) over its rows,
// two lines each (the title or the key, then where it stands); then the foot
// ("show N more", how old the observations are). « hides the pane to a
// rail, kept per tab.
//
// The pane draws; the tab decides what the rows are, how they group, what
// a tick or a query does (hooks).

import { list, h, type ListHandle, type Selection } from '/_kit/kit.js';
import type { FilterRow } from './wire.d.ts';
import type { Ctx } from './app.ts';
import { makeFilterBar } from './filters.ts';
import { getVocab } from './decide.ts';
import { paneLines, type PaneQuery, type PaneRow } from './list-pane-text.ts';

export type { PaneRow, PaneQuery };
export type Tab = 'decide' | 'review' | 'run';

/** SEARCH_MS is how long the search waits for typing to stop. */
const SEARCH_MS = 200;

/**
 * PaneGroup is one group's head: its id (its rows' groupOf), its label, a
 * tag after it ("rule · delete it"), its count, whether it has a checkbox,
 * a menu (⋯) and data attributes for the head.
 */
export interface PaneGroup {
  id: string;
  label: string;
  tag?: string;
  n: number;
  box: boolean;
  more?: HTMLElement | null;
  data?: Record<string, string>;
}

export interface PaneHooks<T> {
  row(it: T): PaneRow;
  groupOf(it: T): string;
  onOpen(it: T): void;
  /** The filters or the search changed (clicked: the filter chip clicked). */
  onQuery(q: PaneQuery, clicked?: string): void;
  onToggle(id: string): void;
  onTickGroup(id: string): void;
  tickedIn(id: string): string[];
  onMore(): void;
  onFilterOpen(row: FilterRow): void;
  onFilterNew(): void;
}

export type ObsState = '' | 'fresh' | 'stale' | 'syncing';

export interface Pane<T> {
  el: HTMLElement;
  handle: ListHandle<T>;
  ownRow: HTMLElement;
  tools: HTMLElement;
  setFilters(rows: FilterRow[], selected: string[]): void;
  setFilterError(msg: string | null): void;
  setSearch(q: string): void;
  query(): PaneQuery;
  /** setRows draws items under groups' heads, an open group's rows shown; it returns the rows shown. */
  setRows(items: T[], groups: PaneGroup[], opened: Set<string>): T[];
  paintHeads(): void;
  setMore(left: number): void;
  setObs(text: string, state: ObsState): void;
  setRail(text: string): void;
}

/**
 * setHashQuery puts query in the address after its path, without a new
 * history entry or a route change: a search typed is kept, not navigated.
 */
export function setHashQuery(query: string): void {
  const path = location.hash.split('?')[0] || '#/';
  history.replaceState(
    null,
    '',
    location.pathname + location.search + path + (query ? `?${query}` : ''),
  );
}

export function makePane<T>(
  ctx: Ctx,
  tab: Tab,
  selection: Selection,
  hooks: PaneHooks<T>,
): Pane<T> {
  let q: PaneQuery = { filters: [], q: '' };
  let timer: ReturnType<typeof setTimeout> | null = null;

  // ---- the foot ----
  const moreBtn = h('button', {
    type: 'button',
    class: 'cb-foot-more',
    hidden: true,
    onclick() {
      hooks.onMore();
    },
  });
  const obsText = h('span', { 'data-testid': 'observations' });
  const obsEl = h(
    'div',
    { class: 'cb-apply-obs', hidden: true },
    h('i', { class: 'cb-apply-obs-dot', 'aria-hidden': 'true' }),
    obsText,
  );
  const foot = h('div', { class: 'cb-pane-foot' }, obsEl, moreBtn);

  const handle = list<T>({
    label: '',
    selection,
    openOnMove: false,
    search: {
      placeholder: 'search by key or title',
      onInput(text: string) {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          q = { ...q, q: text };
          hooks.onQuery({ ...q });
        }, SEARCH_MS);
      },
    },
    row(it: T) {
      const r = hooks.row(it);
      const l = paneLines(r);
      return {
        id: r.id,
        key: l.one,
        title: l.two,
        selectable: r.selectable ?? true,
      };
    },
    onOpen(it: T) {
      hooks.onOpen(it);
    },
    foot,
  });
  const el = handle.el;
  el.classList.add('cb-pane', `cb-pane-${tab}`);
  el.dataset.tab = tab;

  // ---- the top block: filters, search, the tab's own row, its tools ----
  const filterBar = makeFilterBar(ctx, {
    onSelect(ids, clicked) {
      q = { ...q, filters: ids };
      hooks.onQuery({ ...q }, clicked);
    },
    onOpen(row) {
      hooks.onFilterOpen(row);
    },
    onNew() {
      hooks.onFilterNew();
    },
  });
  const ownRow = h('div', { class: 'cb-own' });
  const tools = h('div', { class: 'cb-pane-tools' });
  const lh = el.querySelector<HTMLElement>('.kit-lh');
  const search = el.querySelector<HTMLElement>('.kit-search');
  if (lh) {
    lh.classList.add('cb-pane-top');
    lh.replaceChildren(
      filterBar.el,
      ...(search ? [search] : []),
      ownRow,
      tools,
    );
  }

  // ---- « and the rail ----
  const storeKey = `casebook.sidebar.${tab}`;
  const hideBtn = h(
    'button',
    {
      type: 'button',
      class: 'cb-list-hide',
      title: 'hide the list',
      onclick() {
        setSidebar(false);
      },
    },
    '\u00ab',
  );
  const showBtn = h(
    'button',
    { type: 'button', class: 'cb-list-show', title: 'show the list' },
    '\u00bb',
  );
  const railLabel = h('span', { class: 'cb-list-rail-label' });
  const rail = h(
    'div',
    {
      class: 'cb-list-rail',
      onclick() {
        setSidebar(true);
      },
    },
    showBtn,
    railLabel,
  );
  el.append(hideBtn, rail);
  function setSidebar(open: boolean): void {
    el.classList.toggle('cb-list-closed', !open);
    try {
      localStorage.setItem(storeKey, open ? 'open' : 'closed');
    } catch {
      // storage refused: the choice lasts this page only
    }
  }
  try {
    el.classList.toggle(
      'cb-list-closed',
      localStorage.getItem(storeKey) === 'closed',
    );
  } catch {
    // no storage: the list shows
  }
  void getVocab(ctx)
    .then((v) => {
      hideBtn.title = v.hide_list;
      showBtn.title = v.show_list;
    })
    .catch(() => {});

  // ---- groups and rows ----
  let heads: Array<{ paint(): void }> = [];

  function head(g: PaneGroup, open: boolean): HTMLElement {
    const toggle = (): void => hooks.onToggle(g.id);
    const box = g.box
      ? h('span', {
          class: 'cb-group-box',
          role: 'checkbox',
          'aria-checked': 'false',
          'aria-label': g.label,
          onclick() {
            hooks.onTickGroup(g.id);
          },
        })
      : h('span', { class: 'cb-group-nobox' });
    const tickedN = h('span', { class: 'cb-group-ticked-n' });
    const ticked = h(
      'span',
      { class: 'cb-group-ticked', hidden: true },
      tickedN,
      h(
        'button',
        {
          type: 'button',
          class: 'cb-group-untick',
          onclick() {
            selection.deselect(hooks.tickedIn(g.id));
          },
        },
        'untick',
      ),
    );
    const named = [g.label, g.tag].filter(Boolean).join(' \u00b7 ');
    const top = h(
      'div',
      { class: 'cb-group-top' },
      h(
        'button',
        {
          type: 'button',
          class: 'cb-group-caret',
          'aria-expanded': String(open),
          'aria-label': g.label,
          onclick: toggle,
        },
        open ? '\u25bc' : '\u25b6',
      ),
      box,
      h(
        'span',
        { class: 'cb-group-name', title: named, onclick: toggle },
        h('span', { class: 'cb-group-label' }, g.label),
        g.tag ? h('span', { class: 'cb-group-tag' }, g.tag) : null,
      ),
      ticked,
      h('span', { class: 'cb-group-n' }, String(g.n)),
      g.more ?? null,
    );
    const data: Record<string, string> = { group: g.id, ...(g.data ?? {}) };
    if (tab !== 'decide') data['part'] = g.id;
    const hd = h(
      'div',
      {
        class:
          'cb-group' +
          (tab !== 'decide' ? ' cb-apply-part' : '') +
          (open ? '' : ' collapsed'),
        role: 'presentation',
        dataset: data,
      },
      top,
    );
    heads.push({
      paint() {
        const n = hooks.tickedIn(g.id).length;
        box.setAttribute(
          'aria-checked',
          n === 0 ? 'false' : n >= g.n ? 'true' : 'mixed',
        );
        ticked.hidden = n === 0;
        tickedN.textContent = `${n} ticked \u00b7 `;
      },
    });
    return hd;
  }

  function setRows(items: T[], groups: PaneGroup[], opened: Set<string>): T[] {
    const listedIds = new Set(groups.map((g) => g.id));
    const shown = items.filter((it) => {
      const g = hooks.groupOf(it);
      return !listedIds.has(g) || opened.has(g);
    });
    handle.setItems(shown);
    const body = el.querySelector<HTMLElement>('.kit-rows');
    const rowEls = el.querySelectorAll<HTMLElement>('.kit-rows > .kit-row');
    shown.forEach((it, i) => {
      const rowEl = rowEls[i];
      if (!rowEl) return;
      const r = hooks.row(it);
      const l = paneLines(r);
      rowEl.dataset.key = r.key;
      rowEl.dataset.group = hooks.groupOf(it);
      rowEl.title = l.hover;
      const one = rowEl.querySelector<HTMLElement>('.kit-kicker');
      if (one) one.title = l.one;
      const two = rowEl.querySelector<HTMLElement>('.kit-title');
      if (two) {
        two.title = l.two;
        two.className = `kit-title cb-tone-${r.tone ?? 'muted'}`;
      }
    });
    heads = [];
    if (!body) return shown;
    // Rows in no listed group (a flat list's) are loose: they lead, always
    // shown, flush left; a group with no rows shown goes after them.
    const listed = new Set(groups.map((g) => g.id));
    let last: Element | null = null;
    shown.forEach((it, i) => {
      if (listed.has(hooks.groupOf(it))) return;
      rowEls[i]?.classList.add('cb-loose');
      if (!shown.slice(0, i).some((x) => listed.has(hooks.groupOf(x))))
        last = rowEls[i] ?? last;
    });
    for (const g of groups) {
      const hd = head(g, opened.has(g.id));
      const first = shown.findIndex((it) => hooks.groupOf(it) === g.id);
      if (first >= 0) {
        rowEls[first]?.before(hd);
        let end = first;
        while (end + 1 < shown.length && hooks.groupOf(shown[end + 1]) === g.id)
          end++;
        last = rowEls[end] ?? hd;
      } else {
        if (last) last.after(hd);
        else body.prepend(hd);
        last = hd;
      }
    }
    paintHeads();
    return shown;
  }

  function paintHeads(): void {
    for (const hd of heads) hd.paint();
  }

  return {
    el,
    handle,
    ownRow,
    tools,
    setFilters(rows, selected) {
      q = { ...q, filters: [...selected] };
      filterBar.paint(rows, selected);
    },
    setFilterError(msg) {
      filterBar.setError(msg);
    },
    setSearch(text) {
      q = { ...q, q: text };
      handle.setSearch(text);
    },
    query: () => ({ filters: [...q.filters], q: q.q }),
    setRows,
    paintHeads,
    setMore(left) {
      moreBtn.hidden = left <= 0;
      moreBtn.textContent = `show ${left} more`;
    },
    setObs(text, state) {
      obsText.textContent = text;
      obsEl.dataset.state = state;
      obsEl.hidden = !text;
    },
    setRail(text) {
      railLabel.textContent = text;
    },
  };
}
