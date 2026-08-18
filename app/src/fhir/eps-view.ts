/**
 * Projecting an EPS document Bundle onto the EPS profile.
 *
 * `ips.ts` answered "what are the few clinically interesting fields here?".
 * This answers a different question — "what does this document actually say?"
 * — and the difference drives every choice below: EVERY coding rather than
 * `coding[0]`, full-precision dates rather than `dayOf`, every populated key
 * rather than a chosen handful, and the profile's whole section spine rather
 * than only the sections the mapping happened to emit.
 *
 * Pure, like `ips.ts`: a function of the Bundle and the static model, with no
 * DOM and no I/O, so the exhaustiveness claims above are unit-testable against
 * the real fixture rather than asserted in a comment.
 */

import type {
  CodeableConcept,
  Coding,
  FhirBundle,
  FhirResource,
  Reference,
} from './bundle';
import {
  EPS_COMPOSITION_ELEMENTS,
  EPS_SECTIONS,
  elementsFor,
  sectionSpecFor,
  type EpsElement,
  type EpsSectionSpec,
} from './eps-model';
import {
  codeText,
  deviceLabel,
  findComposition,
  indexBundle,
  resolveReference,
  type ResourceIndex,
} from './ips';

export interface Datapoint {
  label: string;
  /** The FHIR path this came from — also what the testid is built from. */
  path: string;
  /** Human text. Empty when the element is absent. */
  text: string;
  /** EVERY coding, not just `[0]`. */
  codings: Coding[];
  /** The verbatim JSON value, for the expandable raw cell. */
  raw: unknown;
  /**
   * Resolved target, when the element is a reference.
   *
   * `view` carries the target's OWN datapoints so a referenced resource is
   * rendered where it is referenced rather than reduced to its name. Without
   * it the fixture's hip implant appears only as the string "Ceramic hip
   * implant" and its UDI, lot number and expiry are nowhere on the page.
   */
  reference?: {
    display: string;
    resolved: boolean;
    target?: FhirResource;
    view?: ResourceView;
  };
  /** Repeats and backbone children — e.g. one group per `reaction`. */
  groups?: { label: string; datapoints: Datapoint[] }[];
  present: boolean;
}

export interface ResourceView {
  resourceType: string;
  /** One-line heading, reusing the existing label helpers. */
  title: string;
  datapoints: Datapoint[];
  /** Populated keys that no `EpsElement` claimed — the exhaustiveness backstop. */
  residual: Datapoint[];
}

export interface EpsSectionView {
  /** `undefined` for a document section that is not part of the profile. */
  spec?: EpsSectionSpec;
  title: string;
  code?: string;
  /** Whether the Composition actually carries this section. */
  present: boolean;
  resources: ResourceView[];
  unresolved: string[];
  /** `section.emptyReason` — a real assertion, and previously discarded. */
  emptyReason?: string;
  /**
   * `section.text.div`, captured but NEVER rendered as HTML: it is
   * server-supplied XHTML and would need sanitising first. The structured
   * datapoints carry the same information safely.
   */
  narrative?: string;
}

export interface EpsDocumentView {
  bundleMeta: Datapoint[];
  composition?: ResourceView;
  /** All 17 profile sections in order, with any extras appended. */
  sections: EpsSectionView[];
  /** Entries no section reached — how the loose Devices finally become visible. */
  orphans: ResourceView[];
}

/** Structural keys that are never a clinical datapoint. */
const NOISE_KEYS = new Set(['resourceType', 'id', 'meta', 'text', 'implicitRules', 'language']);

/**
 * The document, laid over the profile.
 *
 * The single entry point; everything else in this module serves it.
 */
export function epsDocumentView(bundle: FhirBundle | undefined): EpsDocumentView {
  // ONE index for the whole projection. The old view rebuilt it per table,
  // which was O(entries) work repeated per rendered group for no benefit.
  const index = indexBundle(bundle);
  const composition = findComposition(bundle);

  // Every resource a section or an inline reference reached. What is left over
  // at the end is, by definition, an orphan.
  const reached = new Set<FhirResource>();
  if (composition) reached.add(composition);

  const sections = buildSections(composition, index, reached);

  return {
    bundleMeta: bundleMeta(bundle),
    composition: composition
      ? resourceView(composition, index, reached, EPS_COMPOSITION_ELEMENTS, ['section'])
      : undefined,
    sections,
    orphans: orphansOf(bundle, index, reached),
  };
}

/**
 * The Bundle's own header.
 *
 * Not decoration: `identifier` and `timestamp` identify this exact document
 * instance, and `meta.profile` is what says which profile it claims to be —
 * the previous view showed none of the three.
 */
