// Builds store/ux-scenario-xsol-player.pdf, the UX Scenario document the LG Seller
// Lounge asks for, laid out like LG's template: a screen with numbered UI elements and a
// table describing each number. Needs store/raw/ from e2e/store-screenshots.spec.ts
// (see store/README.md); it never touches the app itself.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = process.cwd();
const RAW = join(ROOT, 'store', 'raw');
const OUT = join(ROOT, 'store', 'ux-scenario-xsol-player.pdf');

const SCREENS = [
  ['1-home', 'Home', 'The first screen after launch. Shows the last watched channel, the sections and featured channels.'],
  ['2-live', 'Live channels', 'Home > Live. Groups on the left, channels in the middle.'],
  ['3-guide', 'Program guide', 'Red key (from Home or Live).'],
  ['4-movies', 'Movies', 'Section bar > Movies (needs an Xtream account).'],
  ['5-series', 'Series', 'Section bar > Series (needs an Xtream account).'],
  ['6-search', 'Search', 'Section bar > Search. Channels, programs, movies and series in one list.'],
  ['7-settings', 'Settings', 'Section bar > Settings (or the Blue key).'],
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const png = async (file) => `data:image/png;base64,${(await readFile(file)).toString('base64')}`;

const CSS = `
@page { size: 1280px 720px; margin: 0 }
* { box-sizing: border-box }
body { margin: 0; font-family: 'Segoe UI', Arial, sans-serif; color: #1b1b1b }
.page { width: 1280px; height: 720px; padding: 34px 44px; position: relative; page-break-after: always; overflow: hidden; background: #fff }
h1 { margin: 0 0 4px; font-size: 30px }
.sub { color: #555; font-size: 15px; margin-bottom: 18px }
.bar { position: absolute; left: 0; top: 0; right: 0; height: 8px; background: #151210 }
.row { display: flex; gap: 28px }
.shot { position: relative; width: 760px; height: 427.5px; flex: none; border: 1px solid #999; background: #000 }
.shot img { width: 100%; height: 100% }
.badge { position: absolute; width: 26px; height: 26px; border-radius: 50%; background: #d6342c; color: #fff; font-weight: 700; font-size: 15px;
  display: flex; align-items: center; justify-content: center; border: 2px solid #fff; transform: translate(-50%, -50%) }
.box { position: absolute; border: 2px solid #d6342c; border-radius: 4px }
table { border-collapse: collapse; width: 100%; font-size: 13.5px }
th, td { border: 1px solid #bbb; padding: 6px 8px; vertical-align: top; text-align: left }
th { background: #eee }
td.n { width: 34px; text-align: center; font-weight: 700; color: #d6342c }
.side { flex: 1; min-width: 0 }
.keys td:first-child { width: 190px; font-weight: 600 }
.map { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 10px }
.node { border: 2px solid #151210; border-radius: 8px; padding: 12px 16px; font-size: 16px; background: #f6f1e8 }
.arrow { align-self: center; font-size: 22px }
ul { margin: 6px 0 0 18px; padding: 0; font-size: 15px; line-height: 1.55 }
.foot { position: absolute; left: 44px; bottom: 14px; font-size: 11px; color: #777 }
`;

const foot = (n) => `<div class="foot">XSol Player 1.0.0 &nbsp;|&nbsp; com.xsol.player &nbsp;|&nbsp; UX scenario &nbsp;|&nbsp; ${n}</div>`;

const icon = await png(join(ROOT, 'store', 'icon-512.png'));
let n = 0;
const pages = [];

pages.push(`<div class="page"><div class="bar"></div>${foot(++n)}
<div class="row" style="gap:36px;margin-top:20px"><img src="${icon}" style="width:150px;height:150px;border-radius:24px">
<div><h1 style="font-size:40px">XSol Player</h1><div class="sub">UX scenario for LG QA &nbsp;|&nbsp; App ID com.xsol.player &nbsp;|&nbsp; Version 1.0.0 &nbsp;|&nbsp; webOS 4 and later</div>
<ul><li>XSol Player is a media player. It plays playlists, program guides and catalogs that the user provides (M3U, Xtream Codes, XMLTV). The app does not include or sell any channel or content.</li>
<li>Demo data in the screens that follow is synthetic (channels such as "News 1", movies with invented titles).</li>
<li>On first launch the device is activated with the activation service; the device ID is shown on screen. Test access and sample playlist are described in the notes for the tester in the submission form.</li>
<li>Remote control: arrows, OK, Back, colour keys, Channel +/-, and the Magic Remote pointer.</li></ul></div></div>
<h1 style="margin-top:34px;font-size:22px">How to read this document</h1>
<ul><li>Each page shows one screen with red numbers on its UI elements.</li><li>The table next to it says what each number does and which key operates it.</li></ul></div>`);

const nav = ['Home', 'Live', 'Movies', 'Series', 'Settings', 'Search'].map((x) => `<div class="node">${x}</div>`).join('');
pages.push(`<div class="page"><div class="bar"></div>${foot(++n)}<h1>Navigation map</h1>
<div class="sub">How the screens connect. Back returns one step.</div>
<div class="map"><div class="node" style="background:#151210;color:#fff">Launch (app icon)</div><div class="arrow">&rarr;</div><div class="node">Activation (first time only)</div><div class="arrow">&rarr;</div><div class="node">Home</div></div>
<div class="sub" style="margin-top:22px">From Home, the section bar (top) opens each section; Left/Right moves, OK opens:</div>
<div class="map">${nav}</div>
<ul style="margin-top:22px"><li><b>Live</b> &rarr; select a channel &rarr; <b>Player</b> (full screen, with on-screen controls, audio/subtitle menu and channel list).</li>
<li><b>Guide</b> (Red key) &rarr; select a program &rarr; play, catch-up or reminder.</li>
<li><b>Movies / Series</b> &rarr; select a poster &rarr; detail page &rarr; play.</li>
<li><b>Settings</b> &rarr; playlists, language, parental control, player and data options.</li>
<li><b>Search</b> &rarr; type &rarr; open a channel, program, movie or series.</li></ul></div>`);

for (const [id, title, where] of SCREENS) {
  const items = JSON.parse(await readFile(join(RAW, `ux-${id}.json`), 'utf8'));
  const k = 760 / 1920;
  const marks = items.map((i) => `<div class="box" style="left:${i.x * k}px;top:${i.y * k}px;width:${i.w * k}px;height:${i.h * k}px"></div>` +
    `<div class="badge" style="left:${i.x * k}px;top:${i.y * k}px">${i.n}</div>`).join('');
  const rows = items.map((i) => `<tr><td class="n">${i.n}</td><td><b>${esc(i.name)}</b><br>${esc(i.text)}</td></tr>`).join('');
  pages.push(`<div class="page"><div class="bar"></div>${foot(++n)}<h1>${title}</h1><div class="sub">${esc(where)}</div>
<div class="row"><div class="shot"><img src="${await png(join(RAW, `store-${id}.png`))}">${marks}</div>
<div class="side"><table><tr><th>No.</th><th>UI element and function</th></tr>${rows}</table></div></div></div>`);
}

pages.push(`<div class="page"><div class="bar"></div>${foot(++n)}<h1>Remote control</h1><div class="sub">Keys used by the app.</div>
<table class="keys"><tr><th>Key</th><th>Action</th></tr>
<tr><td>Arrows</td><td>Move the focus. Up from the top row reaches the section bar.</td></tr>
<tr><td>OK</td><td>Open or play the focused item.</td></tr>
<tr><td>Back</td><td>Go back one step; closes menus and the player.</td></tr>
<tr><td>Channel +/-</td><td>Next/previous channel while playing; on Home, tunes the preview card.</td></tr>
<tr><td>Red</td><td>Open the Guide (leaves the Guide when already there).</td></tr>
<tr><td>Green</td><td>Add or remove a favorite.</td></tr>
<tr><td>Yellow</td><td>Change the sort order (Movies and Series).</td></tr>
<tr><td>Blue</td><td>Open Settings (leaves Settings when already there).</td></tr>
<tr><td>Magic Remote pointer</td><td>Point and click any item, scroll with the wheel. Every item above is also reachable without the pointer.</td></tr>
<tr><td>Play / Pause / Stop / Rewind / Forward</td><td>Control playback in the player.</td></tr><tr><td>Number keys</td><td>Enter a channel number in Live.</td></tr></table>
<ul style="margin-top:16px"><li>The legend in the top bar shows the colour keys for the current screen.</li></ul></div>`);

pages.push(`<div class="page"><div class="bar"></div>${foot(++n)}<h1>Notes for LG QA</h1><div class="sub">Things worth knowing while testing.</div>
<ul><li>The app has no login for the end user. The device is activated by the activation service; the test access is in the submission form.</li>
<li>Channels, movies and series come from the playlist the tester adds under Settings; the app itself ships no content.</li>
<li>Parental control is optional: a PIN can protect content and hide categories. It is off until the tester sets it.</li>
<li>Optional online subtitle search uses the user's own keys with third-party providers and is off by default.</li>
<li>The app has no advertising and no in-app purchases. The activation licence is sold outside the app.</li>
<li>Data stored on the TV (playlists, favorites, history, settings) can be erased in Settings &gt; Data management.</li></ul></div>`);

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${pages.join('')}</body></html>`;
await writeFile(join(RAW, 'ux-scenario.html'), html);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.pdf({ path: OUT, width: '1280px', height: '720px', printBackground: true });
await browser.close();
console.log(OUT, `${pages.length} pages`);
