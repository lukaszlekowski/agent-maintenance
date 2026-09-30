import { ensurePrivateDirectory } from './durable-directories.ts';
import { ROOT_ID_STORAGE, ROOT_ID_TEMP, adapterSchemaId, posixRel, nativeRel, categoryFor, safeSessionId, readJson, type StorageAction, type ArchiveRecord } from './contracts.ts';


import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { resolveMappedPath } from '../core/paths.ts';
import { AGENT_IDS, MaintenanceError, archiveId, transactionId, type AgentId, type SessionId } from '../types.ts';

import { checkpoint, copyToExclusive, hashFile, publishNoReplace, readIdentity, removeIfSame, reserveDirectoryNoReplace, syncDirectory, writeNewJson } from './durable-fs.ts';
import { MANIFEST_VERSION, JOURNAL_VERSION, makeIndexPlan, parseManifest, type ArchiveManifest, type JournalPayload, type StorageJournal } from './schema.ts';
import { RestoreFlow } from './restore-flow.ts';
export class ArchiveFlow extends RestoreFlow {

  async archive(sidInput: string, action: StorageAction): Promise<ArchiveRecord> {
    const sid = safeSessionId(sidInput);
    if (!['archive','soft-delete','temp-move'].includes(action)) throw new MaintenanceError('STORAGE_ACTION_INVALID', 'Unsupported storage action');
    return this.exclusive(sid, () => this.archiveLocked(sid, action));
  }

