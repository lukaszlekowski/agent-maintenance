import { adapterSchemaId, posixRel, nativeRel, sameCreatedObject, TERMINAL_STATES, type ArchiveRecord, type RecoveryDiagnostic } from './contracts.ts';

import { lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { resolveMappedPath } from '../core/paths.ts';
import { MaintenanceError, archiveId, transactionId, type AgentId, type SessionId } from '../types.ts';

import { checkpoint, copyToExclusive, hashFile, publishNoReplace, readIdentity, removeIfSame, sameIdentity, syncDirectory, syncFile } from './durable-fs.ts';
import { JOURNAL_VERSION, makeIndexPlan, stableFingerprint, type ArchiveManifest, type ObjectIdentity, type StorageJournal } from './schema.ts';
import { ArchiveRecoveryFlow } from './archive-recovery.ts';
export abstract class RestoreFlow extends ArchiveRecoveryFlow {
  protected abstract listArchives(agentId?: AgentId, sidInput?: string): Promise<readonly ArchiveRecord[]>;

  protected async restoreLocked(agentId: AgentId, sid: SessionId, archiveIdInput?: string): Promise<ArchiveRecord> {
    const matches = await this.listArchives(agentId, sid);
    let selected: ArchiveRecord;
    if (archiveIdInput === undefined) {
      if (matches.length === 0) throw new MaintenanceError('ARCHIVE_NOT_FOUND', 'No registered archive exists for this agent/session');
      if (matches.length > 1) throw new MaintenanceError('ARCHIVE_SELECTION_AMBIGUOUS', 'Multiple archives exist; supply the exact --archive-id', { archiveIds: matches.map((row) => row.archiveId) });
      selected = matches[0]!;
    } else {
      const exact = archiveId(archiveIdInput);
      const exactMatches = matches.filter((row) => row.archiveId === exact);
      if (exactMatches.length !== 1) throw new MaintenanceError('ARCHIVE_SELECTION_INVALID', 'The supplied archive ID does not select exactly one registered instance');
      selected = exactMatches[0]!;
    }
    const manifest = await this.readManifest(selected);
    if (manifest.adapterSchema !== adapterSchemaId(this.adapter.schema)) throw new MaintenanceError('ADAPTER_SCHEMA_UNSUPPORTED', 'Archive was created by a different adapter schema');
    const before = manifest.index.after;
    const after = manifest.index.before;
    const currentIndex = await this.adapter.readIndexState(sid);
    if (stableFingerprint(currentIndex) !== stableFingerprint(before)) throw new MaintenanceError('RESTORE_INDEX_CHANGED', 'Restore requires the adapter index to match this archive’s recorded post-storage state');
    const index = makeIndexPlan(before, after);
    const txId = transactionId(randomUUID()); const now = new Date().toISOString();
    let journal: StorageJournal = Object.freeze({ journalVersion: JOURNAL_VERSION, txId, archiveId: manifest.archiveId, agentId, sessionId: sid,
      adapterSchema: adapterSchemaId(this.adapter.schema), category: manifest.category, action: 'restore', state: 'INITIATED', progressState: 'INITIATED', createdAt: now, updatedAt: now,
      archiveRootId: selected.rootId, archiveRelPath: selected.relativePath, archiveCreationTxId: transactionId(selected.txId),
      payload: Object.freeze(manifest.payload.map((row) => Object.freeze({ ...row, stageRelPath: `staging/${row.archiveRelPath.split('/').at(-1)}.${txId}.restore` }))),
      index, diagnostics: Object.freeze([]) });
    await this.persistNewJournal(journal);

    for (let i = 0; i < journal.payload.length; i += 1) {
      const row = journal.payload[i]!;
      const target = await resolveMappedPath(this.roots, { baseRoot: row.source.baseRoot, relativePath: nativeRel(row.source.relativePath) });
      if (await this.pathExists(target)) throw new MaintenanceError('RESTORE_COLLISION', `Restore target already exists: ${row.source.baseRoot}/${row.source.relativePath}`);
      const parent = dirname(target);
      if (!(await (await lstat(parent)).isDirectory())) throw new MaintenanceError('RESTORE_PARENT_MISSING', 'Restore target parent must already exist');
      const stageName = `.${basename(target)}.${txId}.restore-stage`;
      const stageRel = posixRel(join(dirname(row.source.relativePath), stageName));
      const stageAbs = join(parent, stageName);
      const archiveFile = await resolveMappedPath(this.roots, { baseRoot: selected.rootId, relativePath: nativeRel(join(selected.relativePath, row.archiveRelPath)) });
      const archiveHash = await hashFile(archiveFile);
      if (archiveHash.sha256 !== row.sha256 || archiveHash.bytes !== row.bytes) throw new MaintenanceError('CHECKSUM_MISMATCH', 'Archive payload failed checksum verification');
      const updated = journal.payload.map((entry, n) => n === i ? Object.freeze({ ...entry, targetStageRelPath: stageRel, targetWasAbsent: true }) : entry);
      journal = await this.updateJournal(journal, { payload: Object.freeze(updated) });
      const copied = await copyToExclusive(archiveFile, stageAbs, row.archiveIdentity!, row.mode, this.options.faultHook, `restore-stage:${i}`, async (identity) => {
        const entries = journal.payload.map((entry, n) => n === i ? Object.freeze({ ...entry, targetStageIdentity: identity }) : entry);
        journal = await this.updateJournal(journal, { payload: Object.freeze(entries) });
      });
      if (copied.sha256 !== row.sha256 || copied.bytes !== row.bytes) throw new MaintenanceError('CHECKSUM_MISMATCH', 'Restore staging checksum failed');
      await checkpoint(this.options.faultHook, `after-completion:restore-stage:${i}`);
    }
    journal = await this.updateJournal(journal, { state: 'STAGED' });
    journal = await this.publishRestoreTargets(journal);
    journal = await this.verifyRestoreTargets(journal);
    journal = await this.updateJournal(journal, { state: 'INDEX_INTENT', indexIntent: true });
    await checkpoint(this.options.faultHook, 'after-intent:restore-index');
    await this.assertSafetyStillCurrent(sid);
    await this.adapter.applyIndexState(sid, journal.index.before, journal.index.after);
    await checkpoint(this.options.faultHook, 'after-side-effect:restore-index');
    journal = await this.updateJournal(journal, { state: 'INDEX_COMMITTED', indexCommitted: true });
    journal = await this.verifyRestoreTargets(journal);
    journal = await this.updateJournal(journal, { state: 'COMPLETED' });
    return selected;
  }

  protected async verifyManifestPayloads(manifest: ArchiveManifest, record: ArchiveRecord): Promise<void> {
    const root = await resolveMappedPath(this.roots, { baseRoot: record.rootId, relativePath: nativeRel(record.relativePath) });
    for (const row of manifest.payload) {
      const path = await resolveMappedPath(this.roots, { baseRoot: record.rootId, relativePath: nativeRel(join(record.relativePath, row.archiveRelPath)) });
      const identity = await readIdentity(path); const hash = await hashFile(path);
      if (!sameIdentity(identity, row.archiveIdentity) || hash.sha256 !== row.sha256 || hash.bytes !== row.bytes) throw new MaintenanceError('ARCHIVE_PAYLOAD_UNVERIFIED', `Archive payload ${row.archiveRelPath} is not intact`);
    }
    await syncDirectory(root, this.options.faultHook, 'restore-archive-verified');
  }

  protected async publishRestoreTargets(input: StorageJournal): Promise<StorageJournal> {
    let journal = input;
    const recordEntry = await this.findRegistryEntry(journal.archiveId);
    if (!recordEntry || recordEntry.status !== 'REGISTERED') throw new MaintenanceError('RESTORE_ARCHIVE_UNAVAILABLE', 'Restore requires a registered archive');
    const record: ArchiveRecord = Object.freeze({ ...recordEntry, createdAt: journal.createdAt });
    const manifest = await this.readManifest(record);
    await this.verifyManifestPayloads(manifest, record);
    if (['INITIATED','STAGED'].includes(journal.state)) journal = await this.updateJournal(journal, { state: 'PUBLISH_INTENT' });
    await checkpoint(this.options.faultHook, 'after-intent:restore-publication');
    for (let i = 0; i < journal.payload.length; i += 1) {
      let row = journal.payload[i]!;
      const target = await resolveMappedPath(this.roots, { baseRoot: row.source.baseRoot, relativePath: nativeRel(row.source.relativePath) });
      const parent = dirname(target);
      if (!(await (await lstat(parent)).isDirectory())) throw new MaintenanceError('RESTORE_PARENT_MISSING', 'Restore target parent must already exist');
      if (await this.pathExists(target)) {
        const identity = await readIdentity(target); const hash = await hashFile(target);
        if (row.targetWasAbsent !== true || !row.targetStageIdentity || !sameCreatedObject(identity, row.targetStageIdentity) || hash.sha256 !== row.sha256 || hash.bytes !== row.bytes) {
          throw new MaintenanceError('RESTORE_TARGET_UNPROVEN', `Restore target ${row.source.relativePath} exists without transaction identity proof`);
        }
        await syncDirectory(parent, this.options.faultHook, `restore-target-reconcile:${i}`);
        const payload = journal.payload.map((entry, n) => n === i ? Object.freeze({ ...entry, targetStageIdentity: identity, targetWasAbsent: true, targetPublished: true }) : entry);
        journal = await this.updateJournal(journal, { payload: Object.freeze(payload) });
        continue;
      }
      let stageRel = row.targetStageRelPath;
      if (!stageRel) {
        const stageName = `.${basename(target)}.${journal.txId}.restore-stage`;
        stageRel = posixRel(join(dirname(row.source.relativePath), stageName));
      }
      const stage = join(parent, basename(stageRel));
      if (row.targetWasAbsent !== true || !row.targetStageRelPath) {
        const payload = journal.payload.map((entry, n) => n === i ? Object.freeze({ ...entry, targetStageRelPath: stageRel, targetWasAbsent: true }) : entry);
        journal = await this.updateJournal(journal, { payload: Object.freeze(payload) }); row = journal.payload[i]!;
      }
      let stageIdentity: ObjectIdentity;
      if (await this.pathExists(stage)) {
        stageIdentity = await readIdentity(stage); const hash = await hashFile(stage);
        if (!row.targetStageIdentity || !sameCreatedObject(stageIdentity, row.targetStageIdentity) || hash.sha256 !== row.sha256 || hash.bytes !== row.bytes) throw new MaintenanceError('RESTORE_STAGE_UNPROVEN', `Restore stage for ${row.source.relativePath} changed`);
        await syncFile(stage, this.options.faultHook, `restore-stage-reconcile:${i}`);
      } else {
        const archive = await resolveMappedPath(this.roots, { baseRoot: record.rootId, relativePath: nativeRel(join(record.relativePath, row.archiveRelPath)) });
        const copied = await copyToExclusive(archive, stage, row.archiveIdentity!, row.mode, this.options.faultHook, `restore-resume:${i}`, async (identity) => {
          const payload = journal.payload.map((entry, n) => n === i ? Object.freeze({ ...entry, targetStageRelPath: stageRel, targetWasAbsent: true, targetStageIdentity: identity }) : entry);
          journal = await this.updateJournal(journal, { payload: Object.freeze(payload) });
        });
        if (copied.sha256 !== row.sha256 || copied.bytes !== row.bytes) throw new MaintenanceError('CHECKSUM_MISMATCH', 'Restore staging checksum failed');
        stageIdentity = copied.identity;
      }
      row = journal.payload[i]!;
      if (!row.publishIntent || !row.targetStageIdentity || !sameIdentity(row.targetStageIdentity, stageIdentity)) {
        const payload = journal.payload.map((entry, n) => n === i ? Object.freeze({ ...entry, publishIntent: true, targetStageIdentity: stageIdentity }) : entry);
        journal = await this.updateJournal(journal, { payload: Object.freeze(payload) });
      }
      await checkpoint(this.options.faultHook, `after-intent:restore-publish:${i}`);
      await this.assertSafetyStillCurrent(journal.sessionId);
      await publishNoReplace(stage, target, this.options.faultHook, `restore-target:${i}`);
      const published = await readIdentity(target); const publishedHash = await hashFile(target);
      if (!sameIdentity(published, stageIdentity) || publishedHash.sha256 !== row.sha256 || publishedHash.bytes !== row.bytes) throw new MaintenanceError('RESTORE_TARGET_UNVERIFIED', `Published restore target ${row.source.relativePath} failed verification`);
      await syncDirectory(parent, this.options.faultHook, `restore-target:${i}`);
      const payload = journal.payload.map((entry, n) => n === i ? Object.freeze({ ...entry, targetStageIdentity: published, targetPublished: true, targetWasAbsent: true }) : entry);
      journal = await this.updateJournal(journal, { payload: Object.freeze(payload) });
      await checkpoint(this.options.faultHook, `after-completion:restore-publish:${i}`);
      await removeIfSame(stage, published, row.sha256, this.options.faultHook, `restore-stage:${i}`);
    }
    const nextState = journal.indexCommitted ? 'INDEX_COMMITTED' : journal.indexIntent ? 'INDEX_INTENT' : 'TARGET_PUBLISHED';
    return this.updateJournal(journal, { state: nextState });
  }

  protected async verifyRestoreTargets(input: StorageJournal): Promise<StorageJournal> {
    const journal = input;
    for (let i = 0; i < journal.payload.length; i += 1) {
      const row = journal.payload[i]!;
      const target = await resolveMappedPath(this.roots, { baseRoot: row.source.baseRoot, relativePath: nativeRel(row.source.relativePath) });
      if (!row.targetWasAbsent || !row.targetPublished || !row.targetStageIdentity || !(await this.pathExists(target))) throw new MaintenanceError('RESTORE_TARGET_MISSING', `Restore target ${row.source.relativePath} is not proven published`);
      const identity = await readIdentity(target); const hash = await hashFile(target);
      if (!sameIdentity(identity, row.targetStageIdentity) || hash.sha256 !== row.sha256 || hash.bytes !== row.bytes) throw new MaintenanceError('RESTORE_TARGET_CHANGED', `Restore target ${row.source.relativePath} changed`);
      await syncDirectory(dirname(target), this.options.faultHook, `restore-target-verify:${i}`);
    }
    return journal;
  }

  protected async recoverRestore(input: StorageJournal): Promise<RecoveryDiagnostic> {
    let journal = input.state === 'RECOVERY_PENDING' ? await this.updateJournal(input, { state: input.progressState }) : input;
    try {
      let archiveRecord: ArchiveRecord;
      try {
        archiveRecord = await this.reconcileArchiveRegistration(journal.archiveId, journal.archiveCreationTxId, journal);
      } catch (error) {
        const rolledBack = await this.rollbackUnpublishedRestore(journal, error);
        if (rolledBack) return rolledBack;
        throw error;
      }
      const manifest = await this.readManifest(archiveRecord);
      if (manifest.adapterSchema !== journal.adapterSchema) return this.pending(journal, 'Restore manifest adapter schema changed');
      try {
        await this.verifyManifestPayloads(manifest, archiveRecord);
      } catch (error) {
        const rolledBack = await this.rollbackUnpublishedRestore(journal, error);
        if (rolledBack) return rolledBack;
        throw error;
      }
      const currentIndex = stableFingerprint(await this.adapter.readIndexState(journal.sessionId));
      if (currentIndex !== journal.index.beforeFingerprint && currentIndex !== journal.index.afterFingerprint) return this.pending(journal, 'Adapter index matches neither restore before nor after evidence');
      journal = await this.publishRestoreTargets(journal);
      journal = await this.verifyRestoreTargets(journal);
      journal = await this.reconcileIndex(journal);
      if (journal.state === 'RECOVERY_PENDING') return Object.freeze({ txId: journal.txId, archiveId: journal.archiveId, state: journal.state, status: 'PENDING', reasons: journal.diagnostics });
      journal = await this.verifyRestoreTargets(journal);
      journal = await this.updateJournal(journal, { state: 'COMPLETED' });
      return Object.freeze({ txId: journal.txId, archiveId: journal.archiveId, state: journal.state, status: 'RECOVERED', reasons: Object.freeze(['All restore targets and index verified; archive retained']) });
    } catch(error) {
      const latest = await this.readPersistedJournal(journal.txId) ?? journal;
      if (TERMINAL_STATES.has(latest.state)) return this.reconcileTerminal(latest);
      return this.pending(latest,error instanceof Error?error.message:'Unexpected restore recovery failure');
    }
  }

  private async rollbackUnpublishedRestore(journal: StorageJournal, cause: unknown): Promise<RecoveryDiagnostic | null> {
    const code = (cause as MaintenanceError).code;
    const missingArchiveFile = code === 'STORAGE_OBJECT_READ_FAILED' && (cause as MaintenanceError).details?.code === 'ENOENT';
    if (!['ARCHIVE_PAYLOAD_UNVERIFIED', 'MANIFEST_SCHEMA_INVALID'].includes(code) && !missingArchiveFile) return null;
    if (journal.action !== 'restore' || journal.indexIntent || journal.indexCommitted || journal.payload.some((row) => row.targetPublished)) return null;
    if (stableFingerprint(await this.adapter.readIndexState(journal.sessionId)) !== journal.index.beforeFingerprint) return null;
    for (const row of journal.payload) {
      const target = await resolveMappedPath(this.roots, { baseRoot: row.source.baseRoot, relativePath: nativeRel(row.source.relativePath) });
      if (await this.pathExists(target)) return null;
      if (!row.targetStageRelPath) continue;
      const stage = await resolveMappedPath(this.roots, { baseRoot: row.source.baseRoot, relativePath: nativeRel(row.targetStageRelPath) });
      if (await this.pathExists(stage) && !row.targetStageIdentity) return null;
    }
    const intent = journal.rollbackIntent ? journal : await this.updateJournal(journal, { rollbackIntent: true });
    for (const row of intent.payload) {
      if (!row.targetStageRelPath || !row.targetStageIdentity) continue;
      const stage = await resolveMappedPath(this.roots, { baseRoot: row.source.baseRoot, relativePath: nativeRel(row.targetStageRelPath) });
      if (!(await this.pathExists(stage))) continue;
      const identity = await readIdentity(stage); const hash = await hashFile(stage);
      if (!sameIdentity(identity, row.targetStageIdentity) || hash.sha256 !== row.sha256 || hash.bytes !== row.bytes) return null;
      await this.assertSafetyStillCurrent(intent.sessionId);
      await removeIfSame(stage, row.targetStageIdentity, row.sha256, this.options.faultHook, 'restore-rollback-stage');
    }
    for (const row of intent.payload) {
      if (!row.targetStageRelPath) continue;
      const stage = await resolveMappedPath(this.roots, { baseRoot: row.source.baseRoot, relativePath: nativeRel(row.targetStageRelPath) });
      if (await this.pathExists(stage)) return null;
      const target = await resolveMappedPath(this.roots, { baseRoot: row.source.baseRoot, relativePath: nativeRel(row.source.relativePath) });
      if (await this.pathExists(target)) return null;
    }
    await this.assertSafetyStillCurrent(intent.sessionId);
    const rolledBack = await this.updateJournal(intent, { state: 'ROLLED_BACK', rollbackIntent: true, rollbackCleanupProven: true,
      diagnostics: [...intent.diagnostics, 'Restore rolled back before publication; unchanged transaction staging was removed and the adapter index remained at its before state'] });
    return Object.freeze({ txId: rolledBack.txId, archiveId: rolledBack.archiveId, state: rolledBack.state, status: 'TERMINAL', reasons: rolledBack.diagnostics });
  }
}
