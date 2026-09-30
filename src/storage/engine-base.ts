import { ensurePrivateDirectory } from './durable-directories.ts';
import { ROOT_ID_STORAGE, ROOT_ID_TEMP, adapterSchemaId, posixRel, nativeRel, isNotFound, readJson, emptyRegistry, safeSessionId, type StorageAdapter, type StorageEngineOptions, type ArchiveRecord } from './contracts.ts';

import { lstat, open, readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { join } from 'node:path';
import { withMaintenanceLocks } from '../core/locks.ts';
import { resolveMappedPath, resolveTrustedRoots } from '../core/paths.ts';
import { MaintenanceError, archiveId, transactionId, type AgentRoot } from '../types.ts';
import { assertStorageSafety, isAuthorizedStorageBackend, protectedRootBackend } from './safety.ts';
import { assertDurableRoot, atomicWriteJson, checkpoint, reserveDirectoryNoReplace, syncDirectory } from './durable-fs.ts';
import { parseJournal, parseManifest, parseRegistry, type ArchiveManifest, type RegistryEntry, type StorageJournal, type StorageRegistry } from './schema.ts';
import type { ManagedDatabaseJournalRef, ManagedDatabaseParticipant, ManagedDatabaseRecoveryParticipant } from './contracts.ts';
export class StorageEngineBase {
  protected readonly options: StorageEngineOptions;
  protected readonly adapter: StorageAdapter;
  protected roots = new Map<string, string>();
  protected readyPromise: Promise<void> | undefined;
  private readonly databaseRecoveryParticipants = new Map<string, ManagedDatabaseRecoveryParticipant>();
  constructor(options: StorageEngineOptions, adapter: StorageAdapter) { this.options = options; this.adapter = adapter; }
  get mutationBoundary(): 'controlled-test' | 'protected-production' { return (this.options.backend ?? protectedRootBackend).kind === 'controlled-test' ? 'controlled-test' : 'protected-production'; }
  registerDatabaseRecoveryParticipant(key: string, participant: ManagedDatabaseRecoveryParticipant): void { this.databaseRecoveryParticipants.set(key, participant); }
  protected async recoverDatabaseParticipants(): Promise<readonly import('./contracts.ts').RecoveryDiagnostic[]> {
    const results = await Promise.all([...this.databaseRecoveryParticipants.values()].map((participant) => participant.recoverManagedTransactions()));
    return Object.freeze(results.flat());
  }

  async listDatabaseJournalRefs(agentId: string): Promise<readonly ManagedDatabaseJournalRef[]> {
    await this.ready();
    const lockDirectory = join(this.roots.get(ROOT_ID_STORAGE)!, 'locks');
    return withMaintenanceLocks(['maintenance'], { lockDirectory }, async () => {
      const txRoot = join(this.roots.get(ROOT_ID_STORAGE)!, 'transactions');
      const files = (await readdir(txRoot)).filter((name) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.database\.json$/i.test(name));
      const refs: ManagedDatabaseJournalRef[] = [];
      for (const name of files) {
        const raw = await readJson(join(txRoot, name), 'DB_JOURNAL_INVALID');
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const row = raw as Record<string, unknown>;
        if (row.adapterId === agentId && typeof row.transactionId === 'string' && typeof row.archiveId === 'string' && typeof row.sessionId === 'string') {
          refs.push(Object.freeze({ txId: row.transactionId, archiveId: row.archiveId, sessionId: row.sessionId }));
        }
      }
      const seen = new Set(refs.map((ref) => ref.txId));
      const registry = await this.loadRegistry();
      for (const entry of registry.entries) {
        if (entry.participant === 'database' && entry.agentId === agentId && entry.status !== 'REGISTERED' && !seen.has(entry.txId)) {
          refs.push(Object.freeze({ txId: entry.txId, archiveId: entry.archiveId, sessionId: entry.sessionId }));
        }
      }
      return Object.freeze(refs);
    });
  }

  async listDatabaseArchives(agentId: string, sessionId?: string): Promise<readonly RegistryEntry[]> {
    await this.ready();
    const lockDirectory = join(this.roots.get(ROOT_ID_STORAGE)!, 'locks');
    return withMaintenanceLocks(['maintenance'], { lockDirectory }, async () => {
      const registry = await this.loadRegistry();
      return Object.freeze(registry.entries.filter((entry) => entry.participant === 'database' && entry.agentId === agentId
        && entry.status === 'REGISTERED' && (sessionId === undefined || entry.sessionId === sessionId)));
    });
  }

  protected async ready(): Promise<void> {
    this.readyPromise ??= this.initialize();
    return this.readyPromise;
  }

  protected async initialize(): Promise<void> {
    const backend = this.options.backend ?? protectedRootBackend;
    if (!isAuthorizedStorageBackend(backend)) throw new MaintenanceError('STORAGE_BACKEND_UNISSUED', 'Filesystem backend did not originate from a supported issuer');
    backend.assertAvailable();
    await ensurePrivateDirectory(this.options.storageRoot);
    const storageRoot = await assertDurableRoot(this.options.storageRoot);
    const roots: AgentRoot[] = [...this.options.trustedRoots, { id: ROOT_ID_STORAGE, path: storageRoot }];
    if (this.options.tempRoot) roots.push({ id: ROOT_ID_TEMP, path: this.options.tempRoot.path });
    const ids = new Set<string>();
    for (const root of roots) { if (ids.has(root.id)) throw new MaintenanceError('DUPLICATE_ROOT_ID', `Storage root ID ${root.id} is duplicated`); ids.add(root.id); }
    this.roots = new Map(await resolveTrustedRoots(roots));
    for (const dir of ['transactions','locks','archived','deleted']) { await ensurePrivateDirectory(join(storageRoot, dir)); await syncDirectory(storageRoot, undefined, `initialize:${dir}`); }
    if (this.options.tempRoot) await ensurePrivateDirectory(this.options.tempRoot.path);
    if (this.options.tempRoot) await assertDurableRoot(this.options.tempRoot.path);
  }

  protected async exclusive<T>(sid: string, action: () => Promise<T>): Promise<T> {
    await this.ready();
    const lockDirectory = join(this.roots.get(ROOT_ID_STORAGE)!, 'locks');
    return withMaintenanceLocks(['maintenance'], { lockDirectory }, () => this.withExternalSafety(sid, action));
  }

  async withDatabaseParticipant<T>(input: { readonly sessionId: string; readonly operation: 'create' | 'restore' | 'recover'; readonly archiveId?: string; readonly txId?: string; readonly schemaFingerprint: string }, action: (participant: ManagedDatabaseParticipant) => Promise<T>): Promise<T> {
    const sid = safeSessionId(input.sessionId);
    return this.exclusive(sid, async () => {
      if (!/^[a-f0-9]{64}$/i.test(input.schemaFingerprint)) throw new MaintenanceError('DB_SCHEMA_DRIFT', 'Database participant requires a SHA-256 schema fingerprint');
      const agentId = this.adapter.agentId; const rootId = ROOT_ID_STORAGE;
      let txId: string; let aid: string; let relativePath: string; let creationTxId: string;
      if (input.operation === 'create') {
        if (input.archiveId !== undefined || input.txId !== undefined) throw new MaintenanceError('DB_PARTICIPANT_ID_INVALID', 'Create allocates IDs internally');
        txId = transactionId(randomUUID()); creationTxId = txId;
        await this.ensureMappedDirectories(rootId, `database/${agentId}/${sid}`);
        let reserved = false; aid = ''; relativePath = '';
        for (let attempt = 0; attempt < 8 && !reserved; attempt += 1) {
          aid = archiveId(randomUUID()); relativePath = `database/${agentId}/${sid}/${aid}`;
          const archiveDir = await resolveMappedPath(this.roots, { baseRoot: rootId, relativePath: nativeRel(relativePath) });
          try { await reserveDirectoryNoReplace(archiveDir, this.options.faultHook, 'database-archive-reservation'); reserved = true; }
          catch (error) { if (!(error instanceof MaintenanceError) || error.code !== 'RESERVATION_COLLISION' || attempt === 7) throw error; }
        }
        if (!reserved) throw new MaintenanceError('DB_ARCHIVE_RESERVATION_FAILED', 'Unable to reserve a unique managed database archive ID');
        await this.putRegistry(Object.freeze({ participant: 'database', archiveId: archiveId(aid), txId: transactionId(txId), agentId, sessionId: sid, category: 'archived', rootId, relativePath, status: 'RESERVED' }));
      } else {
        if (!input.archiveId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.archiveId)) throw new MaintenanceError('DB_PARTICIPANT_ID_INVALID', 'Exact archive ID is required');
        aid = input.archiveId;
        const entry = await this.findRegistryEntry(aid);
        if (!entry || entry.participant !== 'database' || entry.agentId !== agentId || entry.sessionId !== sid || entry.rootId !== rootId
          || entry.relativePath !== `database/${agentId}/${sid}/${aid}` || (input.operation === 'restore' && entry.status !== 'REGISTERED')) {
          throw new MaintenanceError('DB_ARCHIVE_UNAVAILABLE', 'Managed database archive is not registered for this adapter and session');
        }
        relativePath = entry.relativePath; creationTxId = entry.txId;
        if (input.operation === 'restore') {
          if (input.txId !== undefined) throw new MaintenanceError('DB_PARTICIPANT_ID_INVALID', 'Restore allocates its transaction ID internally');
          txId = transactionId(randomUUID());
        } else {
          if (!input.txId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.txId)) throw new MaintenanceError('DB_PARTICIPANT_ID_INVALID', 'Recovery requires an exact transaction ID');
          txId = transactionId(input.txId);
        }
      }
      const archiveDir = await resolveMappedPath(this.roots, { baseRoot: rootId, relativePath: nativeRel(relativePath) });
      const archiveFile = join(archiveDir, 'database.json');
      const journalFile = join(this.roots.get(rootId)!, 'transactions', `${txId}.database.json`);
      const participant: ManagedDatabaseParticipant = Object.freeze({ txId, archiveId: aid, creationTxId, agentId, sessionId: sid,
        schemaFingerprint: input.schemaFingerprint, boundary: (this.options.backend ?? protectedRootBackend).kind === 'controlled-test' ? 'controlled-test' : 'protected-production',
        writeArchive: async (bytes: Uint8Array) => { if (input.operation !== 'create') throw new MaintenanceError('DB_ARCHIVE_READ_ONLY', 'Only a newly reserved participant may publish an archive'); const handle = await open(archiveFile, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await syncDirectory(archiveDir, this.options.faultHook, 'database-archive-publish'); },
        readArchive: async () => readFile(archiveFile),
        writeJournal: async (value: unknown) => { await atomicWriteJson(journalFile, value, this.options.faultHook, `database-journal:${txId}`); },
        readJournal: async () => { try { return JSON.parse(await readFile(journalFile, 'utf8')) as unknown; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } },
        setArchiveStatus: async (status: RegistryEntry['status']) => this.putRegistry(Object.freeze({ participant: 'database', archiveId: archiveId(aid), txId: transactionId(creationTxId), agentId, sessionId: sid, category: 'archived', rootId, relativePath, status })),
      });
      return action(participant);
    });
  }

  protected async withExternalSafety<T>(sid: string, action: () => Promise<T>): Promise<T> {
    return this.adapter.withExternalExclusion(sid, async () => {
      await this.assertSafetyStillCurrent(sid);
      return action();
    });
  }

  async assertSafetyStillCurrent(sid: string): Promise<void> {
    const evidence = await this.adapter.inspectSafety(sid);
    assertStorageSafety(evidence, { agentId: this.adapter.agentId, sessionId: sid, adapterSchema: adapterSchemaId(this.adapter.schema), backend: this.options.backend ?? protectedRootBackend });
  }

  protected async persistNewJournal(journal: StorageJournal): Promise<void> {
    const path=join(this.roots.get(ROOT_ID_STORAGE)??this.options.storageRoot,'transactions',`${journal.txId}.json`);
    await atomicWriteJson(path,journal,this.options.faultHook,`journal:${journal.txId}`);
  }

  protected async updateJournal(journal: StorageJournal, patch: Partial<StorageJournal>): Promise<StorageJournal> {
    const progressState = patch.state && patch.state !== 'RECOVERY_PENDING' && patch.state !== 'RECOVERY_FAILED' ? patch.state : journal.progressState;
    const next=parseJournal({...journal,...patch,progressState,updatedAt:new Date().toISOString()});
    const path=join(this.roots.get(ROOT_ID_STORAGE)!,'transactions',`${next.txId}.json`);
    await atomicWriteJson(path,next,this.options.faultHook,`journal:${next.txId}`);
    await checkpoint(this.options.faultHook,`after-completion:journal:${next.state}`);
    return next;
  }

  protected async readPersistedJournal(txId: string): Promise<StorageJournal | null> {
    const raw = await readJson(join(this.roots.get(ROOT_ID_STORAGE)!, 'transactions', `${txId}.json`), 'JOURNAL_SCHEMA_INVALID');
    return raw === null ? null : parseJournal(raw);
  }

  protected async loadRegistry(): Promise<StorageRegistry> {
    const path=join(this.roots.get(ROOT_ID_STORAGE)!,'registry.json');
    const value=await readJson(path,'REGISTRY_INVALID');
    return value===null?emptyRegistry():parseRegistry(value);
  }

  protected async writeRegistry(registry: StorageRegistry): Promise<void> {
    await atomicWriteJson(join(this.roots.get(ROOT_ID_STORAGE)!,'registry.json'),registry,this.options.faultHook,'registry');
  }

  protected async putRegistry(entry: RegistryEntry): Promise<void> {
    const registry=await this.loadRegistry(); const found=registry.entries.find((row)=>row.archiveId===entry.archiveId);
    if(found && (found.txId!==entry.txId||found.agentId!==entry.agentId||found.sessionId!==entry.sessionId||found.rootId!==entry.rootId||found.relativePath!==entry.relativePath||found.participant!==entry.participant)) {
      throw new MaintenanceError('REGISTRY_CONFLICT','Archive registry identity conflicts with the immutable journal');
    }
    if (found?.status === entry.status) return;
    const entries=found?registry.entries.map((row)=>row.archiveId===entry.archiveId?entry:row):[...registry.entries,entry];
    await this.writeRegistry(Object.freeze({...registry,entries:Object.freeze(entries)}));
  }

  protected async markRegistry(aid: string, status: RegistryEntry['status']): Promise<void> {
    const registry=await this.loadRegistry();
    if(!registry.entries.some((entry)=>entry.archiveId===aid))return;
    if(registry.entries.find((entry)=>entry.archiveId===aid)?.status===status)return;
    await this.writeRegistry(Object.freeze({...registry,entries:Object.freeze(registry.entries.map((entry)=>entry.archiveId===aid?Object.freeze({...entry,status}):entry))}));
  }

  protected async findRegistryEntry(aid: string): Promise<RegistryEntry | null> {
    const registry=await this.loadRegistry(); const entries=registry.entries.filter((row)=>row.archiveId===aid);
    if(entries.length>1)throw new MaintenanceError('REGISTRY_DUPLICATE_ARCHIVE_ID','Registry contains duplicate archive IDs');
    return entries[0]??null;
  }

  protected async readManifest(record: ArchiveRecord): Promise<ArchiveManifest> {
    const location=await resolveMappedPath(this.roots,{baseRoot:record.rootId,relativePath:nativeRel(record.relativePath)});
    const manifest=parseManifest(await readJson(join(location,'manifest.json'),'MANIFEST_INVALID'));
    this.assertRegistryMatches(record,manifest);
    return manifest;
  }

  protected assertRegistryMatches(record: Pick<ArchiveRecord,'archiveId'|'txId'|'agentId'|'sessionId'|'category'|'rootId'|'relativePath'>,manifest:ArchiveManifest):void{
    const expectedRoot = manifest.category === 'temp' ? ROOT_ID_TEMP : ROOT_ID_STORAGE;
    const expectedPath = manifest.category === 'temp' ? posixRel(join(manifest.agentId, manifest.sessionId, manifest.archiveId)) : posixRel(join(manifest.category, manifest.agentId, manifest.sessionId, manifest.archiveId));
    if(record.archiveId!==manifest.archiveId||record.txId!==manifest.txId||record.agentId!==manifest.agentId||record.sessionId!==manifest.sessionId||record.category!==manifest.category||record.rootId!==expectedRoot||record.relativePath!==expectedPath)throw new MaintenanceError('REGISTRY_MANIFEST_MISMATCH','Registry and immutable manifest identities or layout do not match');
  }

  protected recordFor(journal:StorageJournal,status:RegistryEntry['status']):ArchiveRecord{
    return Object.freeze({archiveId:journal.archiveId,txId:journal.txId,agentId:journal.agentId,sessionId:journal.sessionId,category:journal.category,createdAt:journal.createdAt,status,rootId:journal.archiveRootId,relativePath:journal.archiveRelPath});
  }

  protected async ensureMappedDirectories(rootId: string, relativePath: string): Promise<void> {
    const parts = relativePath.split('/').filter((part) => part.length > 0);
    let current = this.roots.get(rootId);
    if (!current) throw new MaintenanceError('STORAGE_ROOT_UNREGISTERED', `Trusted root ${rootId} is not registered`);
    for (const part of parts) {
      const parent = current; current = join(current, part);
      await ensurePrivateDirectory(current);
      await syncDirectory(parent, this.options.faultHook, `directory-layout:${rootId}:${part}`);
    }
  }

  protected async pathExists(path:string):Promise<boolean>{try{await lstat(path);return true;}catch(error){if(isNotFound(error))return false;throw error;}}

  protected async privatePath(path:string):Promise<void>{await ensurePrivateDirectory(path);}
}
