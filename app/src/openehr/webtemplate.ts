/**
 * Web-template lookup: what shape is a field, really?
 *
 * The plan's P7 rule, made mechanical: *derive the control from the web
 * template's* value *child, never from the field name*. `body_site` is the
 * standing proof that the name tells you nothing — the same identifier is three
 * different fields across this one template:
 *
 *   eps_problems/…/body_site:0                     DV_CODED_TEXT, repeatable
 *   eps_history_of_procedures/…/body_site:0        DV_TEXT,       repeatable
 *   eps_medical_devices/…/device_details:0/body_site   DV_TEXT,   single
 *
 * Rendering the Procedures one as `mb-search` because Problems' is coded emits
 * |code/|terminology attributes the CDR rejects. Rendering the Problems one as
 * `mb-input` silently downgrades a DV_CODED_TEXT to DV_TEXT — no error, just a
 * composition that has lost its coding.
 *
 * `describeField()` answers that question from the template itself, so the
 * forms never have to hardcode the answer.
 */

export interface WebTemplateNode {
  id?: string;
  rmType?: string;
  max?: number;
  min?: number;
  name?: string;
  localizedName?: string;
  nodeId?: string;
  children?: WebTemplateNode[];
  inputs?: { suffix?: string; type?: string; list?: { value: string; label?: string }[] }[];
}

export interface WebTemplate {
  templateId?: string;
  tree?: WebTemplateNode;
}

/**
 * RM housekeeping children that sit alongside the real `value` child on every
 * ELEMENT. They must be skipped when looking for the discriminating type.
 */
const RM_SIBLINGS = new Set(['null_flavour', 'name', 'feeder_audit', 'archetype_details', 'links', 'uid']);

export interface FieldShape {
  /** The RM type of the ELEMENT's `value` child — the discriminating type. */
  valueType?: string;
  /** True when the field itself (not its value) may repeat: `max === -1`. */
  repeatable: boolean;
  /** Archetype node id (`at0002`, `openEHR-EHR-…`) — shown as the mockup's archetype label. */
  nodeId?: string;
  /** The template's own label for the field. */
  label?: string;
  /** Local code list, when the value child constrains one. */
  options?: { code: string; label: string }[];
}

/**
 * Walks a FLAT-style path (`eps_allergies/adverse_reaction_risk/substance`,
 * indices optional) from a template root and returns the node it names.
 *
 * Indices are stripped: `:0` is a FLAT-level occurrence marker, and the web
 * template has one node per path regardless of how many times it may occur.
 */
export function findNode(root: WebTemplateNode | undefined, path: string): WebTemplateNode | undefined {
  if (!root) return undefined;

  const segments = path
    .split('/')
    .map((s) => s.replace(/:\d+$/, ''))
    .filter(Boolean);

  let node: WebTemplateNode | undefined = root;
  for (const segment of segments) {
    // The template root carries the template id as its own `id`; a path that
    // starts at the root repeats it, so consume it rather than descend into it.
    if (node?.id === segment) continue;
    node = (node?.children ?? []).find((c) => c.id === segment);
    if (!node) return undefined;
  }
  return node;
}

/**
 * The shape of the field a FLAT path names.
 *
 * `path` may be root-absolute (`eps_patient_summary/…`) or section-relative —
 * the root segment is consumed by `findNode` either way.
 */
export function describeField(template: WebTemplate | undefined, path: string): FieldShape | undefined {
  const node = findNode(template?.tree, path);
  if (!node) return undefined;

  // ELEMENT nodes carry the real type on their `value` child (memory: "the
  // discriminating DV type is on the value child, not the field node"). Nodes
  // that are already a DV_* type describe themselves.
  const valueChild = (node.children ?? []).find((c) => c.id === 'value' && !RM_SIBLINGS.has(c.id ?? ''));
  const typed = valueChild ?? (node.rmType?.startsWith('DV_') ? node : undefined);

  return {
    valueType: typed?.rmType,
    repeatable: node.max === -1,
    nodeId: node.nodeId,
    label: node.localizedName ?? node.name ?? node.id,
    options: localCodeList(typed),
  };
}

/**
 * The archetype-local code list a DV_CODED_TEXT constrains, if any.
 *
 * The list lives on the `defining_code` child's `code` input, which is where
 * the template puts `at*` terms. Terminology-server-backed fields have no list
 * and fall through to `undefined` — those need `mb-search`, not `mb-select`.
 */
