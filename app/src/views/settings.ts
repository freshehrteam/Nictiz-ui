/**
 * Settings — server status, counts, template list and OPT upload.
 *
 * Also the place where the two things a reader must not have to discover for
 * themselves are stated plainly: that the demo patients are fictional, and that
 * this BFF has no user authentication.
 */

import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { getStats, listTemplates, uploadTemplate, type HealthStatus, type Stats } from '../openehr/client';
import { currentUser } from '../auth/session';

@customElement('eps-settings')
export class EpsSettings extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) health?: HealthStatus;

  @state() private stats?: Stats;
  @state() private templates: string[] = [];
  @state() private message = '';
  @state() private messageKind: 'info' | 'error' | 'success' = 'info';
  @state() private busy = false;

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const [stats, templates] = await Promise.all([getStats(), listTemplates()]);
      this.stats = stats;
      this.templates = templates;
    } catch (err) {
      this.messageKind = 'error';
      this.message = (err as Error).message;
    }
  }

  /**
   * Uploads an OPT. The file is sent as XML text exactly as read — EHRbase
   * parses the OPT itself, and re-serialising it here could only corrupt it.
   */
  private async onFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.busy = true;
    try {
      const response = await uploadTemplate(await file.text());
      this.messageKind = 'success';
      this.message = `Uploaded ${file.name}. ${response.slice(0, 300)}`;
      await this.refresh();
    } catch (err) {
      this.messageKind = 'error';
      this.message = (err as Error).message;
    } finally {
      this.busy = false;
      // Allow the same file to be re-selected after a failure.
      input.value = '';
    }
  }

  render() {
    return html`
      <div class="view-head">
        <h2>Settings</h2>
        <p>Server status, stored data and template management.</p>
      </div>

      ${this.message ? html`<div class="message ${this.messageKind}">${this.message}</div>` : nothing}

      <div class="settings-grid">
        <div class="card">
          <div class="card-head">
            <h3>Connections</h3>
          </div>
          <div class="card-body">
            <dl class="kv">
              <dt>EHRbase</dt>
              <dd>
                <span class="pill ${this.health?.ehrbase === 'up' ? 'up' : 'down'}">
                  ${this.health?.ehrbase ?? 'checking…'}
                </span>
                ${this.health?.ehrbaseBase ?? ''}
              </dd>

              <dt>HAPI FHIR</dt>
              <dd>
                <span class="pill ${this.health?.fhir === 'up' ? 'up' : 'down'}">
                  ${this.health?.fhir ?? 'checking…'}
                </span>
                ${this.health?.fhirBase ?? ''}
              </dd>

              <dt>openFHIR</dt>
              <dd>
                <span class="pill ${this.health?.openfhir === 'up' ? 'up' : 'down'}">
                  ${this.health?.openfhir ?? 'checking…'}
                </span>
                ${this.health?.openfhirBase ?? ''}
                ${this.health?.openfhirVersion
                  ? html`<span class="muted">v${this.health.openfhirVersion}</span>`
                  : nothing}
              </dd>

              <dt>Patients</dt>
              <dd>${this.stats?.patients ?? '—'}</dd>
              <dt>EHRs</dt>
              <dd>${this.stats?.ehrs ?? '—'}</dd>
              <dt>Compositions</dt>
              <dd>${this.stats?.compositions ?? '—'}</dd>
            </dl>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Templates</h3></div>
          <div class="card-body">
            ${this.templates.length
              ? this.templates.map(
                  (t) => html`
                    <div class="template-row">
                      <span class="pill up">uploaded</span>
                      <span>${t}</span>
                    </div>
                  `,
                )
              : html`<div class="empty">No templates uploaded.</div>`}

            <div class="upload-row" style="margin-top:16px">
              <label class="btn" for="opt-upload">
                ${this.busy ? html`<span class="spinner"></span>` : nothing} Upload OPT (XML)
              </label>
              <input
                id="opt-upload"
                type="file"
                accept=".opt,.xml,application/xml,text/xml"
                style="display:none"
                @change=${this.onFile}
                ?disabled=${this.busy}
                data-testid="opt-upload"
              />
              <span class="muted">
                Operational templates are uploaded to EHRbase and become available immediately.
              </span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h3>Data provenance</h3>
            <span class="pill demo">demo data</span>
          </div>
          <div class="card-body">
            <p style="margin-top:0">
              The demo patients in this environment are
              <strong>fictional</strong>. They carry the FHIR tag
              <code class="mono">data-origin = demo</code> and use BSNs from the reserved
              <code class="mono">999…</code> test range, so none can collide with a real citizen
              service number.
            </p>
            <!--
              Deliberately NOT "ehrs - patients": an EHR can be created without a
              patient at any time, so that subtraction is a guess dressed up as a
              count. State the relationship instead of computing a wrong number.
            -->
            <p class="muted" style="margin-bottom:0">
              Of ${this.stats?.ehrs ?? '—'} EHRs in this CDR, only those with a patient reference
              appear in the patient list. The rest — including the orphans left by the earlier
              evaluation PoC — have no demographics and are deliberately not shown.
            </p>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Security</h3></div>
          <div class="card-body">
            <div class="message error" style="margin:0">
              <strong>There is no per-user authentication.</strong> The BFF holds one shared EHRbase
              credential and applies no per-user access control, so anyone who gets past the gate can
              read and write every record. Deployed, that gate is a single shared login at the
              ingress; locally there is none at all. Either way nothing records who was at the
              keyboard &mdash; every composition is filed under
              <code>${currentUser().name}</code>. Real per-user authentication and authorisation
              must be in place before this carries real patient data.
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'eps-settings': EpsSettings;
  }
}
