import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import nodeTest from 'node:test';
import { durableStorageTest as test } from '../storage/support/platform-test.ts';
import { assessMutationCapability, nativeMutationCapabilities } from '../../src/mutations/capabilities.ts';
import { archiveHash, actualSchemaFingerprint } from '../../src/mutations/sqlite-codec.ts';
import { SqliteDependencyStore } from '../../src/mutations/sqlite-store.ts';
import { StorageTransactionEngine } from '../../src/storage/engine.ts';
import { adapterSchemaKey, controlledTestBackend } from '../../src/storage/safety.ts';
import type { StorageAdapter } from '../../src/storage/contracts.ts';
import type { ClosureTable, DatabaseArchive, RelationalSessionAdapter, SqlValue } from '../../src/mutations/sqlite-contracts.ts';

async function fixture(t: { after(fn: () => void | Promise<void>): void }, ownership: 'ACTIVE' | 'DORMANT' | 'UNKNOWN' = 'DORMANT') {
  const root = await mkdtemp(join(tmpdir(), 'agent-maintenance-sqlite-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, 'sessions.db');
  const initial = new DatabaseSync(databasePath);
  initial.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), body TEXT NOT NULL UNIQUE);
    CREATE TABLE attachments(id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id), contents BLOB NOT NULL);
    INSERT INTO sessions VALUES ('s1','first'),('s2','unrelated');
    INSERT INTO messages VALUES ('m1','s1','alpha'),('m2','s2','other');
    INSERT INTO attachments VALUES ('a1','m1',X'0102'),('a2','m2',X'0304');`);
  initial.close();
  const db = new DatabaseSync(databasePath); const fingerprint = actualSchemaFingerprint(db); db.close();
  const storageSchema = { name: 'disposable-storage-adapter', version: 'fixture-1', fingerprint };
  const storageAdapter: StorageAdapter = {
    agentId: 'agy_cli', schema: storageSchema,
    inspectSafety: async (sessionId) => ({ agentId: 'agy_cli', sessionId, adapterSchema: adapterSchemaKey(storageSchema), observedAt: new Date().toISOString(),
      ownership: 'DORMANT', activity: 'QUIESCENT', ownershipEvidence: 'controlled fixture', activityEvidence: 'controlled fixture',
      externalWriterExclusion: { enabled: true, evidence: 'fixture callback' }, raceSafeFileOperations: { enabled: true, evidence: 'controlled temporary root' } }),
    withExternalExclusion: async (_sid, action) => action(), snapshotPayload: async () => [], readIndexState: async () => null,
    planIndexRemoval: async () => null, applyIndexState: async () => undefined,
  };
  const storageRoot = join(root, 'managed');
  const engine = new StorageTransactionEngine({ storageRoot, trustedRoots: [], backend: controlledTestBackend() }, storageAdapter);
  const adapter: RelationalSessionAdapter = {
    agentId: 'agy_cli', version: 'fixture-1', databasePath, schemaFingerprint: fingerprint,
    tablesInRestoreOrder: [
      { name: 'sessions', columns: ['id', 'title'], primaryKey: ['id'] },
      { name: 'messages', columns: ['id', 'session_id', 'body'], primaryKey: ['id'] },
      { name: 'attachments', columns: ['id', 'message_id', 'contents'], primaryKey: ['id'] },
    ],
    capability: assessMutationCapability({ operation: 'database', controlBoundary: 'controlled-test', adapterId: 'agy_cli', version: 'fixture-1',
      schema: { name: 'fixture-relational-schema', version: '1', fingerprint }, dependencyCoverage: 'COMPLETE',
      exclusionProtocol: 'SQLite BEGIN IMMEDIATE writer exclusion, disposable fixture only', raceSafeFileOperations: 'VALIDATED', testedOS: process.platform,
      evidenceRef: 'test/mutations/sqlite-store.test.ts fixture schema' }),
    withExternalExclusion: async (_session, action) => action(), inspectOwnership: async () => ownership,
    openDatabase: () => new DatabaseSync(databasePath), captureClosure: (database, sessionId) => capture(database, sessionId),
  };
  const makeStore = (hook?: (boundary: string) => void) => new SqliteDependencyStore(adapter, engine, hook);
  return { root, storageRoot, databasePath, adapter, storageAdapter, engine, store: makeStore(), makeStore };
}
function capture(database: DatabaseSync, sid: string): readonly ClosureTable[] {
  const sessions = database.prepare('SELECT id, title FROM sessions WHERE id = ?').all(sid) as Record<string, SqlValue>[];
  const messages = database.prepare('SELECT id, session_id, body FROM messages WHERE session_id = ? ORDER BY id').all(sid) as Record<string, SqlValue>[];
  const ids = messages.map((row) => row.id).filter((id): id is string => typeof id === 'string');
  const attachments: Record<string, SqlValue>[] = ids.length ? database.prepare(`SELECT id, message_id, contents FROM attachments WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids) as Record<string, SqlValue>[] : [];
  return [{ name: 'sessions', rows: sessions }, { name: 'messages', rows: messages }, { name: 'attachments', rows: attachments }];
}
function rows(path: string, table: string): Record<string, SqlValue>[] { const db = new DatabaseSync(path); try { return (db.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all() as Record<string, SqlValue>[]).map((row) => Object.fromEntries(Object.entries(row))); } finally { db.close(); } }
function archiveFile(x: { storageRoot: string }, sessionId: string, id: string): string { return join(x.storageRoot, 'database/agy_cli', sessionId, id, 'database.json'); }
function journalFile(x: { storageRoot: string }, tx: string): string { return join(x.storageRoot, 'transactions', `${tx}.database.json`); }

