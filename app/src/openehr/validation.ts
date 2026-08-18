/**
 * Form-side enforcement of the template's `min >= 1` constraints.
 *
 * WHY THIS EXISTS
 *
 * Until now the only thing checking mandatory fields was EHRbase, at POST time.
 * A user could fill in a long composition, press Save, and be told
 *
 *   HTTP 422 … /content[openEHR-EHR-EVALUATION.adverse_reaction_risk.v2]
 *   /data[at0001]/items[at0002]: attribute value is mandatory
 *
 * — an RM path, after the fact, naming nothing the user can see on screen. This
 * module moves that decision into the form, phrased in the template's own
 * labels and shown next to the control that has to be fixed.
 *
 * The CDR remains the authority. This is a fast, legible pre-check that removes
 * the common rejection; it does not replicate EHRbase's full validation, and a
 * save that passes here can still be refused for something this does not model.
 *
 * THE THREE RULES THAT ARE NOT OBVIOUS
 *
 * 1. MANDATORY INSIDE A REPEATABLE IS CONDITIONAL. `substance` is min=1 within
 *    an `adverse_reaction_risk`, but a composition with no allergies at all is
 *    valid — the section itself is min=0. Demanding `substance` on an untouched
 *    form would make an empty EPS composition unsaveable: wrong, and worse than
 *    the 422 it replaces. So an occurrence is checked only once the user has put
 *    something in it. A wholly blank occurrence is not an incomplete entry, it
 *    is no entry — and Medblocks' own `hasValue()` filter drops it before it
 *    reaches the CDR.
 *
 * 2. ONLY THE MOUNTED BRANCH COUNTS. Each section renders exactly one of
 *    entries / excluded / no-information (see `forms/section-shell`); the other
 *    two are absent from the DOM and therefore from `export()`. Demanding their
 *    absence statements would put an unfixable error on every section, naming a
 *    field that is not on screen. Validation runs against the form's live
 *    element registry, so an unmounted branch is invisible here by construction
 *    — the same property that keeps contradictory data out of the CDR.
 *
 * 3. EMPTINESS IS READ FROM `.data`, NEVER `.value`. `mb-search` keeps its coded
 *    result on `.data` and leaves `.value` empty, so a populated substance reads
 *    as blank if asked the obvious way. Same trap as `section-shell.hasValue()`.
 */

import { mandatoryFields, type MandatoryField, type WebTemplate } from './webtemplate';

/** A mandatory field that is not filled in, resolved to a concrete occurrence. */
export interface ValidationIssue {
  /**
   * The indexed FLAT path of the empty field —
   * `…/adverse_reaction_risk:0/substance`. Carries real occurrence indices so
   * the UI can mark the exact control.
   */
  path: string;
  /** The template's own label, e.g. "Substance". */
  label: string;
  /** Which section the path belongs to, when it is inside one. */
  sectionKey?: string;
  /** 1-based position within a repeatable, when the field is in one. */
  entryNumber?: number;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/**
 * True when a value counts as "the user filled this in".
 *
 * Mirrors `section-shell.hasValue()`. Objects are inspected recursively: a
 * coded control's `.data` is `{ code, value, terminology }`, and an untouched
 * one is `{ code: '', value: '' }` — an object that is present but empty.
 */
export function hasValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(hasValue);
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasValue);
  }
  return true;
}

/** Strips the `|attr` suffix. */
function stripAttribute(key: string): string {
  const bar = key.lastIndexOf('|');
  return bar === -1 ? key : key.slice(0, bar);
}

/** Removes every `:n` index, giving the structural identity of a key. */
function unindex(key: string): string {
  return stripAttribute(key).replace(/:\d+/g, '');
}

/**
 * The occurrence prefix of `key` at the depth of `repeatablePath`.
 *
 * `…/adverse_reaction_risk:1/adverse_reaction_event:0/manifestation:2` asked
 * about `…/adverse_reaction_risk` yields `…/adverse_reaction_risk:1` — the
 * identity of the entry that key belongs to. Returns undefined when the key is
 * not under that repeatable at all.
 *
 * Written as a segment walk rather than a regex because the indices that matter
 * are positional: a nested repeatable contributes its own `:n` further along
 * the same key, and truncating on the wrong one merges distinct entries.
 */
function occurrenceOf(key: string, repeatablePath: string): string | undefined {
  const target = repeatablePath.split('/');
  const actual = stripAttribute(key).split('/');
  if (actual.length < target.length) return undefined;

  const consumed: string[] = [];
  for (let i = 0; i < target.length; i += 1) {
    const segment = actual[i];
    const bare = segment.replace(/:\d+$/, '');
    if (bare !== target[i]) return undefined;
    consumed.push(segment);
  }
  return consumed.join('/');
}

export interface ValidateOptions {
  /** Maps a FLAT path to the key of the section that owns it, for grouping. */
  sectionKeyFor?: (path: string) => string | undefined;
}

/**
 * Checks a form's live data against the template's mandatory fields.
 *
 * `data` is `mb-form.data` — path -> that element's `.data` — so it contains
 * exactly the fields currently mounted, already excluding unmounted branches
 * (rule 2). Keys carry real occurrence indices, which is what lets a missing
 * value be reported against the entry it belongs to rather than the template
 * path in the abstract.
 */