  protected async archiveLocked(sid: SessionId, action: StorageAction): Promise<ArchiveRecord> {
    const category = categoryFor(action);
    if (category === 'temp' && !this.options.tempRoot) throw new MaintenanceError('TEMP_ROOT_UNREGISTERED', 'Temp relocation requires an explicitly registered trusted temp root');
    const before = await this.adapter.readIndexState(sid);
    if (before === null || before === undefined) throw new MaintenanceError('SESSION_NOT_PRESENT', 'Adapter index does not contain this session');
    const adapterAction = action === 'archive' ? 'archived' : action === 'soft-delete' ? 'deleted' : 'temp-move';
    const after = await this.adapter.planIndexRemoval(sid, before, adapterAction);
    const index = makeIndexPlan(before, after);
    const sourceMappings = await this.adapter.snapshotPayload(sid);
    if (sourceMappings.length === 0) throw new MaintenanceError('PAYLOAD_EMPTY', 'Adapter returned no payload files for the session');
    const canonicalMappings = sourceMappings.map((mapping) => Object.freeze({ baseRoot: mapping.baseRoot, relativePath: posixRel(mapping.relativePath) }));
    const unique = new Set<string>();
    const payloadSeed = [];
    for (let i = 0; i < canonicalMappings.length; i += 1) {
      const source = canonicalMappings[i]!;
      const key = `${source.baseRoot}\0${source.relativePath}`;
      if (unique.has(key)) throw new MaintenanceError('PAYLOAD_DUPLICATE_PATH', 'Adapter returned duplicate payload paths');
      unique.add(key);
      const absolute = await resolveMappedPath(this.roots, { baseRoot: source.baseRoot, relativePath: nativeRel(source.relativePath) });
      const identity = await readIdentity(absolute);
      const hashed = await hashFile(absolute);
      if (identity.size !== hashed.bytes) throw new MaintenanceError('SOURCE_CHANGED', 'Payload size changed while preparing the transaction');
      payloadSeed.push({ source, sha256: hashed.sha256, bytes: hashed.bytes, mode: identity.mode, sourceIdentity: identity, archiveRelPath: `payload/${i.toString().padStart(6,'0')}.bin` });
    }

    const txId = transactionId(randomUUID());
    let aid = archiveId(randomUUID());
    const rootId = category === 'temp' ? ROOT_ID_TEMP : ROOT_ID_STORAGE;
    const relativeArchivePath = (candidate: string) => posixRel(category === 'temp'
      ? join(this.adapter.agentId, sid, candidate)
      : join(category, this.adapter.agentId, sid, candidate));
    let relArchive = relativeArchivePath(aid);
    const now = new Date().toISOString();
    let journal: StorageJournal = Object.freeze({
      journalVersion: JOURNAL_VERSION, txId, archiveId: aid, agentId: this.adapter.agentId, sessionId: sid,
      adapterSchema: adapterSchemaId(this.adapter.schema), category, action, state: 'INITIATED', progressState: 'INITIATED', createdAt: now, updatedAt: now,
      archiveRootId: rootId, archiveRelPath: relArchive,
      payload: Object.freeze(payloadSeed.map((entry) => Object.freeze({ ...entry, stageRelPath: `staging/${entry.archiveRelPath.split('/').at(-1)}.${txId}.part` }))),
      index, diagnostics: Object.freeze([]),
    });
    await this.persistNewJournal(journal);

    await this.ensureMappedDirectories(rootId, posixRel(dirname(relArchive)));
    for (;;) {
      relArchive = relativeArchivePath(aid);
      journal = await this.updateJournal(journal, { archiveId: aid, archiveRelPath: relArchive, reservationIntent: true });
      await checkpoint(this.options.faultHook, 'after-intent:archive-reservation');
      const dir = await resolveMappedPath(this.roots, { baseRoot: rootId, relativePath: nativeRel(relArchive) });
      try {
        const identity = await reserveDirectoryNoReplace(dir, this.options.faultHook, 'archive-reservation');
        journal = await this.updateJournal(journal, { reservationIdentity: identity });
        await checkpoint(this.options.faultHook, 'after-completion:archive-reservation');
        break;
      } catch (error) {
        if (!(error instanceof MaintenanceError) || error.code !== 'RESERVATION_COLLISION') throw error;
        journal = await this.updateJournal(journal, { diagnostics: [...journal.diagnostics, `Archive ID collision: ${aid}`] });
        aid = archiveId(randomUUID());
      }
    }
    const archiveDir = await resolveMappedPath(this.roots, { baseRoot: rootId, relativePath: nativeRel(relArchive) });
    await ensurePrivateDirectory(join(archiveDir, 'staging'));
    await ensurePrivateDirectory(join(archiveDir, 'payload'));
    await syncDirectory(archiveDir, this.options.faultHook, 'archive-layout');
    await this.putRegistry(Object.freeze({ archiveId: aid, txId, agentId: this.adapter.agentId, sessionId: sid, category, rootId, relativePath: relArchive, status: 'RESERVED' }));

    for (let i = 0; i < journal.payload.length; i += 1) {
      const row = journal.payload[i]!;
      const src = await resolveMappedPath(this.roots, { baseRoot: row.source.baseRoot, relativePath: nativeRel(row.source.relativePath) });
      const staging = await resolveMappedPath(this.roots, { baseRoot: rootId, relativePath: nativeRel(join(relArchive, row.stageRelPath)) });
      const final = await resolveMappedPath(this.roots, { baseRoot: rootId, relativePath: nativeRel(join(relArchive, row.archiveRelPath)) });
      await checkpoint(this.options.faultHook, `after-intent:stage:${i}`);
      const copied = await copyToExclusive(src, staging, row.sourceIdentity, row.mode, this.options.faultHook, `payload:${i}`, async (identity) => {
        const payload = journal.payload.map((entry, n) => n === i ? Object.freeze({ ...entry, stageIdentity: identity }) : entry);
        journal = await this.updateJournal(journal, { payload: Object.freeze(payload) });
      });
      if (copied.sha256 !== row.sha256 || copied.bytes !== row.bytes) throw new MaintenanceError('CHECKSUM_MISMATCH', `Staged payload ${i} differs from its source evidence`);
      const publishIntentPayload = journal.payload.map((entry, n) => n === i ? Object.freeze({ ...entry, archivePublishIntent: true }) : entry);
      journal = await this.updateJournal(journal, { payload: Object.freeze(publishIntentPayload) });
      await checkpoint(this.options.faultHook, `after-intent:payload:${i}:publish`);
      await publishNoReplace(staging, final, this.options.faultHook, `payload:${i}`);
      const payload = journal.payload.map((entry, n) => n === i ? Object.freeze({ ...entry, archiveIdentity: copied.identity, staged: true }) : entry);
      journal = await this.updateJournal(journal, { payload: Object.freeze(payload) });
      await checkpoint(this.options.faultHook, `after-completion:stage:${i}`);
      await removeIfSame(staging, copied.identity, row.sha256, this.options.faultHook, `payload-stage:${i}`);
    }

    const finalPayload = journal.payload.map((row): JournalPayload => {
      if (!row.archiveIdentity || row.staged !== true) throw new MaintenanceError('STAGING_INCOMPLETE', 'Payload staging is not complete');
      return row;
    });
    const manifest: ArchiveManifest = Object.freeze({ manifestVersion: MANIFEST_VERSION, archiveId: aid, txId, agentId: this.adapter.agentId, sessionId: sid,
      adapterSchema: adapterSchemaId(this.adapter.schema), category, createdAt: now, trustedRootIds: Object.freeze([...new Set([...finalPayload.map((row) => row.source.baseRoot), rootId])]),
      payload: Object.freeze(finalPayload.map(({ source, archiveRelPath, sha256, bytes, mode, sourceIdentity, archiveIdentity }) => Object.freeze({ source, archiveRelPath, sha256, bytes, mode, sourceIdentity, archiveIdentity: archiveIdentity! }))), index });
    journal = await this.updateJournal(journal, { manifestIntent: true });
    await checkpoint(this.options.faultHook, 'after-intent:manifest');
    const manifestPath = join(archiveDir, 'manifest.json');
    const manifestIdentity = await writeNewJson(manifestPath, manifest, this.options.faultHook, 'manifest');
    journal = await this.updateJournal(journal, { manifestIdentity });
    await this.putRegistry(Object.freeze({ archiveId: aid, txId, agentId: this.adapter.agentId, sessionId: sid, category, rootId, relativePath: relArchive, status: 'RECOVERY_PENDING' }));
    journal = await this.updateJournal(journal, { state: 'STAGED' });
    await checkpoint(this.options.faultHook, 'after-completion:journal:STAGED');

    journal = await this.updateJournal(journal, { state: 'INDEX_INTENT', indexIntent: true });
    await checkpoint(this.options.faultHook, 'after-intent:index');
    await this.assertSafetyStillCurrent(sid);
    await this.adapter.applyIndexState(sid, journal.index.before, journal.index.after);
    await checkpoint(this.options.faultHook, 'after-side-effect:index');
    journal = await this.updateJournal(journal, { state: 'INDEX_COMMITTED', indexCommitted: true });
    await checkpoint(this.options.faultHook, 'after-completion:index');
    journal = await this.drainSources(journal);
    if (journal.state === 'RECOVERY_PENDING') {
      await this.markRegistry(journal.archiveId, 'RECOVERY_PENDING');
      return this.recordFor(journal, 'RECOVERY_PENDING');
    }
    journal = await this.completeArchive(journal);
    return this.recordFor(journal, 'REGISTERED');
  }

