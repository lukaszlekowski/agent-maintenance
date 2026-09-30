import assert from 'node:assert/strict';
import test from 'node:test';
import { MaintenanceError } from '../../src/types.ts';
import { makeIndexPlan, parseJournal, parseManifest, parseRegistry } from '../../src/storage/schema.ts';

const archive = '123e4567-e89b-42d3-a456-426614174000';
const tx = '223e4567-e89b-42d3-a456-426614174000';
const identity = { dev: '1', ino: '2', size: 1, mtimeNs: '3', mode: 0o600 };
const index = makeIndexPlan({ present: true }, { present: false });
const payload = { source: { baseRoot: 'AGENT_HOME', relativePath: 'session.json' }, archiveRelPath: 'payload/000000.bin', sha256: 'a'.repeat(64), bytes: 1, mode: 0o600, sourceIdentity: identity, archiveIdentity: identity };
const manifest = { manifestVersion: 1, archiveId: archive, txId: tx, agentId: 'codex_cli', sessionId: 'session-1', adapterSchema: 'test@1', category: 'archived', createdAt: new Date(0).toISOString(), trustedRootIds: ['AGENT_HOME','MAINTENANCE'], payload: [payload], index };
const journal = { journalVersion: 2, archiveId: archive, txId: tx, agentId: 'codex_cli', sessionId: 'session-1', adapterSchema: 'test@1', category: 'archived', action: 'archive', state: 'INITIATED', progressState: 'INITIATED', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), archiveRootId: 'MAINTENANCE', archiveRelPath: `archived/codex_cli/session-1/${archive}`, payload: [{ ...payload, stageRelPath: 'staging/000000.bin.part' }], index, diagnostics: [] };

function hasCode(error: unknown, code: string): boolean { return error instanceof MaintenanceError && error.code === code; }

test('persisted identity fields reject omissions, coercible objects, numbers, and non-UUID generated IDs', () => {
  for (const parser of [parseManifest, parseJournal]) {
    for (const field of ['archiveId','txId','sessionId'] as const) {
      for (const bad of [undefined, 3, {}]) {
        const valid = parser === parseManifest ? manifest : journal;
        assert.throws(() => parser({ ...valid, [field]: bad }), (error: unknown) => hasCode(error, parser === parseManifest ? 'MANIFEST_SCHEMA_INVALID' : 'JOURNAL_SCHEMA_INVALID'));
      }
    }
  }
  assert.throws(() => parseRegistry({ registryVersion: 1, diagnostics: [], entries: [{ archiveId: undefined, txId: tx, agentId: 'codex_cli', sessionId: 'x', category: 'archived', rootId: 'MAINTENANCE', relativePath: `archived/codex_cli/x/${archive}`, status: 'REGISTERED' }] }), (error: unknown) => hasCode(error, 'REGISTRY_SCHEMA_INVALID'));
});

test('persisted journals reject impossible terminal, index, and publication claims', () => {
  assert.throws(() => parseJournal({ ...journal, state: 'COMPLETED', progressState: 'COMPLETED', indexIntent: true, indexCommitted: true }), (error: unknown) => hasCode(error, 'JOURNAL_SCHEMA_INVALID'));
  assert.throws(() => parseJournal({ ...journal, indexCommitted: true }), (error: unknown) => hasCode(error, 'JOURNAL_SCHEMA_INVALID'));
  assert.throws(() => parseJournal({ ...journal, state: 'RECOVERY_PENDING', progressState: 'RECOVERY_FAILED' }), (error: unknown) => hasCode(error, 'JOURNAL_SCHEMA_INVALID'));
  assert.throws(() => parseJournal({ ...journal, action: 'restore', category: 'archived', state: 'TARGET_PUBLISHED', progressState: 'TARGET_PUBLISHED', indexIntent: true, indexCommitted: true }), (error: unknown) => hasCode(error, 'JOURNAL_SCHEMA_INVALID'));
  assert.throws(() => parseJournal({ ...journal, action: 'restore', state: 'ROLLED_BACK', progressState: 'ROLLED_BACK' }), (error: unknown) => hasCode(error, 'JOURNAL_SCHEMA_INVALID'));
  assert.throws(() => parseManifest({ ...manifest, payload: [{ ...payload, mode: 0o1000 }] }), (error: unknown) => hasCode(error, 'MANIFEST_SCHEMA_INVALID'));
});
