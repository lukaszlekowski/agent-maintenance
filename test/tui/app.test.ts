import assert from 'node:assert/strict';
import React from 'react';
import test from 'node:test';
import { render } from 'ink-testing-library';
import { TuiApp } from '../../src/tui/app.ts';
import { fixtureArchive, fixtureInventory, fixtureServices, fixtureSession } from './fixtures.ts';
import type { AgentInventory } from '../../src/types.ts';
import { MemorySettingsStore } from '../../src/tui/settings.ts';

function tree(services = fixtureServices(), viewport = { rows: 18, columns: 80 }, inventory: AgentInventory = fixtureInventory()) {
  return React.createElement(TuiApp, { services, initialInventory: inventory, initialArchives: [fixtureArchive('archive-one')], viewport });
}

async function interactive(services = fixtureServices(), viewport = { rows: 18, columns: 80 }) {
  const view = render(tree(services, viewport));
  await new Promise((resolve) => setImmediate(resolve));
  return view;
}
async function press(view: ReturnType<typeof render>, input: string) {
  view.stdin.write(input); await new Promise((resolve) => setImmediate(resolve));
}

test('six tabs, hierarchy, compact layout, and resize remain usable', async () => {
  const view = await interactive();
  assert.match(view.lastFrame() ?? '', /Overview/);
  assert.match(view.lastFrame() ?? '', /ownership unknown/);
  await press(view, '2'); assert.match(view.lastFrame() ?? '', /Sessions/); assert.match(view.lastFrame() ?? '', /Fixture session/);
  await press(view, '\r'); assert.doesNotMatch(view.lastFrame() ?? '', /Fixture session/);
  await press(view, '\r'); assert.match(view.lastFrame() ?? '', /Fixture session/);
  await press(view, '3'); assert.match(view.lastFrame() ?? '', /archive-one/);
  await press(view, '4'); assert.match(view.lastFrame() ?? '', /project/);
  await press(view, '5'); assert.match(view.lastFrame() ?? '', /Temporary folder/);
  await press(view, '6'); assert.match(view.lastFrame() ?? '', /Shortcuts|Tabs/);
  await press(view, '?'); assert.match(view.lastFrame() ?? '', /Help/);
  view.rerender(tree(fixtureServices(), { rows: 7, columns: 32 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(view.lastFrame() ?? '', /Help/); assert.ok((view.lastFrame() ?? '').split('\n').length <= 8);
  view.unmount();
});

test('session confirmation cancellation never dispatches a service action', async () => {
  let calls = 0;
  const services = fixtureServices({ performSessionAction: async () => { calls += 1; return { ok: true, message: 'unexpected' }; } });
  const view = await interactive(services); await press(view, '2'); await press(view, '\u001b[B'); await press(view, 'a');
  assert.match(view.lastFrame() ?? '', /Archive session/); await press(view, '\u001b');
  assert.equal(calls, 0); assert.match(view.lastFrame() ?? '', /cancelled/i); view.unmount();
});

test('sessions refresh routes through the read-only inventory provider', async () => {
  let loads = 0; const services = fixtureServices({ loadInventory: async () => { loads += 1; return fixtureInventory(); } });
  const view = await interactive(services); await press(view, '2'); await press(view, 'r');
  assert.equal(loads, 1); assert.match(view.lastFrame() ?? '', /Fixture session/); view.unmount();
});

test('affirmative action is blocked by core policy for unknown ownership before service dispatch', async () => {
  let calls = 0;
  const services = fixtureServices({ performSessionAction: async () => { calls += 1; return { ok: true, message: 'unexpected' }; } });
  const view = await interactive(services); await press(view, '2'); await press(view, '\u001b[B'); await press(view, 'a'); await press(view, 'y');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 0); assert.match(view.lastFrame() ?? '', /UNKNOWN/); assert.match(view.lastFrame() ?? '', /DORMANT ownership/); view.unmount();
});

test('storage restore passes the full selected archive ID to the shared service', async () => {
  const archiveId = '123e4567-e89b-42d3-a456-426614174000'; let requested: string | undefined;
  const services = fixtureServices({ restoreArchive: async (_agent, _session, id) => { requested = id; return { ok: false, message: 'Restore capability disabled' }; } });
  const inventory = fixtureInventory();
  const enabled = { ...inventory, adapters: inventory.adapters.map((adapter) => adapter.agentId === 'codex_cli'
    ? { ...adapter, capabilities: { ...adapter.capabilities, restore: { enabled: true, reason: 'controlled UI fixture' } } } : adapter) };
  const view = render(React.createElement(TuiApp, { services, initialInventory: enabled, initialArchives: [fixtureArchive(archiveId)], viewport: { rows: 18, columns: 80 } })); await new Promise((resolve) => setImmediate(resolve));
  await press(view, '3'); assert.match(view.lastFrame() ?? '', new RegExp(archiveId));
  await press(view, 'u'); await press(view, 'y');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requested, archiveId); assert.match(view.lastFrame() ?? '', /Restore capability disabled/); view.unmount();
});

test('modal text input consumes shortcut digits and cannot switch the active tab', async () => {
  const view = await interactive(); await press(view, '5'); await press(view, 't'); await press(view, '1abc');
  const frame = view.lastFrame() ?? ''; assert.match(frame, /Custom temporary folder/); assert.match(frame, /agent-maintenance-temp1abc/);
  await press(view, '\u001b'); assert.match(view.lastFrame() ?? '', /Settings/); view.unmount();
});

test('settings toggles persist through the internal preference store', async () => {
  const store = new MemorySettingsStore(); const services = fixtureServices({ settings: store }); const view = await interactive(services);
  await press(view, '5'); await press(view, '\u001b[B'); await press(view, '\u001b[B'); await press(view, '\r');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await store.load()).confirmDelete, false); assert.match(view.lastFrame() ?? '', /Confirm destructive requests \(c\): false/); view.unmount();
});

