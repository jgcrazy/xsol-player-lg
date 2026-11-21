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
  /** Names of the playlists the panel holds for this device, comma separated; '' when none or not disclosed. */
  playlistName: string;
  /** Panel code behind 'refused'. */
  errorCode: string;
  /** False when the panel has switched activation enforcement off for everyone. */
  enforced: boolean;
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
  enforced: true,
};
let hydrated = false;
const listeners: Listener[] = [];
let inFlight: Promise<boolean> | null = null;

// Before the panel has answered in this run, start from what it said last time:
// an expired or blocked device must not get a free session by launching offline.
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const link = StorageService.getDeviceLink();
  if (link.deviceId) current.deviceId = link.deviceId;
  if (link.manageKey) current.manageKey = link.manageKey;
  if (link.lockedStatus === 'expired' || link.lockedStatus === 'blocked') current.status = link.lockedStatus;
}

function rememberLock(status: ActivationStatus, enforced: boolean): void {
  const link = StorageService.getDeviceLink();
  const locked = enforced && (status === 'expired' || status === 'blocked') ? status : undefined;
  if (link.lockedStatus === locked) return;
  if (locked) link.lockedStatus = locked;
  else delete link.lockedStatus;
  StorageService.setDeviceLink(link);
}

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

const PANEL_ID_PREFIX = 'xsol-';
const WEB_PLAYLIST_ID_PREFIX = 'xsol-web-';

function isPanelManaged(entry: PlaylistEntry): boolean {
  return entry.id.indexOf(PANEL_ID_PREFIX) === 0;
}

// Fallback label for a source the portal did not name: the account, else the server.
function defaultName(entry: PlaylistEntry): string {
  if (entry.xtream) return entry.xtream.username;
  return entry.url.replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
}

/**
 * The sources the panel holds for this device: every playlist saved on the
 * portal, as the other XSol apps list them, plus the active one when it was set
 * some other way (a code, a sign-in on the TV, the partner API). Null when the
 * answer does not say, so nothing is removed on a guess.
 */
function panelSources(data: PanelData, stored: PlaylistEntry[]): PlaylistEntry[] | null {
  const domain = text(data.domain);
  const saved = data.web_playlists;
  const result: PlaylistEntry[] = [];
  let activeIsSaved = false;

  if (Array.isArray(saved)) {
    for (let i = 0; i < saved.length; i++) {
      const item = saved[i] as { id?: unknown; name?: unknown; m3u_url?: unknown } | null;
      const url = item ? text(item.m3u_url) : '';
      const id = item && (typeof item.id === 'number' || typeof item.id === 'string') ? String(item.id) : '';
      if (!id || !url || isServerOnlyUrl(url)) continue;
      const entry = playlistFromDomain(url, '');
      if (!entry) continue;
      entry.id = WEB_PLAYLIST_ID_PREFIX + id;
      entry.name = text(item!.name) || defaultName(entry);
      if (url === domain) activeIsSaved = true;
      result.push(entry);
    }
  } else if (!domain && data.has_playlist !== false) {
    return null;
  }

  const kept = stored.filter(item => item.id === PANEL_PLAYLIST_ID)[0];
  if (domain && !isServerOnlyUrl(domain) && !activeIsSaved) {
    const entry = playlistFromDomain(domain, '');
    if (entry) {
      // A name the user gave it survives a change of URL; the automatic one follows the new source.
      entry.name = kept && kept.name && kept.name !== defaultName(kept) ? kept.name : defaultName(entry);
      result.push(entry);
    }
  } else if (!domain && data.has_playlist === true && kept) {
    // An empty `domain` with `has_playlist: true` only means the panel is
    // withholding it (ownership not proven yet), not that it was unlinked.
    result.push(kept);
  }
  return result;
}

/** Returns true when the stored sources changed and channel data must be reloaded. */
function applyPanelPlaylist(data: PanelData): { changed: boolean; names: string[] } {
  const stored = StorageService.getPlaylists();
  const wanted = panelSources(data, stored);
  if (wanted === null) {
    return { changed: false, names: stored.filter(isPanelManaged).map(item => item.name) };
  }

  let changed = false;
  const byId: Record<string, PlaylistEntry> = {};
  for (let i = 0; i < wanted.length; i++) byId[wanted[i].id] = wanted[i];

  const next: PlaylistEntry[] = [];
  const placed: Record<string, boolean> = {};
  for (let i = 0; i < stored.length; i++) {
    const existing = stored[i];
    if (!isPanelManaged(existing)) {
      next.push(existing);
      continue;
    }
    const update = byId[existing.id];
    if (!update) {
      changed = true;
      continue;
    }
    placed[existing.id] = true;
    if (sameSource(existing, update) && existing.name === update.name) {
      next.push(existing);
      continue;
    }
    // Keep what the user set on the entry (disabled state, live output) across a change.
    if (existing.enabled === false) update.enabled = false;
    if (update.xtream && existing.xtream?.liveOutput) update.xtream.liveOutput = existing.xtream.liveOutput;
    next.push(update);
    changed = true;
  }
  for (let i = 0; i < wanted.length; i++) {
    if (placed[wanted[i].id]) continue;
    next.push(wanted[i]);
    changed = true;
  }

  if (changed) {
    StorageService.setPlaylists(next);
    log.info('Panel playlists synced', 'event=activation.playlist.synced', `count=${wanted.length}`);
  }
  return { changed, names: wanted.map(item => item.name) };
}