function bundleMeta(bundle: FhirBundle | undefined): Datapoint[] {
  if (!bundle) return [];

  return [
    datapointOf({ path: 'id', label: 'Bundle id', kind: 'string' }, bundle.id),
    datapointOf({ path: 'type', label: 'Type', kind: 'string' }, bundle.type),
    datapointOf({ path: 'timestamp', label: 'Timestamp', kind: 'date' }, bundle.timestamp),
    datapointOf({ path: 'identifier', label: 'Identifier', kind: 'string' }, bundle.identifier),
    datapointOf({ path: 'meta.profile', label: 'Profile', kind: 'string' }, bundle.meta?.profile),
  ];
}

/**
 * The 17 profile sections, plus anything the document carries that they do not
 * describe.
 *
 * Iterating the SPEC rather than the document is the whole point: a section
 * the mapping never emitted has to appear as "not present", because that is a
 * fact about the document a reader needs, and it is invisible in a view that
 * only renders what it was given.
 */
function buildSections(
  composition: FhirResource | undefined,
  index: ResourceIndex,
  reached: Set<FhirResource>,
): EpsSectionView[] {
  const documentSections =
    (composition?.section as DocumentSection[] | undefined) ?? [];

  // Matched by identity so two sections carrying the same code cannot both
  // claim the same spec slot and then look like one section.
  const claimed = new Set<DocumentSection>();

  const spine = EPS_SECTIONS.map((spec) => {
    const match = documentSections.find(
      (section) =>
        !claimed.has(section) && sectionSpecFor(sectionCode(section), section.title) === spec,
    );
    if (match) claimed.add(match);

    return match
      ? sectionView(spec, match, index, reached)
      : {
          spec,
          title: spec.title,
          code: spec.code,
          present: false,
          resources: [],
          unresolved: [],
        };
  });

  // A section the profile does not describe is still something the document
  // asserted — appended rather than dropped.
  const extras = documentSections
    .filter((section) => !claimed.has(section))
    .map((section) => sectionView(undefined, section, index, reached));

  return [...spine, ...extras];
}

interface DocumentSection {
  title?: string;
  code?: CodeableConcept;
  entry?: Reference[];
  emptyReason?: CodeableConcept;
  text?: { div?: string };
}

function sectionCode(section: DocumentSection): string | undefined {
  return section.code?.coding?.find((coding) => coding.code)?.code;
}

function sectionView(
  spec: EpsSectionSpec | undefined,
  section: DocumentSection,
  index: ResourceIndex,
  reached: Set<FhirResource>,
): EpsSectionView {
  const resources: ResourceView[] = [];
  const unresolved: string[] = [];

  for (const reference of section.entry ?? []) {
    const target = resolveReference(index, reference);
    if (target) {
      reached.add(target);
      resources.push(resourceView(target, index, reached));
    } else if (reference.display) {
      unresolved.push(reference.display);
    } else if (reference.reference) {
      unresolved.push(reference.reference);
    }
  }

  return {
    spec,
    title: section.title ?? spec?.title ?? 'Untitled section',
    code: sectionCode(section) ?? spec?.code,
    present: true,
    resources,
    unresolved,
    emptyReason: section.emptyReason ? codeText(section.emptyReason) : undefined,
    narrative: section.text?.div,
  };
}

/**
 * Entries no section and no inline reference reached.
 *
 * The fixture's three Devices are exactly this case: two are reachable only
 * through `Procedure.focalDevice`/`usedReference`, and under the old view all
 * three were invisible. A resource reached transitively is NOT an orphan — it
 * is already rendered inline where it was referenced.
 */
function orphansOf(
  bundle: FhirBundle | undefined,
  index: ResourceIndex,
  reached: Set<FhirResource>,
): ResourceView[] {
  const orphans: ResourceView[] = [];

  for (const entry of bundle?.entry ?? []) {
    const resource = entry?.resource;
    if (!resource || reached.has(resource)) continue;

    reached.add(resource);
    orphans.push(resourceView(resource, index, reached));
  }

  return orphans;
}

/**
 * One resource as an ordered list of datapoints, plus whatever the model missed.
 *
 * `skipKeys` exists for the Composition, whose `section` is rendered as the
 * page's own structure and would otherwise be repeated verbatim as a residual.
 */
function resourceView(
  resource: FhirResource,
  index: ResourceIndex,
  reached: Set<FhirResource>,
  elements: readonly EpsElement[] = elementsFor(resource.resourceType),
  skipKeys: readonly string[] = [],
  expanding: Set<FhirResource> = new Set(),
): ResourceView {
  const consumed = new Set<string>([...NOISE_KEYS, ...skipKeys]);
  // Every resource on the current expansion path, so a reference back into it
  // stops at a label instead of recursing.
  const nested = new Set(expanding).add(resource);

  const datapoints = elements.map((element) => {
    const { key, value } = readElement(resource, element.path);
    if (key) consumed.add(key);
    return datapointOf(element, value, index, reached, nested);
  });

  // Anything populated that no element claimed. This is what makes the viewer
  // exhaustive even where the static model is behind the data.
  const residual = Object.keys(resource)
    .filter((key) => !consumed.has(key) && isPresent(resource[key]))
    .map((key) =>
      datapointOf(
        { path: key, label: humaniseKey(key), kind: 'string' },
        resource[key],
        index,
        reached,
        nested,
      ),
    );

  return {
    resourceType: resource.resourceType,
    title: resourceTitle(resource),
    datapoints,
    residual,
  };
}