test('compact list pagination changes the visible settings selection', async () => {
  const view = await interactive(fixtureServices(), { rows: 7, columns: 40 });
  await press(view, '5'); await press(view, ']');
  assert.match(view.lastFrame() ?? '', /Confirm destructive requests/); view.unmount();
});

test('resize preserves the selected action and bounds compact dialogs', async () => {
  let launches = 0;
  const services = fixtureServices({ guiLauncher: { launch: async () => { launches += 1; return { launched: false, reason: 'disabled by fixture' }; } } });
  const view = await interactive(services, { rows: 18, columns: 80 }); await press(view, '5');
  for (let index = 0; index < 6; index += 1) await press(view, '\u001b[B');
  view.rerender(tree(services, { rows: 7, columns: 32 })); await new Promise((resolve) => setImmediate(resolve));
  assert.match(view.lastFrame() ?? '', /❯ .*Open desktop interface/);
  assert.ok((view.lastFrame() ?? '').split('\n').length <= 7);
  await press(view, '\r'); assert.match(view.lastFrame() ?? '', /Request a GUI launch/);
  assert.ok((view.lastFrame() ?? '').split('\n').length <= 7);
  await press(view, '\u001b'); await press(view, '\u001b[B');
  view.rerender(tree(services, { rows: 18, columns: 80 })); await new Promise((resolve) => setImmediate(resolve));
  assert.match(view.lastFrame() ?? '', /❯ .*Open desktop interface/);
  await press(view, '\r'); assert.match(view.lastFrame() ?? '', /Open desktop interface/);
  await press(view, 'y'); await new Promise((resolve) => setImmediate(resolve));
  view.unmount(); assert.equal(launches, 1);
});