  async listArchives(agentId?: AgentId, sidInput?: string): Promise<readonly ArchiveRecord[]> {
    if (agentId !== undefined && !AGENT_IDS.includes(agentId)) throw new MaintenanceError('AGENT_ID_INVALID', 'Unsupported agent identifier');
    const sidFilter = sidInput === undefined ? undefined : safeSessionId(sidInput);
    await this.ready();
    const registry = await this.loadRegistry();
    const records: ArchiveRecord[] = [];
    for (const entry of registry.entries) {
      if (entry.participant === 'database') continue;
      if (entry.status !== 'REGISTERED' || (agentId && entry.agentId !== agentId) || (sidFilter && entry.sessionId !== sidFilter)) continue;
      const location = await resolveMappedPath(this.roots, { baseRoot: entry.rootId, relativePath: nativeRel(entry.relativePath) });
      const manifest = parseManifest(await readJson(join(location, 'manifest.json'), 'MANIFEST_INVALID'));
      this.assertRegistryMatches(entry, manifest);
      records.push(Object.freeze({ ...entry, createdAt: manifest.createdAt }));
    }
    return Object.freeze(records.sort((a,b) => a.archiveId.localeCompare(b.archiveId)));
  }

  async restore(agentId: AgentId, sidInput: string, archiveIdInput?: string): Promise<ArchiveRecord> {
    const sid = safeSessionId(sidInput);
    if (agentId !== this.adapter.agentId) throw new MaintenanceError('ADAPTER_UNSUPPORTED', `No storage adapter is registered for ${agentId}`);
    return this.exclusive(sid, () => this.restoreLocked(agentId, sid, archiveIdInput));
  }
}
