/**
 * The composition form — an `mb-form` host with a card per clinical section and
 * a sticky save footer.
 *
 * Three things here are load-bearing and easy to break:
 *
 * 1. LIGHT DOM. `createRenderRoot()` returns `this` so `mb-form` can discover
 *    its slotted children. Inside a Lit 3 shadow root the slot traversal in
 *    `handleSlotChange` finds nothing and the whole form binds zero fields.
 *    Consequently `static styles` would be dropped — all CSS is in
 *    `src/styles/views.css`, scoped under `eps-composition-form`.
 *
 * 2. `ensureSearchHandlers()` on EVERY render. `mb-form` propagates
 *    `handleSearch` through a one-shot watcher, so late-connecting children —
 *    which is all of them, plus every copy a repeatable creates — never receive
 *    it. Skip this and all terminology search is dead, with a misleading
 *    "An unexpected error occurred" as the only symptom.
 *
 * 3. `.ctx` bound as a PROPERTY, never an attribute. As an attribute Lit 1
 *    `JSON.parse`s the string and throws. And `ctx` is the only thing that
 *    overrides Medblocks' hardcoded `territory || 'IN'` default — a Dutch
 *    deployment that misses it files every composition under India, silently.
 *
 * The sections come from `forms/registry`, keyed by the route's template id.
 * They used to be a constant list, which meant any template id in the URL got
 * EPS Patient Summary's fields — binding EPS paths against a foreign template
 * and producing a form that looks complete but cannot save correctly. A
 * template with no registered form is now refused outright.
 */

import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import 'medblocks-ui';

import { contextFields, FORM_CTX } from '../forms/context';
import { nowLocalIso } from '../auth/session';
import {
  getTemplateForm,
  recordableTemplateIds,
  type FormSection,
  type TemplateForm,
} from '../forms/registry';
import {
  branchHasData,
  inferMode,
  type SectionMode,
} from '../forms/section-shell';
import { handleSearch } from '../terminology/handleSearch';
import { applyRepeatableStyles, ensureRepeatableStyles } from '../forms/repeatable-styles';
import {
  ensureSearchHandlers,
  importComposition,
  exportComposition,
  type MbForm,
} from '../openehr/medblocks';
import { ROOT } from '../openehr/flat';
import {
  validateMandatory,
  summarizeIssues,
  requiredControlPaths,
  type ValidationIssue,
} from '../openehr/validation';
import type { WebTemplate } from '../openehr/webtemplate';
import './save-pipeline-panel';
import {
  STEPS,
  countBundleResources,
  dwell,
  initialStates,
  withState,
  type RunFacts,
  type StepKey,
  type StepState,
} from './save-pipeline';
import {
  getComposition,
  getCompositionCanonical,
  postComposition,
  updateComposition,
  listTemplates,
  getWebTemplate,
  type FlatComposition,
} from '../openehr/client';
import { toFhir, storeBundle } from '../fhir/bundle';
import { getPatientEhr } from '../fhir/client';
import type { PatientView } from '../fhir/patient';
import { navigate } from '../shell';

/** A step's configured dwell time, from the single source of truth in STEPS. */
function stepDwell(key: StepKey): number {
  return STEPS.find((s) => s.key === key)?.dwellMs ?? 0;
}

