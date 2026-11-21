import { CONFIG } from '../../config';
import { StorageService } from '../storage-service';
import { normalizeXtreamBaseUrl } from '../../utils/xtream-url';
import { createLogger } from '../../utils/logger';
import type { PlaylistEntry } from '../../types';
import { resolveDeviceIdentity } from './device-identity';
import { PanelClient, PanelError, type PanelData } from './panel-client';

const log = createLogger('Activation');

/** Fixed id of the one source the panel manages; everything else the user added stays untouched. */
export const PANEL_PLAYLIST_ID = 'xsol-panel';

export type ActivationStatus =
  | 'connecting'  // no answer from the panel yet
  | 'active'
  | 'expired'
  | 'blocked'
  | 'inactive'    // the panel does not know this device, or an admin removed it
  | 'offline'     // the panel could not be reached
  | 'refused';    // the panel will not register this device (see errorCode)

export interface ActivationSnapshot {
  status: ActivationStatus;
  deviceId: string;
  manageKey: string;
  /** Panel expiry as an ISO-ish string, or '' when unknown. */
  expiryDate: string;
  trial: boolean;
  lifetime: boolean;
  /** True when the panel holds a playlist for this device. */
  hasPlaylist: boolean;
  /** Name of the playlist the panel has linked, '' when none or not disclosed. */
  playlistName: string;
  /** Panel code behind 'refused'. */
  errorCode: string;
}

type Listener = (snapshot: ActivationSnapshot) => void;

let current: ActivationSnapshot = {
  status: 'connecting',
  deviceId: '',
  manageKey: '',
  expiryDate: '',
  trial: false,
  lifetime: false,
  hasPlaylist: false,
  playlistName: '',
  errorCode: '',
};
const listeners: Listener[] = [];
let inFlight: Promise<boolean> | null = null;

