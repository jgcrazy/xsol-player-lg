import { CONFIG } from '../../config';
import { StorageService } from '../storage-service';
import { hmacSha256Hex } from '../../utils/sha256';
import { createLogger } from '../../utils/logger';
import { resolveDeviceIdentity } from './device-identity';

const log = createLogger('Panel');

export type PanelData = Record<string, unknown>;

export interface PanelResponse {
  /** HTTP status; the panel answers business refusals (409, 403, ...) with a JSON body. */
  status: number;
  data: PanelData;
}

/** Transport or registration failure: there is no usable panel answer to interpret. */
export class PanelError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`Panel request failed: ${code}`);
    this.name = 'PanelError';
  }
}

export interface WatchingInfo {
  type: 'live' | 'movie' | 'series';
  title: string;
  streamId?: string;
  extra?: string;
}

let clockOffsetSec = 0;
let clockSynced = false;
let lastForcedRegisterAt = 0;
let registering: Promise<void> | null = null;

function serverNowSec(): number {
  return Math.floor(Date.now() / 1000) + clockOffsetSec;
}

// TV clocks are often wrong, and the panel only accepts signatures within five
// minutes of its own time. Every answer carries `server_time`, since the `Date`
// header is not readable across origins.
function applyServerTime(value: unknown): void {
  if (typeof value !== 'number' || !(value > 0)) return;
  clockOffsetSec = Math.floor(value) - Math.floor(Date.now() / 1000);
  clockSynced = true;
}

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  const cryptoApi = typeof crypto !== 'undefined' ? crypto : undefined;
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return hex;
}

async function send(
  method: 'GET' | 'POST',
  path: string,
  rawBody: string | null,
  headers: Record<string, string>,
): Promise<PanelResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.XSOL.REQUEST_TIMEOUT_MS);
  try {
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (rawBody !== null) init.body = rawBody;
    const response = await fetch(CONFIG.XSOL.PANEL_BASE_URL + path, init);
    let data: PanelData = {};
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === 'object') data = parsed as PanelData;
    } catch {
      // A proxy or rate limiter can answer without JSON; the status still tells the caller.
    }
    applyServerTime(data.server_time);
    return { status: response.status, data };
  } catch (error) {
    log.warn('Panel unreachable', 'event=panel.request.failed', `path=${path}`, error);
    throw new PanelError(0, 'network');
  } finally {
    clearTimeout(timer);
  }
}

// The panel issues the ownership token to whoever it answers first and never
// repeats it, so it is stored the moment it appears, before any caller can bail
// out on the rest of the answer. Losing it leaves the playlist withheld for good.
function captureLinkFields(data: PanelData): void {
  const token = typeof data.device_token === 'string' ? data.device_token.trim() : '';
  const key = typeof data.manage_key === 'string' ? data.manage_key.trim() : '';
  const state = StorageService.getDeviceLink();
  let changed = false;
  if (token.length >= 32 && state.deviceToken !== token) {
    state.deviceToken = token;
    changed = true;
  }
  if (/^\d{6}$/.test(key) && state.manageKey !== key) {
    state.manageKey = key;
    changed = true;
  }
  if (changed) StorageService.setDeviceLink(state);
}

async function register(): Promise<void> {
  const identity = await resolveDeviceIdentity();
  const body = JSON.stringify({
    device_id: identity.deviceId,
    device_proof: identity.proof,
    device_name: CONFIG.XSOL.DEVICE_NAME,
    app_version: CONFIG.VERSION,
    platform: 'webos',
  });
  const response = await send('POST', `${CONFIG.XSOL.API_PREFIX}/register`, body, {
    'Content-Type': 'application/json',
  });
  const secret = typeof response.data.device_secret === 'string' ? response.data.device_secret : '';
  if (response.status !== 200 || response.data.success !== true || secret.length < 32) {
    const code = typeof response.data.message === 'string' && response.data.message
      ? response.data.message
      : 'registration_failed';
    log.warn('Device registration refused', 'event=panel.register.refused',
      `status=${response.status}`, `code=${code}`);
    throw new PanelError(response.status, code);
  }
  const state = StorageService.getDeviceLink();
  state.secret = secret;
  // A new secret always comes with a new ownership token; the old one is dead.
  delete state.deviceToken;
  StorageService.setDeviceLink(state);
  captureLinkFields(response.data);
  log.info('Device registered', 'event=panel.register.completed',
    `reissued=${String(response.data.reissued === true)}`);
}

function ensureRegistered(force = false): Promise<void> {
  if (!force && StorageService.getDeviceLink().secret) return Promise.resolve();
  if (registering) return registering;
  registering = register().then(
    () => { registering = null; },
    (error) => { registering = null; throw error; },
  );
  return registering;
}

