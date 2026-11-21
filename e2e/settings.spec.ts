import { test, expect, type Page, routePlaylist, seedPlaylist, PLAYLIST_URL, enterTab, gotoFirstRunSettings, reloadFirstRunSettings, enterSettings, openSettingsPane, backToLive } from './helpers';

// All Settings coverage: navigation, playlist save/removal, and Xtream.

test.describe('Settings navigation', () => {
  test('the Settings tab on the channel list opens settings', async ({ page }) => {
    await routePlaylist(page);
    await seedPlaylist(page);

    await page.goto('/');
    await expect(page.locator('#view-channels')).toBeVisible();

    await enterSettings(page);

    await expect(page.locator('#view-settings')).toBeVisible();
    // The configured playlist URL is populated in the settings form.
    await expect(page.locator('.playlist-url').first()).toHaveValue(PLAYLIST_URL);
  });

  test('an open dropdown closes on an outside click or Back before leaving Settings', async ({ page }) => {
    await gotoFirstRunSettings(page);
    await openSettingsPane(page, 'appearance');
    const dropdown = page.locator('#app-language');
    const trigger = dropdown.locator('.dropdown-trigger');

    await trigger.click();
    await expect(dropdown).toHaveClass(/open/);
    await page.locator('#settings-appearance .settings-item-title').first().click();
    await expect(dropdown).not.toHaveClass(/open/);

    await trigger.click();
    await expect(dropdown).toHaveClass(/open/);
    await page.keyboard.press('Escape');
    await expect(dropdown).not.toHaveClass(/open/);
    await expect(page.locator('#view-settings')).toBeVisible();
  });

  // A closed menu is `display: none` from the stylesheet, so its options carry
  // no hiding of their own and SpatialNav must keep d-pad out on measurement.
  // jsdom has no layout, so a real engine is the only place this can be checked.
  test('a closed dropdown keeps its options out of d-pad navigation', async ({ page }) => {
    await gotoFirstRunSettings(page);
    await openSettingsPane(page, 'appearance');
    const dropdown = page.locator('#app-language');
    const options = dropdown.locator('.dropdown-option');
    await expect(options.first()).not.toBeVisible();

    // The trigger is the first control of its pane, so only the header sits
    // above it. A hidden option measures as a zero-sized box at the viewport
    // origin, which is above everything and in the same container, so it is the
    // one thing Up could reach if measurement did not rule it out.
    await dropdown.locator('.dropdown-trigger')
      .evaluate(el => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
    await page.keyboard.press('ArrowUp');

    expect(await page.locator('.dropdown-option.focused').count()).toBe(0);
  });

  test('an open dropdown keeps d-pad inside its own options', async ({ page }) => {
    await gotoFirstRunSettings(page);
    await openSettingsPane(page, 'appearance');
    const dropdown = page.locator('#app-language');
    await dropdown.locator('.dropdown-trigger').click();
    await expect(dropdown).toHaveClass(/open/);

    const optionCount = await dropdown.locator('.dropdown-option').count();
    expect(optionCount).toBeGreaterThan(1);

    // Walk past the end of the list; every step must stay among the options.
    for (let step = 0; step < optionCount + 3; step++) {
      await page.keyboard.press('ArrowDown');
      const inside = await page.evaluate(() =>
        !!document.querySelector('#view-settings .focused')?.closest('.dropdown.open'));
      expect(inside).toBe(true);
    }
  });

  // Pointer hover can move focus to the view behind an open menu. The next
  // keypress must re-enter the menu rather than continue through the background.
  test('an open dropdown recaptures focus after pointer hover escapes', async ({ page }) => {
    await gotoFirstRunSettings(page);
    await openSettingsPane(page, 'appearance');
    const dropdown = page.locator('#app-language');
    const trigger = dropdown.locator('.dropdown-trigger');
    const outside = page.locator('#settings-back');

    await trigger.evaluate(el => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
    await page.keyboard.press('Enter');
    await expect(dropdown).toHaveClass(/open/);

    await outside.dispatchEvent('mouseover');
    await expect(outside).toHaveClass(/focused/);

    await page.keyboard.press('ArrowDown');

    const index = await page.evaluate(() => {
      const options = Array.from(document.querySelectorAll('#app-language .dropdown-option'));
      return options.findIndex(o => o.classList.contains('focused'));
    });
    expect(index).toBe(0);
  });

  // Entering a category focuses its first element in DOM order, with no
  // geometry to fall back on — so the visibility check is the only thing
  // standing between focus and an invisible element. A stylesheet rule is the
  // case no attribute selector on the element could ever catch, and jsdom
  // applies no stylesheets, so this needs a real engine.
  test('entering a category skips a first control hidden by a stylesheet', async ({ page }) => {
    await gotoFirstRunSettings(page);
    await expect(page.locator('#view-settings')).toBeVisible();

    // Playback is the category whose first control is a toggle option.
    const options = page.locator('#auto-play .toggle-option');
    const names = await options.evaluateAll(els => els.map(el => el.getAttribute('data-value')));
    expect(names.length).toBeGreaterThan(1);

    await page.addStyleTag({
      content: `#auto-play [data-value="${names[0]}"] { display: none; }`,
    });

    await openSettingsPane(page, 'playback');

    const focused = await page.evaluate(() =>
      document.querySelector('#view-settings .focused')?.getAttribute('data-value') ?? null);
    expect(focused).toBe(names[1]);
  });

  test('keeps dropdown spacing aligned with adjacent settings', async ({ page }) => {
    await gotoFirstRunSettings(page);
    await openSettingsPane(page, 'subtitles');

    // The dropdown is an option row; the keys below it are stacked fields in
    // the same panel. Both kinds of row share the panel's inset.
    const insets = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll<HTMLElement>(
        '#settings-subtitles .settings-panel > .settings-item',
      ));
      return items.map((item) => {
        const bounds = item.getBoundingClientRect();
        const first = item.querySelector<HTMLElement>('.settings-item-title, label')!
          .getBoundingClientRect();
        const controls = Array.from(item.querySelectorAll<HTMLElement>('.dropdown, .settings-input'))
          .map(control => control.getBoundingClientRect());
        return {
          option: item.classList.contains('settings-option'),
          left: first.left - bounds.left,
          top: first.top - bounds.top,
          right: bounds.right - Math.max(...controls.map(control => control.right)),
          bottomGap: bounds.bottom - Math.max(
            ...Array.from(item.querySelectorAll<HTMLElement>('*'))
              .map(el => el.getBoundingClientRect().bottom),
          ),
        };
      });
    });

    expect(insets).toHaveLength(4);
    expect(insets[0].option).toBe(true);
    const fields = insets.slice(1);
    for (const inset of insets) {
      expect(inset.left).toBeCloseTo(insets[0].left, 0);
      expect(inset.right).toBeCloseTo(insets[0].right, 0);
      expect(inset.left).toBeCloseTo(inset.right, 0);
    }
    for (const field of fields) {
      expect(field.option).toBe(false);
      expect(field.top).toBeCloseTo(fields[0].top, 0);
      expect(field.bottomGap).toBeCloseTo(fields[0].bottomGap, 0);
      // The top inset also holds the hairline between two rows.
      expect(Math.abs(field.bottomGap - field.top)).toBeLessThanOrEqual(1.5);
    }
  });

  test('lays out option rows with the text on the left and a centred control on the right', async ({ page }) => {
    await gotoFirstRunSettings(page);
    await openSettingsPane(page, 'playback');

    const layouts = await page.locator('#settings-playback .settings-option')
      .evaluateAll((rows) => rows.map((row) => {
        const bounds = row.getBoundingClientRect();
        const text = row.querySelector<HTMLElement>('.settings-option-text')!
          .getBoundingClientRect();
        const title = row.querySelector<HTMLElement>('.settings-item-title')!
          .getBoundingClientRect();
        const control = row.querySelector<HTMLElement>('.dropdown, .toggle-group')!
          .getBoundingClientRect();
        const hint = row.querySelector<HTMLElement>('.settings-item-hint')
          ?.getBoundingClientRect() ?? null;
        return {
          rowCenter: bounds.top + bounds.height / 2,
          controlCenter: control.top + control.height / 2,
          controlRightGap: bounds.right - control.right,
          controlLeft: control.left,
          textRight: text.right,
          titleLeftGap: title.left - bounds.left,
          titleBottom: title.bottom,
          hintTop: hint ? hint.top : null,
          hintLeft: hint ? hint.left : null,
          titleLeft: title.left,
        };
      }));

    expect(layouts).toHaveLength(6);
    expect(layouts.filter(layout => layout.hintTop !== null).length).toBeGreaterThan(0);
    for (const layout of layouts) {
      expect(Math.abs(layout.controlCenter - layout.rowCenter)).toBeLessThanOrEqual(1);
      expect(layout.controlRightGap).toBeCloseTo(layouts[0].controlRightGap, 0);
      expect(layout.controlRightGap).toBeGreaterThan(0);
      expect(layout.titleLeftGap).toBeCloseTo(layouts[0].titleLeftGap, 0);
      expect(layout.titleLeftGap).toBeCloseTo(layout.controlRightGap, 0);
      expect(layout.textRight).toBeLessThan(layout.controlLeft);
      if (layout.hintTop !== null) {
        expect(layout.hintTop).toBeGreaterThan(layout.titleBottom);
        expect(layout.hintLeft).toBeCloseTo(layout.titleLeft, 0);
      }
    }

    const numberEntry = page.locator('#number-entry-osd-timeout .dropdown-trigger');
    await numberEntry.click();
    const currentRow = page.locator('#settings-playback .settings-option.is-current');
    await expect(currentRow).toHaveCount(1);
    await expect(currentRow.locator('#number-entry-osd-timeout')).toHaveCount(1);
  });

  test('persists Essential mode and disables only costly motion', async ({ page }) => {
    await gotoFirstRunSettings(page);
    await openSettingsPane(page, 'appearance');
    const animationOptions = page.locator('#animation-mode .toggle-option');
    await expect(animationOptions).toHaveCount(3);
    expect(await animationOptions.evaluateAll(options => options.map(
      option => (option as HTMLElement).dataset.value,
    )))
      .toEqual(['essential', 'reduced', 'full']);
    const animationRow = await page.evaluate(() => {
      const row = document.querySelector('#animation-mode')!
        .closest('.settings-option')!.getBoundingClientRect();
      const options = document.querySelector('#animation-mode')!.getBoundingClientRect();
      return {
        rowCenter: row.top + row.height / 2,
        optionsCenter: options.top + options.height / 2,
      };
    });
    expect(Math.abs(animationRow.optionsCenter - animationRow.rowCenter)).toBeLessThanOrEqual(1);
    await page.locator('#animation-mode [data-value="essential"]').click();
    await page.locator('#save-settings').click();

    await expect(page.locator('html')).toHaveAttribute('data-animation', 'essential');
    const durations = await page.evaluate(() => {
      const seconds = (value: string): number[] => value.split(',')
        .map(part => parseFloat(part.trim()))
        .filter(Number.isFinite);
      const liveBadge = document.createElement('span');
      liveBadge.className = 'live-badge-dot';
      document.body.appendChild(liveBadge);
      const motionFixtures = document.createElement('div');
      motionFixtures.innerHTML = `
        <span class="playing-indicator"></span>
        <div class="epg-programme-item state-live"></div>
        <div class="player-sidebar visible channels-only">
          <div class="sidebar-picker-arrow"><svg></svg></div>
          <div class="sidebar-ch-item">
            <div class="ch-name"><span class="ch-name-text scrolling"></span></div>
            <div class="ch-now"><span class="ch-now-text scrolling"></span></div>
          </div>
        </div>
      `;
      document.body.appendChild(motionFixtures);
      const result = {
        button: seconds(getComputedStyle(document.querySelector('#save-settings')!)
          .transitionDuration),
        search: seconds(getComputedStyle(document.querySelector('.tab-bar-search-input')!)
          .transitionDuration),
        liveBadge: getComputedStyle(liveBadge).animationName,
        playingIndicator: getComputedStyle(
          motionFixtures.querySelector('.playing-indicator')!,
        ).animationName,
        epgLiveRail: getComputedStyle(
          motionFixtures.querySelector('.epg-programme-item')!,
          '::before',
        ).animationName,
        groupPicker: getComputedStyle(
          motionFixtures.querySelector('.sidebar-picker-arrow svg')!,
        ).animationName,
        channelMarquee: getComputedStyle(
          motionFixtures.querySelector('.ch-name-text')!,
        ).animationName,
        programmeMarquee: getComputedStyle(
          motionFixtures.querySelector('.ch-now-text')!,
        ).animationName,
        spinner: seconds(getComputedStyle(document.querySelector('.loading-spinner')!)
          .animationDuration),
      };
      liveBadge.remove();
      motionFixtures.remove();
      return result;
    });
    expect(durations.search.every(value => value <= 0.000001)).toBe(true);
    expect(durations.button.some(value => value >= 0.1)).toBe(true);
    expect(durations.liveBadge).toBe('liveBadgeDotPulse');
    expect(durations.playingIndicator).toBe('pulse');
    expect(durations.epgLiveRail).toBe('epgRailPulse');
    expect(durations.groupPicker).toBe('group-picker-nudge');
    expect(durations.channelMarquee).toBe('marquee-bounce');
    expect(durations.programmeMarquee).toBe('marquee-bounce');
    expect(durations.spinner).toContain(0.8);

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-animation', 'essential');
  });

  test('data-animation CSS owns the navigation scroll policy', async ({ page }) => {
    await gotoFirstRunSettings(page);
    for (const [mode, expected] of [
      ['essential', 'auto'],
      ['reduced', 'auto'],
      ['full', 'smooth'],
    ] as const) {
      await page.evaluate((value) => {
        localStorage.setItem('iptv_animation_mode', JSON.stringify(value));
      }, mode);
      await reloadFirstRunSettings(page);
      await expect(page.locator('html')).toHaveAttribute('data-animation', mode);
      const policy = await page.locator('.settings-scroll').evaluate((element) => ({
        supported: typeof document.documentElement.style.scrollBehavior === 'string',
        value: getComputedStyle(element).scrollBehavior,
      }));
      if (policy.supported) expect(policy.value).toBe(expected);
    }
  });

  test('keeps localized animation profile controls on one line', async ({ page }) => {
    const locales = ['en', 'pt-BR'];
    await gotoFirstRunSettings(page);

    for (const locale of locales) {
      await page.evaluate((value) => {
        localStorage.setItem('iptv_locale', JSON.stringify(value));
      }, locale);
      await reloadFirstRunSettings(page);
      await openSettingsPane(page, 'appearance');

      const layout = await page.locator('#animation-mode').evaluate((group) => {
        const section = group.closest<HTMLElement>('.settings-section')!;
        const row = group.closest<HTMLElement>('.settings-option')!;
        const buttons = Array.from(group.querySelectorAll<HTMLElement>('.toggle-option'));
        const rows = Array.from(section.querySelectorAll<HTMLElement>('.settings-option'));
        return {
          buttonCount: buttons.length,
          wrapped: buttons.filter((button) => {
            const range = document.createRange();
            range.selectNodeContents(button);
            return range.getClientRects().length !== 1;
          }).map(button => button.textContent?.trim() ?? ''),
          // The text of a row must stop short of its control.
          textOverlaps: rows.filter((optionRow) => {
            const control = optionRow.querySelector<HTMLElement>('.settings-option-control')!
              .getBoundingClientRect();
            return Array.from(optionRow.querySelectorAll<HTMLElement>(
              '.settings-item-title, .settings-item-hint',
            )).some((text) => {
              const range = document.createRange();
              range.selectNodeContents(text);
              return range.getBoundingClientRect().right > control.left;
            });
          }).map(optionRow => optionRow.textContent?.trim() ?? ''),
          groupRight: Math.round(group.getBoundingClientRect().right),
          hintRight: Math.round(
            row.querySelector<HTMLElement>('.settings-item-hint')!
              .getBoundingClientRect().right,
          ),
          sectionRight: Math.round(section.getBoundingClientRect().right),
        };
      });

      expect(layout.buttonCount, locale).toBe(3);
      expect(layout.wrapped, locale).toEqual([]);
      expect(layout.textOverlaps, locale).toEqual([]);
      expect(layout.groupRight, locale).toBeLessThanOrEqual(layout.sectionRight);
      expect(layout.hintRight, locale).toBeLessThanOrEqual(layout.sectionRight);
    }
  });

  test('the action bar sits below the scroll viewport and stays put while scrolling', async ({ page }) => {
    await gotoFirstRunSettings(page);
    const main = page.locator('.settings-main');
    const scroll = page.locator('.settings-scroll');
    const actions = page.locator('.settings-actions');

    const [mainBox, scrollBox, actionBox] = await Promise.all([
      main.boundingBox(),
      scroll.boundingBox(),
      actions.boundingBox(),
    ]);
    expect(mainBox).not.toBeNull();
    expect(scrollBox).not.toBeNull();
    expect(actionBox).not.toBeNull();
    expect(actionBox!.x).toBeLessThanOrEqual(mainBox!.x);
    expect(actionBox!.y).toBeGreaterThanOrEqual(scrollBox!.y + scrollBox!.height - 1);
    expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(mainBox!.y + mainBox!.height + 1);

    // `position: sticky` is Chromium 56, so the bar must hold its place
    // through the layout itself rather than through the scroll position.
    await scroll.evaluate((el) => {
      el.style.scrollBehavior = 'auto';
      el.scrollTop = el.scrollHeight;
    });
    const scrolled = await actions.boundingBox();
    expect(scrolled!.y).toBeCloseTo(actionBox!.y, 0);
  });

  test('clicking Cancel in a category returns to the Settings cards, not a category or the player', async ({ page }) => {
    await routePlaylist(page);
    await seedPlaylist(page);
    await page.goto('/');
    await expect(page.locator('#view-channels')).toBeVisible();

    // Open settings via the tab bar, then dismiss with Cancel.
    await enterSettings(page);
    await expect(page.locator('#view-settings')).toBeVisible();
    await page.locator('#cancel-settings').click();

    // Give the document-level deferred select (setTimeout 0) a chance to fire,
    // then assert we still sit on the cards: that second select must neither
    // open the card under the pointer nor play a channel.
    await page.waitForTimeout(50);
    await expect(page.locator('#view-prefs')).toBeVisible();
    await expect(page.locator('#view-settings')).toBeHidden();
    await expect(page.locator('#view-player')).toBeHidden();
    await expect(page.locator('#view-channels')).toBeHidden();
  });

  test('scales buttons consistently for pointer and D-pad focus', async ({ page }) => {
    await gotoFirstRunSettings(page);
    await openSettingsPane(page, 'channels');
    const button = page.locator('#edit-channel-list');

    await button.hover();
    await expect(button).toHaveCSS('transform', 'matrix(1.03, 0, 0, 1.03, 0, 0)');

    await page.locator('.settings-title').hover();
    await expect(button).not.toHaveClass(/focused/);
    await expect(button).toHaveCSS('transform', 'none');

    // Down resumes from the button the pointer left: past the toggle row to
    // the next button.
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#show-hidden .toggle-option.focused')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    const focusedButton = page.locator('#view-settings button.focused');
    await expect(focusedButton).toHaveCount(1);
    await expect(focusedButton).toHaveAttribute('id', 'reset-customization');
    await expect(focusedButton).toHaveCSS('transform', 'matrix(1.03, 0, 0, 1.03, 0, 0)');

    const toggle = page.locator('#show-hidden .toggle-option').first();
    await toggle.hover();
    await expect(toggle).toHaveClass(/focused/);
    await expect(toggle).toHaveCSS('transform', 'none');
  });

  test('keeps scaled dropdown controls inside their scroll containers', async ({ page }) => {
    await gotoFirstRunSettings(page);
    await openSettingsPane(page, 'appearance');
    const dropdown = page.locator('#app-language');
    const trigger = dropdown.locator('.dropdown-trigger');

    await trigger.hover();
    await expect(trigger).toHaveCSS('transform', 'matrix(1.03, 0, 0, 1.03, 0, 0)');
    const triggerBounds = await page.evaluate(() => {
      const main = document.querySelector('.settings-main')!.getBoundingClientRect();
      const control = document.querySelector('#app-language .dropdown-trigger')!
        .getBoundingClientRect();
      return {
        leftInset: control.left - main.left,
        rightInset: main.right - control.right,
      };
    });
    expect(triggerBounds.leftInset).toBeGreaterThanOrEqual(0);
    expect(triggerBounds.rightInset).toBeGreaterThanOrEqual(0);

    await trigger.click();
    const option = dropdown.locator('.dropdown-option').first();
    await option.hover();
    await expect(option).toHaveCSS('transform', 'matrix(1.03, 0, 0, 1.03, 0, 0)');
    const optionBounds = await page.evaluate(() => {
      const menu = document.querySelector('#app-language .dropdown-menu')!
        .getBoundingClientRect();
      const item = document.querySelector('#app-language .dropdown-option')!
        .getBoundingClientRect();
      return {
        leftInset: item.left - menu.left,
        rightInset: menu.right - item.right,
        topInset: item.top - menu.top,
      };
    });
    expect(optionBounds.leftInset).toBeGreaterThanOrEqual(0);
    expect(optionBounds.rightInset).toBeGreaterThanOrEqual(0);
    expect(optionBounds.topInset).toBeGreaterThanOrEqual(0);
  });

  test('sideways moves stay inside the block holding the focus', async ({ page }) => {
    await gotoFirstRunSettings(page);
    await openSettingsPane(page, 'playback');

    const hover = (selector: string) => page.locator(selector).first()
      .evaluate(el => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
    const focusedBlock = () => page.evaluate(() => {
      const block = document.querySelector('#view-settings .focused')
        ?.closest('.settings-category, .settings-actions, .settings-head');
      return block ? block.id || block.className : null;
    });

    // The row's last option is at the right edge of the category, level with
    // nothing; the action bar and the header are the nearest things sideways.
    await hover('#auto-play .toggle-option:last-child');
    await expect(page.locator('#auto-play .toggle-option').last()).toHaveClass(/focused/);
    for (let step = 0; step < 3; step++) {
      await page.keyboard.press('ArrowRight');
      expect(await focusedBlock()).toBe('settings-playback');
    }
    for (let step = 0; step < 4; step++) {
      await page.keyboard.press('ArrowLeft');
      expect(await focusedBlock()).toBe('settings-playback');
    }

    await hover('#save-settings');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#save-settings')).toHaveClass(/focused/);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#cancel-settings')).toHaveClass(/focused/);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#cancel-settings')).toHaveClass(/focused/);

    await hover('#settings-back');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#settings-back')).toHaveClass(/focused/);

    // Up and Down are what cross between the blocks.
    await page.keyboard.press('ArrowDown');
    expect(await focusedBlock()).toBe('settings-playback');
  });

  test('Left closes an open dropdown and returns to its trigger', async ({ page }) => {
    await gotoFirstRunSettings(page);
    await openSettingsPane(page, 'playback');
    const dropdown = page.locator('#live-reconnect-attempts');
    const trigger = dropdown.locator('.dropdown-trigger');

    await trigger.evaluate(el => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
    await page.keyboard.press('Enter');
    await expect(dropdown).toHaveClass(/open/);

    await page.keyboard.press('ArrowLeft');
    await expect(dropdown).not.toHaveClass(/open/);
    await expect(trigger).toHaveClass(/focused/);
    await expect(page.locator('#view-settings')).toBeVisible();
  });

  test('Back from a category returns to the Settings cards', async ({ page }) => {
    await gotoFirstRunSettings(page);
    await openSettingsPane(page, 'guide');
    await expect(page.locator('#settings-pane-title')).toBeVisible();

    await page.evaluate(() => document.dispatchEvent(
      new KeyboardEvent('keydown', { keyCode: 461, bubbles: true }),
    ));
    await expect(page.locator('#view-prefs')).toBeVisible();
    await expect(page.locator('#view-settings')).toBeHidden();

    await openSettingsPane(page, 'guide');
    await page.locator('#settings-back').click();
    await expect(page.locator('#view-prefs')).toBeVisible();
    await expect(page.locator('#view-settings')).toBeHidden();
  });

  test('keeps every localized category title and option row within its screen', async ({ page }) => {
    const locales = ['en', 'pt-BR'];
    const panes = ['sources', 'channels', 'guide', 'appearance', 'playback', 'subtitles', 'data'] as const;
    await gotoFirstRunSettings(page);

    for (const locale of locales) {
      await page.evaluate((value) => {
        localStorage.setItem('iptv_locale', JSON.stringify(value));
      }, locale);
      await reloadFirstRunSettings(page);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);

      for (const pane of panes) {
        await openSettingsPane(page, pane);
        const result = await page.locator('.settings-view').evaluate((view) => {
          const head = view.querySelector<HTMLElement>('.settings-head')!.getBoundingClientRect();
          const title = view.querySelector<HTMLElement>('#settings-pane-title')!;
          const range = document.createRange();
          range.selectNodeContents(title);
          const lines = new Set(Array.from(range.getClientRects()).map(rect => Math.round(rect.top)));
          const rows = Array.from(view.querySelectorAll<HTMLElement>(
            '.settings-category.is-active .settings-option',
          ));
          return {
            title: title.textContent?.trim() ?? '',
            titleLines: lines.size,
            titleFits: range.getBoundingClientRect().right <= head.right + 1,
            bad: rows.filter((row) => {
              const bounds = row.getBoundingClientRect();
              const control = row.querySelector<HTMLElement>('.settings-option-control')!
                .getBoundingClientRect();
              const texts = Array.from(row.querySelectorAll<HTMLElement>(
                '.settings-item-title, .settings-item-hint',
              ));
              return control.right > bounds.right + 1
                || texts.some((text) => {
                  const textRange = document.createRange();
                  textRange.selectNodeContents(text);
                  return text.scrollWidth > text.clientWidth + 1
                    || textRange.getBoundingClientRect().right > control.left;
                });
            }).map(row => row.querySelector('.settings-item-title')?.textContent?.trim() ?? ''),
          };
        });

        expect(result.title, `${locale} ${pane}`).not.toBe('');
        expect(result.titleLines, `${locale} ${pane}`).toBe(1);
        expect(result.titleFits, `${locale} ${pane}`).toBe(true);
        expect(result.bad, `${locale} ${pane}`).toEqual([]);
      }
    }
  });

  test('keeps localized EPG time correction text and controls within the section', async ({ page }) => {
    const locales = ['en', 'pt-BR'];
    await gotoFirstRunSettings(page);

    for (const locale of locales) {
      await page.evaluate((value) => {
        localStorage.setItem('iptv_locale', JSON.stringify(value));
      }, locale);
      await reloadFirstRunSettings(page);
      await openSettingsPane(page, 'guide');

      const layout = await page.locator('.epg-offset-controls').evaluate((controls) => {
        const item = controls.closest<HTMLElement>('.settings-item')!;
        const section = controls.closest<HTMLElement>('.settings-section')!;
        const dropdown = controls.querySelector<HTMLElement>('.dropdown')!;
        const stepper = controls.querySelector<HTMLElement>('.epg-offset-stepper')!;
        const sectionRight = section.getBoundingClientRect().right;
        const overflowing = Array.from(item.querySelectorAll<HTMLElement>(
          '.settings-item-title, .settings-item-hint, .epg-offset-controls',
        )).filter(element =>
          element.scrollWidth > element.clientWidth + 1
          || element.getBoundingClientRect().right > sectionRight + 1)
          .map(element => element.textContent?.trim() ?? '');
        const hintLines = Array.from(item.querySelectorAll<HTMLElement>('.settings-item-hint'))
          .map(element => Math.round(
            element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight),
          ));
        return {
          overflowing,
          hintLines,
          dropdownTop: Math.round(dropdown.getBoundingClientRect().top),
          stepperTop: Math.round(stepper.getBoundingClientRect().top),
          controlsRight: Math.round(controls.getBoundingClientRect().right),
          sectionRight: Math.round(sectionRight),
        };
      });

      expect(layout.overflowing, locale).toEqual([]);
      expect(Math.max(...layout.hintLines), locale).toBeLessThanOrEqual(2);
      expect(layout.stepperTop, locale).toBe(layout.dropdownTop);
      expect(layout.controlsRight, locale).toBeLessThanOrEqual(layout.sectionRight);
    }
  });

  test('the text size picker scales only fonts and persists', async ({ page }) => {
    await routePlaylist(page);
    await seedPlaylist(page);
    await page.goto('/');
    await enterSettings(page);
    await expect(page.locator('#view-settings')).toBeVisible();

    const title = page.locator('.settings-title');
    const fontSize = () => title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const base = await fontSize();

    await openSettingsPane(page, 'appearance');
    await page.locator('#text-size .dropdown-trigger').click();
    const option = page.locator('#text-size .dropdown-option[data-dropdown-value="130"]');
    await expect(option).toBeVisible();
    await option.click();
    // Live preview: the scale applies before saving.
    expect(await fontSize()).toBeCloseTo(base * 1.3, 1);

    await page.locator('#save-settings').click();
    await backToLive(page);

    // Persisted across a relaunch and applied outside Settings, without
    // changing the dimensions of controls.
    await page.reload();
    await expect(page.locator('#view-channels')).toBeVisible();
    const row = page.locator('.channel-item').first();
    const metrics = () => row.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        font: parseFloat(getComputedStyle(el.querySelector('.channel-name')!).fontSize),
        height: parseFloat(cs.height),
        padding: parseFloat(cs.paddingLeft),
        logo: parseFloat(getComputedStyle(el.querySelector('.channel-logo-wrap')!).width),
      };
    });
    const scaled = await metrics();
    // Same measurements at the default size, from a clean load.
    await page.evaluate(() => localStorage.removeItem('iptv_text_size'));
    await page.reload();
    await expect(page.locator('#view-channels')).toBeVisible();
    const unscaled = await metrics();
    expect(scaled.font).toBeCloseTo(unscaled.font * 1.3, 1);
    for (const key of ['height', 'padding', 'logo'] as const)
      expect(scaled[key], key).toBeCloseTo(unscaled[key], 1);
  });
});