test('managed SQLite participant snapshots, strict delete/restore, registry linkage, and unrelated rows', async (t) => {
  const x = await fixture(t); const result = await x.store.exportAndDelete('s1');
  assert.equal(result.archive.creationTransactionId, result.transactionId);
  assert.deepEqual(rows(x.databasePath, 'sessions'), [{ id: 's2', title: 'unrelated' }]);
  assert.equal(result.archive.tables.reduce((sum, table) => sum + table.rows.length, 0), 3);
  assert.deepEqual([...result.archive.tables[2]!.rows[0]!.contents as Uint8Array], [1, 2]);
  assert.equal(JSON.parse(await readFile(journalFile(x, result.transactionId), 'utf8')).state, 'DB_COMMITTED');
  assert.deepEqual((await x.engine.listDatabaseArchives('agy_cli', 's1')).map((entry) => entry.archiveId), [result.archiveId]);
  const restoredTx = await x.store.restore('s1', result.archiveId);
  assert.equal(JSON.parse(await readFile(journalFile(x, restoredTx), 'utf8')).state, 'RESTORE_COMMITTED');
  assert.deepEqual(rows(x.databasePath, 'sessions').map((row) => row.id), ['s1', 's2']);
});

test('terminal creation and restore journals remain historical after restore and later edits', async (t) => {
  const x = await fixture(t); const created = await x.store.exportAndDelete('s1');
  const restoreTx = await x.store.restore('s1', created.archiveId);
  const creationJournalPath = journalFile(x, created.transactionId); const restoreJournalPath = journalFile(x, restoreTx);
  const creationBefore = await readFile(creationJournalPath); const restoreBefore = await readFile(restoreJournalPath);
  const db = new DatabaseSync(x.databasePath); db.prepare("UPDATE sessions SET title='legitimate later edit' WHERE id='s1'").run(); db.close();
  await x.engine.recover(); await x.engine.recover();
  assert.deepEqual(await readFile(creationJournalPath), creationBefore);
  assert.deepEqual(await readFile(restoreJournalPath), restoreBefore);
  assert.equal(JSON.parse(creationBefore.toString('utf8')).state, 'DB_COMMITTED');
  assert.equal(JSON.parse(restoreBefore.toString('utf8')).state, 'RESTORE_COMMITTED');
  assert.deepEqual((await x.engine.listDatabaseArchives('agy_cli', 's1')).map((entry) => entry.archiveId), [created.archiveId]);
  assert.equal(rows(x.databasePath, 'sessions').find((row) => row.id === 's1')?.title, 'legitimate later edit');
});

test('recovery repairs registry publication after terminal creation journal without rewriting history', async (t) => {
  const x = await fixture(t); const interrupted = x.makeStore((boundary) => {
    if (boundary === 'after-terminal:db-delete-before-registry') throw new Error('stopped before registry publication');
  });
  await assert.rejects(interrupted.exportAndDelete('s1'), /stopped before registry publication/);
  const tx = await findTx(x, 's1', 'export-delete'); const journalPath = journalFile(x, tx);
  const terminalBeforeRecovery = await readFile(journalPath);
  assert.equal(JSON.parse(terminalBeforeRecovery.toString('utf8')).state, 'DB_COMMITTED');
  assert.deepEqual(await x.engine.listDatabaseArchives('agy_cli', 's1'), []);
  await x.engine.recover();
  const repairedJournal = await readFile(journalPath);
  assert.deepEqual(repairedJournal, terminalBeforeRecovery);
  const archiveId = JSON.parse(repairedJournal.toString('utf8')).archiveId as string;
  assert.deepEqual((await x.engine.listDatabaseArchives('agy_cli', 's1')).map((entry) => entry.archiveId), [archiveId]);
  await x.engine.recover();
  assert.deepEqual(await readFile(journalPath), repairedJournal);
  assert.deepEqual((await x.engine.listDatabaseArchives('agy_cli', 's1')).map((entry) => entry.archiveId), [archiveId]);
});

