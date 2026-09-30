import { directoryIdentity } from './durable-directories.ts';
import { nativeRel, sameCreatedObject, readJson, TERMINAL_STATES, type ArchiveRecord, type RecoveryDiagnostic } from './contracts.ts';

import { unlink } from 'node:fs/promises';

import { dirname, join } from 'node:path';

import { resolveMappedPath } from '../core/paths.ts';
import { MaintenanceError } from '../types.ts';

import { checkpoint, hashFile, injectOperationError, publishNoReplace, readIdentity, removeIfSame, sameIdentity, syncDirectory, syncFile, writeNewJson } from './durable-fs.ts';
import { MANIFEST_VERSION, parseJournal, parseManifest, stableFingerprint, type ArchiveManifest, type StorageJournal } from './schema.ts';
import { RecoveryFlow } from './recovery-core.ts';
export abstract class ArchiveRecoveryFlow extends RecoveryFlow {

  protected async recoverArchive(input: StorageJournal): Promise<RecoveryDiagnostic> {
    let journal = input.state === 'RECOVERY_PENDING' ? await this.updateJournal(input, { state: input.progressState }) : input;
    const reasons: string[] = [];
    try {
      const archiveDir = await resolveMappedPath(this.roots, { baseRoot: journal.archiveRootId, relativePath: nativeRel(journal.archiveRelPath) });
      if (journal.reservationIdentity) { const reservation = await directoryIdentity(archiveDir); if (reservation.dev !== journal.reservationIdentity.dev || reservation.ino !== journal.reservationIdentity.ino || reservation.mode !== journal.reservationIdentity.mode) return this.pending(journal, 'Archive reservation directory identity changed'); }
      const manifestRaw = await readJson(join(archiveDir, 'manifest.json'), 'MANIFEST_INVALID');
      if (manifestRaw === null) {
        journal = await this.reconcileUnmanifestedPayload(journal);
        if (journal.state === 'RECOVERY_PENDING') return Object.freeze({ txId: journal.txId, archiveId: journal.archiveId, state: journal.state, status: 'PENDING', reasons: journal.diagnostics });
        const manifest: ArchiveManifest = Object.freeze({ manifestVersion: MANIFEST_VERSION, archiveId: journal.archiveId, txId: journal.txId, agentId: journal.agentId, sessionId: journal.sessionId, adapterSchema: journal.adapterSchema, category: journal.category, createdAt: journal.createdAt, trustedRootIds: Object.freeze([...new Set([...journal.payload.map((row) => row.source.baseRoot), journal.archiveRootId])]), payload: Object.freeze(journal.payload.map((row) => Object.freeze({ source: row.source, archiveRelPath: row.archiveRelPath, sha256: row.sha256, bytes: row.bytes, mode: row.mode, sourceIdentity: row.sourceIdentity, archiveIdentity: row.archiveIdentity! }))), index: journal.index });
        journal = await this.updateJournal(journal, { manifestIntent: true });
        const manifestIdentity = await writeNewJson(join(archiveDir, 'manifest.json'), manifest, this.options.faultHook, 'recovery-manifest');
        journal = await this.updateJournal(journal, { manifestIdentity });
        await this.putRegistry(Object.freeze({ archiveId: journal.archiveId, txId: journal.txId, agentId: journal.agentId, sessionId: journal.sessionId, category: journal.category, rootId: journal.archiveRootId, relativePath: journal.archiveRelPath, status: 'RECOVERY_PENDING' }));
        return this.finishArchiveRecovery(journal);
      }
      const manifest = parseManifest(manifestRaw);
      if (manifest.archiveId !== journal.archiveId || manifest.txId !== journal.txId || manifest.agentId !== journal.agentId || manifest.sessionId !== journal.sessionId) {
        return this.pending(journal, 'Manifest identity does not match journal');
      }
      for (const row of manifest.payload) {
        const file = await resolveMappedPath(this.roots, { baseRoot: journal.archiveRootId, relativePath: nativeRel(join(journal.archiveRelPath, row.archiveRelPath)) });
        const hashed = await hashFile(file);
        if (hashed.sha256 !== row.sha256 || hashed.bytes !== row.bytes) return this.pending(journal, `Archive payload ${row.archiveRelPath} failed verification`);
      }
      journal = await this.updateJournal(journal, { state: 'STAGED', manifestIntent: true });
      await this.putRegistry(Object.freeze({ archiveId: journal.archiveId, txId: journal.txId, agentId: journal.agentId, sessionId: journal.sessionId, category: journal.category, rootId: journal.archiveRootId, relativePath: journal.archiveRelPath, status: 'RECOVERY_PENDING' }));
      if (!journal.indexIntent) {
        const actual = await this.adapter.readIndexState(journal.sessionId);
        if (stableFingerprint(actual) !== journal.index.beforeFingerprint) return this.pending(journal, 'Index changed before transaction intent; no source drain attempted');
        for (const row of journal.payload) {
          const src = await resolveMappedPath(this.roots, { baseRoot: row.source.baseRoot, relativePath: nativeRel(row.source.relativePath) });
          const current = await readIdentity(src); const hash = await hashFile(src);
          if (!sameIdentity(current, row.sourceIdentity) || hash.sha256 !== row.sha256) return this.pending(journal, 'Source changed before index intent; preserved both source and staged archive');
        }
        journal = await this.updateJournal(journal, { state: 'INDEX_INTENT', indexIntent: true });
      }
      journal = await this.reconcileIndex(journal);
      if (journal.state === 'RECOVERY_PENDING') return Object.freeze({ txId: journal.txId, archiveId: journal.archiveId, state: journal.state, status: 'PENDING', reasons: journal.diagnostics });
      journal = await this.drainSources(journal);
      if (journal.state === 'RECOVERY_PENDING') return Object.freeze({ txId: journal.txId, archiveId: journal.archiveId, state: journal.state, status: 'PENDING', reasons: journal.diagnostics });
      journal = await this.completeArchive(journal);
      return Object.freeze({ txId: journal.txId, archiveId: journal.archiveId, state: journal.state, status: 'RECOVERED', reasons: Object.freeze(reasons) });
    } catch (error) {
      const latest = await this.readPersistedJournal(journal.txId) ?? journal;
      if (TERMINAL_STATES.has(latest.state)) return this.reconcileTerminal(latest);
      return this.pending(latest, error instanceof Error ? error.message : 'Unexpected archive recovery failure');
    }
  }