/**
 * Reads one element path off a resource, resolving `[x]` choices.
 *
 * A choice element is stored under a TYPE-SUFFIXED key — `onsetDateTime`,
 * `onsetPeriod`, `medicationCodeableConcept` — so `onset[x]` has to match by
 * prefix. Reading `resource['onset[x]']` finds nothing, silently, which is
 * exactly how a mapped onset date would vanish from the view.
 *
 * Returns the key that was consumed, so the residual pass knows not to list it
 * again under its raw name.
 */
function readElement(
  resource: FhirResource,
  path: string,
): { key?: string; value: unknown } {
  const dot = path.indexOf('.');
  if (dot >= 0) {
    // Nested paths are read by the backbone walk, not from the resource root.
    return { value: undefined };
  }

  if (!path.endsWith('[x]')) {
    return { key: path, value: resource[path] };
  }

  const stem = path.slice(0, -3);
  const key = Object.keys(resource).find(
    (candidate) =>
      candidate === stem ||
      (candidate.startsWith(stem) && candidate.length > stem.length && isTypeSuffix(candidate, stem)),
  );

  return key ? { key, value: resource[key] } : { value: undefined };
}

/**
 * Whether `candidate` is `stem` plus a FHIR type suffix.
 *
 * The capital-letter test matters: without it `onset[x]` would also swallow
 * `onsetAgeless`-style siblings, and — the real case — `performed[x]` on a
 * Procedure would be free to match any key merely beginning with "performed".
 */
function isTypeSuffix(candidate: string, stem: string): boolean {
  const suffix = candidate.slice(stem.length);
  return suffix.length > 0 && suffix[0] === suffix[0].toUpperCase();
}

/** Builds the rendered form of one value, whatever shape it arrived in. */
function datapointOf(
  element: EpsElement,
  value: unknown,
  index?: ResourceIndex,
  reached?: Set<FhirResource>,
  expanding?: Set<FhirResource>,
): Datapoint {
  const base: Datapoint = {
    label: element.label,
    path: element.path,
    text: '',
    codings: [],
    raw: value,
    present: isPresent(value),
  };

  if (!base.present) return base;

  if (element.kind === 'backbone' || (element.children?.length ?? 0) > 0) {
    return { ...base, ...backboneOf(element, value, index, reached, expanding) };
  }

  if (element.kind === 'reference') {
    return { ...base, ...referenceOf(value, index, reached, expanding) };
  }

  return { ...base, text: textOf(value), codings: codingsOf(value) };
}

/**
 * A backbone element — one group per repeat.
 *
 * Rendered as groups rather than flattened to a string because the grouping is
 * the information: two reactions with two manifestations each say something a
 * comma-joined list of four manifestations does not.
 */
function backboneOf(
  element: EpsElement,
  value: unknown,
  index?: ResourceIndex,
  reached?: Set<FhirResource>,
  expanding?: Set<FhirResource>,
): Partial<Datapoint> {
  const repeats = asArray(value);
  const children = element.children ?? [];

  const groups = repeats.map((repeat, position) => {
    const label = repeats.length > 1 ? `${element.label} ${position + 1}` : element.label;

    if (!isRecord(repeat)) {
      // A repeat that is a bare value (a `given` name, a `category` code)
      // still has to render, so it becomes a one-datapoint group.
      return {
        label,
        datapoints: [
          datapointOf({ path: element.path, label: element.label, kind: 'string' }, repeat),
        ],
      };
    }

    const datapoints = children.map((child) => {
      const { value: childValue } = readElement(repeat as FhirResource, child.path);
      return datapointOf(child, childValue, index, reached, expanding);
    });

    // Children the model does not name are appended so a backbone is as
    // exhaustive as the resource level is.
    const named = new Set(
      children.map((child) => child.path.replace(/\[x\]$/, '')),
    );
    const extra = Object.keys(repeat)
      .filter(
        (key) =>
          !NOISE_KEYS.has(key) &&
          isPresent((repeat as Record<string, unknown>)[key]) &&
          ![...named].some((stem) => key === stem || key.startsWith(stem)),
      )
      .map((key) =>
        datapointOf(
          { path: `${element.path}.${key}`, label: humaniseKey(key), kind: 'string' },
          (repeat as Record<string, unknown>)[key],
          index,
          reached,
          expanding,
        ),
      );

    return { label, datapoints: [...datapoints, ...extra] };
  });

  return { text: summaryOf(value), groups };
}