function statusFrom(data: PanelData): ActivationStatus {
  if (data.activated === true) return 'active';
  const status = text(data.status).toLowerCase();
  if (status === 'blocked') return 'blocked';
  if (status === 'expired') return 'expired';
  return 'inactive';
}

// The playlist the panel has as this device's active one, as last reported.
let activeDomain = '';

function panelAccepted(response: { status: number; data: PanelData }): boolean {
  return response.status === 200 && response.data.success === true;
}

async function removeSource(id: string): Promise<boolean> {
  const stored = StorageService.getPlaylists();
  const entry = stored.filter(item => item.id === id)[0];
  if (!entry) return true;
  try {
    if (isPanelManaged(entry)) {
      if (id.indexOf(WEB_PLAYLIST_ID_PREFIX) === 0) {
        const response = await PanelClient.deleteWebPlaylist(id.slice(WEB_PLAYLIST_ID_PREFIX.length));
        if (!panelAccepted(response)) return false;
      }
      // Left as the active playlist, it would come straight back on the next check.
      const active = activeDomain ? playlistFromDomain(activeDomain, '') : null;
      if (id === PANEL_PLAYLIST_ID || (active && sameSource(active, entry))) {
        if (!panelAccepted(await PanelClient.deletePlaylist())) return false;
        activeDomain = '';
      }
    }
  } catch (error) {
    log.warn('Playlist removal failed', 'event=activation.playlist.remove_failed', error);
    return false;
  }
  StorageService.setPlaylists(StorageService.getPlaylists().filter(item => item.id !== id));
  log.info('Playlist removed', 'event=activation.playlist.removed');
  return true;
}

async function check(): Promise<boolean> {
  hydrate();
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
    activeDomain = text(data.domain);
    const synced = applyPanelPlaylist(data);
    const changed = synced.changed;
    const expiry = data.expiry_date;
    const status = statusFrom(data);
    const enforced = data.activation_enforced !== false;
    rememberLock(status, enforced);
    publish({
      status,
      enforced,
      deviceId: identity.deviceId,
      manageKey: StorageService.getDeviceLink().manageKey ?? '',
      expiryDate: typeof expiry === 'string' ? expiry : '',
      trial: data.trial === true,
      lifetime: data.lifetime === true,
      hasPlaylist: synced.names.length > 0
        || (data.has_playlist === true && !isServerOnlyUrl(text(data.domain))),
      playlistName: synced.names.join(', '),
      errorCode: '',
    });
    return changed;
  } catch (error) {
    if (error instanceof PanelError && error.code !== 'network') {
      publish({ ...base, status: 'refused', errorCode: error.code });
    } else {
      // Unreachable is not a way out of a lock: keep showing what the panel last said.
      const locked = StorageService.getDeviceLink().lockedStatus;
      publish({ ...base, status: locked ?? 'offline', errorCode: '' });
    }
    return false;
  }
}

export const ActivationService = {
  get snapshot(): ActivationSnapshot {
    hydrate();
    return current;
  },

  /** True while the panel has this device expired or blocked and enforces activation. */
  get locked(): boolean {
    const snapshot = this.snapshot;
    return snapshot.enforced && (snapshot.status === 'expired' || snapshot.status === 'blocked');
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

  /**
   * Removes one source for good: on the panel too when it lives there, so the
   * next check does not bring it back. Resolves false when the panel refused
   * or could not be reached, leaving the source in place.
   */
  removePlaylist(id: string): Promise<boolean> {
    return removeSource(id);
  },

  resetForTests(): void {
    activeDomain = '';
    hydrated = false;
    inFlight = null;
    listeners.length = 0;
    current = {
      status: 'connecting', deviceId: '', manageKey: '', expiryDate: '',
      trial: false, lifetime: false, hasPlaylist: false, playlistName: '', errorCode: '',
      enforced: true,
    };
  },
};
