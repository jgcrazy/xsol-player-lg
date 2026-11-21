// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PinPrompt } from './pin-prompt';
import { ParentalService } from '../services/parental';
import { StorageService } from '../services/storage-service';

describe('ParentalService', () => {
  beforeEach(() => StorageService.setParental({ enabled: false, pinHash: '' }));

  it('is off until a 4-digit PIN is set, and stores only a digest of it', () => {
    expect(ParentalService.enabled).toBe(false);
    expect(ParentalService.enable('12a4')).toBe(false);
    expect(ParentalService.enable('123')).toBe(false);
    expect(ParentalService.enabled).toBe(false);

    expect(ParentalService.enable('1234')).toBe(true);
    expect(ParentalService.enabled).toBe(true);
    const stored = StorageService.getParental();
    expect(stored.pinHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain('1234');
  });

  it('accepts the PIN it was given and no other', () => {
    ParentalService.enable('1234');
    expect(ParentalService.matches('1234')).toBe(true);
    expect(ParentalService.matches('4321')).toBe(false);
    expect(ParentalService.matches('')).toBe(false);
  });

  it('forgets the PIN when turned off', () => {
    ParentalService.enable('1234');
    ParentalService.disable();
    expect(ParentalService.enabled).toBe(false);
    expect(ParentalService.matches('1234')).toBe(false);
  });
});

describe('PinPrompt', () => {
  let prompt: PinPrompt;
  const root = () => document.querySelector<HTMLElement>('.pin-prompt')!;
  const filled = () => root().querySelectorAll('.pin-dot.is-filled').length;
  const focused = () => root().querySelector<HTMLElement>('.pin-key.focused')?.dataset.pinKey;
  const click = (key: string) => root().querySelector<HTMLElement>(`[data-pin-key="${key}"]`)!.click();

  beforeEach(() => { prompt = new PinPrompt(); });
  afterEach(() => { document.body.innerHTML = ''; });

  it('fills a dot per digit and submits once the entry is complete', () => {
    const onSubmit = vi.fn();
    prompt.show({ title: 'T1', hint: 'H1', length: 4, onSubmit, onCancel: vi.fn() });
    expect(prompt.visible).toBe(true);
    expect(root().querySelector('#pin-title')?.textContent).toBe('T1');
    expect(root().querySelectorAll('.pin-dot')).toHaveLength(4);

    click('1'); click('2'); click('3');
    expect(filled()).toBe(3);
    expect(onSubmit).not.toHaveBeenCalled();
    click('4');
    expect(onSubmit).toHaveBeenCalledWith('1234');
    // The entry is never drawn as digits.
    expect(root().querySelector('.pin-dots')?.textContent?.trim()).toBe('');
  });

  it('walks the keypad with the D-pad and types with OK', () => {
    const onSubmit = vi.fn();
    prompt.show({ title: 'T1', length: 4, onSubmit, onCancel: vi.fn() });
    expect(focused()).toBe('1');

    prompt.handleAction('right');
    prompt.handleAction('down');
    expect(focused()).toBe('5');
    prompt.handleAction('select');
    prompt.handleAction('down');
    prompt.handleAction('down');
    expect(focused()).toBe('0');
    prompt.handleAction('select');
    prompt.handleAction('right');
    expect(focused()).toBe('erase');
    prompt.handleAction('select');
    expect(filled()).toBe(1);
    // The edges stop the focus instead of wrapping.
    prompt.handleAction('right');
    prompt.handleAction('down');
    expect(focused()).toBe('erase');
  });

  it('takes digits from a remote with number keys', () => {
    const onSubmit = vi.fn();
    prompt.show({ title: 'T1', length: 4, onSubmit, onCancel: vi.fn() });
    ['1', '12', '123', '1234'].forEach((digits) => prompt.handleAction('number_input', { number: 0, digits }));
    expect(onSubmit).toHaveBeenCalledWith('1234');
  });

  it('shows why an entry was refused and starts over', () => {
    prompt.show({ title: 'T1', hint: 'H1', length: 4, onSubmit: () => 'Wrong', onCancel: vi.fn() });
    click('1'); click('2'); click('3'); click('4');
    expect(filled()).toBe(0);
    expect(root().querySelector('#pin-hint')?.textContent).toBe('Wrong');
    expect(root().querySelector('#pin-hint')?.classList.contains('is-error')).toBe(true);
    // Typing again clears the message.
    click('1');
    expect(root().querySelector('#pin-hint')?.textContent).toBe('H1');
  });

  it('cancels on Back and on the Cancel key, and offers the extra link only when given', () => {
    const onCancel = vi.fn();
    prompt.show({ title: 'T1', length: 4, onSubmit: vi.fn(), onCancel });
    expect(root().querySelector('[data-pin-key="link"]')).toBeNull();
    prompt.handleAction('back');
    click('cancel');
    expect(onCancel).toHaveBeenCalledTimes(2);

    const onSelect = vi.fn();
    prompt.show({ title: 'T1', length: 4, onSubmit: vi.fn(), onCancel, link: { label: 'L1', onSelect } });
    expect(root().querySelector('[data-pin-key="link"]')?.textContent?.trim()).toBe('L1');
    for (let i = 0; i < 4; i++) prompt.handleAction('down');
    expect(focused()).toBe('link');
    prompt.handleAction('select');
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('lets the submit handler open the next step without being overwritten', () => {
    const second = vi.fn();
    prompt.show({
      title: 'T1', length: 4, onCancel: vi.fn(),
      onSubmit: () => { prompt.show({ title: 'T2', length: 4, onSubmit: second, onCancel: vi.fn() }); },
    });
    click('1'); click('2'); click('3'); click('4');
    expect(root().querySelector('#pin-title')?.textContent).toBe('T2');
    expect(filled()).toBe(0);
  });
});
