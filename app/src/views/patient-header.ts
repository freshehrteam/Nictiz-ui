/**
 * The mockup's patient header: avatar, name, age, sex, date of birth.
 *
 * Shown above every patient-scoped view so the record on screen always names
 * whose it is — the one piece of chrome that must never be ambiguous.
 */

import { LitElement, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { PatientView } from '../fhir/patient';
import { navigate } from '../shell';

@customElement('eps-patient-header')
export class EpsPatientHeader extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) patient?: PatientView;

  private requestDelete(): void {
    this.dispatchEvent(
      new CustomEvent('patient-delete-request', { bubbles: true, composed: true }),
    );
  }

  render() {
    const p = this.patient;
    if (!p) return nothing;

    return html`
      <div class="row">
        <div class="avatar" aria-hidden="true">${p.initials}</div>

        <div>
          <div class="name" data-testid="patient-name">${p.name}</div>
          <div class="demographics">
            <span>Age <b>${p.age != null ? p.age : '—'}</b></span>
            <span>Sex <b>${p.sex ?? 'unknown'}</b></span>
            <span>DOB <b>${p.birthDate ?? '—'}</b></span>
            ${p.identifier ? html`<span>BSN <b class="mono">${p.identifier}</b></span>` : nothing}
          </div>
        </div>

        <div class="spacer"></div>

        <button class="btn" @click=${() => navigate('#/patients')} data-testid="change-patient">
          Change patient
        </button>

        <!-- Emits rather than deletes. This header is purely presentational —
             it holds no data-layer dependency beyond navigate() — and the
             confirmation dialog belongs with whoever owns the patient list it
             has to refresh afterwards. -->
        <button
          class="btn danger"
          @click=${this.requestDelete}
          aria-label="Delete ${p.name}"
          data-testid="header-delete-patient"
        >
          Delete
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'eps-patient-header': EpsPatientHeader;
  }
}