function localCodeList(node: WebTemplateNode | undefined): { code: string; label: string }[] | undefined {
  if (!node) return undefined;

  const carriers = [node, ...(node.children ?? []).filter((c) => c.id === 'defining_code')];
  for (const carrier of carriers) {
    const list = carrier.inputs?.find((i) => i.suffix === 'code' || i.type === 'CODED_TEXT')?.list;
    if (list?.length) return list.map((o) => ({ code: o.value, label: o.label ?? o.value }));
  }
  return undefined;
}

/** True when a path's value child is DV_CODED_TEXT — i.e. it needs a coded control. */
export function isCoded(template: WebTemplate | undefined, path: string): boolean {
  return describeField(template, path)?.valueType === 'DV_CODED_TEXT';
}

/* ------------------------------------------------------------------------- *
 * Mandatory fields (min >= 1)
 * ------------------------------------------------------------------------- */

/**
 * Structural RM containers that exist in the web template but are ELIDED from
 * FLAT paths.
 *
 * This is the difference that makes a naive implementation find nothing at all.
 * The template nests the substance ELEMENT as
 *
 *   eps_allergies/adverse_reaction_risk/tree/substance
 *
 * while the FLAT key the form actually binds — and the CDR actually stores — is
 *
 *   eps_allergies/adverse_reaction_risk:0/substance
 *
 * The ITEM_TREE segment is gone. `findNode()` above walks template paths, so it
 * returns `undefined` for every FLAT path the form uses; a validator built on it
 * would report zero mandatory fields and pass every empty form silently — the
 * exact failure mode this feature exists to remove.
 *
 * The segment is not reliably named `tree`, either: problem_diagnosis calls its
 * ITEM_TREE `structure`, and medical_device_summary has both `tree` and `tree2`.
 * So they are recognised by rmType, never by id.
 */
const STRUCTURAL_RM_TYPES = new Set([
  'ITEM_TREE',
  'ITEM_LIST',
  'ITEM_TABLE',
  'ITEM_SINGLE',
  'ITEM_STRUCTURE',
  'HISTORY',
  'EVENT',
  'POINT_EVENT',
  'INTERVAL_EVENT',
]);

/**
 * RM attributes that are mandatory in the reference model but are never a
 * user-facing field: the CDR supplies them, `ensureMandatoryContext()` stamps
 * them, or they are pure housekeeping.
 *
 * `language`, `territory` and `category` are mandatory at the COMPOSITION root
 * and are genuinely required — but they come from `mb-form.ctx` and are
 * guaranteed at export time, so asking a clinician to fill them in would be
 * demanding something the form already knows.
 */
const NON_FIELD_RM_ATTRIBUTES = new Set([
  'null_flavour',
  'name',
  'feeder_audit',
  'archetype_details',
  'archetype_node_id',
  'links',
  'uid',
  'encoding',
  'subject',
  'provider',
  'other_participations',
  'language',
  'territory',
  'category',
  'composer',
  'context',
  'math_function',
  'width',
  'time',
  'origin',
]);

/**
 * Branches that are structurally mandatory but out of the form's scope, mirroring
 * `OUT_OF_SCOPE_PATTERNS` in `flat.ts`. `fhir_narrative` is the live case: its
 * `narrative` and `status` children are both min=1, so including it would
 * demand two fields the form deliberately does not render and can never satisfy.
 */
const OUT_OF_SCOPE_SEGMENTS = [
  /^container$/,
  /^fhir_narrative$/,
  /^_/,
  /^activity_id$/,
  /^instruction_id$/,
  /**
   * ACTION state machinery, not clinical input. The RAW template declares
   * `careflow_step` and `current_state` as min=1 and repeats the whole block
   * seven times (`ism_transition`, `ism_transition2`, … `ism_transition7`), one
   * per pathway state — so including it would put fourteen unfixable required
   * fields on Procedures for a state EHRbase sets itself. The simplified
   * template EHRbase serves does not mark them mandatory at all; excluding it
   * is what makes the two shapes agree.
   */
  /^ism_transition\d*$/,
];

/** One field the template says must be filled in. */
export interface MandatoryField {
  /**
   * FLAT path with structural segments elided and NO occurrence indices —
   * `eps_patient_summary/eps_allergies/adverse_reaction_risk/substance`.
   * Indices are added per-occurrence at validation time.
   */
  path: string;
  /** The template's own label, used verbatim in the error message. */
  label: string;
  /** RM type of the value child, for message wording and control mapping. */
  valueType?: string;
  /**
   * The nearest repeatable ancestor's path, if any.
   *
   * This is what makes the requirement CONDITIONAL. `substance` is mandatory
   * *within an adverse_reaction_risk*, not on the form as a whole — a
   * composition with no allergies at all is perfectly valid. Validation
   * therefore only demands it for occurrences the user actually started.
   */
  repeatableAncestor?: string;
}