  protected async reconcileUnmanifestedPayload(input: StorageJournal): Promise<StorageJournal> {
    let journal = input;
    for (let i = 0; i < journal.payload.length; i += 1) {
      let row = journal.payload[i]!;
      const stage = await resolveMappedPath(this.roots, { baseRoot: journal.archiveRootId, relativePath: nativeRel(join(journal.archiveRelPath, row.stageRelPath)) });
      const target = await resolveMappedPath(this.roots, { baseRoot: journal.archiveRootId, relativePath: nativeRel(join(journal.archiveRelPath, row.archiveRelPath)) });
      if (await this.pathExists(target)) {
        const identity = await readIdentity(target); const hash = await hashFile(target);
        await syncDirectory(dirname(target), this.options.faultHook, `recovery-payload-published:${i}`);
        if (!row.stageIdentity || !sameCreatedObject(identity, row.stageIdentity) || hash.sha256 !== row.sha256 || hash.bytes !== row.bytes) return this.pendingJournal(journal, `Unmanifested payload ${i} is not proven transaction-created`);
        const payload = journal.payload.map((entry, n) => n === i ? Object.freeze({ ...entry, archiveIdentity: identity, staged: true, archivePublishIntent: true }) : entry);
        journal = await this.updateJournal(journal, { payload: Object.freeze(payload) });
      } else if (await this.pathExists(stage)) {
        const identity = await readIdentity(stage); const hash = await hashFile(stage);
        if (!row.stageIdentity || !sameCreatedObject(identity, row.stageIdentity) || hash.sha256 !== row.sha256 || hash.bytes !== row.bytes) return this.pendingJournal(journal, `Staging payload ${i} changed; preserved for manual review`);
        await syncFile(stage, this.options.faultHook, `recovery-payload-stage:${i}`);
        if (!row.archivePublishIntent) {
          const payload = journal.payload.map((entry, n) => n === i ? Object.freeze({ ...entry, archivePublishIntent: true }) : entry);
          journal = await this.updateJournal(journal, { payload: Object.freeze(payload) }); row = journal.payload[i]!;
        }
        await publishNoReplace(stage, target, this.options.faultHook, `recovery-payload:${i}`);
        const payload = journal.payload.map((entry, n) => n === i ? Object.freeze({ ...entry, archiveIdentity: identity, staged: true }) : entry);
        journal = await this.updateJournal(journal, { payload: Object.freeze(payload) });
        await removeIfSame(stage, identity, row.sha256, this.options.faultHook, `recovery-stage:${i}`);
      } else {
        return this.pendingJournal(journal, `Payload ${i} has no staged or published transaction object`);
      }
    }
    const allReady = journal.payload.every((row) => row.archiveIdentity && row.staged);
    if (!allReady) return this.pendingJournal(journal, 'Payload staging could not be fully reconciled');
    return journal;
  }