@customElement('eps-composition-form')
export class EpsCompositionForm extends LitElement {
  /** Light DOM — mandatory for mb-form slotting. See the class comment. */
  createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) patientId = '';
  @property({ attribute: false }) patient?: PatientView;
  /** Composition uid, or 'new' for a blank form. */
  @property({ attribute: false }) uid = '';
  @property({ attribute: false }) templateId = '';

  @state() private ehrId = '';
  @state() private status = '';
  @state() private statusKind: 'info' | 'error' | 'success' | 'warning' = 'info';
  @state() private detail = '';
  @state() private busy = false;
  @state() private loaded = false;

  /** Pipeline modal state — see `views/save-pipeline`. */
  @state() private pipelineOpen = false;
  @state() private stepStates: Record<StepKey, StepState> = initialStates();
  @state() private run: RunFacts = { templateId: '', ehrId: '' };

  /**
   * Which of the three branches each section shows — see `forms/section-shell`.
   *
   * This lives here rather than in the sections because unmounting a branch is
   * what keeps contradictory data out of `export()`, and only a stateful host
   * can drive that. Sections default to 'entries' so a new composition opens on
   * the fields a user most often wants, and so the e2e formReady() threshold of
   * >20 bound elements still holds.
   */
  @state() private sectionModes: Record<string, SectionMode> = {};

  /**
   * The web template, fetched at runtime — the source of truth for which fields
   * are mandatory. Nothing hardcodes that list: `min >= 1` is read from the OPT
   * the CDR itself validates against, so the form and EHRbase cannot disagree.
   */
  @state() private webTemplate?: WebTemplate;

  /**
   * Missing mandatory fields, keyed by the indexed FLAT path of each control.
   *
   * Empty until the user tries to save. Validating from the first keystroke
   * would paint a blank form red before anyone has typed anything, which is
   * noise rather than feedback; after a rejected save it updates live, so a
   * field clears as soon as it is filled in.
   */
  @state() private issues: ValidationIssue[] = [];

  /** True once a save has been blocked — what turns on live re-validation. */
  @state() private validationAttempted = false;

  /** When this form was opened — stamped as the composition's start_time. */
  private startTime = nowLocalIso();
  /** Guards against re-importing the same composition on every render. */
  private importedUid = '';
  /**
   * The uid of a composition saved but not yet navigated to. The route change
   * waits for the panel to close, so this holds it in the meantime.
   */
  private savedUid = '';

  connectedCallback(): void {
    super.connectedCallback();
    void this.prepare();

    // Medblocks controls hold their value on `.data` and announce a change with
    // `mb-input`; they do not write to a property of THIS component, so Lit has
    // no reason to re-render and `updated()` never runs. Without this listener
    // the marks are computed once and then frozen: a field stays red after the
    // user has filled it in, which trains them to ignore the marking entirely.
    this.addEventListener('mb-input', this.onFieldInput);

    // D-10, second half. Clicking "add" on a repeatable runs `this.count++`
    // inside mb-repeatable-simple and nothing else — no property of THIS
    // component changes, so Lit never re-renders and the `updated()` hook below
    // never fires for the new occurrence. The copy is cloned from
    // `slotNode.outerHTML`, so it cannot inherit `handleSearch` either, and
    // mb-form's own `handleChildConnect` assigns only `mbForm` and `variant`.
    // `mb-connect` bubbles and is composed, so it is the one signal that does
    // reach us for a freshly added mb-search.
    this.addEventListener('mb-connect', this.onChildConnect);

    // D-11. A repeatable that connects outside our render pass — a nested one
    // created inside a copy, for instance — would otherwise wait for the next
    // `updated()` to be styled, showing one unstyled frame. `Repeatable` emits
    // this from its own `connectedCallback` and it bubbles composed.
    this.addEventListener('mb-connect-repeatable', this.onRepeatableConnect);
  }

  disconnectedCallback(): void {
    this.removeEventListener('mb-input', this.onFieldInput);
    this.removeEventListener('mb-connect', this.onChildConnect);
    this.removeEventListener('mb-connect-repeatable', this.onRepeatableConnect);
    super.disconnectedCallback();
  }

  /**
   * Re-renders on any field change, so validation marks stay current.
   *
   * Only after a save has been refused: before that there is nothing marked,
   * and re-rendering the whole form on every keystroke would be pure cost.
   */
  private readonly onFieldInput = (): void => {
    if (this.validationAttempted) this.requestUpdate();
  };

  /**
   * Wires `handleSearch` onto elements that appear without a re-render of this
   * component — every occurrence a repeatable adds after the first.
   *
   * `mb-connect` fires from the child's `connectedCallback`, so the emitting
   * element is `composedPath()[0]` and is wired directly rather than by
   * re-scanning: at this point it may not be in `querySelectorAll` range yet.
   * A repeatable occurrence containing a search nested deeper still gets swept
   * by the `updated()` pass and by its own `mb-connect`, since every mb-*
   * element emits one.
   */
  private readonly onChildConnect = (e: Event): void => {
    const target = e.composedPath()[0] as (HTMLElement & { handleSearch?: unknown }) | undefined;
    if (!target?.tagName) return;
    const tag = target.tagName.toLowerCase();
    if (tag !== 'mb-search' && tag !== 'mb-search-multiple') return;
    if (typeof target.handleSearch !== 'function') {
      target.handleSearch = handleSearch;
    }
  };

  /**
   * Adopts the occurrence styles into a repeatable as soon as it connects.
   *
   * `mb-connect-repeatable` fires from `Repeatable.connectedCallback`, which
   * runs BEFORE the element's first render — so `shadowRoot` is usually still
   * null at this point. `updateComplete` is the earliest moment it exists.
   * Falling back to `updated()` alone would work, but only after a full render
   * of this component, which is a frame of unstyled markup the user can see.
   */
  private readonly onRepeatableConnect = (e: Event): void => {
    const el = e.composedPath()[0] as (HTMLElement & { updateComplete?: Promise<unknown> }) | undefined;
    if (!el?.shadowRoot && !el?.updateComplete) return;

    if (el.shadowRoot) {
      applyRepeatableStyles(el.shadowRoot);
      return;
    }
    void el.updateComplete?.then(() => {
      if (el.shadowRoot) applyRepeatableStyles(el.shadowRoot);
    });
  };

  updated(changed: PropertyValues): void {
    // D-10: repeatable copies appear after any interaction, not only at first
    // paint, so this runs on every render — not once in connectedCallback.
    ensureSearchHandlers(this, handleSearch as unknown as (o: unknown) => Promise<unknown[]>);

    // D-11: a repeatable renders occurrences 1+ into its own SHADOW root, which
    // our `eps-composition-form ...` CSS cannot reach. Adopt the layout rules
    // into each one so an added entry looks like the first. Same reason as
    // above for running on every render: a repeatable appears when a section
    // switches to its entries branch, not only at first paint.
    ensureRepeatableStyles(this);

    if (changed.has('uid') || changed.has('patientId')) void this.prepare();

    // Prepopulate once the form element exists and the route names a stored
    // composition. `loaded` alone is not enough: mb-form is rendered by this
    // very update, so the first pass through here is the earliest it can bind.
    if (this.loaded && this.isExisting && this.importedUid !== this.uid) {
      void this.prepopulate();
    }

    // Once a save has been refused, keep the marks honest: a field should clear
    // the moment it is filled in, not on the next save attempt. Only after an
    // attempt, so an untouched new form is never painted red.
    if (this.validationAttempted) this.syncIssues();

    this.markControls();
  }

  /**
   * Marks the mandatory controls in the DOM: `data-required` on every one, and
   * `data-missing` on those currently reported empty.
   *
   * `required` IS set too — Medblocks implements it properly on every control
   * this form uses (`mb-input`, `mb-date`, `mb-buttons`, `mb-select`,
   * `mb-search`), so leaving it unset would put the library's own validity
   * state at odds with ours. What it cannot do is drive the UI on its own:
   * `mb-form.validate()` returns a single boolean, which is enough to block a
   * submit but not to say WHICH field, in which repeat occurrence, so the
   * message can name it and the page can scroll to it.
   *
   * DONE IN THE DOM, NOT IN THE TEMPLATES, because the marks follow *occurrence*
   * paths (`…risk:1/substance`), which only exist once a repeatable has rendered
   * its copies. The section templates are written against `:0`; the copies
   * Medblocks clones are not theirs to annotate. Matching on the live `path`
   * property covers every copy.
   *
   * Attributes rather than classes so `src/styles/views.css` can style them
   * without the components' own class handling interfering.
   */
  private markControls(): void {
    if (!this.webTemplate) return;

    const required = new Set(requiredControlPaths(this.webTemplate, this.form?.data ?? {}));
    const missing = new Set(this.issues.map((i) => i.path));

    for (const el of this.querySelectorAll<HTMLElement>('[data-testid]')) {
      const path = (el as unknown as { path?: string }).path;
      if (!path) continue;

      const isRequired = required.has(path);
      el.toggleAttribute('data-required', isRequired);
      el.toggleAttribute('data-missing', missing.has(path));
      if (missing.has(path)) el.setAttribute('aria-invalid', 'true');
      else el.removeAttribute('aria-invalid');

      // Keep the control's own validity in step with ours, so anything that
      // asks Medblocks directly — `mb-form.validate()`, `export(true)` — agrees
      // with what the form is showing.
      (el as unknown as { required?: boolean }).required = isRequired;
    }
  }

  /**
   * Recomputes issues and updates them only when they have actually changed.
   *
   * Guarded because this runs from `updated()`: assigning a fresh array every
   * render would re-trigger `updated()` and spin. Comparing the resolved paths
   * is enough — the label and section of a given path never change.
   */
  private syncIssues(): void {
    const next = this.revalidate();
    const key = (list: ValidationIssue[]) => list.map((i) => i.path).sort().join('|');
    if (key(next) !== key(this.issues)) this.issues = next;
  }

  /** Every missing mandatory field belonging to one section. */
  private sectionIssues(key: string): ValidationIssue[] {
    return this.issues.filter((i) => i.sectionKey === key);
  }

  /**
   * The "2 required fields missing" marker in a section head.
   *
   * Sections collapse a lot of form below them, so an error rendered only at
   * the offending control can sit off screen. This puts the count where the
   * section is identified, and each entry is a button that jumps to the field —
   * naming a required field the user cannot then find is barely better than the
   * 422 this replaces.
   */
  private renderSectionIssues(key: string) {
    const issues = this.sectionIssues(key);
    if (!issues.length) return nothing;

    return html`
      <span class="missing-pill" data-testid="missing-${key}">
        ${issues.length} required ${issues.length === 1 ? 'field' : 'fields'} missing:
        ${issues.map(
          (issue) => html`
            <button
              type="button"
              class="missing-link"
              @click=${() => this.focusIssue(issue)}
              title="Go to this field"
            >
              ${issue.label}${issue.entryNumber ? ` (entry ${issue.entryNumber})` : ''}
            </button>
          `,
        )}
      </span>
    `;
  }

  private get isExisting(): boolean {
    return Boolean(this.uid) && this.uid !== 'new';
  }

  /** The hand-written form for this route's template, if one is registered. */
  private get templateForm(): TemplateForm | undefined {
    return getTemplateForm(this.templateId);
  }

  private get form(): MbForm | null {
    return this.querySelector('mb-form') as MbForm | null;
  }

  private async prepare(): Promise<void> {
    if (!this.patientId) return;
    this.loaded = false;
    this.importedUid = '';

    try {
      const ehrId = await getPatientEhr(this.patientId);
      if (!ehrId) {
        this.setStatus('error', 'This patient has no EHR yet — create one from the Compositions view.');
        return;
      }
      this.ehrId = ehrId;

      // A form reached directly by URL may carry no template. Falling back to
      // the server's first one used to hide that: the form rendered EPS fields
      // under someone else's template id. Only a single unambiguous choice is
      // taken automatically; anything else is reported.
      if (!this.templateId) {
        const recordable = recordableTemplateIds();
        if (recordable.length === 1) {
          this.templateId = recordable[0];
        } else {
          this.setStatus(
            'error',
            'No template named in the URL — open this form from the Compositions view, ' +
              'which records which template you are filling in.',
          );
          return;
        }
      }

      if (!this.templateForm) {
        this.setStatus(
          'error',
          `No form has been built for “${this.templateId}”. This app uses hand-written forms, ` +
            `so a template needs one before it can be recorded against.`,
        );
        return;
      }

      // A template can have a form here but be absent from the CDR, in which
      // case the save is guaranteed to fail validation — better said now than
      // after the user has filled the whole thing in.
      const templates = await listTemplates().catch(() => [] as string[]);
      if (templates.length && !templates.includes(this.templateId)) {
        this.setStatus(
          'error',
          `Template “${this.templateId}” is not uploaded to the CDR, so nothing can be stored ` +
            `against it. Upload the OPT from Settings first.`,
        );
        return;
      }

      // The web template drives mandatory-field checking. A failure here is not
      // fatal: the form still works and EHRbase still validates on save, so the
      // user loses the early warning, not the ability to record. Silently
      // degrading would be worse than saying so.
      try {
        this.webTemplate = (await getWebTemplate(this.templateId)) as WebTemplate;
      } catch {
        this.webTemplate = undefined;
      }

      this.loaded = true;
      if (!this.isExisting) {
        this.setStatus(
          'info',
          this.webTemplate
            ? 'New composition — nothing has been saved yet. Fields marked * are required.'
            : 'New composition — nothing has been saved yet. The web template could not be ' +
                'loaded, so required fields cannot be checked until the composition is submitted.',
        );
      }
    } catch (err) {
      this.setStatus('error', (err as Error).message);
    }
  }

  /**
   * Loads a stored composition into the form.
   *
   * The reported number is what actually BOUND, never what was handed over:
   * `import()` diverts unmatched keys to `deferredData` and `serialize()` merges
   * them straight back, so an import that binds nothing can still look perfect.
   * `importComposition()` is what makes the distinction (D-1, D-8).
   */
  private async prepopulate(): Promise<void> {
    const form = this.form;
    if (!form || !this.ehrId) return;

    this.importedUid = this.uid;
    this.busy = true;
    this.setStatus('info', 'Loading composition…');

    try {
      const stored = await getComposition(this.ehrId, this.uid);

      // Mode BEFORE import, so the branch holding the stored values is already
      // mounted when `import()` binds. Do this after and the exclusion field
      // would be absent from the DOM — invisible to the user, absent from the
      // element registry, and therefore silently dropped on the next save.
      this.applyStoredModes(stored as Record<string, unknown>);
      await this.updateComplete;

      const report = await importComposition(form, stored);

      this.setStatus(
        'success',
        `Loaded ${report.bound} of ${report.read} stored values into the form.`,
      );
    } catch (err) {
      // Let a failed load be retried rather than latching on a bad attempt.
      this.importedUid = '';
      this.setStatus('error', `Could not load composition: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /** A section's mode, defaulting to the entries branch. */
  private modeFor(section: FormSection): SectionMode {
    return this.sectionModes[section.key] ?? 'entries';
  }

  /**
   * Switches a section's branch, but not at the cost of data already entered.
   *
   * Switching unmounts the outgoing branch, and an unmounted field leaves
   * `mb-form`'s element registry — so anything typed there is gone from the
   * next `export()`. That is exactly the property that keeps contradictory data
   * out of the CDR, but it makes an accidental click destructive, so a branch
   * holding values asks first. Declining leaves the mode unchanged.
   */
  private setSectionMode(section: FormSection, mode: SectionMode): void {
    const current = this.modeFor(section);
    if (current === mode) return;

    const data = this.form?.data ?? {};
    if (branchHasData(data, current, section.sectionPath, section.entriesPath)) {
      const ok = confirm(
        `“${section.title}” has data entered here. Switching will discard it. Continue?`,
      );
      if (!ok) return;
    }

    this.sectionModes = { ...this.sectionModes, [section.key]: mode };
  }

  /** Derives every section's mode from a stored composition's FLAT keys. */
  private applyStoredModes(stored: Record<string, unknown>): void {
    const form = this.templateForm;
    if (!form) return;

    const modes: Record<string, SectionMode> = {};
    for (const section of form.sections) {
      modes[section.key] = inferMode(stored, section.sectionPath);
    }
    this.sectionModes = modes;
  }

  /** The at-a-glance state shown in each section head. */
  private modeLabel(section: FormSection): string {
    switch (this.modeFor(section)) {
      case 'excluded':
        return 'None known';
      case 'no-information':
        return 'No information';
      default:
        return 'Recorded';
    }
  }

  /**
   * Saves the form, then reads the composition back and diffs it.
   *
   * The read-back is not decoration: it is the only proof that what the CDR
   * stored matches what was submitted. A 201 alone says the payload parsed, not
   * that every value survived.
   */
  /**
   * Re-runs mandatory-field validation against what is currently in the form.
   *
   * Reads `mb-form.data` — the live element registry — so unmounted branches are
   * absent by construction and their mandatory fields are not demanded. See
   * `openehr/validation` for why that matters.
   */
  private revalidate(): ValidationIssue[] {
    const form = this.form;
    if (!form || !this.webTemplate) return [];

    const { issues } = validateMandatory(this.webTemplate, form.data ?? {}, {
      sectionKeyFor: (path) => this.sectionKeyFor(path),
    });
    return issues;
  }

  /** Which section owns a FLAT path, so an issue can be grouped and linked. */
  private sectionKeyFor(path: string): string | undefined {
    return this.templateForm?.sections.find((s) => path.startsWith(`${s.sectionPath}/`))?.key;
  }

  /**
   * Saves the form — but only once the template's mandatory fields are filled in.
   *
   * This check is the point of the feature. EHRbase rejects a composition
   * missing a `min=1` value with a 422 naming an RM path
   * (`/content[…]/data[at0001]/items[at0002]`), which arrives after the whole
   * form has been filled in and points at nothing the user can see. Refusing
   * here instead costs one render and names the field in the template's own
   * words, beside the control.
   *
   * The CDR is still the authority — this does not model everything EHRbase
   * checks, so a save that passes here can still be refused for another reason.
   */
  private async save(): Promise<void> {
    const form = this.form;
    if (!form || !this.ehrId || !this.templateId) return;

    const issues = this.revalidate();
    this.issues = issues;
    this.validationAttempted = true;

    if (issues.length) {
      // Deliberately not opening the pipeline panel: nothing was submitted, and
      // showing a "validate → commit" run that never left the browser would
      // misrepresent where the composition got to.
      this.setStatus(
        'error',
        `Cannot save yet — ${issues.length} required ${
          issues.length === 1 ? 'field is' : 'fields are'
        } missing: ${summarizeIssues(issues)}.`,
        [
          'The template marks these as mandatory (min 1), so the CDR would reject the',
          'composition. They are marked in red on the form.',
          '',
          ...issues.map(
            (i) =>
              `  - ${i.label}${i.entryNumber ? ` (entry ${i.entryNumber})` : ''}` +
              `${i.sectionKey ? ` — ${i.sectionKey}` : ''}`,
          ),
        ].join('\n'),
      );

      // Bring the first offending control into view; a required field far down
      // a long form is otherwise reported but not findable.
      this.focusIssue(issues[0]);
      return;
    }

    this.busy = true;
    this.setStatus('info', 'Saving…');

    // The panel opens BEFORE the request so the first step is visibly running
    // while the POST is in flight, rather than every step resolving at once
    // after it returns.
    this.stepStates = initialStates();
    this.run = { templateId: this.templateId, ehrId: this.ehrId };
    this.pipelineOpen = true;

    try {
      const flat = exportComposition(form, ROOT);

      // Step 1 — validate. There is no separate validation request: EHRbase
      // validates as part of the POST. So this step covers building the FLAT
      // payload, and a payload that the CDR then rejects surfaces on step 2,
      // where the rejection actually happens.
      this.setStep('validate', 'running');
      this.run = { ...this.run, submitted: Object.keys(flat).length };
      await dwell(stepDwell('validate'));
      this.setStep('validate', 'done');

      // Step 2 — commit. Real write plus the read-back that proves it stored.
      //
      // A loaded composition is UPDATED, not re-created. Its FLAT payload
      // carries its own `_uid`, so posting it again is a create with an id the
      // CDR already holds — `412 Provided Id … already exists`. The uid to
      // update is the one that was LOADED (`importedUid`), not `this.uid`,
      // which may name a different version after an earlier save in this
      // session.
      this.setStep('commit', 'running');
      const started = performance.now();
      const existingUid = this.isExisting ? (this.importedUid || this.uid) : '';
      const { uid } = existingUid
        ? await updateComposition(this.ehrId, this.templateId, existingUid, flat)
        : await postComposition(this.ehrId, this.templateId, flat);
      const readBack = await getComposition(this.ehrId, uid);

      // The 201 is what decides the outcome. The read-back is only counted, not
      // compared: EHRbase legitimately reformats values it stores — it returns
      // an `mb-date`'s `…T07:28:00.000Z` as `…T07:28:00Z` — so a byte
      // difference never implied a value was lost, and reporting one read as a
      // problem where there was none.
      this.run = {
        ...this.run,
        uid,
        updated: Boolean(existingUid),
        readBack: Object.keys(readBack).length,
      };

      // Floor, not a fixed delay: a localhost POST can return in 40ms, and a
      // step that never renders as running reads as skipped.
      await dwell(Math.max(0, stepDwell('commit') - (performance.now() - started)));
      this.setStep('commit', 'done');

      // Steps 3 and 4 — the FHIR mapping, in their OWN try/catch.
      //
      // Nested deliberately. The composition is already committed by this
      // point, so a mapping failure must not reach the outer handler: that one
      // reports "Save failed", which would be a plain falsehood about a
      // composition sitting safely in the CDR. It is the same judgement made
      // for the read-back diff above — the 201 decides the outcome, everything
      // after it is a report.
      try {
        // Step 3 — map. Canonical, not the FLAT read-back already fetched
        // above: openFHIR deduces the payload type from its shape, and only
        // the canonical form carries the full RM structure it maps from. A
        // second, purposeful read of a different representation.
        this.setStep('map', 'running');
        const mapStarted = performance.now();
        const canonical = await getCompositionCanonical(this.ehrId, uid);
        const bundle = await toFhir(this.templateId, canonical);

        // Counted from the Bundle the engine returned, never predicted.
        this.run = { ...this.run, resources: countBundleResources(bundle) };
        await dwell(Math.max(0, stepDwell('map') - (performance.now() - mapStarted)));
        this.setStep('map', 'done');

        // Step 4 — bundle. Persisted so the summary survives a reload: only
        // the id travels in the URL and the viewer re-reads from the server.
        this.setStep('bundle', 'running');
        const bundleStarted = performance.now();
        const bundleId = await storeBundle(bundle, this.patientId);

        this.run = { ...this.run, bundleId };
        await dwell(Math.max(0, stepDwell('bundle') - (performance.now() - bundleStarted)));
        this.setStep('bundle', 'done');
      } catch (err) {
        // Whichever of the two was in flight is the one that failed; the other
        // stays pending and visibly untried.
        const running = STEPS.find((step) => this.stepStates[step.key] === 'running');
        this.run = { ...this.run, error: (err as Error).message };
        if (running) this.setStep(running.key, 'failed');
      }

      // Reports the REAL diff, not a blanket success: the pipeline no longer
      // halts on a discrepancy, so this block below the form is where a
      // dropped or altered key stays visible and reviewable.
      this.reportSave(flat, readBack, uid);

      // The save went through, so any marks left from an earlier refusal are
      // stale. Clearing the attempt flag too stops the freshly saved form being
      // re-marked as the user carries on editing it.
      this.issues = [];
      this.validationAttempted = false;

      // The route change is deferred to the panel's dismissal: navigating now
      // would tear this view down mid-animation and take the panel with it.
      this.savedUid = uid;
    } catch (err) {
      const message = (err as Error).message;
      // Whichever step was in flight is the one that failed. Nothing after it
      // runs, so the remaining steps stay pending and visibly untried.
      const running = STEPS.find((s) => this.stepStates[s.key] === 'running');
      this.run = { ...this.run, error: message };
      if (running) this.setStep(running.key, 'failed');
      this.setStatus('error', `Save failed: ${message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Moves one step to a new state. */
  private setStep(key: StepKey, state: StepState): void {
    this.stepStates = withState(this.stepStates, key, state);
  }

  /**
   * Scrolls to the control an issue names and focuses it.
   *
   * Matched on the mb-* element's `path` property rather than a selector,
   * because a FLAT path contains `/`, `:` and sometimes `|` — none of which
   * survive being put in an attribute selector unescaped.
   */
  private focusIssue(issue: ValidationIssue): void {
    const element = [...this.querySelectorAll<HTMLElement>('[data-testid]')].find(
      (el) => (el as unknown as { path?: string }).path === issue.path,
    );
    if (!element) return;

    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // mb-* controls delegate focus to an inner Shoelace input; focusing the host
    // is enough for the ones that implement it and harmless for those that do not.
    (element as HTMLElement & { focus?: () => void }).focus?.();
  }

  /**
   * Writes the save outcome to the inline status and detail block.
   *
   * The panel is transient; this is what remains on the page afterwards.
   */
  private reportSave(
    flat: FlatComposition,
    readBack: Record<string, unknown>,
    uid: string,
  ): void {
    // A mapping failure does not undo the save, but it must not be swallowed
    // either: the banner is what remains on the page after the panel closes, so
    // a summary the user cannot open has to be explained here rather than only
    // on a modal they have already dismissed.
    const mappingFailed = Boolean(this.run.error);
    const mappingNote = mappingFailed
      ? ` The FHIR mapping did not complete, so no Patient Summary was generated (${this.run.error}).`
      : '';

    // The 201 decides the outcome. Only a mapping failure downgrades this to a
    // warning — the composition itself is stored either way.
    this.setStatus(
      mappingFailed ? 'warning' : 'success',
      `Saved. ${Object.keys(flat).length} values stored.` + mappingNote,
      [
        `EHR ${this.ehrId}`,
        `UID ${uid}`,
        this.run.bundleId ? `Bundle ${this.run.bundleId}` : '',
        '',
        `Submitted ${Object.keys(flat).length} keys, read back ${Object.keys(readBack).length}.`,
        mappingFailed ? `\nFHIR mapping failed:\n  ${this.run.error}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  /**
   * Closes the panel and, if the save succeeded, lands on the saved record so
   * the URL names what is now on screen. Deferred to here rather than done at
   * save time because navigating unmounts this view mid-animation.
   */
  private closePipeline(): void {
    this.pipelineOpen = false;
    const uid = this.savedUid;
    if (!uid) return;
    this.savedUid = '';
    this.importedUid = uid;
    navigate(
      `#/patients/${encodeURIComponent(this.patientId)}/compositions/${encodeURIComponent(uid)}` +
        `?template=${encodeURIComponent(this.templateId)}`,
    );
  }

  /**
   * Opens the mapped Patient Summary.
   *
   * Distinct from `closePipeline`, which this used to be wired to — the call to
   * action said "View European Patient Summary" and merely shut the modal.
   *
   * A Bundle id is required rather than assumed. Mapping is non-fatal, so a
   * composition can be saved with no Bundle behind it; in that case there is
   * nothing to show and the only honest thing to do is what the button used to
   * do — close, and land on the saved record.
   */
  private viewSummary(): void {
    const uid = this.savedUid;
    if (!uid || !this.run.bundleId) return this.closePipeline();

    this.pipelineOpen = false;
    this.savedUid = '';
    this.importedUid = uid;
    navigate(
      `#/patients/${encodeURIComponent(this.patientId)}/compositions/${encodeURIComponent(uid)}` +
        `/summary?template=${encodeURIComponent(this.templateId)}` +
        `&bundle=${encodeURIComponent(this.run.bundleId)}`,
    );
  }

  /**
   * Shown when the form cannot be built at all — no template, no registered
   * form, or the template is missing from the CDR. The way out is the
   * compositions list, where templates are chosen explicitly.
   */
  private renderRefusal() {
    return html`
      <div class="view">
        <div class="view-head">
          <h2>Cannot open this form</h2>
          ${this.templateId
            ? html`<p><span class="pill">${this.templateId}</span></p>`
            : nothing}
        </div>

        <div class="message error" data-testid="form-status">${this.status}</div>

        <div class="card">
          <div class="empty">
            <button
              class="btn primary"
              @click=${() =>
                navigate(`#/patients/${encodeURIComponent(this.patientId)}/compositions`)}
              data-testid="form-back"
            >
              Back to compositions
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private setStatus(
    kind: 'info' | 'error' | 'success' | 'warning',
    message: string,
    detail = '',
  ): void {
    this.statusKind = kind;
    this.status = message;
    this.detail = detail;
  }

  render() {
    if (!this.loaded && this.statusKind !== 'error') {
      return html`<div class="view"><div class="empty"><span class="spinner"></span> Preparing form…</div></div>`;
    }

    // Refused before render: there is no usable form, so showing an empty
    // mb-form with a Save button would only invite a failing submission.
    if (!this.loaded) return this.renderRefusal();

    const form = this.templateForm!;

    return html`
      <div class="form-scroll">
        <div class="view-head">
          <h2>${this.isExisting ? 'Composition' : 'New composition'}</h2>
          <p>
            <span class="pill">${this.templateId || 'no template'}</span>
            ${this.isExisting
              ? html`<span class="mono muted"> · ${this.uid.split('::')[0]}</span>`
              : nothing}
          </p>
        </div>

        ${this.status
          ? html`<div class="message ${this.statusKind}" data-testid="form-status">${this.status}</div>`
          : nothing}

        <!--
          ctx MUST be a property binding. As an attribute Lit 1 JSON.parses it
          and throws; and it is the only override for the hardcoded
          territory='IN' default (D-4, D-7).
        -->
        <mb-form
          templateId=${this.templateId}
          .handleSearch=${handleSearch}
          .ctx=${FORM_CTX}
          data-testid="mb-form"
        >
          <div class="section-card">
            <div class="section-head">
              <h3>Composition context</h3>
              <span class="archetype-id">${form.rootArchetype}</span>
            </div>
            <div class="section-body">${contextFields(this.startTime)}</div>
          </div>

          ${form.sections.map(
            (section) => html`
              <div
                class="section-card ${this.sectionIssues(section.key).length ? 'has-missing' : ''}"
                data-testid="section-${section.key}"
              >
                <div class="section-head">
                  <h3>${section.title}</h3>
                  <span class="pill mode-pill" data-testid="mode-${section.key}">
                    ${this.modeLabel(section)}
                  </span>
                  ${this.renderSectionIssues(section.key)}
                  <span class="archetype-id">${section.archetype}</span>
                </div>
                <div class="section-body">
                  ${section.render({
                    mode: this.modeFor(section),
                    setMode: (mode: SectionMode) => this.setSectionMode(section, mode),
                  })}
                </div>
              </div>
            `,
          )}
        </mb-form>

        ${this.detail ? html`<pre class="output" data-testid="form-detail">${this.detail}</pre>` : nothing}
      </div>

      <div class="save-footer">
        <button
          class="btn"
          @click=${() => navigate(`#/patients/${encodeURIComponent(this.patientId)}/compositions`)}
          data-testid="form-cancel"
        >
          Back to compositions
        </button>

        <span class="save-status">
          ${this.patient ? `${this.patient.name} · ` : ''}
          ${this.ehrId ? html`<span class="mono">EHR ${this.ehrId.slice(0, 8)}…</span>` : ''}
        </span>

        <div class="spacer"></div>

        <button
          class="btn primary large"
          ?disabled=${this.busy || !this.ehrId || !this.templateId}
          @click=${this.save}
          data-testid="form-save"
        >
          ${this.busy ? html`<span class="spinner"></span>` : nothing}
          ${this.busy ? 'Saving…' : 'Save composition'}
        </button>
      </div>

      <eps-save-pipeline
        .open=${this.pipelineOpen}
        .states=${this.stepStates}
        .run=${this.run}
        @pipeline-close=${this.closePipeline}
        @pipeline-view-summary=${this.viewSummary}
      ></eps-save-pipeline>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'eps-composition-form': EpsCompositionForm;
  }
}