/**
 * Every field the template marks `min >= 1`, keyed by FLAT path.
 *
 * TWO TRAPS ARE HANDLED HERE, both of which produce a validator that is worse
 * than none at all if missed.
 *
 * 1. CHOICE ALTERNATIVES. An ELEMENT with several typed `*_value` children is a
 *    CHOICE: `onset_of_first_reaction` offers date_time_value, duration_value,
 *    text_value and two interval flavours — and EVERY ONE of them is min=1,
 *    because each means "if you pick this alternative, it must have a value".
 *    Descending into them would emit five separate requirements for one
 *    optional field, none of which can be satisfied together. The walk
 *    therefore STOPS at the ELEMENT and reports the ELEMENT's own min, which is
 *    0 for that field — correctly optional.
 *
 * 2. STRUCTURAL SEGMENTS. See `STRUCTURAL_RM_TYPES` — the emitted path omits
 *    them so it matches the FLAT keys the form and the CDR use.
 *
 * Verified against the committed fixture: 15 mandatory ELEMENTs, all 15 of
 * which match keys present in the golden FLAT composition.
 */
export function mandatoryFields(template: WebTemplate | undefined): MandatoryField[] {
  const root = template?.tree;
  if (!root) return [];

  const found: MandatoryField[] = [];

  const walk = (node: WebTemplateNode, flatPath: string, repeatableAncestor?: string): void => {
    for (const child of node.children ?? []) {
      const id = child.id;
      if (!id || NON_FIELD_RM_ATTRIBUTES.has(id)) continue;
      if (OUT_OF_SCOPE_SEGMENTS.some((re) => re.test(id))) continue;

      // Structural containers contribute nothing to a FLAT path (raw form only;
      // the simplified form has already removed them).
      const structural = STRUCTURAL_RM_TYPES.has(child.rmType ?? '');
      const path = structural ? flatPath : `${flatPath}/${id}`;
      const ancestor = child.max === -1 && !structural ? path : repeatableAncestor;

      if (isLeafField(child)) {
        if ((child.min ?? 0) >= 1) {
          found.push({
            path,
            label: child.localizedName || child.name || id,
            valueType: leafValueType(child),
            // A repeatable leaf is scoped by its ANCESTOR, not by itself: its
            // own occurrences are alternatives, any one of which satisfies it.
            repeatableAncestor: child.max === -1 ? repeatableAncestor : ancestor,
          });
        }
        // Trap 1: never descend into a leaf's CHOICE alternatives.
        continue;
      }

      walk(child, path, ancestor);
    }
  };

  walk(root, root.id ?? '');
  return found;
}

/**
 * Whether a node is a field the user fills in, rather than a container to
 * descend into.
 *
 * THIS IS WHERE THE TWO WEB-TEMPLATE FORMATS ARE RECONCILED, and getting it
 * wrong yields a validator that silently finds nothing.
 *
 * The committed fixture (generated by `tools/webtemplate-gen`) is the RAW form:
 *
 *   adverse_reaction_risk/tree/substance      rmType ELEMENT
 *     └── value                               rmType DV_CODED_TEXT   <- the type
 *
 * EHRbase's `/webtemplate` endpoint returns the SIMPLIFIED form, which is what
 * the running app actually gets:
 *
 *   adverse_reaction_risk/substance           rmType DV_CODED_TEXT   <- the type
 *
 * The ITEM_TREE wrapper is gone and the DV type is hoisted onto the field node
 * itself. A walk that only recognises `rmType === 'ELEMENT'` therefore matches
 * every node in the fixture and NOT ONE in production — the form would mark
 * nothing required and pass every empty composition straight to the 422 this
 * feature exists to prevent. It is caught by a test running against each shape.
 *
 * A node is a leaf when it is an ELEMENT (raw form) or is itself a DV_* type
 * (simplified form). In BOTH shapes the CHOICE alternatives sit BELOW that
 * node, so stopping here is what keeps `onset_of_first_reaction` — optional,
 * with five min=1 alternatives — from becoming five impossible requirements.
 */
function isLeafField(node: WebTemplateNode): boolean {
  return node.rmType === 'ELEMENT' || (node.rmType?.startsWith('DV_') ?? false);
}

/** The DV type of a leaf, from whichever of the two shapes it is in. */
function leafValueType(node: WebTemplateNode): string | undefined {
  if (node.rmType?.startsWith('DV_')) return node.rmType;
  return (node.children ?? []).find((c) => !NON_FIELD_RM_ATTRIBUTES.has(c.id ?? ''))?.rmType;
}
