import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createGuiApi, parseGuiCommand } from '../../src/gui/api.ts';
import { CONFIG_DEFAULTS, validateConfig } from '../../src/core/config.ts';
import { fixtureInventory, fixtureServices } from '../tui/fixtures.ts';

test('actual Settings form sends numeric ports and rejects invalid values before API dispatch', async () => {
  const directory = new URL('../../src/gui/public/', import.meta.url);
  const html = await readFile(new URL('index.html', directory), 'utf8');
  const app = await readFile(new URL('app.js', directory), 'utf8');
  const dom = new JSDOM(html, { url: `http://127.0.0.1:4567/#token=${'c'.repeat(64)}`, runScripts: 'outside-only' });
  const posts: Array<Record<string, unknown>> = [];
  const settings = validateConfig(CONFIG_DEFAULTS);
  const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
  dom.window.fetch = async (url, options) => {
    if (url === '/api/snapshot') return response({ inventory: fixtureInventory(), archives: [], archiveAvailable: false });
    if (url === '/api/settings') return response(settings);
    if (url === '/api/actions') {
      const body: unknown = JSON.parse(options?.body as string);
      posts.push(body as Record<string, unknown>);
      return response({ ok: true, message: 'Preferences saved' });
    }
    throw new Error(`Unexpected GUI request ${String(url)}`);
  };
  dom.window.confirm = () => true;
  dom.window.setInterval = (() => 0) as typeof dom.window.setInterval;
  Object.defineProperty(dom.window, 'WebSocket', { value: class { constructor() { throw new Error('WebSocket is outside this form test'); } } });
  try {
    dom.window.eval(app);
    await tick(); await tick();
    const settingsTab = [...dom.window.document.querySelectorAll<HTMLButtonElement>('nav button')].find((button) => button.textContent === 'Settings');
    assert.ok(settingsTab);
    settingsTab.click();
    let form = dom.window.document.querySelector<HTMLFormElement>('main form');
    assert.ok(form);
    const port = form.elements.namedItem('defaultPort') as HTMLInputElement;
    const folder = form.elements.namedItem('tempFolder') as HTMLInputElement;
    const confirmDelete = form.elements.namedItem('confirmDelete') as HTMLInputElement;
    assert.equal(port.valueAsNumber, 4567);
    folder.value = '/tmp/gui-preferences'; confirmDelete.checked = false;
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => posts.length === 1);
    const unchangedPort = posts[0]?.settings as Record<string, unknown>;
    assert.equal(unchangedPort.defaultPort, 4567);
    assert.equal(typeof unchangedPort.defaultPort, 'number');
    assert.equal(unchangedPort.tempFolder, '/tmp/gui-preferences');
    assert.equal(unchangedPort.confirmDelete, false);

    await tick();
    form = dom.window.document.querySelector<HTMLFormElement>('main form'); assert.ok(form);
    const changedPort = form.elements.namedItem('defaultPort') as HTMLInputElement;
    changedPort.value = '8123';
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => posts.length === 2);
    assert.equal((posts[1]?.settings as Record<string, unknown>).defaultPort, 8123);

    await tick();
    form = dom.window.document.querySelector<HTMLFormElement>('main form'); assert.ok(form);
    const invalidPort = form.elements.namedItem('defaultPort') as HTMLInputElement;
    invalidPort.value = '70000';
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    assert.equal(posts.length, 2);
    assert.match(dom.window.document.querySelector('#result')?.textContent ?? '', /integer from 1 through 65535/);

    invalidPort.value = '';
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    assert.equal(posts.length, 2);

    const api = createGuiApi(fixtureServices({ settings: { load: async () => settings, save: async (value) => { assert.equal(value.defaultPort, 8123); } } }));
    const command = parseGuiCommand(posts[1]);
    assert.ok(command);
    assert.equal((await api.dispatch(command)).ok, true);
  } finally { dom.window.close(); }
});

function tick(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 0)); }
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 250;
  while (!condition() && Date.now() < deadline) await tick();
  assert.equal(condition(), true, 'GUI form submission did not reach the API');
}