test('Trust filter, add cancellation, and per-agent sync outcomes use shared services', async () => {
  let adds = 0; let syncs = 0;
  const services = fixtureServices({
    addTrustedPath: async () => { adds += 1; return { ok: false, message: 'write capability disabled' }; },
    syncTrust: async () => { syncs += 1; return [
      { agentId: 'codex_cli', ok: true, message: 'fixture accepted' },
      { agentId: 'claude_code_cli', ok: false, message: 'schema unsupported' },
    ]; },
  });
  const source = fixtureInventory();
  const readable = { ...source, adapters: source.adapters.map((adapter) => adapter.agentId === 'codex_cli' ? { ...adapter, capabilities: { ...adapter.capabilities, trustRead: { enabled: true, reason: 'fixture validated source' } } } : adapter) };
  const view = render(React.createElement(TuiApp, { services, initialInventory: readable, initialArchives: [], viewport: { rows: 18, columns: 80 } })); await new Promise((resolve) => setImmediate(resolve)); await press(view, '4'); await press(view, 'f');
  assert.match(view.lastFrame() ?? '', /Codex/); assert.doesNotMatch(view.lastFrame() ?? '', /Claude/);
  await press(view, 'a'); await press(view, '/tmp/new-project'); await press(view, '\r');
  assert.match(view.lastFrame() ?? '', /Add trusted directory/); await press(view, '\u001b'); assert.equal(adds, 0);
  await press(view, 's'); await press(view, 'y'); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(syncs, 1); assert.match(view.lastFrame() ?? '', /Codex: synced/); assert.match(view.lastFrame() ?? '', /Claude: blocked/);
  view.unmount();
});

test('trust add submit is capability gated and modal text remains bounded', async () => {
  let adds = 0;
  const services = fixtureServices({ addTrustedPath: async () => { adds += 1; return { ok: true, message: 'unexpected' }; } });
  const view = await interactive(services, { rows: 7, columns: 32 }); await press(view, '4'); await press(view, 'f'); await press(view, 'a');
  await press(view, '/tmp/trust-path-that-is-longer-than-this-window'); assert.ok((view.lastFrame() ?? '').split('\n').length <= 7);
  await press(view, '\r'); await press(view, 'y'); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adds, 0); assert.match(view.lastFrame() ?? '', /trust|disabled|capability/i); assert.ok((view.lastFrame() ?? '').split('\n').length <= 7);
  view.unmount();
});

test('confirmed trust add reaches the shared service only after absolute-path entry', async () => {
  let requested = '';
  const services = fixtureServices({ addTrustedPath: async (_agent, path) => { requested = path; return { ok: false, message: 'controlled capability denied' }; } });
  const source = fixtureInventory();
  const enabled = { ...source, adapters: source.adapters.map((adapter) => adapter.agentId === 'codex_cli'
    ? { ...adapter, capabilities: { ...adapter.capabilities, trustEdit: { enabled: true, reason: 'controlled UI test' } } } : adapter) };
  const view = render(React.createElement(TuiApp, { services, initialInventory: enabled, initialArchives: [], viewport: { rows: 12, columns: 40 } }));
  await new Promise((resolve) => setImmediate(resolve)); await press(view, '4'); await press(view, 'f'); await press(view, 'a');
  await press(view, '/tmp/fixture'); await press(view, '\r'); assert.match(view.lastFrame() ?? '', /Request trust for/);
  await press(view, 'y'); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requested, '/tmp/fixture'); assert.match(view.lastFrame() ?? '', /controlled capability denied/); view.unmount();
});

