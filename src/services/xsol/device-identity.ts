import { StorageService } from '../storage-service';
import { isLunaAvailable, lunaRequest, type LunaResponse } from '../luna';
import { sha256Hex } from '../../utils/sha256';
import { createLogger } from '../../utils/logger';

const log = createLogger('DeviceIdentity');

const HARDWARE_ID_TIMEOUT_MS = 3000;
const DEVICE_SEED_PREFIX = 'xsol-device-v1:';
const PROOF_SEED_PREFIX = 'xsol-proof-v1:';

export interface DeviceIdentity {
  deviceId: string;
  proof: string;
  source: 'hardware' | 'install';
}

interface DeviceIdsResponse extends LunaResponse {
  idList?: Array<{ idType?: string; idValue?: string }>;
}

// Same shape the other XSol apps show: a MAC-looking code whose first byte has the
// locally-administered bit set and the multicast bit clear, so it can never be
// mistaken for a real vendor prefix. The panel rejects anything else.
export function pseudoMacFromSeed(seed: string): string {
  const hex = sha256Hex(DEVICE_SEED_PREFIX + seed).slice(0, 12).toUpperCase();
  const firstByte = (parseInt(hex.slice(0, 2), 16) | 0x02) & 0xfe;
  const pairs = [(firstByte < 16 ? '0' : '') + firstByte.toString(16).toUpperCase()];
  for (let i = 2; i < 12; i += 2) pairs.push(hex.slice(i, i + 2));
  return pairs.join(':');
}

// A second digest of the same seed under a different prefix: knowing the MAC on
// screen gives no way to compute it.
export function proofFromSeed(seed: string): string {
  return sha256Hex(PROOF_SEED_PREFIX + seed);
}

function randomSeed(): string {
  const bytes = new Uint8Array(32);
  const cryptoApi = typeof crypto !== 'undefined' ? crypto : undefined;
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let seed = '';
  for (let i = 0; i < bytes.length; i++) seed += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return seed;
}

function readHardwareId(): Promise<string | null> {
  if (!isLunaAvailable()) return Promise.resolve(null);
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), HARDWARE_ID_TIMEOUT_MS);
    try {
      lunaRequest<DeviceIdsResponse>('luna://com.webos.service.sm', {
        method: 'deviceid/getIDs',
        parameters: { idType: ['LGUDID'] },
        onSuccess: (response) => {
          const list = response.idList ?? [];
          let value = '';
          for (let i = 0; i < list.length; i++) {
            const candidate = (list[i].idValue ?? '').trim();
            if (candidate) {
              value = candidate;
              break;
            }
          }
          finish(value || null);
        },
        onFailure: (response) => {
          log.warn('Hardware id unavailable', 'event=device.identity.hardware.failed',
            `code=${String(response.errorCode ?? 'none')}`);
          finish(null);
        },
      });
    } catch (error) {
      log.warn('Hardware id request threw', error);
      finish(null);
    }
  });
}

let pending: Promise<DeviceIdentity> | null = null;

/**
 * The identity is resolved once and then read from storage for good: a TV that
 * flipped between its hardware id and a generated one would show the customer a
 * different MAC from one launch to the next.
 */
export function resolveDeviceIdentity(): Promise<DeviceIdentity> {
  const stored = StorageService.getDeviceLink();
  if (stored.deviceId && stored.proof) {
    return Promise.resolve({
      deviceId: stored.deviceId,
      proof: stored.proof,
      source: stored.source === 'hardware' ? 'hardware' : 'install',
    });
  }
  if (pending) return pending;

  pending = readHardwareId().then((hardwareId) => {
    const source: DeviceIdentity['source'] = hardwareId ? 'hardware' : 'install';
    const seed = hardwareId ?? randomSeed();
    const identity: DeviceIdentity = {
      deviceId: pseudoMacFromSeed(seed),
      proof: proofFromSeed(seed),
      source,
    };
    const state = StorageService.getDeviceLink();
    state.deviceId = identity.deviceId;
    state.proof = identity.proof;
    state.source = identity.source;
    StorageService.setDeviceLink(state);
    log.info('Device identity created', 'event=device.identity.created', `source=${source}`);
    pending = null;
    return identity;
  });
  return pending;
}

/** Test seam: forget the in-flight resolution between cases. */
export function resetDeviceIdentityForTests(): void {
  pending = null;
}
