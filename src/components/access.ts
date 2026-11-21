import type { Action } from '../types';
import { CONFIG } from '../config';
import { SpatialNav } from '../navigation/spatial-nav';
import {
  ActivationService,
  type ActivationSnapshot,
} from '../services/xsol/activation-service';
import { html, raw } from '../utils/dom';
import { morph } from '../utils/morph';
import { qrDataUrl } from '../utils/qr';
import { getLocale, t, type TextMessageKey } from '../i18n';
import { BACK_ICON, RESYNC_ICON } from './icons';

interface AccessHandlers {
  /** The panel delivered (or withdrew) a playlist: channel data must be reloaded. */
  onPlaylistChanged: () => void;
  onBack: () => void;
  /** Up from the top row: hand focus to the tab bar. Returns false when there is none. */
  onRevealTabBar: () => boolean;
}

const STATUS_KEY: Record<ActivationSnapshot['status'], TextMessageKey> = {
  connecting: 'access.status.connecting',
  active: 'access.status.active',
  expired: 'access.status.expired',
  blocked: 'access.status.blocked',
  inactive: 'access.status.inactive',
  offline: 'access.status.offline',
  refused: 'access.status.refused',
};

function formatKey(key: string): string {
  return key.length === 6 ? `${key.slice(0, 3)} ${key.slice(3)}` : key;
}

// The panel sends either "YYYY-MM-DD HH:MM:SS" or an ISO timestamp.
function formatExpiry(raw: string): string {
  const parsed = new Date(raw.indexOf('T') === -1 ? raw.replace(' ', 'T') : raw);
  if (isNaN(parsed.getTime())) return '';
  try {
    return parsed.toLocaleDateString(getLocale());
  } catch {
    return parsed.toLocaleDateString();
  }
}

/**
 * The "Access" section: shows the MAC and key the customer types on the portal,
 * a QR code that opens the portal for this device, and the activation state.
 * While it is on screen it polls the panel, so a playlist saved on the portal
 * reaches the TV without the user doing anything here.
 */
export class Access {
  private nav: SpatialNav;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private opened = false;
  private refreshing = false;
  private qrFor = '';
  private qrSrc = '';

  constructor(
    private container: HTMLElement,
    private handlers: AccessHandlers,
  ) {
    this.nav = new SpatialNav(container);
    this.container.setAttribute('data-self-activate', '');
    this.container.addEventListener('click', (event: MouseEvent) => {
      const control = (event.target as HTMLElement).closest<HTMLElement>('[data-focusable]');
      if (!control) return;
      this.nav.focus(control);
      this.activate(control);
    });
  }

  open(): void {
    if (!this.opened) {
      this.opened = true;
      this.unsubscribe = ActivationService.subscribe(() => this.render());
    }
    this.render();
    this.focusFirst();
    void this.poll();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  handleAction(action: Action): void {
    if (action === 'back') {
      this.handlers.onBack();
    } else if (action === 'select' && this.nav.focused) {
      this.activate(this.nav.focused);
    } else if (action === 'up') {
      if (!this.nav.move('up')) this.handlers.onRevealTabBar();
    } else if (action === 'down' || action === 'left' || action === 'right') {
      this.nav.move(action);
    }
  }

  private activate(control: HTMLElement): void {
    const action = control.dataset.accessAction;
    if (action === 'back') this.handlers.onBack();
    else if (action === 'refresh') void this.poll();
  }

  private focusFirst(): void {
    const first = this.container.querySelector<HTMLElement>('[data-focusable]');
    if (first) this.nav.focus(first);
  }

  private async poll(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.opened || this.refreshing) return;
    this.refreshing = true;
    this.render();
    let changed = false;
    try {
      changed = await ActivationService.refresh();
    } finally {
      this.refreshing = false;
    }
    if (!this.opened) return;
    this.render();
    if (changed) {
      this.handlers.onPlaylistChanged();
      return;
    }
    this.timer = setTimeout(() => { void this.poll(); }, CONFIG.XSOL.ACTIVATION_POLL_INTERVAL_MS);
  }

  private statusDetail(snapshot: ActivationSnapshot): string {
    if (snapshot.status === 'refused') {
      return snapshot.errorCode === 'device_already_registered'
        ? t('access.detail.alreadyRegistered')
        : t('access.detail.code', { code: snapshot.errorCode });
    }
    if (snapshot.status !== 'active') return '';
    if (snapshot.lifetime) return t('access.detail.lifetime');
    const date = formatExpiry(snapshot.expiryDate);
    if (!date) return '';
    return t(snapshot.trial ? 'access.detail.trialUntil' : 'access.detail.validUntil', { date });
  }

  private qr(deviceId: string): string {
    if (deviceId !== this.qrFor) {
      this.qrFor = deviceId;
      this.qrSrc = deviceId ? qrDataUrl(ActivationService.portalUrl(deviceId)) : '';
    }
    return this.qrSrc;
  }

  private render(): void {
    const snapshot = ActivationService.snapshot;
    const focusedAction = this.nav.focused?.dataset.accessAction ?? '';
    const detail = this.statusDetail(snapshot);
    const qr = this.qr(snapshot.deviceId);
    const portal = CONFIG.XSOL.PORTAL_URL.replace(/^https?:\/\//, '');
    morph(this.container, html`
      <div class="access-view">
        <header class="access-header">
          <button class="access-button" data-focusable data-access-action="back" data-key="access-back">
            <span class="access-button-icon">${raw(BACK_ICON)}</span>
            <span>${t('common.back')}</span>
          </button>
          <button class="access-button" data-focusable data-access-action="refresh" data-key="access-refresh">
            <span class="access-button-icon">${raw(RESYNC_ICON)}</span>
            <span>${t('access.refresh')}</span>
          </button>
        </header>
        <div class="access-body">
          <section class="access-identity" data-key="access-identity">
            <h1 class="access-title">${t('access.title')}</h1>
            <p class="access-intro">${t('access.intro', { portal })}</p>
            <dl class="access-codes">
              <div class="access-code" data-key="access-mac">
                <dt>${t('access.mac')}</dt>
                <dd class="access-code-value" id="access-mac">${snapshot.deviceId || '—'}</dd>
              </div>
              <div class="access-code" data-key="access-key">
                <dt>${t('access.key')}</dt>
                <dd class="access-code-value" id="access-key">${
                  snapshot.manageKey ? formatKey(snapshot.manageKey) : '—'}</dd>
              </div>
            </dl>
            <div class="access-status access-status--${snapshot.status}" data-key="access-status">
              <span class="access-status-dot"></span>
              <span class="access-status-text" id="access-status">${t(STATUS_KEY[snapshot.status])}</span>
              ${detail ? html`<span class="access-status-detail" id="access-status-detail">${detail}</span>` : ''}
            </div>
          </section>
          <section class="access-portal" data-key="access-portal">
            ${qr
              ? html`<img class="access-qr" data-key="access-qr" alt="${t('access.qrAlt')}" src="${qr}">`
              : html`<div class="access-qr access-qr--empty" data-key="access-qr-empty"></div>`}
            <p class="access-portal-hint">${t('access.qrHint')}</p>
            <p class="access-portal-url">${portal}</p>
          </section>
        </div>
      </div>
    `);
    // morph rewrites the class attribute, which drops the focus ring SpatialNav put there.
    if (focusedAction) {
      const again = this.container.querySelector<HTMLElement>(`[data-access-action="${focusedAction}"]`);
      if (again) this.nav.focus(again);
    }
  }
}