/**
 * A reference, resolved against the Bundle where possible — and EXPANDED.
 *
 * Marking the target as reached here is what keeps `DeviceUseStatement.device`
 * from ALSO appearing in the orphans block. That is only defensible because
 * the target is genuinely rendered here, as its own nested `ResourceView`:
 * suppressing it from the orphans while showing nothing but its name would
 * lose the resource entirely, which is the bug this whole view exists to fix.
 */
function referenceOf(
  value: unknown,
  index?: ResourceIndex,
  reached?: Set<FhirResource>,
  expanding?: Set<FhirResource>,
): Partial<Datapoint> {
  const references = asArray(value).filter(isRecord) as Reference[];

  const targets = references.map((reference) => ({
    reference,
    target: index ? resolveReference(index, reference) : undefined,
  }));

  for (const { target } of targets) if (target) reached?.add(target);

  const labelFor = ({ reference, target }: (typeof targets)[number]) =>
    (target && (deviceLabel(target) || resourceTitle(target))) ||
    reference.display ||
    reference.reference ||
    '';

  const first = targets[0];
  const target = first?.target;

  return {
    text: targets.map(labelFor).filter(Boolean).join(', '),
    reference: {
      display: first ? labelFor(first) : '',
      resolved: Boolean(target),
      target,
      // `expanding` breaks a reference CYCLE. Two resources that reference
      // each other — a Patient and its generalPractitioner PractitionerRole,
      // say — would otherwise recurse until the stack gives out.
      view:
        target && index && !expanding?.has(target)
          ? resourceView(target, index, reached ?? new Set(), undefined, [], expanding)
          : undefined,
    },
  };
}

/**
 * Every coding on the value, flattened across repeats.
 *
 * The `[0]`-only behaviour this replaces was a real loss, not a theoretical
 * one: the fixture's `Condition.clinicalStatus` carries four codings and the
 * old view rendered exactly one of them.
 */
function codingsOf(value: unknown): Coding[] {
  return asArray(value)
    .filter(isRecord)
    .flatMap((item) => ((item as CodeableConcept).coding ?? []) as Coding[])
    .filter((coding) => coding.system || coding.code || coding.display);
}

/** Human text for a scalar, a CodeableConcept, or a repeat of either. */
function textOf(value: unknown): string {
  return asArray(value).map(scalarText).filter(Boolean).join(', ');
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (isRecord(value)) {
    const record = value as Record<string, unknown>;

    // Ordered by how directly each names the value, not by frequency: `text`
    // is what the source system chose to call it, and a coding display is a
    // terminology's name for it.
    const concept = codeText(record as CodeableConcept);
    if (concept) return concept;

    // A Period is BOTH ends. Falling through to the `start`-only branch below
    // silently drops the end date — which is how the fixture's device timing
    // would render as an open-ended implant that was in fact explanted.
    if (typeof record.start === 'string' || typeof record.end === 'string') {
      return [record.start, record.end].filter(Boolean).join(' → ');
    }

    for (const key of ['value', 'display', 'name', 'reference']) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate) return candidate;
    }
  }

  return '';
}

/** A one-line stand-in for a backbone, shown before the groups are expanded. */
function summaryOf(value: unknown): string {
  const repeats = asArray(value);
  const text = repeats.map(scalarText).filter(Boolean).join(', ');
  if (text) return text;

  // A count rather than '' even for a single repeat. Falling through to the
  // empty string renders the row as `—`, i.e. as ABSENT — directly above the
  // children that prove it is not (`udiCarrier` is the case in the fixture).
  if (!repeats.length) return '';
  return repeats.length === 1 ? '1 entry' : `${repeats.length} entries`;
}

/**
 * The heading for a resource card.
 *
 * `deviceLabel` first for a Device, whose name lives on `deviceName[]` rather
 * than on `code`, and which would otherwise head its own card as "Device".
 */
function resourceTitle(resource: FhirResource): string {
  const named =
    deviceLabel(resource) ||
    codeText(resource.code as CodeableConcept) ||
    codeText(resource.type as CodeableConcept) ||
    codeText(resource.vaccineCode as CodeableConcept) ||
    codeText(resource.medicationCodeableConcept as CodeableConcept) ||
    (resource.title as string) ||
    (resource.name as string) ||
    '';

  return typeof named === 'string' && named ? named : resource.resourceType;
}

/**
 * Whether a value counts as recorded.
 *
 * An empty array and an empty object are ABSENT, not present-but-blank: a
 * mapping that emits `"note": []` has said nothing, and rendering it as a
 * populated field would overstate the document.
 */
function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(isPresent);
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function asArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `lastOccurrence` → `Last occurrence`, for keys the model never named. */
function humaniseKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
