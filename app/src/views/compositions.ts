/**
 * Compositions browser — two panes: templates on the left, the selected
 * template's compositions on the right.
 *
 * The left pane lists every template ON THE SERVER, not only those this patient
 * already has records for. Those are different sets, and conflating them broke
 * creation: a template the patient had no data for could not be reached at all,
 * and "New composition" inherited whatever row was selected — so which template
 * you recorded against depended on where you last clicked. Each row now carries
 * its own "+ New", which is the only way to start one, so the template is always
 * chosen deliberately and travels in the URL.
 *
 * A row is offered for creation only when a hand-written form exists for it
 * (see `forms/registry`). Templates without one are still listed — hiding them
 * would misrepresent what the CDR holds — but marked as not yet recordable.
 *
 * Grouping by template happens in the BFF, in JavaScript, because EHRbase's AQL
 * engine does not support `GROUP BY` — it is a parse error on this server, not
 * a limitation we chose to work around.
 *
 * A patient may legitimately have no EHR yet (they were created outside the
 * seeding script), so this view offers to create one rather than dead-ending.
 */

import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { listCompositions, listTemplates, createEhr, type TemplateGroup } from '../openehr/client';
import { getPatientEhr } from '../fhir/client';
import type { PatientView } from '../fhir/patient';
import { isRecordable } from '../forms/registry';
import { navigate } from '../shell';

/** One row of the left pane: a template, with what this patient has under it. */
interface TemplateRow {
  templateId: string;
  /** Stored compositions for this patient under this template. */
  count: number;
  /** A form exists, so a new composition can be started. */
  recordable: boolean;
  /** The server no longer has this template, but the patient has records. */
  orphaned: boolean;
}