test.describe('Settings playlists', () => {
  test('saving a playlist in settings reloads and shows its channels', async ({ page }) => {
    await routePlaylist(page);
    await gotoFirstRunSettings(page);

    // First run with no playlist opens settings.
    await expect(page.locator('#view-settings')).toBeVisible();

    // Add a playlist row and fill in its URL.
    await page.locator('#add-playlist').click();
    await page.locator('.playlist-name').first().fill('Saved');
    await page.locator('.playlist-url').first().fill(PLAYLIST_URL);

    // Drive Save via the remote-style focus + Enter path (avoids the click's
    // deferred select firing on the channel view after the reload). Use an
    // explicit CustomEvent so SpatialNav's parent-bound listener receives a
    // bubbling nav:hover.
    await page.locator('.playlist-url').first().blur();
    await page.evaluate(() => {
      document.getElementById('save-settings')!
        .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    });
    await page.keyboard.press('Enter');

    await expect(page.locator('#view-channels')).toBeVisible();
    await expect(page.locator('.channel-main .channel-name').filter({ hasText: 'Channel One' })).toBeVisible();
    await expect(page.locator('.channel-main .channel-name').filter({ hasText: 'Channel Two' })).toBeVisible();
  });

  test('removing the last playlist clears in-memory channels so back returns an empty list', async ({ page }) => {
    await routePlaylist(page);
    await seedPlaylist(page);
    await page.goto('/');

    // Channels render from the configured playlist.
    await expect(page.locator('#view-channels')).toBeVisible();
    await expect(page.locator('.channel-main .channel-item')).toHaveCount(2);

    // Open settings, remove the only playlist, and save.
    await enterSettings(page);
    await expect(page.locator('#view-settings')).toBeVisible();
    await page.locator('.remove-playlist').first().click();
    await expect(page.locator('#playlist-entries .settings-row')).toHaveCount(0);
    // Save via the keyboard path so the deferred-select skip-list does not
    // matter here (this test is about stale in-memory state, not click wiring).
    // Use page.evaluate for an explicit CustomEvent so SpatialNav's parent-
    // bound listener definitely receives the bubbling nav:hover.
    await page.evaluate(() => {
      document.getElementById('save-settings')!
        .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    });
    await page.keyboard.press('Enter');

    // With no source left, loadData lands on the Access screen, as on first run.
    await expect(page.locator('#view-access')).toBeVisible();

    // Press Back to return to the channel list — it must NOT show the previous
    // playlist's channels (the bug: PlaylistService kept stale in-memory state).
    // Use dispatchEvent(KeyboardEvent) rather than page.keyboard.press('Escape')
    // — in this Playwright/Chromium combo press('Escape') gets consumed by
    // native key handling before any JS keydown listener fires (verified by
    // tracing: keyCode=13 Enter pressed via press() reaches KeyHandler, but
    // keyCode=27 Escape pressed via press() never does).
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    });
    await expect(page.locator('#view-channels')).toBeVisible();
    await expect(page.locator('.channel-main .channel-item')).toHaveCount(0);
    await expect(page.locator('.empty-state')).toContainText('No channels found');
  });

  // Regression: a global document click handler fired a deferred "select" after
  // the clicked Remove button detached (its `.settings-view` ancestor gone, so
  // the guard missed it), deleting a second row — clicking Remove on row N wiped
  // out N and N+1. waitForTimeout lets that deferred select fire.
  test.describe('playlist removal', () => {
    // Seed three playlists and stub their URLs so the app boots into the channel
    // list without real network.
    async function seedThree(page: Page): Promise<void> {
      const stream = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:-1,\nhttp://streams.example.com/s.ts';
      await page.route('**/one.m3u8', r => r.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: stream }));
      await page.route('**/two.m3u8', r => r.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: stream }));
      await page.route('**/four.m3u', r => r.fulfill({ status: 200, contentType: 'application/x-mpegurl',
        body: '#EXTM3U\n#EXTINF:-1,Alpha\nhttp://streams.example.com/a\n#EXTINF:-1,Bravo\nhttp://streams.example.com/b' }));
      await page.addInitScript(() => {
        localStorage.setItem('iptv_playlists', JSON.stringify([
          { name: 'Playlist 1', url: 'http://host.example.com/one.m3u8', source: 'url', id: 'id1' },
          { name: 'Playlist 2', url: 'http://host.example.com/two.m3u8', source: 'url', id: 'id2' },
          { name: 'Playlist 4', url: 'http://host.example.com/four.m3u', source: 'url', id: 'id3' },
        ]));
      });
    }

    async function openSettings(page: Page): Promise<void> {
      await page.goto('/');
      await page.waitForSelector('.tab-bar-item[data-section="settings"]', { timeout: 20000 });
      await enterSettings(page);
      await page.waitForSelector('.remove-playlist');
    }

    const names = (page: Page) =>
      page.$$eval('.playlist-name', els => (els as HTMLInputElement[]).map(e => e.value));

    test('Remove deletes only the clicked row', async ({ page }) => {
      await seedThree(page);
      await openSettings(page);
      await page.locator('.remove-playlist').first().click();
      await page.waitForTimeout(200);
      expect(await names(page)).toEqual(['Playlist 2', 'Playlist 4']);
    });

    test('removing a middle row leaves the rest intact', async ({ page }) => {
      await seedThree(page);
      await openSettings(page);
      await page.locator('.remove-playlist').nth(1).click();
      await page.waitForTimeout(200);
      expect(await names(page)).toEqual(['Playlist 1', 'Playlist 4']);
    });

    test('deleting down to the last row clears it (no spurious re-add)', async ({ page }) => {
      // Removing the last row left focus on "+ Add Playlist"; the deferred select
      // then "clicked" it and re-added an empty row, so the last one never went.
      await seedThree(page);
      await openSettings(page);
      for (let i = 0; i < 3; i++) {
        await page.locator('.remove-playlist').first().click();
        await page.waitForTimeout(150);
      }
      await expect(page.locator('.playlist-name')).toHaveCount(0);
      await expect(page.locator('#playlist-entries .empty-hint')).toBeVisible();
    });
  });
});

