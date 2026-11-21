// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../../config';
import { StorageService } from '../storage-service';
import {
  ActivationService,
  PANEL_PLAYLIST_ID,
  playlistFromDomain,
} from './activation-service';
import { resetDeviceIdentityForTests } from './device-identity';
import { PanelClient } from './panel-client';

const API = CONFIG.XSOL.API_PREFIX;
const XTREAM = 'http://host:8080/get.php?username=u1&password=p%261&type=m3u_plus&output=ts';

let checkReply: { status: number; data: Record<string, unknown> };
let registerReply: { status: number; data: Record<string, unknown> };
let offline: boolean;

function active(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activated: true, status: 'active', expiry_date: '2030-01-01 00:00:00', trial: false,
    lifetime: false, domain: '', has_playlist: false, manage_key: '123456', ...extra,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetDeviceIdentityForTests();
  PanelClient.resetForTests();
  ActivationService.resetForTests();
  offline = false;
  registerReply = {
    status: 200,
    data: {
      success: true, device_secret: new Array(65).join('1'),
      device_token: new Array(65).join('a'), manage_key: '123456',
    },
  };
  checkReply = { status: 200, data: active() };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (offline) throw new TypeError('offline');
    const path = url.slice(CONFIG.XSOL.PANEL_BASE_URL.length);
    const reply = path === `${API}/register` ? registerReply
      : path === `${API}/time` ? { status: 200, data: { success: true, server_time: 2000000000 } }
      : checkReply;
    return { status: reply.status, json: async () => reply.data };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('playlistFromDomain', () => {
  it('turns an Xtream get.php link into an Xtream account', () => {
    expect(playlistFromDomain(XTREAM, 'N1')).toEqual({
      id: PANEL_PLAYLIST_ID,
      name: 'N1',
      url: 'http://host:8080',
      source: 'xtream',
      xtream: { username: 'u1', password: 'p&1' },
    });
  });

  it('keeps a sub-path in the Xtream base', () => {
    const entry = playlistFromDomain('https://host/a/b/get.php?password=p1&USERNAME=u1', 'N1');
    expect(entry?.url).toBe('https://host/a/b');
    expect(entry?.xtream).toEqual({ username: 'u1', password: 'p1' });
  });

  it('keeps any other link as a plain M3U source', () => {
    expect(playlistFromDomain('http://host/a.m3u', 'N1')).toEqual({
      id: PANEL_PLAYLIST_ID, name: 'N1', url: 'http://host/a.m3u', source: 'url',
    });
    expect(playlistFromDomain('http://host/get.php?username=u1', 'N1')?.source).toBe('url');
  });

  it('rejects anything that is not an http link', () => {
    expect(playlistFromDomain('', 'N1')).toBeNull();
    expect(playlistFromDomain('ftp://host/a', 'N1')).toBeNull();
    expect(playlistFromDomain('javascript:alert(1)', 'N1')).toBeNull();
  });

  it('survives a malformed escape in the query string', () => {
    expect(playlistFromDomain('http://host/get.php?username=u1&password=%E0%A4%A&x=1', 'N1')?.source)
      .toBe('url');
  });
});

describe('ActivationService.refresh', () => {
  it('reports the device, the key and the activation the panel returns', async () => {
    checkReply.data = active({ trial: true, expiry_date: '2027-02-18T23:55:02.000000Z' });

    const changed = await ActivationService.refresh();

    expect(changed).toBe(false);
    const snapshot = ActivationService.snapshot;
    expect(snapshot.status).toBe('active');
    expect(snapshot.deviceId).toBe(StorageService.getDeviceLink().deviceId);
    expect(snapshot.manageKey).toBe('123456');
    expect(snapshot.trial).toBe(true);
    expect(snapshot.expiryDate).toBe('2027-02-18T23:55:02.000000Z');
  });

  it('adds the panel playlist next to the sources already on the TV', async () => {
    StorageService.setPlaylists([{ id: 'p1', name: 'P1', url: 'http://host/a' }]);
    checkReply.data = active({ domain: XTREAM, has_playlist: true });

    expect(await ActivationService.refresh()).toBe(true);

    const playlists = StorageService.getPlaylists();
    expect(playlists.map(item => item.id)).toEqual(['p1', PANEL_PLAYLIST_ID]);
    expect(playlists[1]).toMatchObject({
      source: 'xtream', url: 'http://host:8080', xtream: { username: 'u1', password: 'p&1' },
    });
    expect(ActivationService.snapshot.hasPlaylist).toBe(true);
  });

  it('reports no change when the same playlist comes back', async () => {
    checkReply.data = active({ domain: XTREAM, has_playlist: true });
    await ActivationService.refresh();

    expect(await ActivationService.refresh()).toBe(false);
    expect(StorageService.getPlaylists()).toHaveLength(1);
  });

  it('replaces the panel playlist in place and keeps what the user set on it', async () => {
    checkReply.data = active({ domain: XTREAM, has_playlist: true });
    await ActivationService.refresh();
    const stored = StorageService.getPlaylists();
    stored[0].enabled = false;
    stored[0].name = 'N2';
    stored.push({ id: 'p1', name: 'P1', url: 'http://host/a' });
    StorageService.setPlaylists(stored);

    checkReply.data = active({ domain: 'http://host/b.m3u', has_playlist: true });
    expect(await ActivationService.refresh()).toBe(true);

    const playlists = StorageService.getPlaylists();
    expect(playlists.map(item => item.id)).toEqual([PANEL_PLAYLIST_ID, 'p1']);
    expect(playlists[0]).toMatchObject({ url: 'http://host/b.m3u', source: 'url', enabled: false, name: 'N2' });
  });

  it('keeps the playlist while the panel is only withholding it', async () => {
    checkReply.data = active({ domain: XTREAM, has_playlist: true });
    await ActivationService.refresh();

    // Empty domain with has_playlist still true: ownership not proven, not an unlink.
    checkReply.data = active({ domain: '', has_playlist: true });
    expect(await ActivationService.refresh()).toBe(false);
    expect(StorageService.getPlaylists()).toHaveLength(1);
  });

  it('removes only the panel playlist once it is unlinked on the portal', async () => {
    StorageService.setPlaylists([{ id: 'p1', name: 'P1', url: 'http://host/a' }]);
    checkReply.data = active({ domain: XTREAM, has_playlist: true });
    await ActivationService.refresh();

    checkReply.data = active({ domain: '', has_playlist: false });
    expect(await ActivationService.refresh()).toBe(true);
    expect(StorageService.getPlaylists().map(item => item.id)).toEqual(['p1']);
  });

  it.each([
    [{ activated: false, status: 'expired' }, 'expired'],
    [{ activated: false, status: 'blocked' }, 'blocked'],
    [{ activated: false, status: 'inactive' }, 'inactive'],
  ] as const)('maps %j to %s', async (data, expected) => {
    checkReply.data = { ...data, manage_key: '123456' };

    await ActivationService.refresh();

    expect(ActivationService.snapshot.status).toBe(expected);
  });

  it('is offline when the panel cannot be reached, keeping the identity on screen', async () => {
    await ActivationService.refresh();
    offline = true;

    expect(await ActivationService.refresh()).toBe(false);

    const snapshot = ActivationService.snapshot;
    expect(snapshot.status).toBe('offline');
    expect(snapshot.deviceId).toMatch(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
    expect(snapshot.manageKey).toBe('123456');
  });

  it('shows the MAC even when the very first contact fails', async () => {
    offline = true;

    await ActivationService.refresh();

    expect(ActivationService.snapshot.status).toBe('offline');
    expect(ActivationService.snapshot.deviceId).toMatch(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
    expect(ActivationService.snapshot.manageKey).toBe('');
  });

  it('is refused, with the panel code, when registration is rejected', async () => {
    registerReply = { status: 409, data: { success: false, message: 'device_already_registered' } };

    await ActivationService.refresh();

    expect(ActivationService.snapshot.status).toBe('refused');
    expect(ActivationService.snapshot.errorCode).toBe('device_already_registered');
  });

  it('is refused when a signed call is rejected for good', async () => {
    checkReply = { status: 401, data: { success: false, message: 'credential_revoked' } };

    await ActivationService.refresh();

    expect(ActivationService.snapshot.status).toBe('refused');
    expect(ActivationService.snapshot.errorCode).toBe('credential_revoked');
  });

  it('names the linked playlist as it was saved on the portal', async () => {
    checkReply.data = active({
      domain: XTREAM, has_playlist: true,
      web_playlists: [
        { id: 1, name: 'N1', m3u_url: 'http://host/other.m3u' },
        { id: 2, name: 'N2', m3u_url: XTREAM },
      ],
    });

    await ActivationService.refresh();

    expect(ActivationService.snapshot.playlistName).toBe('N2');
  });

  it('falls back to the account, then the server, for the playlist name', async () => {
    checkReply.data = active({ domain: XTREAM, has_playlist: true });
    await ActivationService.refresh();
    expect(ActivationService.snapshot.playlistName).toBe('u1');

    checkReply.data = active({ domain: 'http://host:8080/a/b.m3u', has_playlist: true });
    await ActivationService.refresh();
    expect(ActivationService.snapshot.playlistName).toBe('host:8080');
  });

  it('has no name while the panel withholds the playlist, but still reports one linked', async () => {
    checkReply.data = active({ domain: '', has_playlist: true });

    await ActivationService.refresh();

    expect(ActivationService.snapshot.playlistName).toBe('');
    expect(ActivationService.snapshot.hasPlaylist).toBe(true);
  });

  it('does not take a server-only address for a playlist', async () => {
    // What a redeemed code leaves on the panel until the user signs in with an account.
    checkReply.data = active({ domain: 'http://host:8080', has_playlist: true });

    expect(await ActivationService.refresh()).toBe(false);

    expect(StorageService.getPlaylists()).toEqual([]);
    expect(ActivationService.snapshot.hasPlaylist).toBe(false);
    expect(ActivationService.snapshot.playlistName).toBe('');
  });

  it('notifies subscribers and stops after unsubscribe', async () => {
    const seen: string[] = [];
    const stop = ActivationService.subscribe(snapshot => seen.push(snapshot.status));

    await ActivationService.refresh();
    stop();
    await ActivationService.refresh();

    expect(seen).toEqual(['active']);
  });

  it('shares one request between concurrent callers', async () => {
    await Promise.all([ActivationService.refresh(), ActivationService.refresh()]);

    const calls = vi.mocked(fetch).mock.calls.filter(call => String(call[0]).indexOf('check-activation') !== -1);
    expect(calls).toHaveLength(1);
  });
});
