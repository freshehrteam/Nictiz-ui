/**
 * Patients — the FHIR patient list with search.
 *
 * Search is server-side (HAPI's `name` parameter) rather than a client filter,
 * so it stays correct once the list outgrows one page.
 */

import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { searchPatients, createPatient } from '../fhir/client';
import { validateDraft, type PatientDraft, type PatientView } from '../fhir/patient';
import { navigate } from '../shell';

/** Search debounce — long enough not to query on every keystroke. */
const SEARCH_DEBOUNCE_MS = 250;

const EMPTY_DRAFT: PatientDraft = {
  firstName: '',
  lastName: '',
  birthDate: '',
  gender: 'unknown',
  bsn: '',
};

const GENDERS = ['female', 'male', 'other', 'unknown'];

@customElement('eps-patients')
export class EpsPatients extends LitElement {
  createRenderRoot() {
    return this;
  }

  @state() private patients: PatientView[] = [];
  @state() private query = '';
  @state() private loading = true;
  @state() private error = '';

  @state() private creating = false;
  @state() private draft: PatientDraft = { ...EMPTY_DRAFT };
  @state() private draftErrors: Record<string, string> = {};
  @state() private saving = false;
  @state() private created = '';

  private debounce?: ReturnType<typeof setTimeout>;

  connectedCallback(): void {
    super.connectedCallback();
    void this.search();
  }

  disconnectedCallback(): void {
    if (this.debounce) clearTimeout(this.debounce);
    super.disconnectedCallback();
  }

  private async search(): Promise<void> {
    this.loading = true;
    try {
      this.patients = await searchPatients(this.query);
      this.error = '';
    } catch (err) {
      this.error = (err as Error).message;
      this.patients = [];
    } finally {
      this.loading = false;
    }
  }

