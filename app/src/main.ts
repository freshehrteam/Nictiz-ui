/**
 * Shoelace's theme stylesheet defines every `--sl-*` design token the `sl-*`
 * components inside Medblocks depend on. Without it those tokens resolve to
 * empty and the components collapse to unstyled browser defaults (inputs render
 * at 22px instead of ~40px).
 *
 * Medblocks does NOT import it for you — it is a peer responsibility of the
 * host app, and nothing warns you when it is missing. It must come BEFORE our
 * own stylesheets so `theme.css` can override the tokens it defines.
 */
import '@shoelace-style/shoelace/dist/themes/light.css';
import './styles/theme.css';
import './styles/views.css';
import './shell';

import { resolveUser } from './auth/session';

/**
 * Identity is resolved BEFORE the shell mounts.
 *
 * `composer` is mandatory at the COMPOSITION root and is read synchronously
 * during form render. Mounting first and resolving after would let a form open
 * against the fallback user and file a composition attributed to nobody — a
 * wrong value written to the CDR, not merely a late-updating label.
 *
 * Wrapped in a function rather than written as a top-level await: Vite's
 * default browser target does not support top-level await, and raising the
 * whole app's baseline for one call would be the wrong trade.
 *
 * `resolveUser()` never rejects (it falls back internally), so there is no
 * failure path here that should stop the app from starting.
 */
async function bootstrap(): Promise<void> {
  await resolveUser();
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = '<eps-app></eps-app>';
}

void bootstrap();