@customElement('eps-compositions')
export class EpsCompositions extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) patientId = '';
  @property({ attribute: false }) patient?: PatientView;

  @state() private ehrId: string | null = null;
  @state() private groups: TemplateGroup[] = [];
  /** Template ids known to the server — what a NEW composition could be based on. */
  @state() private templates: string[] = [];
  @state() private selected = '';
  @state() private loading = true;
  @state() private busy = false;
  @state() private error = '';

  updated(changed: Map<string, unknown>): void {
    if (changed.has('patientId') && this.patientId) void this.load();
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.patientId) void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.error = '';
    try {
      const [ehrId, templates] = await Promise.all([
        getPatientEhr(this.patientId),
        listTemplates().catch(() => [] as string[]),
      ]);

      this.ehrId = ehrId;
      this.templates = templates;

      const { groups } = ehrId ? await listCompositions(ehrId) : { groups: [] as TemplateGroup[] };
      this.groups = groups;

      // Prefer keeping the current selection, then the first template with
      // records, then the first recordable one — landing on a row the user can
      // act on rather than on an unrecordable template with nothing under it.
      const rows = this.rows;
      this.selected =
        rows.find((r) => r.templateId === this.selected)?.templateId ??
        rows.find((r) => r.count > 0)?.templateId ??
        rows.find((r) => r.recordable)?.templateId ??
        rows[0]?.templateId ??
        '';
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.loading = false;
    }
  }

  /**
   * The left pane's rows: every server template, plus any template this patient
   * has records under that the server no longer lists. The second case is real —
   * a template can be removed while its compositions remain — and dropping those
   * rows would hide stored data.
   */
  private get rows(): TemplateRow[] {
    const counts = new Map(this.groups.map((g) => [g.templateId, g.count]));
    const server = new Set(this.templates);

    const rows: TemplateRow[] = this.templates.map((templateId) => ({
      templateId,
      count: counts.get(templateId) ?? 0,
      recordable: isRecordable(templateId),
      orphaned: false,
    }));

    for (const group of this.groups) {
      if (server.has(group.templateId)) continue;
      rows.push({
        templateId: group.templateId,
        count: group.count,
        // Without the template on the server a composition cannot be validated,
        // so creation is off regardless of whether a form exists.
        recordable: false,
        orphaned: true,
      });
    }

    // Templates that can be filled in come first — the rest are reference only.
    return rows.sort((a, b) => {
      if (a.recordable !== b.recordable) return a.recordable ? -1 : 1;
      if (a.count !== b.count) return b.count - a.count;
      return a.templateId.localeCompare(b.templateId);
    });
  }

  /** Creates the EHR a patient is missing, linked to them by subject reference. */
  private async createEhrForPatient(): Promise<void> {
    this.busy = true;
    try {
      this.ehrId = await createEhr(this.patientId);
      await this.load();
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Starts a blank composition for one specific template.
   *
   * The template is always passed explicitly — never defaulted from the current
   * selection or from the server's first template — so the URL fully determines
   * what is being recorded.
   */
  private newComposition(templateId: string): void {
    if (!templateId || !isRecordable(templateId)) return;
    navigate(
      `#/patients/${encodeURIComponent(this.patientId)}/compositions/new` +
        `?template=${encodeURIComponent(templateId)}`,
    );
  }

  private open(uid: string, templateId: string): void {
    navigate(
      `#/patients/${encodeURIComponent(this.patientId)}/compositions/${encodeURIComponent(uid)}` +
        `?template=${encodeURIComponent(templateId)}`,
    );
  }

  render() {
    return html`
      <div class="view-head">
        <h2>Compositions</h2>
        <p>
          ${this.patient ? `Records held for ${this.patient.name}` : 'Records held for this patient'}
          ${this.ehrId ? html` · <span class="mono muted">EHR ${this.ehrId.slice(0, 8)}…</span>` : nothing}
        </p>
      </div>

      ${this.error ? html`<div class="message error">${this.error}</div>` : nothing}
      ${this.renderNewCompositionBanner()}
      ${this.renderBody()}
    `;
  }

  /**
   * The banner acts on the SELECTED row, mirroring the per-row buttons rather
   * than introducing a second, differently-behaving path to creation. When the
   * selected template cannot be recorded it says so instead of quietly starting
   * a different one.
   */
  private renderNewCompositionBanner() {
    if (!this.ehrId || this.loading) return nothing;

    const selected = this.rows.find((r) => r.templateId === this.selected);
    const recordable = selected?.recordable ?? false;

    return html`
      <div class="new-composition">
        <div>
          <h3>Record a new composition</h3>
          <p>
            ${recordable
              ? html`Starts a blank <strong>${selected!.templateId}</strong> form for this patient.`
              : selected
                ? html`No form has been built for <strong>${selected.templateId}</strong> yet — pick a
                    template marked “form ready”.`
                : 'Select a template to record against.'}
          </p>
        </div>
        <button
          class="btn large"
          @click=${() => this.newComposition(this.selected)}
          ?disabled=${!recordable}
          data-testid="new-composition"
        >
          + New composition
        </button>
      </div>
    `;
  }

  private renderBody() {
    if (this.loading) {
      return html`<div class="card"><div class="empty"><span class="spinner"></span> Loading…</div></div>`;
    }

    if (!this.ehrId) {
      return html`
        <div class="card">
          <div class="empty">
            <p>This patient has no openEHR record yet.</p>
            <button
              class="btn primary"
              @click=${this.createEhrForPatient}
              ?disabled=${this.busy}
              data-testid="create-ehr"
            >
              ${this.busy ? html`<span class="spinner"></span>` : nothing} Create EHR
            </button>
          </div>
        </div>
      `;
    }

    return html`
      <div class="panes">
        ${this.renderTemplatePane()}
        ${this.renderCompositionPane()}
      </div>
    `;
  }

  private renderTemplatePane() {
    const rows = this.rows;

    return html`
      <div class="card">
        <div class="card-head">
          <h3>Templates</h3>
          <span class="muted">${rows.length}</span>
        </div>

        <div class="template-list" role="listbox" aria-label="Templates">
          ${rows.length
            ? rows.map((row) => this.renderTemplateRow(row))
            : html`<div class="empty">No templates on the server.</div>`}
        </div>

        ${rows.some((r) => !r.recordable)
          ? html`<p class="template-note">
              Templates without a form can be browsed but not recorded against — this app uses
              hand-written forms, so each template needs one built.
            </p>`
          : nothing}
      </div>
    `;
  }

  private renderTemplateRow(row: TemplateRow) {
    const selected = row.templateId === this.selected;

    return html`
      <div class="template-row ${row.recordable ? '' : 'unsupported'}">
        <button
          class="template-item"
          role="option"
          aria-selected=${selected}
          @click=${() => (this.selected = row.templateId)}
          data-testid="template-${row.templateId}"
        >
          <span class="template-name">
            <span class="id" title=${row.templateId}>${row.templateId}</span>
            ${row.recordable
              ? nothing
              : html`<span class="tag">${row.orphaned ? 'not on server' : 'no form yet'}</span>`}
          </span>
          <span class="count ${row.count ? '' : 'zero'}">${row.count}</span>
        </button>

        ${row.recordable
          ? html`<button
              class="template-new"
              title=${`New ${row.templateId} composition`}
              aria-label=${`New ${row.templateId} composition`}
              @click=${() => this.newComposition(row.templateId)}
              data-testid="new-${row.templateId}"
            >
              +
            </button>`
          : nothing}
      </div>
    `;
  }

  private renderCompositionPane() {
    const group = this.groups.find((g) => g.templateId === this.selected);
    const row = this.rows.find((r) => r.templateId === this.selected);

    return html`
      <div class="card">
        <div class="card-head">
          <h3>${this.selected || 'Compositions'}</h3>
          ${group ? html`<span class="muted">${group.count} stored</span>` : nothing}
        </div>

        ${group?.compositions.length
          ? html`
              <div class="composition-list" data-testid="composition-list">
                ${group.compositions.map(
                  (c) => html`
                    <button
                      class="composition-item"
                      @click=${() => this.open(c.uid, c.templateId)}
                      title=${c.uid}
                      data-testid="composition-${c.uid.split('::')[0]}"
                    >
                      <span>
                        <span class="when">${c.startTime || '(no start time)'}</span><br />
                        <span class="uid">
                          ${c.uid.split('::')[0].slice(0, 8)}… · v${c.uid.split('::')[2] ?? '1'}
                        </span>
                      </span>
                      <span class="chev" aria-hidden="true">›</span>
                    </button>
                  `,
                )}
              </div>
            `
          : this.renderEmptyCompositions(row)}
      </div>
    `;
  }

  /**
   * The empty state used to dead-end by pointing at a "New composition" button
   * that might start a different template. It now offers the action for the
   * template actually being looked at, or explains why it cannot.
   */
  private renderEmptyCompositions(row?: TemplateRow) {
    if (!row) {
      return html`<div class="empty">Select a template to see its compositions.</div>`;
    }

    if (!row.recordable) {
      return html`<div class="empty">
        <p>Nothing stored under ${row.templateId} for this patient.</p>
        <p class="muted">
          ${row.orphaned
            ? 'This template is no longer on the server, so nothing new can be recorded against it.'
            : 'No form has been built for this template yet, so it cannot be recorded against here.'}
        </p>
      </div>`;
    }

    return html`<div class="empty">
      <p>Nothing stored under ${row.templateId} for this patient yet.</p>
      <button
        class="btn primary"
        @click=${() => this.newComposition(row.templateId)}
        data-testid="empty-new-composition"
      >
        + Record the first one
      </button>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'eps-compositions': EpsCompositions;
  }
}