test('long exact archive identities remain confirmed and dialogs stay inside resized viewports', async () => {
  const identity = `${'archive-id-'.repeat(8)}final-id`;
  const archive = fixtureArchive(identity);
  let requested: string | undefined;
  const services = fixtureServices({ restoreArchive: async (_agent, _session, archiveId) => { requested = archiveId; return { ok: false, message: 'fixture complete' }; } });
  const source = fixtureInventory();
  const enabled = { ...source, adapters: source.adapters.map((adapter) => adapter.agentId === 'codex_cli'
    ? { ...adapter, capabilities: { ...adapter.capabilities, restore: { enabled: true, reason: 'controlled UI test' } } } : adapter) };
  const view = render(React.createElement(TuiApp, { services, initialInventory: enabled, initialArchives: [archive], viewport: { rows: 7, columns: 32 } }));
  await new Promise((resolve) => setImmediate(resolve)); await press(view, '3');
  assert.ok((view.lastFrame() ?? '').split('\n').length <= 7);
  await press(view, '\r');
  assert.ok((view.lastFrame() ?? '').split('\n').length <= 7);
  const frame = view.lastFrame() ?? '';
  assert.match(frame, /Restore exact archive ID/);
  assert.ok(frame.split('\n').length <= 7);
  for (let index = 0; index < 5; index += 1) await press(view, ']');
  assert.match(view.lastFrame() ?? '', /final-id/);
  assert.ok((view.lastFrame() ?? '').split('\n').length <= 7);
  await press(view, 'y'); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requested, identity); view.unmount();
});

test('compact multiline archive selection stays visible and restores its exact record', async () => {
  let requested: string | undefined;
  const services = fixtureServices({ restoreArchive: async (_agent, _session, id) => { requested = id; return { ok: true, message: 'controlled restore complete' }; } });
  const source = fixtureInventory();
  const enabled = { ...source, adapters: source.adapters.map((adapter) => adapter.agentId === 'codex_cli'
    ? { ...adapter, capabilities: { ...adapter.capabilities, restore: { enabled: true, reason: 'controlled UI test' } } } : adapter) };
  const view = render(React.createElement(TuiApp, { services, initialInventory: enabled, initialArchives: [fixtureArchive('archive-first-with-long-path'), fixtureArchive('archive-second-exact')], viewport: { rows: 7, columns: 32 } }));
  await new Promise((resolve) => setImmediate(resolve)); await press(view, '3'); await press(view, '\u001b[B');
  assert.match(view.lastFrame() ?? '', /❯/); assert.ok((view.lastFrame() ?? '').split('\n').length <= 7);
  await press(view, 'u'); assert.match(view.lastFrame() ?? '', /Restore exact archive ID/);
  await press(view, 'y'); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requested, 'archive-second-exact'); view.unmount();
});

test('inventory shrink reconciles disappeared selection before highlighting and actions', async () => {
  const full = fixtureInventory();
  const reduced = { ...full, sessions: [], verifiedSubagents: [], adapters: full.adapters.slice(0, 1) };
  const services = fixtureServices({ loadInventory: async () => reduced });
  const view = await interactive(services); await press(view, '2');
  for (let index = 0; index < 4; index += 1) await press(view, '\u001b[B');
  assert.match(view.lastFrame() ?? '', /❯ .*OpenCode/);
  await press(view, 'r'); await new Promise((resolve) => setImmediate(resolve));
  assert.match(view.lastFrame() ?? '', /❯ .*Codex/);
  await press(view, '\r'); assert.match(view.lastFrame() ?? '', /❯ .*▶ Codex/);
  assert.doesNotMatch(view.lastFrame() ?? '', /OpenCode/); view.unmount();
});

test('stable row identity survives adapter reordering and vanished session rows use a visible fallback', async () => {
  const source = fixtureInventory();
  const reordered = { ...source, adapters: [...source.adapters].reverse() };
  const vanished = { ...reordered, sessions: [], verifiedSubagents: [] };
  let refreshed = reordered;
  const services = fixtureServices({ loadInventory: async () => refreshed });
  const view = await interactive(services); await press(view, '2');
  await press(view, '\u001b[B');
  assert.match(view.lastFrame() ?? '', /❯ .*Fixture session/);
  await press(view, 'r'); await new Promise((resolve) => setImmediate(resolve));
  assert.match(view.lastFrame() ?? '', /❯ .*Fixture session/);
  refreshed = vanished; await press(view, 'r'); await new Promise((resolve) => setImmediate(resolve));
  assert.match(view.lastFrame() ?? '', /❯ .*OpenCode/);
  view.unmount();
});