  protected async finishArchiveRecovery(journal: StorageJournal): Promise<RecoveryDiagnostic> {
    const manifestRaw = await readJson(join(await resolveMappedPath(this.roots, { baseRoot: journal.archiveRootId, relativePath: nativeRel(journal.archiveRelPath) }), 'manifest.json'), 'MANIFEST_INVALID');
    if (manifestRaw === null) return this.pending(journal, 'Recovery manifest did not persist');
    const manifest = parseManifest(manifestRaw);
    for (const row of manifest.payload) {
      const file = await resolveMappedPath(this.roots, { baseRoot: journal.archiveRootId, relativePath: nativeRel(join(journal.archiveRelPath, row.archiveRelPath)) });
      const hashed = await hashFile(file);
      if (hashed.sha256 !== row.sha256 || hashed.bytes !== row.bytes) return this.pending(journal, `Archive payload ${row.archiveRelPath} failed verification`);
    }
    if (!journal.indexIntent) {
      const actual = await this.adapter.readIndexState(journal.sessionId);
      if (stableFingerprint(actual) !== journal.index.beforeFingerprint) return this.pending(journal, 'Index changed before transaction intent; no source drain attempted');
      for (const row of journal.payload) {
        const source = await resolveMappedPath(this.roots, { baseRoot: row.source.baseRoot, relativePath: nativeRel(row.source.relativePath) });
        const identity = await readIdentity(source); const hash = await hashFile(source);
        if (!sameIdentity(identity, row.sourceIdentity) || hash.sha256 !== row.sha256) return this.pending(journal, 'Source changed before index intent; preserved source and destination');
      }
      journal = await this.updateJournal(journal, { state: 'INDEX_INTENT', indexIntent: true });
    }
    if (journal.indexIntent) {
      journal = await this.reconcileIndex(journal);
      if (journal.state === 'RECOVERY_PENDING') return Object.freeze({ txId: journal.txId, archiveId: journal.archiveId, state: journal.state, status: 'PENDING', reasons: journal.diagnostics });
      journal = await this.drainSources(journal);
      if (journal.state === 'RECOVERY_PENDING') return Object.freeze({ txId: journal.txId, archiveId: journal.archiveId, state: journal.state, status: 'PENDING', reasons: journal.diagnostics });
      journal = await this.completeArchive(journal);
      return Object.freeze({ txId: journal.txId, archiveId: journal.archiveId, state: journal.state, status: 'RECOVERED', reasons: Object.freeze(['Recovered archive publication and transaction completion']) });
    }
    return this.pending(journal, 'Archive transaction could not enter index reconciliation');
  }

  protected async verifyArchivePayloads(journal: StorageJournal, verifyCurrentIndex = true): Promise<void> {
    const archiveDir = await resolveMappedPath(this.roots, { baseRoot: journal.archiveRootId, relativePath: nativeRel(journal.archiveRelPath) });
    const manifest = parseManifest(await readJson(join(archiveDir, 'manifest.json'), 'MANIFEST_INVALID'));
    if (manifest.archiveId !== journal.archiveId || manifest.txId !== journal.txId || manifest.adapterSchema !== journal.adapterSchema) throw new MaintenanceError('MANIFEST_JOURNAL_MISMATCH', 'Archive manifest does not match the active journal');
    for (const row of manifest.payload) {
      const path = await resolveMappedPath(this.roots, { baseRoot: journal.archiveRootId, relativePath: nativeRel(join(journal.archiveRelPath, row.archiveRelPath)) });
      const identity = await readIdentity(path); const hash = await hashFile(path);
      if (!sameIdentity(identity, row.archiveIdentity) || hash.sha256 !== row.sha256 || hash.bytes !== row.bytes) throw new MaintenanceError('ARCHIVE_PAYLOAD_UNVERIFIED', `Archive payload ${row.archiveRelPath} is not intact`);
    }
    if (verifyCurrentIndex) {
      const index = await this.adapter.readIndexState(journal.sessionId);
      if (stableFingerprint(index) !== journal.index.afterFingerprint) throw new MaintenanceError('INDEX_STATE_UNVERIFIED', 'Adapter index is not in the recorded post-archive state');
    }
  }

