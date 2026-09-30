import { ACTIVE_STATES, TERMINAL_STATES, ROOT_ID_STORAGE, adapterSchemaId, readJson, type RecoveryDiagnostic } from './contracts.ts';

import { readdir } from 'node:fs/promises';

import { join } from 'node:path';
import { withMaintenanceLocks } from '../core/locks.ts';



import { parseJournal, stableFingerprint, type StorageJournal } from './schema.ts';
import { StorageEngineBase } from './engine-base.ts';
export abstract class RecoveryFlow extends StorageEngineBase {
  protected abstract recoverArchive(input: StorageJournal): Promise<RecoveryDiagnostic>;
  protected abstract recoverRestore(input: StorageJournal): Promise<RecoveryDiagnostic>;
  protected abstract reconcileTerminal(input: StorageJournal): Promise<RecoveryDiagnostic>;

  async recover(): Promise<readonly RecoveryDiagnostic[]> {
    await this.ready();
    const lockDirectory = join(this.roots.get(ROOT_ID_STORAGE)!, 'locks');
    return withMaintenanceLocks(['maintenance'], { lockDirectory }, async () => {
      const transactions = join(this.roots.get(ROOT_ID_STORAGE)!, 'transactions');
      const files = (await readdir(transactions)).filter((name) => name.endsWith('.json')).sort();
      const diagnostics: RecoveryDiagnostic[] = [];
      for (const name of files) {
        let journal: StorageJournal;
        try { journal = parseJournal(await readJson(join(transactions, name), 'JOURNAL_SCHEMA_INVALID')); }
        catch (error) { diagnostics.push(Object.freeze({ txId: name.slice(0,-5), archiveId: 'unknown', state: 'UNKNOWN', status: 'PENDING', reasons: Object.freeze([error instanceof Error ? error.message : 'Journal invalid']) })); continue; }
        if (journal.agentId !== this.adapter.agentId || journal.adapterSchema !== adapterSchemaId(this.adapter.schema)) {
          diagnostics.push(Object.freeze({ txId: journal.txId, archiveId: journal.archiveId, state: journal.state, status: 'PENDING', reasons: Object.freeze([...journal.diagnostics, 'No matching adapter schema is registered for recovery']) }));
          continue;
        }
        if (TERMINAL_STATES.has(journal.state)) {
          try {
            const result = await this.withExternalSafety(journal.sessionId, () => this.reconcileTerminal(journal));
            diagnostics.push(result);
          } catch (error) {
            diagnostics.push(Object.freeze({ txId: journal.txId, archiveId: journal.archiveId, state: journal.state, status: 'PENDING', reasons: Object.freeze([error instanceof Error ? error.message : 'Terminal registry reconciliation failed']) }));
          }
          continue;
        }
        if (journal.state === 'RECOVERY_FAILED') {
          diagnostics.push(Object.freeze({ txId: journal.txId, archiveId: journal.archiveId, state: journal.state, status: 'PENDING', reasons: Object.freeze([...journal.diagnostics, 'Manual reconciliation is required']) }));
          continue;
        }
        if (!ACTIVE_STATES.has(journal.state)) continue;
        try {
          const result = await this.withExternalSafety(journal.sessionId, async () => {
            return journal.action === 'restore' ? this.recoverRestore(journal) : this.recoverArchive(journal);
          });
          diagnostics.push(result);
        } catch (error) {
          diagnostics.push(Object.freeze({ txId: journal.txId, archiveId: journal.archiveId, state: journal.state, status: 'PENDING', reasons: Object.freeze([error instanceof Error ? error.message : 'Safety gate unavailable']) }));
        }
      }
      return Object.freeze(diagnostics);
    });
  }

  protected async reconcileIndex(journal: StorageJournal): Promise<StorageJournal> {
    const current=await this.adapter.readIndexState(journal.sessionId); const fingerprint=stableFingerprint(current);
    if (fingerprint===journal.index.afterFingerprint) {
      return this.updateJournal(journal,{state:'INDEX_COMMITTED',indexIntent:true,indexCommitted:true});
    }
    if (fingerprint===journal.index.beforeFingerprint) {
      if (!journal.indexIntent) journal=await this.updateJournal(journal,{state:'INDEX_INTENT',indexIntent:true});
      await this.assertSafetyStillCurrent(journal.sessionId);
      await this.adapter.applyIndexState(journal.sessionId,journal.index.before,journal.index.after);
      const after=await this.adapter.readIndexState(journal.sessionId);
      if (stableFingerprint(after)!==journal.index.afterFingerprint) return this.pendingJournal(journal,'Adapter index commit could not be proven after recovery');
      return this.updateJournal(journal,{state:'INDEX_COMMITTED',indexCommitted:true});
    }
    return this.pendingJournal(journal,'Current adapter index matches neither recorded before nor after evidence');
  }

  protected async pending(journal: StorageJournal, reason: string): Promise<RecoveryDiagnostic> {
    const pending=await this.pendingJournal(journal,reason);
    if (pending.action !== 'restore') await this.markRegistry(pending.archiveId,'RECOVERY_PENDING');
    return Object.freeze({txId:pending.txId,archiveId:pending.archiveId,state:pending.state,status:'PENDING',reasons:pending.diagnostics});
  }

  protected async pendingJournal(journal: StorageJournal, reason: string): Promise<StorageJournal> {
    if (journal.state==='RECOVERY_PENDING' && journal.diagnostics.includes(reason)) return journal;
    return this.updateJournal(journal,{state:'RECOVERY_PENDING',diagnostics:journal.diagnostics.includes(reason)?journal.diagnostics:[...journal.diagnostics,reason]});
  }
}
