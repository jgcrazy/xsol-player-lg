// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../../config';
import { StorageService } from '../storage-service';
import {
  ActivationService,
  PANEL_PLAYLIST_ID,
  playlistFromDomain,
  settleSingleAccess,
  useOnlyPlaylist,
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

  it('brings every playlist saved on the portal, not only the active one', async () => {
    StorageService.setPlaylists([{ id: 'p1', name: 'P1', url: 'http://host/a' }]);
    // Saved on the portal but never set as the device's active playlist.
    checkReply.data = active({
      domain: '', has_playlist: false,
      web_playlists: [
        { id: 7, name: 'N1', m3u_url: 'http://host/other.m3u' },
        { id: 9, name: 'N2', m3u_url: XTREAM },
      ],
    });

    expect(await ActivationService.refresh()).toBe(true);

    const playlists = StorageService.getPlaylists();
    expect(playlists.map(item => item.id)).toEqual(['p1', 'xsol-web-7', 'xsol-web-9']);
    expect(playlists[1]).toMatchObject({ name: 'N1', url: 'http://host/other.m3u', source: 'url' });
    expect(playlists[2]).toMatchObject({
      name: 'N2', source: 'xtream', url: 'http://host:8080', xtream: { username: 'u1', password: 'p&1' },
    });
    expect(ActivationService.snapshot.playlistName).toBe('N1, N2');
    expect(ActivationService.snapshot.hasPlaylist).toBe(true);
    expect(await ActivationService.refresh()).toBe(false);
  });

  it('does not list the active playlist twice when it is one of the saved ones', async () => {
    checkReply.data = active({
      domain: XTREAM, has_playlist: true,
      web_playlists: [{ id: 9, name: 'N2', m3u_url: XTREAM }],
    });

    await ActivationService.refresh();

    expect(StorageService.getPlaylists().map(item => item.id)).toEqual(['xsol-web-9']);
    expect(ActivationService.snapshot.playlistName).toBe('N2');
  });

  it('follows a rename, a removal and an addition made on the portal', async () => {
    checkReply.data = active({
      web_playlists: [
        { id: 7, name: 'N1', m3u_url: 'http://host/a.m3u' },
        { id: 9, name: 'N2', m3u_url: 'http://host/b.m3u' },
      ],
    });
    await ActivationService.refresh();
    const stored = StorageService.getPlaylists();
    stored[1].enabled = false;
    StorageService.setPlaylists(stored);

    checkReply.data = active({
      web_playlists: [
        { id: 9, name: 'N2 renamed', m3u_url: 'http://host/b.m3u' },
        { id: 11, name: 'N3', m3u_url: 'http://host/c.m3u' },
      ],
    });
    expect(await ActivationService.refresh()).toBe(true);

    const playlists = StorageService.getPlaylists();
    expect(playlists.map(item => item.id)).toEqual(['xsol-web-9', 'xsol-web-11']);
    // What the user set on the TV survives the rename.
    expect(playlists[0]).toMatchObject({ name: 'N2 renamed', enabled: false });
  });

  it('removes the saved playlists when the portal list is emptied, leaving the TV sources', async () => {
    StorageService.setPlaylists([{ id: 'p1', name: 'P1', url: 'http://host/a' }]);
    checkReply.data = active({ web_playlists: [{ id: 7, name: 'N1', m3u_url: 'http://host/a.m3u' }] });
    await ActivationService.refresh();

    checkReply.data = active({ web_playlists: [] });
    expect(await ActivationService.refresh()).toBe(true);

    expect(StorageService.getPlaylists().map(item => item.id)).toEqual(['p1']);
    expect(ActivationService.snapshot.playlistName).toBe('');
  });

  it('skips a saved entry it cannot use, without dropping the others', async () => {
    checkReply.data = active({
      web_playlists: [
        null,
        { id: 1, name: 'N1', m3u_url: 'ftp://host/a' },
        { id: 2, name: 'N2', m3u_url: 'http://host:8080' },
        { name: 'N3', m3u_url: 'http://host/c.m3u' },
        { id: 4, name: '', m3u_url: 'http://host/d.m3u' },
      ],
    });

    await ActivationService.refresh();

    const playlists = StorageService.getPlaylists();
    expect(playlists.map(item => item.id)).toEqual(['xsol-web-4']);
    expect(playlists[0].name).toBe('host');
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

  it.each(['expired', 'blocked'] as const)('locks the app while the panel reports %s', async (status) => {
    checkReply.data = { activated: false, status, manage_key: '123456' };

    await ActivationService.refresh();

    expect(ActivationService.locked).toBe(true);
    expect(StorageService.getDeviceLink().lockedStatus).toBe(status);
  });

  it('does not lock an inactive, offline or refused device', async () => {
    checkReply.data = { activated: false, status: 'inactive' };
    await ActivationService.refresh();
    expect(ActivationService.locked).toBe(false);

    offline = true;
    await ActivationService.refresh();
    expect(ActivationService.locked).toBe(false);
  });

  it('does not lock when the panel has enforcement switched off', async () => {
    checkReply.data = { activated: false, status: 'expired', activation_enforced: false };

    await ActivationService.refresh();

    expect(ActivationService.snapshot.status).toBe('expired');
    expect(ActivationService.locked).toBe(false);
    expect(StorageService.getDeviceLink().lockedStatus).toBeUndefined();
  });

  it('stays locked across a restart with no connection, and unlocks on the next good answer', async () => {
    checkReply.data = { activated: false, status: 'expired', manage_key: '123456' };
    await ActivationService.refresh();

    // A new run: nothing in memory, and the panel cannot be reached.
    ActivationService.resetForTests();
    offline = true;
    expect(ActivationService.locked).toBe(true);
    expect(ActivationService.snapshot.manageKey).toBe('123456');
    await ActivationService.refresh();
    // Losing the connection is not a way out of the lock.
    expect(ActivationService.snapshot.status).toBe('expired');
    expect(ActivationService.locked).toBe(true);
    expect(StorageService.getDeviceLink().lockedStatus).toBe('expired');

    offline = false;
    checkReply.data = active();
    await ActivationService.refresh();
    expect(ActivationService.locked).toBe(false);
    expect(StorageService.getDeviceLink().lockedStatus).toBeUndefined();
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

describe('ActivationService.removePlaylist', () => {
  const ok = { status: 200, data: { success: true } };
  let deleteWeb: ReturnType<typeof vi.spyOn>;
  let deleteActive: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    deleteWeb = vi.spyOn(PanelClient, 'deleteWebPlaylist').mockClear().mockResolvedValue(ok);
    deleteActive = vi.spyOn(PanelClient, 'deletePlaylist').mockClear().mockResolvedValue(ok);
  });

  it('removes a source added on the TV without calling the panel', async () => {
    StorageService.setPlaylists([{ id: 'p1', name: 'P1', url: 'http://host/a' }]);

    expect(await ActivationService.removePlaylist('p1')).toBe(true);

    expect(StorageService.getPlaylists()).toEqual([]);
    expect(deleteWeb).not.toHaveBeenCalled();
    expect(deleteActive).not.toHaveBeenCalled();
  });

  it('deletes a portal playlist on the panel, by the portal id', async () => {
    checkReply.data = active({
      web_playlists: [
        { id: 7, name: 'N1', m3u_url: 'http://host/a.m3u' },
        { id: 9, name: 'N2', m3u_url: 'http://host/b.m3u' },
      ],
    });
    await ActivationService.refresh();

    expect(await ActivationService.removePlaylist('xsol-web-7')).toBe(true);

    expect(deleteWeb).toHaveBeenCalledWith('7');
    expect(deleteActive).not.toHaveBeenCalled();
    expect(StorageService.getPlaylists().map(item => item.id)).toEqual(['xsol-web-9']);
  });

  it('also clears the active playlist when that is the one removed, so it does not come back', async () => {
    checkReply.data = active({
      domain: 'http://host/a.m3u', has_playlist: true,
      web_playlists: [{ id: 7, name: 'N1', m3u_url: 'http://host/a.m3u' }],
    });
    await ActivationService.refresh();

    expect(await ActivationService.removePlaylist('xsol-web-7')).toBe(true);

    expect(deleteWeb).toHaveBeenCalledWith('7');
    expect(deleteActive).toHaveBeenCalledOnce();
  });

  it('clears the active playlist that was never saved on the portal', async () => {
    checkReply.data = active({ domain: 'http://host/a.m3u', has_playlist: true });
    await ActivationService.refresh();

    expect(await ActivationService.removePlaylist('xsol-panel')).toBe(true);

    expect(deleteActive).toHaveBeenCalledOnce();
    expect(deleteWeb).not.toHaveBeenCalled();
    expect(StorageService.getPlaylists()).toEqual([]);
  });

  it.each([
    ['refuses', () => Promise.resolve({ status: 404, data: {} })],
    ['cannot be reached', () => Promise.reject(new PanelError(0, 'network'))],
  ])('keeps the source when the panel %s', async (_label, answer) => {
    checkReply.data = active({ web_playlists: [{ id: 7, name: 'N1', m3u_url: 'http://host/a.m3u' }] });
    await ActivationService.refresh();
    deleteWeb.mockImplementation(answer);

    expect(await ActivationService.removePlaylist('xsol-web-7')).toBe(false);

    expect(StorageService.getPlaylists().map(item => item.id)).toEqual(['xsol-web-7']);
  });

  it('is fine with an id that is no longer there', async () => {
    expect(await ActivationService.removePlaylist('gone')).toBe(true);
  });
});

describe('one access in use at a time', () => {
  const inUse = () => StorageService.getPlaylists().filter(item => item.enabled !== false).map(item => item.id);

  it('takes the first list that arrives into use', async () => {
    checkReply.data = active({ web_playlists: [{ id: 7, name: 'N1', m3u_url: 'http://host/a.m3u' }] });
    await ActivationService.refresh();
    expect(inUse()).toEqual(['xsol-web-7']);
  });

  it('puts a list that arrives from the portal into use, switching the previous one off', async () => {
    StorageService.setPlaylists([{ id: 'p1', name: 'P1', url: 'http://host/a' }]);
    checkReply.data = active({ web_playlists: [{ id: 7, name: 'N1', m3u_url: 'http://host/a.m3u' }] });

    expect(await ActivationService.refresh()).toBe(true);

    expect(StorageService.getPlaylists().map(item => item.id)).toEqual(['p1', 'xsol-web-7']);
    expect(inUse()).toEqual(['xsol-web-7']);

    // A second one added later takes over in turn; nothing changes while the portal is quiet.
    checkReply.data = active({
      web_playlists: [
        { id: 7, name: 'N1', m3u_url: 'http://host/a.m3u' },
        { id: 9, name: 'N2', m3u_url: 'http://host/b.m3u' },
      ],
    });
    expect(await ActivationService.refresh()).toBe(true);
    expect(inUse()).toEqual(['xsol-web-9']);
    expect(await ActivationService.refresh()).toBe(false);
    expect(inUse()).toEqual(['xsol-web-9']);
  });

  it('prefers the panel active list when several arrive together', async () => {
    checkReply.data = active({
      domain: 'http://host/a.m3u', has_playlist: true,
      web_playlists: [
        { id: 7, name: 'N1', m3u_url: 'http://host/a.m3u' },
        { id: 9, name: 'N2', m3u_url: 'http://host/b.m3u' },
      ],
    });
    await ActivationService.refresh();
    expect(inUse()).toEqual(['xsol-web-7']);
  });

  it('keeps the choice made on the TV when a list is only renamed or removed on the portal', async () => {
    checkReply.data = active({
      web_playlists: [
        { id: 7, name: 'N1', m3u_url: 'http://host/a.m3u' },
        { id: 9, name: 'N2', m3u_url: 'http://host/b.m3u' },
      ],
    });
    await ActivationService.refresh();
    useOnlyPlaylist('xsol-web-7');

    checkReply.data = active({
      web_playlists: [
        { id: 7, name: 'N1', m3u_url: 'http://host/a.m3u' },
        { id: 9, name: 'N2 renamed', m3u_url: 'http://host/b.m3u' },
      ],
    });
    await ActivationService.refresh();
    expect(inUse()).toEqual(['xsol-web-7']);
  });

  it('takes a new list into use when everything configured was switched off', async () => {
    StorageService.setPlaylists([{ id: 'p1', name: 'P1', url: 'http://host/a', enabled: false }]);
    checkReply.data = active({ web_playlists: [{ id: 7, name: 'N1', m3u_url: 'http://host/a.m3u' }] });
    await ActivationService.refresh();
    expect(inUse()).toEqual(['xsol-web-7']);
  });

  it('useOnlyPlaylist switches the others off and reports whether anything changed', () => {
    StorageService.setPlaylists([
      { id: 'p1', name: 'P1', url: 'http://host/a' },
      { id: 'p2', name: 'P2', url: 'http://host/b', enabled: false },
    ]);
    expect(useOnlyPlaylist('p2')).toBe(true);
    expect(inUse()).toEqual(['p2']);
    expect(useOnlyPlaylist('p2')).toBe(false);
    expect(useOnlyPlaylist('gone')).toBe(false);
    expect(inUse()).toEqual(['p2']);
  });

  it('settles several lists left on by an older build, keeping the first', () => {
    StorageService.setPlaylists([
      { id: 'xsol-web-1', name: 'N1', url: 'http://host/a' },
      { id: 'xsol-web-2', name: 'N2', url: 'http://host/b' },
    ]);
    expect(settleSingleAccess()).toBe(true);
    expect(inUse()).toEqual(['xsol-web-1']);
    expect(settleSingleAccess()).toBe(false);

    // Sources combined by hand in Settings, none from the panel, are left alone.
    StorageService.setPlaylists([
      { id: 'p1', name: 'P1', url: 'http://host/a' },
      { id: 'p2', name: 'P2', url: 'http://host/b' },
    ]);
    expect(settleSingleAccess()).toBe(false);
    expect(inUse()).toEqual(['p1', 'p2']);
  });
});
