import assert from 'node:assert/strict';
import test from 'node:test';
import { exactArchiveSelection, moveTab, pageStart, sessionRows, tabForKey } from '../../src/tui/model.ts';
import { fixtureArchive, fixtureInventory } from './fixtures.ts';

test('six-tab mapping wraps and help shortcut is global', () => {
  assert.equal(tabForKey('6'), 'Help'); assert.equal(tabForKey('?'), 'Help'); assert.equal(tabForKey('7'), undefined);
  assert.equal(moveTab('Overview', -1), 'Help'); assert.equal(moveTab('Help', 1), 'Overview');
});

test('pagination bounds and session agent hierarchy expansion are stable', () => {
  assert.equal(pageStart(4, 5, 11), 10); assert.equal(pageStart(5, 5, 11), 10);
  const inventory = fixtureInventory();
  assert.equal(sessionRows(inventory, new Set()).filter((row) => row.kind === 'session').length, 0);
  assert.equal(sessionRows(inventory, new Set(['codex_cli'])).filter((row) => row.kind === 'session').length, 1);
});

test('archive selection rejects ambiguous instances and preserves exact identity', () => {
  const rows = [fixtureArchive('archive-one'), fixtureArchive('archive-two')];
  assert.deepEqual(exactArchiveSelection(rows), { kind: 'ambiguous', archiveIds: ['archive-one', 'archive-two'] });
  assert.equal(exactArchiveSelection(rows, 'archive-two').kind, 'selected');
  assert.equal(exactArchiveSelection(rows, 'unknown').kind, 'missing');
});