export function validateMandatory(
  template: WebTemplate | undefined,
  data: Record<string, unknown>,
  options: ValidateOptions = {},
): ValidationResult {
  const required = mandatoryFields(template);
  if (!required.length) return { valid: true, issues: [] };

  const issues: ValidationIssue[] = [];

  // Indexed by structural identity so an occurrence's keys can be found without
  // rebuilding index permutations.
  const entries = Object.entries(data);

  for (const field of required) {
    if (field.repeatableAncestor) {
      issues.push(...issuesForRepeatable(field, entries, options));
    } else {
      issuesForSingle(field, entries, options, issues);
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * A mandatory field with no repeatable ancestor: required whenever it is on
 * screen at all.
 *
 * Absent from `data` means the branch holding it is not mounted — the section is
 * in a different mode — so there is nothing to demand. That is rule 2, and it
 * relies on `mb-form.data` being built from the live element registry.
 */
function issuesForSingle(
  field: MandatoryField,
  entries: [string, unknown][],
  options: ValidateOptions,
  issues: ValidationIssue[],
): void {
  const matches = entries.filter(([key]) => unindex(key) === field.path);
  if (!matches.length) return;

  if (!matches.some(([, value]) => hasValue(value))) {
    issues.push({
      path: stripAttribute(matches[0][0]),
      label: field.label,
      sectionKey: options.sectionKeyFor?.(field.path),
    });
  }
}

/**
 * A mandatory field inside a repeatable: required once, and only once, the user
 * has started that occurrence (rule 1).
 *
 * "Started" means any key under the occurrence holds a value — including a
 * sibling field, which is the whole point: an entry with a criticality but no
 * substance is exactly the incomplete state the CDR would reject.
 */
function issuesForRepeatable(
  field: MandatoryField,
  entries: [string, unknown][],
  options: ValidateOptions,
): ValidationIssue[] {
  const ancestor = field.repeatableAncestor!;

  // occurrence prefix -> whether anything under it is filled in
  const started = new Map<string, boolean>();
  for (const [key, value] of entries) {
    const occurrence = occurrenceOf(key, ancestor);
    if (!occurrence) continue;
    started.set(occurrence, (started.get(occurrence) ?? false) || hasValue(value));
  }

  const issues: ValidationIssue[] = [];
  const ordered = [...started.keys()].sort();

  for (const occurrence of ordered) {
    if (!started.get(occurrence)) continue;

    // The field's path below the repeatable, re-attached to this occurrence.
    const suffix = field.path.slice(ancestor.length);
    const prefix = `${occurrence}${suffix}`;

    // A repeatable LEAF (manifestation:0, :1 …) is satisfied by any occurrence
    // of itself holding a value, so all of its indices are considered together.
    const own = entries.filter(([key]) => {
      const bare = stripAttribute(key);
      return bare === prefix || bare.startsWith(`${prefix}:`);
    });

    if (!own.length) continue;
    if (own.some(([, value]) => hasValue(value))) continue;

    issues.push({
      path: stripAttribute(own[0][0]),
      label: field.label,
      sectionKey: options.sectionKeyFor?.(field.path),
      entryNumber: entryNumberOf(occurrence),
    });
  }

  return issues;
}

/** 1-based position of the innermost occurrence, for "entry 2" in a message. */
function entryNumberOf(occurrence: string): number | undefined {
  const indices = [...occurrence.matchAll(/:(\d+)/g)].map((m) => Number(m[1]));
  const last = indices[indices.length - 1];
  return last === undefined ? undefined : last + 1;
}

/** One-line summary for the save banner. */
export function summarizeIssues(issues: ValidationIssue[]): string {
  if (!issues.length) return 'no missing mandatory fields';
  const labels = issues.map((i) =>
    i.entryNumber ? `${i.label} (entry ${i.entryNumber})` : i.label,
  );
  const unique = [...new Set(labels)];
  const shown = unique.slice(0, 3).join(', ');
  return unique.length > 3 ? `${shown} and ${unique.length - 3} more` : shown;
}

/**
 * The concrete, indexed paths of every mandatory control currently on screen.
 *
 * `mandatoryFields()` yields index-free template paths; the form binds
 * `…/adverse_reaction_risk:1/substance`. Rather than reconstructing every index
 * permutation, this reads the occurrences that actually exist out of the form's
 * own data — which is also the only way to cover the copies a repeatable clones
 * at runtime.
 *
 * Used to mark controls with a required indicator. It deliberately reports
 * every mandatory control, filled in or not: the asterisk states a rule of the
 * template and should not appear and disappear as the user types.
 */
export function requiredControlPaths(
  template: WebTemplate | undefined,
  data: Record<string, unknown>,
): string[] {
  const required = mandatoryFields(template);
  if (!required.length) return [];

  const keys = Object.keys(data).map(stripAttribute);
  const paths = new Set<string>();

  for (const field of required) {
    for (const key of keys) {
      // A repeatable leaf binds as `manifestation:0`; its unindexed identity is
      // what matches the template path.
      if (unindex(key) === field.path) paths.add(key);
    }
  }

  return [...paths];
}
