/**
 * Dashboard — counts and connection state.
 *
 * Deliberately shows raw counts rather than a synthesised "all good": when one
 * back end is down the tiles must say which, because every other view in the
 * app fails differently depending on the answer.
 */

import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { getStats, type HealthStatus, type Stats } from '../openehr/client';
import { navigate } from '../shell';

@customElement('eps-dashboard')
export class EpsDashboard extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) health?: HealthStatus;

  @state() private stats?: Stats;
  @state() private error = '';

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      this.stats = await getStats();
      this.error = '';
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  render() {
    const ehrbaseUp = this.health?.ehrbase === 'up';
    const fhirUp = this.health?.fhir === 'up';

    return html`
      <div class="view-head">
        <h2>Dashboard</h2>
        <p>Connection state and record counts across both back ends.</p>
      </div>

      ${this.error ? html`<div class="message error">${this.error}</div>` : nothing}

      <div class="tiles">
        ${this.tile(this.stats?.patients, 'Patients (FHIR)')}
        ${this.tile(this.stats?.ehrs, 'EHRs (openEHR)')}
        ${this.tile(this.stats?.compositions, 'Compositions')}
        ${this.tile(this.stats?.templates, 'Templates')}
      </div>

      <div class="dash-grid">
        <div class="card">
          <div class="card-head">
            <h3>Connections</h3>
            <button class="btn" @click=${this.refresh} data-testid="dashboard-refresh">Refresh</button>
          </div>
          <div class="card-body">
            <div class="template-row">
              <span class="pill ${ehrbaseUp ? 'up' : 'down'}">
                EHRbase ${this.health?.ehrbase ?? 'checking…'}
              </span>
              <span class="mono muted">${this.health?.ehrbaseBase ?? ''}</span>
            </div>
            <div class="template-row">
              <span class="pill ${fhirUp ? 'up' : 'down'}">
                FHIR ${this.health?.fhir ?? 'checking…'}
              </span>
              <span class="mono muted">${this.health?.fhirBase ?? ''}</span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Get started</h3></div>
          <div class="card-body">
            <p class="muted" style="margin-top:0">
              Pick a patient to browse their compositions, or record a new one.
            </p>
            <button class="btn primary" @click=${() => navigate('#/patients')} data-testid="dashboard-patients">
              Go to patients
            </button>
            ${this.stats?.patients === 0
              ? html`<div class="message info" style="margin-top:14px">
                  No patients yet. Run <code class="mono">npm run seed</code> to create the demo set.
                </div>`
              : nothing}
          </div>
        </div>
      </div>
    `;
  }

  private tile(value: number | undefined, label: string) {
    return html`
      <div class="tile">
        <div class="value">${value ?? html`<span class="spinner"></span>`}</div>
        <div class="label">${label}</div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'eps-dashboard': EpsDashboard;
  }
}
