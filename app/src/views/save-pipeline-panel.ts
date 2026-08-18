/**
 * The modal shown while a composition is being committed.
 *
 * It presents the save as a four-step technical pipeline — validate, commit,
 * map, bundle — with each step lighting up as it completes. All four are backed
 * by a real request; `views/save-pipeline` documents what each one reports.
 *
 * This component is deliberately PASSIVE. It renders whatever step states it
 * is handed and emits no requests of its own: the composition form owns the
 * real POST and read-back, and drives this panel through its properties. That
 * split is what lets a real EHRbase failure halt the pipeline honestly — the
 * form knows the request failed, so it sets `failed` on the step and the panel
 * simply stops advancing. A panel that ran the pipeline itself would have to
 * duplicate the save logic to know that.
 *
 * Light DOM, like every component here: see `styles/theme.css`. Styles live in
 * `styles/views.css` under `eps-save-pipeline`.
 */

import { LitElement, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import {
  STEPS,
  type RunFacts,
  type StepKey,
  type StepState,
} from './save-pipeline';

@customElement('eps-save-pipeline')
export class EpsSavePipeline extends LitElement {
  createRenderRoot() {
    return this;
  }

  /** Whether the modal is on screen at all. */
  @property({ attribute: false }) open = false;
  @property({ attribute: false }) states: Record<StepKey, StepState> = {
    validate: 'pending',
    commit: 'pending',
    map: 'pending',
    bundle: 'pending',
  };
  @property({ attribute: false }) run: RunFacts = { templateId: '', ehrId: '' };

  /** True once every step is done — reveals the closing call to action. */
  private get complete(): boolean {
    return STEPS.every((s) => this.states[s.key] === 'done');
  }

  private get failedStep() {
    return STEPS.find((s) => this.states[s.key] === 'failed');
  }

  /**
   * A failure that happened AFTER the composition was committed.
   *
   * The distinction is the whole point of making the mapping non-fatal: a
   * failed `map` or `bundle` leaves a composition safely in the CDR, so the
   * panel must not tell the user their save did not happen. `uid` is the
   * evidence — EHRbase only issues one on a successful commit.
   */
  private get savedDespiteFailure(): boolean {
    return Boolean(this.failedStep && this.run.uid);
  }

  private close(): void {
    this.dispatchEvent(new CustomEvent('pipeline-close', { bubbles: true, composed: true }));
  }

  /**
   * Asks to open the mapped Patient Summary. The form decides what that means:
   * it holds the stored Bundle's id, and falls back to simply closing when
   * mapping failed and there is no Bundle to show.
   */
  private viewSummary(): void {
    this.dispatchEvent(new CustomEvent('pipeline-view-summary', { bubbles: true, composed: true }));
  }

  private renderIcon(state: StepState) {
    switch (state) {
      case 'done':
        return html`<span class="step-icon done" aria-hidden="true">✓</span>`;
      case 'failed':
        return html`<span class="step-icon failed" aria-hidden="true">✕</span>`;
      case 'running':
        // The filled pulsing dot of the mockup's in-flight step.
        return html`<span class="step-icon running" aria-hidden="true"></span>`;
      default:
        return html`<span class="step-icon pending" aria-hidden="true"></span>`;
    }
  }

  render() {
    if (!this.open) return nothing;

    const failed = this.failedStep;
    const done = STEPS.filter((s) => this.states[s.key] === 'done').length;
    // The progress bar tracks completed steps, but a failure freezes it where
    // it stopped rather than letting it read as nearly finished.
    const pct = Math.round((done / STEPS.length) * 100);

    return html`
      <div class="pipeline-backdrop" data-testid="pipeline-backdrop">
        <div
          class="pipeline-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pipeline-title"
          data-testid="pipeline"
        >
          <div class="pipeline-head">
            <h3 id="pipeline-title">
              ${failed
                ? this.savedDespiteFailure
                  ? 'Composition saved, but not mapped'
                  : 'Could not process composition'
                : 'Processing composition'}
            </h3>
            <p>
              ${failed
                ? this.savedDespiteFailure
                  ? 'The composition is stored in the CDR. Only the FHIR mapping below failed.'
                  : 'The pipeline stopped at the step below. Nothing further was attempted.'
                : 'Committing to EHRbase and mapping to FHIR via openFHIR'}
            </p>
          </div>

          <div
            class="pipeline-progress ${failed ? 'failed' : ''}"
            role="progressbar"
            aria-valuenow=${pct}
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <span style="width: ${pct}%"></span>
          </div>

          <ol class="pipeline-steps">
            ${STEPS.map((step) => {
              const state = this.states[step.key];
              return html`
                <li class="step ${state}" data-testid="step-${step.key}" data-state=${state}>
                  ${this.renderIcon(state)}
                  <div class="step-body">
                    <div class="step-title">${step.title}</div>
                    ${state === 'pending'
                      ? nothing
                      : html`<div class="step-line">
                          <span class="chev">&gt;</span>
                          ${state === 'failed' ? (this.run.error ?? 'failed') : step.line(this.run)}
                        </div>`}
                    ${step.key === 'commit' && state === 'done' && this.run.note
                      ? html`<div class="step-note" data-testid="step-note">
                          ${this.run.note} — see the detail below the form.
                        </div>`
                      : nothing}
                  </div>
                </li>
              `;
            })}
          </ol>

          <p class="pipeline-note">
            ${failed
              ? html`EHR <span class="mono">${this.run.ehrId.slice(0, 8)}…</span> ·
                ${this.run.uid
                  ? html`the composition was saved; the step below did not complete.`
                  : html`nothing was mapped or bundled.`}`
              : 'Runs in under a second in production — slowed down here for demo visibility.'}
          </p>

          ${failed
            ? html`<button class="btn primary large pipeline-cta" @click=${this.close} data-testid="pipeline-close">
                ${this.savedDespiteFailure ? 'Continue to saved record' : 'Close and fix'}
              </button>`
            : html`<button
                class="btn primary large pipeline-cta"
                ?disabled=${!this.complete}
                @click=${this.viewSummary}
                data-testid="pipeline-cta"
              >
                View European Patient Summary →
              </button>`}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'eps-save-pipeline': EpsSavePipeline;
  }
}
