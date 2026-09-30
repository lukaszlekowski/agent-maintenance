import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGuiApi, parseGuiCommand } from '../../src/gui/api.ts';
import { fixtureArchive, fixtureInventory, fixtureServices } from '../tui/fixtures.ts';

test('GUI API uses shared inventory and preserves an exact archive identity', async () => {
  let restores = 0; let actions = 0;
  const archive = fixtureArchive('archive-exact');
  const api = createGuiApi(fixtureServices({
    loadInventory: async () => fixtureInventory(),
    listArchives: async () => ({ records: [archive], available: true }),
    restoreArchive: async (_agent, _session, archiveId) => { restores += 1; return { ok: false, message: `Blocked ${archiveId}` }; },
    performSessionAction: async () => { actions += 1; return { ok: true, message: 'should not execute' }; },
  }));
  const snapshot = await api.snapshot();
  assert.equal(snapshot.inventory.sessions[0]?.ownership, 'UNKNOWN');
  assert.equal(snapshot.archives[0]?.archiveId, 'archive-exact');
  const restore = await api.dispatch({ kind: 'restore', archiveId: 'archive-exact' });
  assert.equal(restore.ok, false);
  assert.match(restore.message, /evidence|disabled/i);
  assert.equal(restores, 0, 'shared capability policy blocks unavailable restore');
  const stale = await api.dispatch({ kind: 'restore', archiveId: 'not-listed' });
  assert.match(stale.message, /unavailable/i);
  const session = await api.dispatch({ kind: 'session', action: 'archive', agentId: 'codex_cli', sessionId: 'session-1' });
  assert.equal(session.ok, false);
  assert.equal(actions, 0, 'unknown ownership never reaches a writer service');
});

test('GUI command parser rejects malformed and oversized intent fields', () => {
  assert.equal(parseGuiCommand(null), null);
  assert.equal(parseGuiCommand({ kind: 'session', action: 'archive', agentId: 'codex_cli', sessionId: 'x'.repeat(257) }), null);
  assert.equal(parseGuiCommand({ kind: 'session', action: 'delete-all', agentId: 'codex_cli', sessionId: 'x' }), null);
  assert.equal(parseGuiCommand({ kind: 'restore', archiveId: '' }), null);
});
