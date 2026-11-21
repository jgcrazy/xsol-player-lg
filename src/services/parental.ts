import { StorageService } from './storage-service';
import { sha256Hex } from '../utils/sha256';

const PIN_LENGTH = 4;

function digest(pin: string): string {
  return sha256Hex(`xsol-pin-v1:${pin}`);
}

/**
 * Parental control: a 4-digit PIN that guards Settings and the Access screen,
 * which is where hidden categories can be shown again and the access changed.
 * Only a digest of the PIN is stored.
 */
export const ParentalService = {
  PIN_LENGTH,

  get enabled(): boolean {
    const state = StorageService.getParental();
    return state.enabled && state.pinHash !== '';
  },

  isValidPin(pin: string): boolean {
    return /^\d{4}$/.test(pin);
  },

  matches(pin: string): boolean {
    const state = StorageService.getParental();
    return state.pinHash !== '' && digest(pin) === state.pinHash;
  },

  enable(pin: string): boolean {
    if (!this.isValidPin(pin)) return false;
    StorageService.setParental({ enabled: true, pinHash: digest(pin) });
    // A fresh start: everything adult is screened again.
    StorageService.setParentalScreened([]);
    return true;
  },

  disable(): void {
    StorageService.setParental({ enabled: false, pinHash: '' });
  },
};