async function signedPost(endpoint: string, fields: PanelData): Promise<PanelResponse> {
  await ensureRegistered();
  if (!clockSynced) {
    try {
      await PanelClient.syncClock();
    } catch {
      // The first signed answer carries server_time too; the retry below uses it.
    }
  }

  const path = `${CONFIG.XSOL.API_PREFIX}/${endpoint}`;
  let recovered = false;
  for (;;) {
    const link = StorageService.getDeviceLink();
    const deviceId = link.deviceId ?? '';
    const secret = link.secret ?? '';
    const body: PanelData = { device_id: deviceId, app_version: CONFIG.VERSION };
    if (link.deviceToken) body.device_token = link.deviceToken;
    for (const key in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) body[key] = fields[key];
    }
    // The exact bytes sent are the bytes signed.
    const rawBody = JSON.stringify(body);
    const timestamp = String(serverNowSec());
    const nonce = randomHex(16);
    const signature = hmacSha256Hex(secret, `${timestamp}\n${nonce}\nPOST\n${path}\n${rawBody}`);

    const response = await send('POST', path, rawBody, {
      'Content-Type': 'application/json',
      'X-Device-Id': deviceId,
      'X-Device-Timestamp': timestamp,
      'X-Device-Nonce': nonce,
      'X-Device-Signature': signature,
    });
    captureLinkFields(response.data);

    if (response.status !== 401 || recovered) return response;
    const code = typeof response.data.message === 'string' ? response.data.message : '';
    if (code === 'timestamp_expired') {
      // send() already took the panel's server_time; sign again with it.
      recovered = true;
      continue;
    }
    // The panel no longer knows this secret (admin reset, or the record was removed):
    // register again. A matching hardware proof gets the same device back.
    const canRegisterAgain = Date.now() - lastForcedRegisterAt >= CONFIG.XSOL.REGISTER_RETRY_MIN_MS;
    if ((code === 'unknown_device' || code === 'invalid_signature') && canRegisterAgain) {
      lastForcedRegisterAt = Date.now();
      recovered = true;
      await ensureRegistered(true);
      continue;
    }
    return response;
  }
}

export const PanelClient = {
  async syncClock(): Promise<void> {
    const response = await send('GET', `${CONFIG.XSOL.API_PREFIX}/time`, null, {});
    if (!clockSynced) throw new PanelError(response.status, 'clock_sync_failed');
  },

  /** Registers on first use; a no-op once this TV holds a secret. */
  ensureRegistered(): Promise<void> {
    return ensureRegistered();
  },

  checkActivation(): Promise<PanelResponse> {
    return signedPost('check-activation', { device_name: CONFIG.XSOL.DEVICE_NAME });
  },

  /** Explicit user action only: the panel will not revive an admin-deleted device on a passive check. */
  activateDevice(): Promise<PanelResponse> {
    return signedPost('activate-device', { device_name: CONFIG.XSOL.DEVICE_NAME });
  },

  heartbeat(watching?: WatchingInfo | null): Promise<PanelResponse> {
    const fields: PanelData = {};
    if (watching === null) {
      // Present-but-empty tells the panel to clear "watching now".
      fields.watching_type = '';
      fields.watching_title = '';
    } else if (watching) {
      fields.watching_type = watching.type;
      fields.watching_title = watching.title;
      if (watching.streamId) fields.watching_stream_id = watching.streamId;
      if (watching.extra) fields.watching_extra = watching.extra;
    }
    return signedPost('heartbeat', fields);
  },

  bindAccount(account: {
    username: string;
    password: string;
    serverHost?: string;
    displayName?: string;
    manual?: boolean;
  }): Promise<PanelResponse> {
    const fields: PanelData = { username: account.username, password: account.password };
    if (account.serverHost) fields.server_host = account.serverHost;
    if (account.displayName) fields.display_name = account.displayName;
    if (account.manual) fields.manual = true;
    return signedPost('bind-account', fields);
  },

  savePlaylist(playlistUrl: string): Promise<PanelResponse> {
    return signedPost('save-playlist', { playlist_url: playlistUrl });
  },

  deletePlaylist(): Promise<PanelResponse> {
    return signedPost('delete-playlist', {});
  },

  /** Deletes one playlist saved on the portal; `playlistId` is the portal's own id. */
  deleteWebPlaylist(playlistId: string): Promise<PanelResponse> {
    return signedPost('delete-device-web-playlist', { playlist_id: playlistId });
  },

  redeemPlaylistCode(code: string): Promise<PanelResponse> {
    return signedPost('redeem-playlist-code', { code, device_name: CONFIG.XSOL.DEVICE_NAME });
  },

  webPlaylists(): Promise<PanelResponse> {
    return signedPost('device-web-playlists', {});
  },

  /** Test seam: module state survives between cases otherwise. */
  resetForTests(): void {
    clockOffsetSec = 0;
    clockSynced = false;
    lastForcedRegisterAt = 0;
    registering = null;
  },
};