test.describe('Settings Xtream: add -> cancel -> re-enter', () => {
  // Boot into the channel list (so the settings gear is present) with one M3U
  // playlist and NO Xtream account — matching "no Xtream account at all".
  async function seedOneM3u(page: Page): Promise<void> {
    await page.route('**/one.m3u', r => r.fulfill({
      status: 200, contentType: 'application/x-mpegurl',
      body: '#EXTM3U\n#EXTINF:-1,Alpha\nhttp://streams.example.com/a',
    }));
    await page.addInitScript(() => {
      localStorage.setItem('iptv_playlists', JSON.stringify([
        { name: 'Playlist 1', url: 'http://host.example.com/one.m3u', source: 'url', id: 'id1' },
      ]));
    });
  }

  async function openSettings(page: Page): Promise<void> {
    await page.waitForSelector('.tab-bar-item[data-section="settings"]', { timeout: 20000 });
    await enterSettings(page);
    await page.waitForSelector('#add-xtream');
  }

  test("re-entering Settings after Cancel must NOT show a leftover Xtream card", async ({ page }) => {
    await seedOneM3u(page);
    await page.goto('/');

    // 1) Open Settings — no Xtream account yet, no auto-added card.
    await openSettings(page);
    await expect(page.locator('#xtream-entries .xtream-card')).toHaveCount(0);
    await expect(page.locator('#xtream-entries .empty-hint')).toHaveText('No Xtream accounts added yet');

    // 2) Click "+ Add Xtream Account" — a blank card appears.
    await page.click('#add-xtream');
    await expect(page.locator('#xtream-entries .xtream-card')).toHaveCount(1);

    // 3) Cancel.
    await page.click('#cancel-settings');
    await expect(page.locator('#view-prefs')).toBeVisible(); // back on the cards

    // 4) Re-enter Settings.
    await openSettings(page);

    // 5) The card must be gone (this is the user's reported bug).
    await expect(page.locator('#xtream-entries .xtream-card')).toHaveCount(0);
    await expect(page.locator('#xtream-entries .empty-hint')).toHaveText('No Xtream accounts added yet');
  });
});

