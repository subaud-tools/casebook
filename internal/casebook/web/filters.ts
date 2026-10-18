// filters.ts — the Attention list's saved filters: a row of chips under the
// view chips, and the editor that opens in the middle pane.
//
// makeFilterBar(ctx, hooks) draws one toggle chip per filter (serve's
// GET /api/filters, in id order), then `+ filter`, as the rules row is
// drawn. Selecting is the caller's (hooks.onSelect with the new selection;
// the address keeps it); the page shows the clicked filter in the middle
// pane (renderFilter: edit, make a rule, delete). A filter that doesn't
// validate shows marked, with serve's message as its title: a click shows
// it, to fix, without selecting it.
//
// filterEditor(ctx, row, hooks) is the editor: its title, the name with
// save and cancel, then the rules' condition editor (conditions.ts), so
// adding a condition moves neither. It previews nothing itself: every edit
// goes to hooks.onDraft, and the page lists the draft's matches in the list
// on the left. serve validates: a 400 shows under the condition it names
// (showError), a 409 under the name.

import { h, ApiError, buttons, card, type Button } from '/_kit/kit.js';
import type { Condition, FilterRow, FiltersView } from './wire.d.ts';
import type { Ctx } from './app.ts';
import { conditionEditor, setConditionError } from './conditions.ts';
import { conditionErrorIndex, slug } from './rules-text.ts';
import { toggleFilter } from './filters-text.ts';

export interface FilterBar {
  el: HTMLElement;
  paint(rows: FilterRow[], selected: string[]): void;
  setError(message: string | null): void;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function makeFilterBar(
  _ctx: Ctx,
  hooks: {
    /** The new selection, and the chip clicked (the filter to show). */
    onSelect(ids: string[], clicked: string): void;
    /** A filter that doesn't validate: show it, to fix, unselected. */
    onOpen(row: FilterRow): void;
    onNew(): void;
  },
): FilterBar {
  let rows: FilterRow[] = [];
  let selected: string[] = [];

  const chipsEl = h('div', {
    class: 'kit-chips cb-filter-chips',
    'data-group': 'filters',
  });
  const addBtn = h(
    'button',
    {
      type: 'button',
      class: 'kit-chip cb-filter-add',
      onclick() {
        hooks.onNew();
      },
    },
    '+ filter',
  );
  const errEl = h('p', { class: 'cb-filter-err', hidden: true });
  const el = h(
    'div',
    { class: 'cb-filters', 'aria-label': 'saved filters' },
    h('span', { class: 'cb-bar-label' }, 'filters'),
    chipsEl,
    errEl,
  );

  function chip(row: FilterRow): HTMLElement {
    const id = row.filter.id;
    const on = selected.includes(id);
    const b = h(
      'button',
      {
        type: 'button',
        class: 'kit-chip cb-filter' + (on ? ' on' : ''),
        'data-id': id,
        'aria-pressed': String(on),
        onclick() {
          if (row.invalid) {
            hooks.onOpen(row);
            return;
          }
          const next = toggleFilter(rows, selected, id);
          if (next !== selected) hooks.onSelect(next, id);
        },
      },
      row.filter.name || id,
    );
    if (row.invalid) {
      b.setAttribute('data-invalid', '');
      b.title = row.invalid;
    }
    return b;
  }

  function paint(r: FilterRow[], sel: string[]): void {
    rows = r;
    selected = sel;
    chipsEl.replaceChildren(...rows.map(chip), addBtn);
  }

  function setError(msg: string | null): void {
    errEl.hidden = msg === null;
    errEl.textContent = msg ?? '';
  }

  paint([], []);
  return { el, paint, setError };
}

/**
 * renderFilter draws a saved filter in the middle pane, read only: its
 * conditions, then edit, make a rule and delete (delete posts here; the
 * caller hears hooks.onDeleted).
 */
export function renderFilter(
  ctx: Ctx,
  row: FilterRow,
  hooks: {
    onEdit(): void;
    onMakeRule(): void;
    onDeleted(): void;
  },
): HTMLElement {
  const f = row.filter;
  const note = h('p', { class: 'cb-rule-note', role: 'status' });
  const bs: Button[] = [{ label: 'edit', run: () => hooks.onEdit() }];
  if (!row.invalid)
    bs.push({ label: 'make a rule', run: () => hooks.onMakeRule() });
  bs.push({
    label: 'delete',
    run: () => {
      note.textContent = '';
      void ctx.api
        .post<FiltersView>('/filters/delete', { id: f.id })
        .then(() => hooks.onDeleted())
        .catch((err: unknown) => {
          note.textContent = message(err);
        });
    },
  });
  return h(
    'div',
    { class: 'kit-doc' },
    h(
      'article',
      { class: 'cb-rule cb-filter-doc', 'data-filter': f.id },
      h('p', { class: 'kit-kick' }, 'filter'),
      h('h1', { class: 'kit-h1' }, f.name || f.id),
      row.invalid
        ? card({
            edge: 'signal',
            head: 'not valid',
            body: h(
              'div',
              null,
              h('p', { class: 'cb-invalid-msg' }, row.invalid),
              h(
                'p',
                { class: 'cb-invalid-help' },
                'This filter selects nothing until it is valid. Edit it to fix it.',
              ),
            ),
          })
        : null,
      h('h3', { class: 'kit-label' }, 'items that match all of'),
      conditionEditor(
        ctx,
        { match: f.match, status: 'active', editable: false },
        () => {},
      ),
      h('div', { class: 'cb-rule-actions' }, buttons(bs), note),
    ),
  );
}

export interface FilterEditor {
  el: HTMLElement;
  /** showError shows serve's refusal of the draft (null clears it). */
  showError(err: unknown): void;
}

/**
 * filterEditor edits row (null: a new filter). hooks.onDraft gets the
 * conditions after every edit (and once at the start), hooks.onSaved the
 * saved filter's id, hooks.onCancel a cancel.
 */
export function filterEditor(
  ctx: Ctx,
  row: FilterRow | null,
  hooks: {
    onDraft(match: Condition[]): void;
    onSaved(id: string): void;
    onCancel(): void;
  },
): FilterEditor {
  let match: Condition[] = (row?.filter.match ?? []).map((c) => ({ ...c }));
  const editor = conditionEditor(
    ctx,
    { match, status: 'draft' },
    (m: Condition[]) => {
      match = m;
      hooks.onDraft(match);
    },
  );
  // A filter that doesn't validate opens with serve's reason under the
  // condition it names.
  if (row?.invalid) {
    setConditionError(editor, conditionErrorIndex(row.invalid), row.invalid);
  }

  const name = h('input', {
    class: 'cb-filter-name',
    type: 'text',
    placeholder: 'name',
    'aria-label': 'filter name',
    onkeydown(e: KeyboardEvent) {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        void save();
      }
    },
  }) as HTMLInputElement;
  if (row) name.value = row.filter.name;
  const nameErr = h('p', { class: 'cb-filter-name-err', hidden: true });
  function showNameError(msg: string | null): void {
    nameErr.hidden = msg === null;
    nameErr.textContent = msg ?? '';
  }

