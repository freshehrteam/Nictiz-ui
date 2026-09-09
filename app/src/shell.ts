/**
 * `<eps-app>` — sidebar navigation and the view router.
 *
 * Routing is hash-based with no router dependency: the URL is the single source
 * of truth for which view is showing and which patient/composition is in
 * context, so a reload or a shared link lands in the same place.
 *
 *   #/dashboard
 *   #/patients
 *   #/patients/:patientId/compositions
 *   #/patients/:patientId/compositions/new?template=…
 *   #/patients/:patientId/compositions/:uid
 *   #/patients/:patientId/compositions/:uid/summary?bundle=…
 *   #/patients/:patientId/bundles/:bundleId
 *   #/settings
 *
 * LIGHT DOM (see `createRenderRoot`) is mandatory throughout this app: inside a
 * Lit 3 shadow root, `mb-form`'s slot traversal cannot see its children. The
 * consequence is that `static styles` is silently dropped, so all CSS lives in
 * `src/styles/*.css`, scoped by tag name.
 */

import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import './views/dashboard';
import './views/patients';
import './views/compositions';
import './views/composition-form';
import './views/settings';
import './views/patient-header';
import './views/patient-summary';
import './views/confirm-dialog';

import { getHealth, type HealthStatus } from './openehr/client';
import { getPatient, deletePatient, getDeletionPreview } from './fhir/client';
import { currentUser, isAuthenticated, logout } from './auth/session';
import type { PatientView } from './fhir/patient';

export interface Route {
  view: 'dashboard' | 'patients' | 'compositions' | 'form' | 'summary' | 'settings';
  patientId?: string;
  /** Composition uid, or 'new' for a blank form. */
  uid?: string;
  templateId?: string;
  /**
   * The stored Bundle's id, on the summary route only.
   *
   * Only the ID travels in the URL — the Bundle itself is re-read from the FHIR
   * server. That is what makes a reload, a deep link and the back button all
   * work without any client-side store to keep in sync.
   */
  bundleId?: string;
}