  protected async reconcileTerminal(input: StorageJournal): Promise<RecoveryDiagnostic> {
    try {
      const creationTxId = input.action === 'restore' ? input.archiveCreationTxId : input.txId;
      await this.reconcileArchiveRegistration(input.archiveId, creationTxId, input);
      return Object.freeze({ txId: input.txId, archiveId: input.archiveId, state: input.state, status: 'TERMINAL', reasons: Object.freeze([...input.diagnostics]) });
    } catch (error) {
      return Object.freeze({ txId: input.txId, archiveId: input.archiveId, state: input.state, status: 'PENDING', reasons: Object.freeze([`Terminal archive registration is not proven: ${error instanceof Error ? error.message : 'unknown evidence failure'}`]) });
    }
  }

  protected async reconcileArchiveRegistration(archiveId: string, expectedCreationTxId?: string, restore?: StorageJournal): Promise<ArchiveRecord> {
    const registered = await this.findRegistryEntry(archiveId);
    const creationTxId = registered?.txId ?? expectedCreationTxId;
    if (!creationTxId || (expectedCreationTxId && creationTxId !== expectedCreationTxId)) throw new MaintenanceError('ARCHIVE_CREATION_EVIDENCE_MISSING', 'Archive creation transaction identity is unavailable or conflicting');
    const raw = await readJson(join(this.roots.get('MAINTENANCE')!, 'transactions', `${creationTxId}.json`), 'JOURNAL_SCHEMA_INVALID');
    if (!raw) throw new MaintenanceError('ARCHIVE_CREATION_EVIDENCE_MISSING', 'Archive creation journal is missing');
    const creation = parseJournal(raw);
    if (creation.action === 'restore' || creation.state !== 'COMPLETED' || creation.progressState !== 'COMPLETED'
      || creation.archiveId !== archiveId || creation.txId !== creationTxId || !creation.indexCommitted) {
      throw new MaintenanceError('ARCHIVE_CREATION_EVIDENCE_INVALID', 'Archive creation journal does not prove a completed immutable archive');
    }
    if (registered && (registered.txId !== creation.txId || registered.agentId !== creation.agentId || registered.sessionId !== creation.sessionId
      || registered.category !== creation.category || registered.rootId !== creation.archiveRootId || registered.relativePath !== creation.archiveRelPath)) {
      throw new MaintenanceError('REGISTRY_CONFLICT', 'Existing archive registry identity differs from its creation journal');
    }
    if (restore && (creation.agentId !== restore.agentId || creation.sessionId !== restore.sessionId || creation.category !== restore.category
      || creation.adapterSchema !== restore.adapterSchema || creation.archiveRootId !== restore.archiveRootId || creation.archiveRelPath !== restore.archiveRelPath)) {
      throw new MaintenanceError('RESTORE_ARCHIVE_IDENTITY_MISMATCH', 'Restore journal does not reference this archive creation transaction');
    }
    const record = this.recordFor(creation, 'REGISTERED');
    const manifest = await this.readManifest(record);
    if (manifest.txId !== creation.txId || manifest.archiveId !== archiveId) throw new MaintenanceError('MANIFEST_JOURNAL_MISMATCH', 'Retained archive manifest identity is not immutable');
    await this.verifyArchivePayloads(creation, false);
    await this.putRegistry(Object.freeze({ archiveId: creation.archiveId, txId: creation.txId, agentId: creation.agentId, sessionId: creation.sessionId,
      category: creation.category, rootId: creation.archiveRootId, relativePath: creation.archiveRelPath, status: 'REGISTERED' }));
    return record;
  }