  private onInput(e: Event): void {
    this.query = (e.target as HTMLInputElement).value;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.search(), SEARCH_DEBOUNCE_MS);
  }

  // --- creating a patient ---------------------------------------------------

  private openForm(): void {
    this.draft = { ...EMPTY_DRAFT };
    this.draftErrors = {};
    this.created = '';
    this.creating = true;
  }

  private closeForm(): void {
    this.creating = false;
    this.draftErrors = {};
  }

  /** Updates one field, clearing only that field's error as the user fixes it. */
  private setField(field: keyof PatientDraft, value: string): void {
    this.draft = { ...this.draft, [field]: value };
    if (this.draftErrors[field]) {
      const { [field]: _removed, ...rest } = this.draftErrors;
      this.draftErrors = rest;
    }
  }

  /**
   * Creates the patient and their EHR, then puts them on screen.
   *
   * The EHR id is assigned by EHRbase, not chosen here — see `createPatient`.
   * A patient created without one would be unreachable from every other view,
   * so that case is surfaced as a warning rather than passed off as success.
   */
  private async submitDraft(): Promise<void> {
    const errors = validateDraft(this.draft);
    this.draftErrors = errors;
    if (Object.keys(errors).length) return;

    this.saving = true;
    this.error = '';
    try {
      const { patientId, ehrId } = await createPatient(this.draft);

      this.created = ehrId
        ? `Created ${this.draft.firstName} ${this.draft.lastName} — EHR ${ehrId.slice(0, 8)}…`
        : `Created ${this.draft.firstName} ${this.draft.lastName}, but no EHR was returned. ` +
          `Open the patient to create one before recording compositions.`;

      this.creating = false;
      // Clear the filter, or a new patient outside the current search vanishes
      // the moment they are created.
      this.query = '';
      await this.search();
      // Land on the new patient: creating one is almost always the first step
      // of recording something for them.
      if (ehrId) navigate(`#/patients/${encodeURIComponent(patientId)}/compositions`);
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.saving = false;
    }
  }

  render() {
    return html`
      <div class="view-head">
        <h2>Patients</h2>
        <p>Select a patient to browse and record their compositions.</p>
      </div>

      <div class="search-row">
        <input
          class="text"
          type="search"
          placeholder="Search by name…"
          .value=${this.query}
          @input=${this.onInput}
          data-testid="patient-search"
          aria-label="Search patients by name"
        />
        <button class="btn" @click=${this.search} ?disabled=${this.loading} data-testid="patient-refresh">
          ${this.loading ? html`<span class="spinner"></span>` : nothing} Refresh
        </button>
        <button
          class="btn primary"
          @click=${this.openForm}
          ?disabled=${this.creating}
          data-testid="new-patient"
        >
          + New patient
        </button>
      </div>

      ${this.created ? html`<div class="message success">${this.created}</div>` : nothing}
      ${this.error ? html`<div class="message error">${this.error}</div>` : nothing}
      ${this.creating ? this.renderForm() : nothing}
      ${this.renderList()}
    `;
  }

  private renderForm() {
    return html`
      <div class="card new-patient-form" data-testid="new-patient-form">
        <div class="card-head">
          <h3>New patient</h3>
          <span class="muted">The openEHR record is created automatically.</span>
        </div>

        <div class="card-body">
          <div class="field-grid">
            ${this.field('firstName', 'First name(s)', 'text', { required: true })}
            ${this.field('lastName', 'Last name', 'text', { required: true })}
            ${this.field('birthDate', 'Date of birth', 'date', { required: true })}

            <div>
              <label class="field-label" for="np-gender">Sex</label>
              <select
                id="np-gender"
                class="text"
                .value=${this.draft.gender}
                @change=${(e: Event) => this.setField('gender', (e.target as HTMLSelectElement).value)}
                data-testid="np-gender"
              >
                ${GENDERS.map(
                  (g) => html`<option value=${g} ?selected=${g === this.draft.gender}>${g}</option>`,
                )}
              </select>
            </div>

            ${this.field('bsn', 'BSN (optional)', 'text', { placeholder: '9 digits' })}
          </div>

          <p class="muted form-note">
            The EHR id is generated by EHRbase and linked to this patient automatically — there is
            nothing to enter for it.
          </p>

          <div class="form-actions">
            <button class="btn" @click=${this.closeForm} ?disabled=${this.saving} data-testid="np-cancel">
              Cancel
            </button>
            <button
              class="btn primary"
              @click=${this.submitDraft}
              ?disabled=${this.saving}
              data-testid="np-save"
            >
              ${this.saving ? html`<span class="spinner"></span>` : nothing}
              ${this.saving ? 'Creating…' : 'Create patient'}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private field(
    name: keyof PatientDraft,
    label: string,
    type: string,
    opts: { required?: boolean; placeholder?: string } = {},
  ) {
    const error = this.draftErrors[name];
    return html`
      <div>
        <label class="field-label" for="np-${name}">
          ${label}${opts.required ? html` <span class="req">*</span>` : nothing}
        </label>
        <input
          id="np-${name}"
          class="text ${error ? 'invalid' : ''}"
          type=${type}
          placeholder=${opts.placeholder ?? ''}
          .value=${this.draft[name] ?? ''}
          @input=${(e: Event) => this.setField(name, (e.target as HTMLInputElement).value)}
          aria-invalid=${error ? 'true' : 'false'}
          data-testid="np-${name}"
        />
        ${error ? html`<div class="field-error" data-testid="np-${name}-error">${error}</div>` : nothing}
      </div>
    `;
  }

  private renderList() {
    if (this.loading && !this.patients.length) {
      return html`<div class="empty"><span class="spinner"></span> Loading patients…</div>`;
    }

    if (!this.patients.length) {
      return html`<div class="card">
        <div class="empty">
          ${this.query
            ? html`No patients match “${this.query}”.`
            : html`No patients yet. Run <code class="mono">npm run seed</code> to create the demo set.`}
        </div>
      </div>`;
    }

    return html`
      <div class="patient-grid" data-testid="patient-list">
        ${this.patients.map(
          (p) => html`
            <button
              class="patient-card"
              @click=${() => navigate(`#/patients/${encodeURIComponent(p.id)}/compositions`)}
              data-testid="patient-${p.id}"
            >
              <span class="avatar" aria-hidden="true">${p.initials}</span>
              <span>
                <span class="name">${p.name}</span><br />
                <span class="meta">
                  ${p.age != null ? `${p.age} y` : 'age unknown'} ·
                  ${p.sex ?? 'unknown'} ·
                  ${p.birthDate ?? 'no DOB'}
                </span>
                ${p.identifier ? html`<br /><span class="bsn">BSN ${p.identifier}</span>` : nothing}
              </span>
            </button>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'eps-patients': EpsPatients;
  }
}