function publish(next: ActivationSnapshot): void {
  current = next;
  for (const listener of listeners.slice()) listener(current);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// `http://host:port` with nothing after it: a server, not yet a playlist. A code
// that only names the provider's server leaves exactly this on the panel until
// the user signs in with an account.
export function isServerOnlyUrl(url: string): boolean {
  return /^https?:\/\/[^/?#]+\/?$/i.test(url.trim());
}

// What to call the linked playlist on screen: the name it was saved under on the
// portal, else the account, else the server.
function playlistNameFrom(data: PanelData, domain: string): string {
  const saved = data.web_playlists;
  if (Array.isArray(saved)) {
    for (let i = 0; i < saved.length; i++) {
      const item = saved[i] as { name?: unknown; m3u_url?: unknown } | null;
      if (item && text(item.m3u_url) === domain && text(item.name)) return text(item.name);
    }
  }
  const entry = playlistFromDomain(domain, '');
  if (!entry) return '';
  if (entry.xtream) return entry.xtream.username;
  return entry.url.replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
}

/**
 * The panel hands the active playlist over as one M3U URL. An Xtream `get.php`
 * link becomes an Xtream account, so Movies, Series and the derived guide work;
 * anything else stays a plain M3U source.
 */
export function playlistFromDomain(domain: string, name: string): PlaylistEntry | null {
  const url = domain.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  const params: Record<string, string> = {};
  if (queryStart !== -1) {
    const pairs = url.slice(queryStart + 1).split('#')[0].split('&');
    for (let i = 0; i < pairs.length; i++) {
      const eq = pairs[i].indexOf('=');
      if (eq <= 0) continue;
      try {
        params[decodeURIComponent(pairs[i].slice(0, eq)).toLowerCase()] =
          decodeURIComponent(pairs[i].slice(eq + 1).replace(/\+/g, ' '));
      } catch {
        // A malformed escape in one parameter must not discard the whole playlist.
      }
    }
  }
  const username = params.username ?? '';
  const password = params.password ?? '';
  if (/\/get\.php$/i.test(path) && username && password) {
    return {
      id: PANEL_PLAYLIST_ID,
      name,
      url: normalizeXtreamBaseUrl(path.replace(/\/get\.php$/i, '')),
      source: 'xtream',
      xtream: { username, password },
    };
  }
  return { id: PANEL_PLAYLIST_ID, name, url, source: 'url' };
}

function sameSource(a: PlaylistEntry, b: PlaylistEntry): boolean {
  return a.url === b.url
    && (a.source ?? 'url') === (b.source ?? 'url')
    && (a.xtream?.username ?? '') === (b.xtream?.username ?? '')
    && (a.xtream?.password ?? '') === (b.xtream?.password ?? '');
}

/** Returns true when the stored sources changed and channel data must be reloaded. */
function applyPanelPlaylist(data: PanelData): boolean {
  const playlists = StorageService.getPlaylists();
  const index = playlists.findIndex(item => item.id === PANEL_PLAYLIST_ID);
  const domain = text(data.domain);

  if (!domain) {
    // An empty `domain` with `has_playlist: true` only means the panel is
    // withholding it (ownership not proven yet). Drop the source only when the
    // panel says there is none any more, i.e. it was unlinked on the portal.
    if (data.has_playlist === false && index !== -1) {
      playlists.splice(index, 1);
      StorageService.setPlaylists(playlists);
      log.info('Panel playlist removed', 'event=activation.playlist.removed');
      return true;
    }
    return false;
  }

  if (isServerOnlyUrl(domain)) return false;

  const existing = index === -1 ? null : playlists[index];
  const next = playlistFromDomain(domain, existing?.name || CONFIG.APP_NAME);
  if (!next) return false;
  if (existing && sameSource(existing, next)) return false;
  // Keep what the user set on the entry (disabled state, live output) across a change of URL.
  if (existing) {
    if (existing.enabled === false) next.enabled = false;
    if (next.xtream && existing.xtream?.liveOutput) next.xtream.liveOutput = existing.xtream.liveOutput;
    playlists[index] = next;
  } else {
    playlists.push(next);
  }
  StorageService.setPlaylists(playlists);
  log.info('Panel playlist applied', 'event=activation.playlist.applied', `kind=${next.source}`);
  return true;
}

function statusFrom(data: PanelData): ActivationStatus {
  if (data.activated === true) return 'active';
  const status = text(data.status).toLowerCase();
  if (status === 'blocked') return 'blocked';
  if (status === 'expired') return 'expired';
  return 'inactive';
}

async function check(): Promise<boolean> {
  const identity = await resolveDeviceIdentity();
  const link = StorageService.getDeviceLink();
  const base: ActivationSnapshot = {
    ...current,
    deviceId: identity.deviceId,
    manageKey: link.manageKey ?? current.manageKey,
  };
  try {
    const response = await PanelClient.checkActivation();
    const data = response.data;
    if (response.status !== 200) {
      publish({ ...base, status: 'refused', errorCode: text(data.message) || `http_${response.status}` });
      return false;
    }
    const changed = applyPanelPlaylist(data);
    const expiry = data.expiry_date;
    const domain = text(data.domain);
    publish({
      status: statusFrom(data),
      deviceId: identity.deviceId,
      manageKey: StorageService.getDeviceLink().manageKey ?? '',
      expiryDate: typeof expiry === 'string' ? expiry : '',
      trial: data.trial === true,
      lifetime: data.lifetime === true,
      hasPlaylist: data.has_playlist === true && !isServerOnlyUrl(domain),
      playlistName: domain && !isServerOnlyUrl(domain) ? playlistNameFrom(data, domain) : '',
      errorCode: '',
    });
    return changed;
  } catch (error) {
    if (error instanceof PanelError && error.code !== 'network') {
      publish({ ...base, status: 'refused', errorCode: error.code });
    } else {
      publish({ ...base, status: 'offline', errorCode: '' });
    }
    return false;
  }
}

export const ActivationService = {
  get snapshot(): ActivationSnapshot {
    return current;
  },

  /** The portal page for this device, MAC prefilled; what the QR code carries. */
  portalUrl(deviceId: string): string {
    return `${CONFIG.XSOL.PORTAL_URL}/?device_id=${encodeURIComponent(deviceId)}`;
  },

  subscribe(listener: Listener): () => void {
    listeners.push(listener);
    return () => {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    };
  },

  /**
   * Asks the panel for this device's state and applies the playlist it holds.
   * Resolves true when the stored sources changed. Concurrent callers share one request.
   */
  refresh(): Promise<boolean> {
    if (inFlight) return inFlight;
    inFlight = check().then(
      (changed) => { inFlight = null; return changed; },
      (error) => { inFlight = null; throw error; },
    );
    return inFlight;
  },

  resetForTests(): void {
    inFlight = null;
    listeners.length = 0;
    current = {
      status: 'connecting', deviceId: '', manageKey: '', expiryDate: '',
      trial: false, lifetime: false, hasPlaylist: false, playlistName: '', errorCode: '',
    };
  },
};