test('strict restore rejects uniqueness and relationship conflicts without partial inserts', async (t) => {
  for (const conflict of ['unique', 'foreign-key'] as const) {
    const x = await fixture(t); const result = await x.store.exportAndDelete('s1');
    const file = archiveFile(x, 's1', result.archiveId); const archive = JSON.parse(await readFile(file, 'utf8')) as DatabaseArchive;
    if (conflict === 'unique') { const db = new DatabaseSync(x.databasePath); db.prepare("UPDATE messages SET body='alpha' WHERE id='m2'").run(); db.close(); }
    else {
      const tables = archive.tables.map((table) => table.name === 'sessions' ? { ...table, rows: [] } : table);
      const body = { formatVersion: archive.formatVersion, archiveId: archive.archiveId, creationTransactionId: archive.creationTransactionId,
        agentId: archive.agentId, adapterVersion: archive.adapterVersion,
        schemaFingerprint: archive.schemaFingerprint, sessionId: archive.sessionId, exportedAt: archive.exportedAt, tables };
      await writeFile(file, JSON.stringify({ ...body, integrityHash: archiveHash(body as unknown as DatabaseArchive) }));
    }
    await assert.rejects(x.store.restore('s1', result.archiveId));
    assert.equal(rows(x.databasePath, 'sessions').length, 1);
  }
});

test('managed database recovery is idempotent before and after SQL commit', async (t) => {
  const x = await fixture(t);
  const afterCommit = x.makeStore((boundary) => { if (boundary === 'after-side-effect:db-delete') throw new Error('lost completion'); });
  await assert.rejects(afterCommit.exportAndDelete('s1'));
  const tx = await findTx(x, 's1', 'export-delete');
  const recovery = await x.engine.recover();
  assert.ok(recovery.some((row) => row.txId === tx && row.status === 'RECOVERED'));
  const before = x.makeStore((boundary) => { if (boundary === 'after-intent:db-delete') throw new Error('before commit'); });
  await assert.rejects(before.exportAndDelete('s2'));
  const beforeTx = await findTx(x, 's2', 'export-delete'); const beforeJournal = JSON.parse(await readFile(journalFile(x, beforeTx), 'utf8')) as { archiveId: string };
  assert.equal((await x.store.recover('s2', beforeJournal.archiveId, beforeTx)).state, 'ABORTED');
});

test('database participant shares the OS maintenance lock with a competing process', async (t) => {
  const x = await fixture(t); const started = join(x.root, 'competitor-started'); const entered = join(x.root, 'competitor-entered');
  let child: ReturnType<typeof spawn> | undefined;
  await x.engine.withDatabaseParticipant({ sessionId: 's1', operation: 'create', schemaFingerprint: x.adapter.schemaFingerprint }, async () => {
    const schema = x.storageAdapter.schema;
    const source = `import { writeFile } from 'node:fs/promises'; import { StorageTransactionEngine } from './src/storage/engine.ts'; import { adapterSchemaKey, controlledTestBackend } from './src/storage/safety.ts'; const root=${JSON.stringify(x.storageRoot)}; const started=${JSON.stringify(started)}; const entered=${JSON.stringify(entered)}; const schema=${JSON.stringify(schema)}; const adapter={agentId:'agy_cli',schema,inspectSafety:async(sessionId)=>({agentId:'agy_cli',sessionId,adapterSchema:adapterSchemaKey(schema),observedAt:new Date().toISOString(),ownership:'DORMANT',activity:'QUIESCENT',ownershipEvidence:'child fixture',activityEvidence:'child fixture',externalWriterExclusion:{enabled:true,evidence:'child fixture'},raceSafeFileOperations:{enabled:true,evidence:'controlled root'}}),withExternalExclusion:async(_sid,action)=>action(),snapshotPayload:async()=>[],readIndexState:async()=>null,planIndexRemoval:async()=>null,applyIndexState:async()=>{}}; await writeFile(started,'started'); const engine=new StorageTransactionEngine({storageRoot:root,trustedRoots:[],backend:controlledTestBackend()},adapter); await engine.withDatabaseParticipant({sessionId:'s1',operation:'create',schemaFingerprint:schema.fingerprint},async(participant)=>writeFile(entered,participant.archiveId));`;
    const processChild = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { cwd: process.cwd(), stdio: 'ignore' });
    child = processChild;
    t.after(() => { if (processChild.exitCode === null) processChild.kill('SIGKILL'); });
    await waitForFile(started); await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(readFile(entered));
  });
  await new Promise<void>((resolve, reject) => { child!.once('error', reject); child!.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`competing process exited ${code}`))); });
  assert.match(await readFile(entered, 'utf8'), /^[0-9a-f-]{36}$/i);
});
async function waitForFile(path: string): Promise<void> { for (let i = 0; i < 300; i += 1) { try { await readFile(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } } throw new Error('competing process did not start'); }
async function findTx(x: { storageRoot: string }, session: string, action: string): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  for (const name of await readdir(join(x.storageRoot, 'transactions'))) { if (!name.endsWith('.database.json')) continue; const value = JSON.parse(await readFile(join(x.storageRoot, 'transactions', name), 'utf8')) as { sessionId: string; action: string }; if (value.sessionId === session && value.action === action) return name.replace('.database.json', ''); }
  throw new Error('managed database transaction not found');
}

