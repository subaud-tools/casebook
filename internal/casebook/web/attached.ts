// attached.ts — what goes with a message: the composer's `attached:` line.
//
// Pure helpers with no browser or kit imports, so node --test can load them.
//
//   attachedLabel  — the line's display value: "4 prs selected",
//                    "schuettc/hail#4", "rule landed-branches", "job #3"
//                    (with its title when the page gives one: "job #3 ·
//                    close stale prs"), "list · 2 filters · rule x · search
//                    foo" (decide's list as it is narrowed).
//   attachedText   — the editable form of the same value, in the words the
//                    delivery text uses: "pr:o/r#1 pr:o/r#2", "open pr:o/r#4",
//                    "rule landed-branches", "job 3", and the list as
//                    `list filters=a,b rule=x search="foo" group=none`
//                    (a draft previewing: `list match="[...]"`).
//   parseAttached  — reads an edited line back into an Attached. Words it
//                    doesn't recognise are dropped; the line then re-renders
//                    from what was parsed, so what Court sees is what is sent.

import type { Attached, AttachedList } from './wire.d.ts';
import { keyWithoutKind, kindFromKey, pluralize } from './decide-math.ts';

// Plural nouns for item kinds. The default adds "s"; branch is the exception.
const KIND_PLURAL: Record<string, string> = { branch: 'branches' };

/** isEmpty reports whether nothing is attached. */
export function isEmpty(a: Attached): boolean {
  return !a.keys?.length && !a.open && !a.rule && !a.job && !a.list;
}

/**
 * attachedLabel is the attached line's display value ('' when empty).
 * jobTitle, when the section showing the job gives it, follows the job's
 * number, lower-cased as the line reads: "job #3 · close stale prs".
 */
export function attachedLabel(a: Attached, jobTitle = ''): string {
  const parts: string[] = [];
  const keys = a.keys ?? [];
  if (keys.length === 1) {
    parts.push(keyWithoutKind(keys[0]));
  } else if (keys.length > 1) {
    const kinds = new Set(keys.map(kindFromKey));
    const kind = kinds.size === 1 ? [...kinds][0] : '';
    const noun = kind
      ? pluralize(keys.length, kind, KIND_PLURAL[kind])
      : pluralize(keys.length, 'item');
    parts.push(`${noun} selected`);
  }
  if (a.open && !(keys.length === 1 && keys[0] === a.open)) {
    parts.push(keyWithoutKind(a.open));
  }
  if (a.rule) parts.push(`rule ${a.rule}`);
  if (a.job)
    parts.push(
      jobTitle
        ? `job #${a.job} \u00b7 ${jobTitle.toLowerCase()}`
        : `job #${a.job}`,
    );
  // The list as it is narrowed, not its keys: "list · 2 filters · rule x
  // · search foo"; "list" alone is the whole list.
  if (a.list) parts.push(listLabel(a.list));
  return parts.join(' \u00b7 ');
}

// listLabel is the narrowed list's display value.
function listLabel(l: AttachedList): string {
  const parts = ['list'];
  if (l.match) parts.push('draft');
  const n = l.filters?.length ?? 0;
  if (n) parts.push(pluralize(n, 'filter'));
  if (l.rule) parts.push(`rule ${l.rule}`);
  if (l.q) parts.push(`search ${l.q}`);
  if (l.group) parts.push(`group ${l.group}`);
  return parts.join(' \u00b7 ');
}

// listText is the narrowed list's editable form, one word per part:
// `list filters=a,b rule=x search="foo" group=none`.
function listText(l: AttachedList): string {
  const words = ['list'];
  if (l.match) words.push(`match=${JSON.stringify(l.match)}`);
  if (l.filters?.length) words.push(`filters=${l.filters.join(',')}`);
  if (l.rule) words.push(`rule=${l.rule}`);
  if (l.q) words.push(`search=${JSON.stringify(l.q)}`);
  if (l.group) words.push(`group=${l.group}`);
  return words.join(' ');
}

// LIST_RE finds the list's editable form in a line: "list" and the
// name=value words after it (a search's value is quoted).
const LIST_RE =
  /(?:^|\s)list((?:\s+(?:match|filters|rule|search|group)=(?:"(?:[^"\\]|\\.)*"|\S+))*)(?=\s|$)/;

// parseList reads the name=value words after "list".
function parseList(words: string): AttachedList {
  const l: AttachedList = {};
  const re = /(match|filters|rule|search|group)=("(?:[^"\\]|\\.)*"|\S+)/g;
  for (const m of words.matchAll(re)) {
    const [, name, raw] = m;
    let v = raw;
    if (raw.startsWith('"')) {
      try {
        v = JSON.parse(raw) as string;
      } catch {
        v = raw.slice(1, -1);
      }
    }
    if (name === 'filters') {
      const ids = v.split(',').filter(Boolean);
      if (ids.length) l.filters = ids;
    } else if (name === 'match') l.match = v;
    else if (name === 'rule') l.rule = v;
    else if (name === 'search') l.q = v;
    else l.group = v;
  }
  return l;
}

/** attachedText is the editable form of an Attached. */
export function attachedText(a: Attached): string {
  const words: string[] = [...(a.keys ?? [])];
  if (a.open && !(a.keys?.length === 1 && a.keys[0] === a.open)) {
    words.push(`open ${a.open}`);
  }
  if (a.rule) words.push(`rule ${a.rule}`);
  if (a.job) words.push(`job ${a.job}`);
  if (a.list) words.push(listText(a.list));
  return words.join(' ');
}

/** parseAttached reads the editable form back into an Attached. */
export function parseAttached(text: string): Attached {
  const out: Attached = {};
  const list = LIST_RE.exec(text);
  if (list) {
    out.list = parseList(list[1]);
    text =
      text.slice(0, list.index) + ' ' + text.slice(list.index + list[0].length);
  }
  const words = text
    .split(/[\s,]+/)
    .map((w) => w.trim())
    .filter(Boolean);
  const keys: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    if ((w === 'rule' || w === 'job' || w === 'open') && next) {
      if (w === 'rule') out.rule = next;
      else if (w === 'job') out.job = next.replace(/^#/, '');
      else if (isKey(next)) out.open = next;
      i++;
      continue;
    }
    if (isKey(w) && !keys.includes(w)) keys.push(w);
  }
  if (keys.length) out.keys = keys;
  return out;
}

// isKey reports whether a word looks like an item key: <kind>:<id>.
function isKey(w: string): boolean {
  return /^[a-z]+:\S+$/.test(w);
}

/** sameAttached compares two Attached values by content. */
export function sameAttached(a: Attached, b: Attached): boolean {
  return attachedText(a) === attachedText(b);
}
