import type { Action, NumberEvent } from '../types';
import { html, raw } from '../utils/dom';
import { morph } from '../utils/morph';
import { t } from '../i18n';
import { REMOVE_ICON } from './icons';

export interface PinPromptOptions {
  title: string;
  hint?: string;
  /** How many digits complete the entry. */
  length: number;
  /** Called with the complete entry. Return a message to refuse it and ask again. */
  onSubmit: (digits: string) => string | void;
  onCancel: () => void;
  /** Label and handler of the extra link under the keypad, when there is one. */
  link?: { label: string; onSelect: () => void };
}

// Rows of the keypad, as key ids. 'back' erases a digit; 'link' is the extra row.
const KEYS: string[][] = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['cancel', '0', 'erase']];

/**
 * A modal digit entry with an on-screen keypad, for remotes that have no number
 * keys. Number keys on the remote work too.
 */
export class PinPrompt {
  private el: HTMLElement | null = null;
  private options: PinPromptOptions | null = null;
  private digits = '';
  private error = '';
  private row = 0;
  private column = 0;

  get visible(): boolean {
    return this.el !== null && !this.el.classList.contains('hidden');
  }

  show(options: PinPromptOptions): void {
    this.options = options;
    this.digits = '';
    this.error = '';
    this.row = 0;
    this.column = 0;
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'pin-prompt';
      this.el.setAttribute('data-self-activate', '');
      document.body.appendChild(this.el);
      this.el.addEventListener('click', (event: MouseEvent) => {
        const key = (event.target as HTMLElement).closest<HTMLElement>('[data-pin-key]');
        if (key?.dataset.pinKey) this.press(key.dataset.pinKey);
      });
      this.el.addEventListener('mouseover', (event: MouseEvent) => {
        const key = (event.target as HTMLElement).closest<HTMLElement>('[data-pin-key]');
        if (!key?.dataset.pinKey) return;
        this.focusKey(key.dataset.pinKey);
      });
    }
    this.el.classList.remove('hidden');
    this.render();
  }

  hide(): void {
    this.el?.classList.add('hidden');
    this.options = null;
    this.digits = '';
  }

  handleAction(action: Action, event?: NumberEvent): void {
    if (!this.visible || !this.options) return;
    if (action === 'number') return;
    if (action === 'number_input') {
      // KeyHandler buffers the digits typed for channel entry; take the newest one.
      const digit = (event?.digits ?? '').slice(-1);
      if (/^\d$/.test(digit)) this.press(digit);
      return;
    }
    const rows = this.rows();
    switch (action) {
      case 'up':
        this.row = Math.max(0, this.row - 1);
        break;
      case 'down':
        this.row = Math.min(rows.length - 1, this.row + 1);
        break;
      case 'left':
        this.column = Math.max(0, this.column - 1);
        break;
      case 'right':
        this.column = Math.min(rows[this.row].length - 1, this.column + 1);
        break;
      case 'select':
        this.press(rows[this.row][Math.min(this.column, rows[this.row].length - 1)]);
        return;
      case 'back':
        this.options.onCancel();
        return;
      default:
        return;
    }
    this.column = Math.min(this.column, rows[this.row].length - 1);
    this.render();
  }

  private rows(): string[][] {
    return this.options?.link ? KEYS.concat([['link']]) : KEYS;
  }

  private focusKey(key: string): void {
    const rows = this.rows();
    for (let r = 0; r < rows.length; r++) {
      const c = rows[r].indexOf(key);
      if (c === -1) continue;
      if (this.row === r && this.column === c) return;
      this.row = r;
      this.column = c;
      this.render();
      return;
    }
  }

  private press(key: string): void {
    const options = this.options;
    if (!options) return;
    if (key === 'cancel') { options.onCancel(); return; }
    if (key === 'link') { options.link?.onSelect(); return; }
    if (key === 'erase') {
      this.digits = this.digits.slice(0, -1);
      this.error = '';
      this.render();
      return;
    }
    if (this.digits.length >= options.length) return;
    this.digits += key;
    this.error = '';
    if (this.digits.length < options.length) {
      this.render();
      return;
    }
    const entered = this.digits;
    const refusal = options.onSubmit(entered);
    // The handler may have closed this prompt or opened the next step.
    if (this.options !== options) return;
    if (typeof refusal === 'string') {
      this.digits = '';
      this.error = refusal;
    }
    this.render();
  }

  private render(): void {
    if (!this.el || !this.options) return;
    const options = this.options;
    const rows = this.rows();
    const dots: boolean[] = [];
    for (let i = 0; i < options.length; i++) dots.push(i < this.digits.length);
    const label = (key: string) => {
      if (key === 'cancel') return html`<span class="pin-key-text">${t('common.cancel')}</span>`;
      if (key === 'erase') return html`<span class="pin-key-icon">${raw(REMOVE_ICON)}</span>`;
      if (key === 'link') return html`<span class="pin-key-text">${options.link?.label ?? ''}</span>`;
      return html`${key}`;
    };
    morph(this.el, html`
      <div class="pin-dialog" role="dialog" aria-modal="true">
        <h2 class="pin-title" id="pin-title">${options.title}</h2>
        <p class="pin-hint ${this.error ? 'is-error' : ''}" id="pin-hint">${this.error || options.hint || ''}</p>
        <div class="pin-dots" id="pin-dots" data-filled="${this.digits.length}">
          ${dots.map((filled, index) => html`<span class="pin-dot ${filled ? 'is-filled' : ''}" data-key="dot:${index}"></span>`)}
        </div>
        <div class="pin-keys">
          ${rows.map((row, r) => html`
            <div class="pin-row ${row[0] === 'link' ? 'pin-row-link' : ''}" data-key="row:${r}">
              ${row.map((key, c) => html`
                <button class="pin-key ${key.length > 1 ? 'pin-key-wide' : ''} ${
                  r === this.row && c === this.column ? 'focused' : ''}"
                        data-key="key:${key}" data-pin-key="${key}">${label(key)}</button>`)}
            </div>`)}
        </div>
      </div>
    `);
  }
}