test('SQLite writer contention, active ownership, disabled adapter, and schema drift fail closed', async (t) => {
  const x = await fixture(t); let blocked = false;
  const store = x.makeStore((boundary) => { if (boundary !== 'after-intent:db-delete') return; const contender = new DatabaseSync(x.databasePath, { timeout: 0 }); try { contender.prepare("INSERT INTO sessions VALUES ('s3','racing writer')").run(); } catch (error) { blocked = /locked/i.test(String(error)); } finally { contender.close(); } });
  await store.exportAndDelete('s1'); assert.equal(blocked, true);
  const active = await fixture(t, 'ACTIVE'); await assert.rejects(active.store.exportAndDelete('s1'), /observed ACTIVE/);
  const forged = { ...nativeMutationCapabilities.agy_cli, enabled: true, adapterId: 'agy_cli' as const, version: 'fixture-1', schemaKey: x.adapter.capability.schemaKey };
  const disabled = new SqliteDependencyStore({ ...x.adapter, capability: forged }, x.engine);
  await assert.rejects(disabled.exportAndDelete('s2'), /capability issuance/i);
  const db = new DatabaseSync(x.databasePath); db.exec('CREATE TABLE unreviewed_table(id TEXT PRIMARY KEY)'); db.close();
  await assert.rejects(x.store.exportAndDelete('s2'), /schema fingerprint/);
});

test('database recovery ignores forged absolute archive paths and uses managed archive identity', async (t) => {
  const x = await fixture(t); const result = await x.store.exportAndDelete('s1');
  const attackerPath = join(x.root, 'attacker.json'); await writeFile(attackerPath, 'must remain untouched');
  const file = journalFile(x, result.transactionId); const journal = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  journal.archivePath = attackerPath; await writeFile(file, JSON.stringify(journal));
  const recovered = await x.store.recover('s1', result.archiveId, result.transactionId);
  assert.equal(recovered.state, 'DB_COMMITTED');
  assert.equal(await readFile(attackerPath, 'utf8'), 'must remain untouched');
  assert.equal(rows(x.databasePath, 'sessions').length, 1);
});

nodeTest('production protected-root backend and cross-boundary fixture evidence fail closed', async (t) => {
  const x = await fixture(t);
  const productionEngine = new StorageTransactionEngine({ storageRoot: join(x.root, 'production-managed'), trustedRoots: [] }, x.storageAdapter);
  const productionCapability = assessMutationCapability({ operation: 'database', controlBoundary: 'protected-production', adapterId: 'agy_cli', version: 'fixture-1',
    schema: { name: 'fixture-relational-schema', version: '1', fingerprint: x.adapter.schemaFingerprint }, dependencyCoverage: 'COMPLETE',
    exclusionProtocol: 'fixture only', raceSafeFileOperations: 'VALIDATED', testedOS: process.platform, evidenceRef: 'fixture only' });
  const store = new SqliteDependencyStore({ ...x.adapter, capability: productionCapability }, productionEngine);
  await assert.rejects(store.exportAndDelete('s1'), /Handle-relative protected-root operations are unavailable/);
  assert.equal(rows(x.databasePath, 'sessions').length, 2);
});