test('long denied status remains available in notice while noncompact frames stay within height', async () => {
  for (const viewport of [{ rows: 18, columns: 40 }, { rows: 10, columns: 40 }, { rows: 7, columns: 32 }]) {
    const view = await interactive(fixtureServices(), viewport); await press(view, '2'); await press(view, '\u001b[B'); await press(view, 'a'); await press(view, 'y');
    const notice = view.lastFrame() ?? '';
    assert.match(notice, /DORMANT/); assert.match(notice, /ownership/); assert.ok(notice.split('\n').length <= viewport.rows);
    await press(view, '\r');
    const ordinary = view.lastFrame() ?? '';
    assert.match(ordinary, /❯/); assert.ok(ordinary.split('\n').length <= viewport.rows);
    view.unmount();
  }
});

test('multiline trust sync results stay scrollable in notice and status stays one line at compact breakpoints', async () => {
  const source = fixtureInventory();
  const readable = { ...source, adapters: source.adapters.map((adapter) => adapter.agentId === 'codex_cli'
    ? { ...adapter, capabilities: { ...adapter.capabilities, trustRead: { enabled: true, reason: 'fixture validated source' } } } : adapter) };
  const long = 'configuration capability blocked: '.repeat(4);
  const services = fixtureServices({ syncTrust: async () => ['codex_cli', 'claude_code_cli', 'agy_cli', 'opencode_cli'].map((agentId) => ({
    agentId: agentId as 'codex_cli' | 'claude_code_cli' | 'agy_cli' | 'opencode_cli', ok: false, message: long,
  })) });
  for (const viewport of [{ rows: 18, columns: 40 }, { rows: 10, columns: 40 }, { rows: 7, columns: 32 }]) {
    const view = render(React.createElement(TuiApp, { services, initialInventory: readable, initialArchives: [], viewport }));
    await new Promise((resolve) => setImmediate(resolve)); await press(view, '4');
    await press(view, 's'); await press(view, 'y');
    assert.match(view.lastFrame() ?? '', /Codex: blocked/);
    assert.ok((view.lastFrame() ?? '').split('\n').length <= viewport.rows);
    let notice = view.lastFrame() ?? '';
    for (let index = 0; index < 30 && !notice.includes('OpenCode: blocked'); index += 1) {
      await press(view, ']'); notice = view.lastFrame() ?? '';
      assert.ok(notice.split('\n').length <= viewport.rows);
    }
    assert.match(notice, /OpenCode: blocked/);
    await press(view, '\r');
    const frame = view.lastFrame() ?? '';
    assert.ok(frame.split('\n').length <= viewport.rows, `${viewport.rows}x${viewport.columns} frame exceeded its height`);
    view.unmount();
  }
});

test('ambiguous archive restore is never selected implicitly', async () => {
  const services = fixtureServices();
  const view = render(React.createElement(TuiApp, { services, initialInventory: fixtureInventory(),
    initialArchives: [fixtureArchive('archive-one'), fixtureArchive('archive-two')], viewport: { rows: 18, columns: 80 } }));
  await new Promise((resolve) => setImmediate(resolve)); await press(view, '3'); await press(view, 'r');
  assert.match(view.lastFrame() ?? '', /exact archive/i); assert.doesNotMatch(view.lastFrame() ?? '', /Restore archived session/); view.unmount();
});

test('GUI action uses the shared launcher seam and surfaces its unavailable result', async () => {
  let launches = 0;
  const services = fixtureServices({ guiLauncher: { launch: async () => { launches += 1; return { launched: false, reason: 'Phase 6 launcher unavailable' }; } } });
  const view = await interactive(services); await press(view, '5'); await press(view, 'g'); await press(view, 'y');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(launches, 1); assert.match(view.lastFrame() ?? '', /Phase 6 launcher unavailable/); view.unmount();
});

test('fixture session stays unknown rather than appearing active or working', async () => {
  assert.equal(fixtureSession.ownership, 'UNKNOWN');
  const view = await interactive(); await press(view, '2'); assert.match(view.lastFrame() ?? '', /UNKNOWN/); view.unmount();
});