  function showError(err: unknown): void {
    if (err === null) {
      // A filter that doesn't validate keeps its reason until it is fixed.
      if (!row?.invalid || match.length) setConditionError(editor, -1, null);
      return;
    }
    const msg = message(err);
    setConditionError(editor, conditionErrorIndex(msg), msg);
  }

  async function save(): Promise<void> {
    const n = name.value.trim();
    const id = row ? row.filter.id : slug(n);
    showNameError(null);
    try {
      await ctx.api.post<FiltersView>(
        row ? '/filters/save' : '/filters/save?create=1',
        { id, name: n, match },
      );
      hooks.onSaved(id);
    } catch (err) {
      const msg = message(err);
      if (err instanceof ApiError && err.status === 409) {
        showNameError(msg);
        return;
      }
      const i = conditionErrorIndex(msg);
      if (i < 0 && /name|filter id/.test(msg)) {
        showNameError(msg);
        return;
      }
      setConditionError(editor, i, msg);
    }
  }

  const el = h(
    'div',
    { class: 'kit-doc' },
    h(
      'article',
      { class: 'cb-filter-edit', 'data-testid': 'filter-editor' },
      h(
        'h1',
        { class: 'kit-h1 cb-filter-title' },
        row ? `edit ${row.filter.name || row.filter.id}` : 'new filter',
      ),
      h(
        'div',
        { class: 'cb-filter-acts' },
        name,
        h(
          'button',
          {
            type: 'button',
            class: 'kit-btn fill cb-filter-save',
            onclick() {
              void save();
            },
          },
          'save',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'kit-btn cb-filter-cancel',
            onclick() {
              hooks.onCancel();
            },
          },
          'cancel',
        ),
      ),
      nameErr,
      editor,
    ),
  );
  return { el, showError };
}