  protected async completeArchive(input: StorageJournal): Promise<StorageJournal> {
    const journal = input;
    if (!journal.indexCommitted || journal.state === 'RECOVERY_PENDING' || journal.payload.some((row) => row.drained !== true)) {
      throw new MaintenanceError('ARCHIVE_TERMINAL_PROOF_MISSING', 'Archive cannot complete without a committed index and every proven source drain');
    }
    await this.verifyArchivePayloads(journal);
    for (const row of journal.payload) {
      const source = await resolveMappedPath(this.roots, { baseRoot: row.source.baseRoot, relativePath: nativeRel(row.source.relativePath) });
      if (await this.pathExists(source)) throw new MaintenanceError('ARCHIVE_SOURCE_REMAINS', `Archive source ${row.source.relativePath} still exists`);
      await syncDirectory(dirname(source), this.options.faultHook, 'archive-terminal-source-absence');
    }
    const drained = journal.state === 'SOURCE_DRAINED' ? journal : await this.updateJournal(journal, { state: 'SOURCE_DRAINED' });
    const completed = await this.updateJournal(drained, { state: 'COMPLETED' });
    await this.putRegistry(Object.freeze({ archiveId: completed.archiveId, txId: completed.txId, agentId: completed.agentId, sessionId: completed.sessionId, category: completed.category, rootId: completed.archiveRootId, relativePath: completed.archiveRelPath, status: 'REGISTERED' }));
    return completed;
  }

  protected async drainSources(input: StorageJournal): Promise<StorageJournal> {
    let journal = input;
    if (!journal.indexCommitted) throw new MaintenanceError('DRAIN_BEFORE_INDEX', 'Source drain requires a durable index completion record');
    await this.verifyArchivePayloads(journal);
    if (stableFingerprint(await this.adapter.readIndexState(journal.sessionId)) !== journal.index.afterFingerprint) return this.pendingJournal(journal, 'Adapter index changed before source drain');
    journal = await this.updateJournal(journal, { state: 'DRAIN_INTENT' });
    for (let i=0;i<journal.payload.length;i+=1) {
      let row=journal.payload[i]!;
      if (row.drained) continue;
      const src=await resolveMappedPath(this.roots,{baseRoot:row.source.baseRoot,relativePath:nativeRel(row.source.relativePath)});
      if (!row.drainIntent) {
        const entries=journal.payload.map((entry,n)=>n===i?Object.freeze({...entry,drainIntent:true}):entry);
        journal=await this.updateJournal(journal,{payload:Object.freeze(entries)}); row=journal.payload[i]!;
      }
      await checkpoint(this.options.faultHook,`after-intent:drain:${i}`);
      if (!(await this.pathExists(src))) {
        if (!row.drainIntent) return this.pendingJournal(journal, `Source ${row.source.relativePath} disappeared before drain intent`);
        await syncDirectory(dirname(src), this.options.faultHook, `source-drain-reconcile:${i}`);
        const entries=journal.payload.map((entry,n)=>n===i?Object.freeze({...entry,drained:true}):entry);
        journal=await this.updateJournal(journal,{payload:Object.freeze(entries),diagnostics:[...journal.diagnostics,`Source ${row.source.relativePath} already absent during drain reconciliation`]});
        continue;
      }
      const current=await readIdentity(src); const hashed=await hashFile(src);
      if (!sameIdentity(current,row.sourceIdentity) || hashed.sha256!==row.sha256 || hashed.bytes!==row.bytes) {
        return this.pendingJournal(journal,`Source changed or resumed; preserved ${row.source.relativePath}`);
      }
      await this.assertSafetyStillCurrent(journal.sessionId);
      await checkpoint(this.options.faultHook,`before-side-effect:drain:${i}:unlink`);
      await injectOperationError(this.options.faultHook, 'unlink', src);
      await unlink(src);
      await checkpoint(this.options.faultHook,`after-side-effect:drain:${i}:unlink`);
      await syncDirectory(dirname(src),this.options.faultHook,`source-drain:${i}`);
      const entries=journal.payload.map((entry,n)=>n===i?Object.freeze({...entry,drained:true}):entry);
      journal=await this.updateJournal(journal,{payload:Object.freeze(entries)});
      await checkpoint(this.options.faultHook,`after-completion:drain:${i}`);
    }
    return journal;
  }
}
