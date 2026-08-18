/**
 * FLAT-format helpers shared by the form, the seeding script and the tests.
 *
 * FLAT key grammar (as produced by EHRbase / consumed by mb-form):
 *   segment          eps_patient_summary/eps_allergies/...
 *   repeat index     adverse_reaction_risk:0/adverse_reaction_event:1/...
 *   attribute        ...|code  |value  |terminology  |id  |other  |name
 */

export const ROOT = 'eps_patient_summary';

/** Splits `path|attr` into its two parts. */
export function splitAttribute(key: string): { path: string; attribute?: string } {
  const i = key.lastIndexOf('|');
  if (i === -1) return { path: key };
  return { path: key.slice(0, i), attribute: key.slice(i + 1) };
}

/** Replaces every `:n` index with `:*` so keys can be compared structurally. */
export function normalizeIndices(key: string): string {
  return key.replace(/:\d+/g, ':*');
}

/** The `:n` indices in a key, outermost first. */
export function indicesOf(key: string): number[] {
  return [...key.matchAll(/:(\d+)/g)].map((m) => Number(m[1]));
}

/**
 * In-scope prefixes. All four clinical sections of `EPS Patient Summary` are
 * built (P6 Allergies + Problems, P7 Devices + Procedures); narrative,
 * workflow-id and container keys stay excluded — see OUT_OF_SCOPE_PATTERNS.
 */
export const IN_SCOPE_PREFIXES = [
  `${ROOT}/category`,
  `${ROOT}/language`,
  `${ROOT}/territory`,
  `${ROOT}/composer`,
  `${ROOT}/context/start_time`,
  `${ROOT}/context/setting`,
  `${ROOT}/eps_allergies/`,
  `${ROOT}/eps_problems/`,
  `${ROOT}/eps_medical_devices/`,
  `${ROOT}/eps_history_of_procedures/`,
];

/**
 * Keys that are in an in-scope section but out of scope for the form
 * (plan: narrative, workflow/guideline ids, container).
 */
export const OUT_OF_SCOPE_PATTERNS = [
  /fhir_narrative/,
  /_work_flow_id/,
  /_guideline_id/,
  /\/container\//,
];

export function isInScope(key: string): boolean {
  if (OUT_OF_SCOPE_PATTERNS.some((re) => re.test(key))) return false;
  return IN_SCOPE_PREFIXES.some((p) => key === p || key.startsWith(p) || key.startsWith(`${p}|`));
}

export function filterToScope(flat: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(flat).filter(([k]) => isInScope(k)));
}

export interface DiffBuckets {
  /** Present in expected, missing from actual. */
  lost: string[];
  /** Present in both, different value. */
  mangled: { key: string; expected: unknown; actual: unknown }[];
  /** Present in actual, absent from expected. */
  spurious: string[];
  /** Present in both with equal value. */
  matched: string[];
}

/**
 * The three-bucket comparison the plan's criterion C1 is scored on.
 * Values are compared as strings — FLAT is a string-valued format and EHRbase
 * is not consistent about numeric quoting.
 */
export function diffFlat(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): DiffBuckets {
  const buckets: DiffBuckets = { lost: [], mangled: [], spurious: [], matched: [] };

  for (const [key, want] of Object.entries(expected)) {
    if (!(key in actual)) {
      buckets.lost.push(key);
      continue;
    }
    const got = actual[key];
    if (String(want) === String(got)) buckets.matched.push(key);
    else buckets.mangled.push({ key, expected: want, actual: got });
  }

  for (const key of Object.keys(actual)) {
    if (!(key in expected)) buckets.spurious.push(key);
  }

  return buckets;
}

/**
 * Normalizes an `mb-form.export()` result into a payload EHRbase accepts.
 *
 * FINDING (criterion C3/C10): `mb-context` emits its keys *unprefixed*
 * (`category|code`) while every other mb-* element emits them rooted
 * (`eps_patient_summary/category|code`). A raw export therefore contains both
 * forms, and EHRbase rejects the unprefixed strays with
 *
 *   HTTP 400 Could not consume Parts [territory|code, language|terminology, ...]
 *
 * Dropping an unprefixed key is safe only when its rooted twin is present —
 * otherwise it is re-rooted, so no value is ever silently lost.
 */
export function normalizeExport(
  flat: Record<string, unknown>,
  root: string = ROOT,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const prefix = `${root}/`;

  for (const [key, value] of Object.entries(flat)) {
    if (key.startsWith(prefix)) {
      out[key] = value;
      continue;
    }
    const rooted = `${prefix}${key}`;
    // Prefer the already-rooted twin when Medblocks emitted both.
    if (!(rooted in flat)) out[rooted] = value;
  }

  return expandRootCodePhrases(out, root);
}

/**
 * `language` and `territory` are CODE_PHRASE at the composition root: EHRbase
 * requires `|code` + `|terminology`, never a bare scalar.
 *
 * Medblocks serializes the form-level `ctx` object verbatim, so setting
 * `ctx.territory = 'NL'` produces the bare key `eps_patient_summary/territory`
 * and EHRbase answers
 *
 *   HTTP 400 Could not consume Parts [eps_patient_summary/language, ...]
 *
 * Expanding here keeps `ctx` as the single place a deployment sets its
 * language/territory, which is the API Medblocks actually intends.
 */
function expandRootCodePhrases(
  flat: Record<string, unknown>,
  root: string,
): Record<string, unknown> {
  const CODE_PHRASES: Record<string, string> = {
    language: 'ISO_639-1',
    territory: 'ISO_3166-1',
  };

  const out = { ...flat };

  for (const [field, terminology] of Object.entries(CODE_PHRASES)) {
    const bare = `${root}/${field}`;
    if (!(bare in out)) continue;

    const value = out[bare];
    delete out[bare];
    if (value == null || value === '') continue;

    out[`${bare}|code`] ??= value;
    out[`${bare}|terminology`] ??= terminology;
  }

  // `composer` is a PARTY_PROXY, not a CODE_PHRASE: it needs `|name`, and a
  // bare `eps_patient_summary/composer` is rejected the same way.
  const composer = `${root}/composer`;
  if (composer in out) {
    const value = out[composer];
    delete out[composer];
    if (value != null && value !== '') out[`${composer}|name`] ??= value;
  }

  return out;
}

/**
 * Guarantees at least one occurrence of every repeatable the form declares.
 *
 * DEFECT (D-8): `mb-form.getCount()` returns 0 when a repeatable's path is
 * absent from the imported data, and `mb-repeatable-simple.render()` then
 * evaluates `[...Array(this.count - 1)]` — i.e. `Array(-1)` — which throws
 *
 *   RangeError: Invalid array length
 *
 * Every repeatable on the page crashes, so importing a composition that simply
 * has no allergies (or no problems) breaks the form. Seeding an empty `:0`
 * marker key keeps the count at 1 and costs nothing: an empty-valued key is
 * dropped by `serialize()`'s `hasValue()` filter and never reaches the CDR.
 */
export function ensureRepeatableOccurrences(
  flat: Record<string, unknown>,
  repeatablePaths: string[],
): Record<string, unknown> {
  const out = { ...flat };

  for (const path of repeatablePaths) {
    const present = Object.keys(out).some((k) => k.startsWith(`${path}:`));
    if (!present) out[`${path}:0`] = '';
  }

  return out;
}

/** Human-readable summary used by tests and the in-app report. */
export function summarizeDiff(d: DiffBuckets): string {
  return `matched ${d.matched.length} · lost ${d.lost.length} · mangled ${d.mangled.length} · spurious ${d.spurious.length}`;
}
