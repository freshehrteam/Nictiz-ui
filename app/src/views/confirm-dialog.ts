/**
 * A modal that asks one question before something irreversible happens.
 *
 * Like `eps-save-pipeline`, this component is deliberately PASSIVE: it renders
 * a question and emits the answer, and it never performs the action it is
 * guarding. The parent owns the mutation. That split is the load-bearing part
 * of the pattern — a dialog that deleted things itself would have to know about
 * every caller's data, and each new caller would widen it.
 *
 * It is generic on purpose. The native `confirm()` in `composition-form` is an
 * obvious future consumer, but converting it is a real refactor rather than a
 * substitution: that call is synchronous and branches on a returned boolean
 * inline, where this one resolves through an event on a later tick.
 *
 * Light DOM, like every component here: see `styles/theme.css`. Styles live in
 * `styles/views.css` under `eps-confirm-dialog`.
 */

import { LitElement, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('eps-confirm-dialog')
export class EpsConfirmDialog extends LitElement {
  createRenderRoot() {
    return this;
  }

  /** Whether the modal is on screen at all. */
  @property({ attribute: false }) open = false;
  @property({ attribute: false }) heading = 'Are you sure?';
  @property({ attribute: false }) body = '';
  @property({ attribute: false }) confirmLabel = 'Confirm';
  @property({ attribute: false }) cancelLabel = 'Cancel';
  /** Styles the confirm button as destructive. */
  @property({ attribute: false }) destructive = false;
  /** The action is in flight: both buttons lock and the confirm spins. */
  @property({ attribute: false }) busy = false;

  connectedCallback(): void {
    super.connectedCallback();
    // On document rather than on the element: the dialog renders into light DOM
    // and focus sits on its Cancel button, but a keydown anywhere else on the
    // page should still dismiss a modal that is blocking the whole view.
    document.addEventListener('keydown', this.onKeydown);
  }

  disconnectedCallback(): void {
    document.removeEventListener('keydown', this.onKeydown);
    super.disconnectedCallback();
  }

  /**
   * Escape cancels — but never while the action is running.
   *
   * Once the delete is in flight there is nothing left to decline: dismissing
   * would hide a mutation that is still going to land, leaving the user looking
   * at a list that has not caught up yet.
   */
  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !this.open || this.busy) return;
    e.stopPropagation();
    this.cancel();
  };

  updated(changed: Map<string, unknown>): void {
    // Focus lands on CANCEL, not on confirm. The dialog appears under the
    // pointer and often under a keystroke already in flight, and a stray Enter
    // must not be able to complete a destructive action the user never read.
    if (changed.has('open') && this.open) {
      this.renderRoot.querySelector<HTMLButtonElement>('[data-testid="confirm-cancel"]')?.focus();
    }
  }

  private accept(): void {
    this.dispatchEvent(new CustomEvent('confirm-accept', { bubbles: true, composed: true }));
  }

  private cancel(): void {
    this.dispatchEvent(new CustomEvent('confirm-cancel', { bubbles: true, composed: true }));
  }

  /** Only a click on the backdrop ITSELF dismisses — not one bubbling up from the card. */
  private onBackdropClick(e: MouseEvent): void {
    if (e.target !== e.currentTarget || this.busy) return;
    this.cancel();
  }

  render() {
    if (!this.open) return nothing;

    return html`
      <div
        class="confirm-backdrop"
        data-testid="confirm-backdrop"
        @click=${this.onBackdropClick}
      >
        <div
          class="confirm-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          data-testid="confirm-dialog"
        >
          <h3 id="confirm-title">${this.heading}</h3>
          ${this.body ? html`<p class="confirm-body">${this.body}</p>` : nothing}

          <div class="confirm-actions">
            <button
              class="btn"
              @click=${this.cancel}
              ?disabled=${this.busy}
              data-testid="confirm-cancel"
            >
              ${this.cancelLabel}
            </button>
            <button
              class="btn primary ${this.destructive ? 'danger' : ''}"
              @click=${this.accept}
              ?disabled=${this.busy}
              data-testid="confirm-accept"
            >
              ${this.busy ? html`<span class="spinner"></span>` : nothing} ${this.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'eps-confirm-dialog': EpsConfirmDialog;
  }
}