test.describe('Settings Xtream live output', () => {
  test('keeps long localized format labels aligned with the dropdown', async ({ page }) => {
    await page.route('**/get.php*', route => route.fulfill({
      status: 200,
      contentType: 'application/x-mpegurl',
      body: '#EXTM3U',
    }));
    await page.route('**/xmltv.php*', route =>
      route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
    await page.route('**/player_api.php*', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.addInitScript(() => {
      localStorage.setItem('iptv_playlists', JSON.stringify([{
        id: 'x1',
        name: 'Account 1',
        url: 'http://host.example.com:8080',
        source: 'xtream',
        xtream: { username: 'u1', password: 'p1' },
      }]));
    });

    await page.goto('/');
    for (const locale of ['en', 'pt-BR']) {
      await page.evaluate((value) => {
        localStorage.setItem('iptv_locale', JSON.stringify(value));
      }, locale);
      await page.reload();
      await enterSettings(page, 'sources');

      const layout = await page.locator('.xtream-output').evaluate((field) => {
        const label = field.querySelector('label')!;
        const dropdown = field.querySelector('.dropdown')!;
        return {
          fieldWidth: field.getBoundingClientRect().width,
          labelWidth: label.getBoundingClientRect().width,
          labelHeight: label.getBoundingClientRect().height,
          labelLineHeight: parseFloat(getComputedStyle(label).lineHeight),
          dropdownWidth: dropdown.getBoundingClientRect().width,
        };
      });
      expect(layout.labelHeight, locale).toBeLessThanOrEqual(layout.labelLineHeight + 1);
      expect(layout.labelWidth, locale).toBeCloseTo(layout.fieldWidth, 0);
      expect(layout.dropdownWidth, locale).toBeCloseTo(layout.fieldWidth, 0);
      expect(layout.fieldWidth, locale).toBeLessThanOrEqual(260);
    }
  });

  test('saving HLS reloads the account with output=m3u8', async ({ page }) => {
    await page.route('**/get.php*', (route) => {
      const output = new URL(route.request().url()).searchParams.get('output');
      const channel = output === 'm3u8' ? 'HLS Channel' : 'TS Channel';
      return route.fulfill({
        status: 200,
        contentType: 'application/x-mpegurl',
        body: `#EXTM3U\n#EXTINF:-1,${channel}\nhttp://streams.example.com/live`,
      });
    });
    await page.route('**/xmltv.php*', route =>
      route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
    await page.route('**/player_api.php*', (route) => {
      const action = new URL(route.request().url()).searchParams.get('action');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: action === 'get_live_streams'
          ? JSON.stringify([{
              stream_id: 101,
              direct_source: 'http://streams.example.com/live',
              tv_archive: 0,
            }])
          : '{}',
      });
    });
    await page.addInitScript(() => {
      localStorage.setItem('iptv_playlists', JSON.stringify([{
        id: 'x1',
        name: 'Account 1',
        url: 'http://host.example.com:8080',
        source: 'xtream',
        xtream: { username: 'u1', password: 'p1' },
      }]));
    });

    await page.goto('/');
    await expect(page.locator('.channel-main .channel-item')).toContainText('TS Channel');
    await enterSettings(page, 'sources');
    await page.locator('#xtream-output-x1 .dropdown-trigger').click();
    await page.locator('#xtream-output-x1 [data-dropdown-value="m3u8"]').click();

    const hlsRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname.endsWith('/get.php') && url.searchParams.get('output') === 'm3u8';
    });
    await page.locator('#save-settings').click();
    await hlsRequest;

    await expect(page.locator('#view-channels')).toBeVisible();
    await expect(page.locator('.channel-main .channel-item')).toContainText('HLS Channel');
    await expect.poll(() => page.evaluate(() => {
      const playlists = JSON.parse(localStorage.getItem('iptv_playlists') || '[]');
      return playlists[0]?.xtream?.liveOutput;
    })).toBe('m3u8');
  });
});