/** Parses a location hash into a route. Unknown hashes fall back to Dashboard. */
export function parseRoute(hash: string): Route {
  const [path, queryString] = hash.replace(/^#\/?/, '').split('?');
  const segments = path.split('/').filter(Boolean);
  const query = new URLSearchParams(queryString ?? '');
  const templateId = query.get('template') ?? undefined;

  if (segments[0] === 'patients') {
    const patientId = segments[1];
    if (!patientId) return { view: 'patients' };
    if (segments[2] === 'compositions') {
      const uid = segments[3];
      if (!uid) return { view: 'compositions', patientId };

      // `…/compositions/:uid/summary` — the mapped Patient Summary for that
      // composition. Checked before the form so a uid of 'summary' cannot be
      // confused for one: the segment only means the summary in position 4.
      if (segments[4] === 'summary') {
        return {
          view: 'summary',
          patientId,
          uid: decodeURIComponent(uid),
          templateId,
          bundleId: query.get('bundle') ?? undefined,
        };
      }

      return { view: 'form', patientId, uid: decodeURIComponent(uid), templateId };
    }

    // `…/bundles/:bundleId` — a stored Bundle opened from the list, not from a
    // just-saved composition. Same summary view; `uid` stays undefined, which
    // is what flips its back button to the compositions list.
    if (segments[2] === 'bundles' && segments[3]) {
      return { view: 'summary', patientId, bundleId: decodeURIComponent(segments[3]) };
    }

    return { view: 'compositions', patientId };
  }

  if (segments[0] === 'settings') return { view: 'settings' };
  return { view: 'dashboard' };
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}

@customElement('eps-app')
export class EpsApp extends LitElement {
  /** Light DOM — see the class comment (mb-form slotting). */
  createRenderRoot() {
    return this;
  }

  @state() private route: Route = { view: 'dashboard' };
  @state() private health?: HealthStatus;
  /** The patient named by the route, resolved once and passed down. */
  @state() private patient?: PatientView;

  /** Set while the header's delete is being confirmed. */
  @state() private confirmingDelete = false;
  @state() private deleting = false;
  @state() private deletePreview?: { compositions: number; bundles: number };
  @state() private deleteError = '';

  private onHashChange = () => this.applyRoute();

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('hashchange', this.onHashChange);
    if (!window.location.hash) window.location.hash = '#/dashboard';
    this.applyRoute();
    void this.refreshHealth();
  }

  disconnectedCallback(): void {
    window.removeEventListener('hashchange', this.onHashChange);
    super.disconnectedCallback();
  }

  private async refreshHealth(): Promise<void> {
    try {
      this.health = await getHealth();
    } catch {
      this.health = {
        ehrbase: 'unreachable',
        fhir: 'unreachable',
        openfhir: 'unreachable',
        hades: 'unreachable',
        templates: [],
      };
    }
  }

  /**
   * Re-resolves the patient only when the id actually changes — navigating
   * between a patient's compositions and one of their forms must not re-fetch
   * (and must not blank the header mid-navigation).
   */
  private async applyRoute(): Promise<void> {
    const route = parseRoute(window.location.hash);
    const changed = route.patientId !== this.route.patientId;
    this.route = route;

    if (!route.patientId) {
      this.patient = undefined;
      return;
    }
    if (!changed && this.patient) return;

    try {
      this.patient = await getPatient(route.patientId);
    } catch {
      this.patient = undefined;
    }
  }

  // --- deleting the patient in context ---------------------------------------

  /**
   * Opens the confirmation dialog for the header's delete button.
   *
   * The shell owns this rather than the header because the header is purely
   * presentational, and because the shell is what holds the patient in context
   * — it is the thing that has to stop holding them once they are gone.
   */
  private async onDeleteRequest(): Promise<void> {
    const patient = this.patient;
    if (!patient) return;

    this.confirmingDelete = true;
    this.deletePreview = undefined;
    this.deleteError = '';

    try {
      const preview = await getDeletionPreview(patient.id);
      if (this.confirmingDelete && this.patient?.id === patient.id) {
        this.deletePreview = { compositions: preview.compositions, bundles: preview.bundles };
      }
    } catch {
      // Descriptive only — the dialog falls back to general wording and the
      // delete still reports exactly what it removed.
    }
  }

  private cancelDelete(): void {
    if (this.deleting) return;
    this.confirmingDelete = false;
    this.deletePreview = undefined;
  }

  /**
   * Deletes the patient in context and leaves the patient-scoped views.
   *
   * Navigating away is not cosmetic: every view below this one is keyed on a
   * patient id that no longer resolves, so staying would render a header and a
   * composition list for someone who has just been removed.
   */
  private async confirmDelete(): Promise<void> {
    const patient = this.patient;
    if (!patient || this.deleting) return;

    this.deleting = true;
    this.deleteError = '';
    try {
      await deletePatient(patient.id);
      this.confirmingDelete = false;
      this.deletePreview = undefined;
      this.patient = undefined;
      navigate('#/patients');
    } catch (err) {
      // Kept open, so the failure is attached to the question that caused it.
      this.deleteError = (err as Error).message;
    } finally {
      this.deleting = false;
    }
  }

  /** See `eps-patients` for why the surviving EHR shell is not mentioned here. */
  private deleteBody(): string {
    const base = this.deletePreview
      ? `This permanently removes the patient, their ${this.deletePreview.compositions} openEHR ` +
        `composition${this.deletePreview.compositions === 1 ? '' : 's'}, and ` +
        `${this.deletePreview.bundles} stored FHIR ` +
        `bundle${this.deletePreview.bundles === 1 ? '' : 's'}. This cannot be undone.`
      : 'This permanently removes the patient, their openEHR compositions and their stored ' +
        'FHIR bundles. This cannot be undone.';

    return this.deleteError ? `${base}\n\n${this.deleteError}` : base;
  }

  render() {
    return html`
      <aside class="sidebar">
        <div class="brand">
          <h1>Nictiz openEHR EMR</h1>
          <p>EPS Patient Summary</p>
        </div>

        <nav>
          ${this.navItem('#/dashboard', 'dashboard', '◧', 'Dashboard')}
          ${this.navItem('#/patients', 'patients', '👤', 'Patients')}
          ${this.navItem('#/settings', 'settings', '⚙', 'Settings')}
        </nav>

        ${this.patient
          ? html`
              <div class="sidebar-patient">
                <div class="label">In context</div>
                <div class="name">${this.patient.name}</div>
                <div>${this.patient.age != null ? `${this.patient.age} y` : 'age unknown'}</div>
              </div>
            `
          : nothing}

        <div class="sidebar-foot">
          ${isAuthenticated()
            ? html`
                <div class="sidebar-user">
                  <span class="user-name" title=${currentUser().name}>${currentUser().name}</span>
                  <button class="logout" @click=${logout} data-testid="logout">Log out</button>
                </div>
              `
            : nothing}
          <div class="conn">
            <span class="dot ${this.health?.ehrbase === 'up' ? 'up' : 'down'}"></span>
            EHRbase ${this.health?.ehrbase ?? 'checking…'}
          </div>
          <div class="conn">
            <span class="dot ${this.health?.fhir === 'up' ? 'up' : 'down'}"></span>
            FHIR ${this.health?.fhir ?? 'checking…'}
          </div>
          <div class="conn">
            <span class="dot ${this.health?.openfhir === 'up' ? 'up' : 'down'}"></span>
            openFHIR ${this.health?.openfhir ?? 'checking…'}
          </div>
          <div class="conn">
            <span class="dot ${this.health?.hades === 'up' ? 'up' : 'down'}"></span>
            Hades ${this.health?.hades ?? 'checking…'}
          </div>
        </div>
      </aside>

      <div class="main">
        ${this.patient && this.route.view !== 'patients'
          ? html`<eps-patient-header
              .patient=${this.patient}
              @patient-delete-request=${this.onDeleteRequest}
            ></eps-patient-header>`
          : nothing}
        ${this.renderView()}
      </div>

      <eps-confirm-dialog
        .open=${this.confirmingDelete}
        .heading=${this.patient ? `Delete ${this.patient.name}?` : ''}
        .body=${this.deleteBody()}
        .confirmLabel=${this.deleting ? 'Deleting…' : 'Delete patient'}
        .destructive=${true}
        .busy=${this.deleting}
        @confirm-accept=${this.confirmDelete}
        @confirm-cancel=${this.cancelDelete}
      ></eps-confirm-dialog>
    `;
  }

  private navItem(hash: string, view: Route['view'], icon: string, label: string) {
    // Compositions and the form are both reached from Patients, so they keep
    // that nav item highlighted rather than leaving no item current.
    const active =
      this.route.view === view ||
      (view === 'patients' &&
        (this.route.view === 'compositions' ||
          this.route.view === 'form' ||
          this.route.view === 'summary'));

    return html`
      <button
        aria-current=${active ? 'page' : nothing}
        @click=${() => navigate(hash)}
        data-testid="nav-${view}"
      >
        <span class="nav-icon" aria-hidden="true">${icon}</span>${label}
      </button>
    `;
  }

  private renderView() {
    const { view, patientId, uid, templateId } = this.route;

    switch (view) {
      case 'patients':
        return html`<eps-patients class="view"></eps-patients>`;

      case 'compositions':
        return html`<eps-compositions
          class="view"
          .patientId=${patientId ?? ''}
          .patient=${this.patient}
        ></eps-compositions>`;

      case 'form':
        return html`<eps-composition-form
          .patientId=${patientId ?? ''}
          .patient=${this.patient}
          .uid=${uid ?? ''}
          .templateId=${templateId ?? ''}
        ></eps-composition-form>`;

      case 'summary':
        return html`<eps-patient-summary
          class="view"
          .patientId=${patientId ?? ''}
          .patient=${this.patient}
          .uid=${uid ?? ''}
          .templateId=${templateId ?? ''}
          .bundleId=${this.route.bundleId ?? ''}
        ></eps-patient-summary>`;

      case 'settings':
        return html`<eps-settings class="view" .health=${this.health}></eps-settings>`;

      default:
        return html`<eps-dashboard class="view" .health=${this.health}></eps-dashboard>`;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'eps-app': EpsApp;
  }
}
