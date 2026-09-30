import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultTuiServices } from '../../src/tui/services.ts';
import { fixtureSession } from './fixtures.ts';

test('default TUI services report unsupported storage and keep native actions disabled', async () => {
  const services = createDefaultTuiServices();
  const listing = await services.listArchives();
  assert.equal(listing.available, false); assert.match(listing.reason ?? '', /protected-root/);
  const result = await services.performSessionAction('archive', fixtureSession);
  assert.equal(result.ok, false); assert.match(result.message, /UNKNOWN/);
  const dormant = { ...fixtureSession, ownership: 'DORMANT' as const, ownershipExplanation: 'fixture ownership' };
  const disabled = await services.performSessionAction('archive', dormant);
  assert.equal(disabled.ok, false); assert.match(disabled.message, /Phase 0|exclusion|dependency/i);
  assert.equal((await services.restoreArchive('codex_cli', 'session-1', 'archive-id')).ok, false);
  const sync = await services.syncTrust('codex_cli', '/fixture/project');
  assert.equal(sync.length, 4); assert.ok(sync.every((outcome) => !outcome.ok && /disabled|unavailable|evidence/i.test(outcome.message)));
});
