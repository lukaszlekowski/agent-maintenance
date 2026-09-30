import { ensurePrivateDirectory } from './durable-directories.ts';
import { ROOT_ID_STORAGE, ROOT_ID_TEMP, adapterSchemaId, posixRel, nativeRel, isNotFound, readJson, emptyRegistry, type StorageAdapter, type StorageEngineOptions, type ArchiveRecord } from './contracts.ts';

import { lstat } from 'node:fs/promises';

import { join } from 'node:path';
import { withMaintenanceLocks } from '../core/locks.ts';
import { resolveMappedPath, resolveTrustedRoots } from '../core/paths.ts';
import { MaintenanceError, type AgentRoot } from '../types.ts';
import { assertStorageSafety, protectedRootBackend } from './safety.ts';
import { assertDurableRoot, atomicWriteJson, checkpoint, syncDirectory } from './durable-fs.ts';
import { parseJournal, parseManifest, parseRegistry, type ArchiveManifest, type RegistryEntry, type StorageJournal, type StorageRegistry } from './schema.ts';
export class StorageEngineBase {
  protected readonly options: StorageEngineOptions;
  protected readonly adapter: StorageAdapter;
  protected roots = new Map<string, string>();
  protected readyPromise: Promise<void> | undefined;
  constructor(options: StorageEngineOptions, adapter: StorageAdapter) { this.options = options; this.adapter = adapter; }

  protected async ready(): Promise<void> {
    this.readyPromise ??= this.initialize();
    return this.readyPromise;
  }

  protected async initialize(): Promise<void> {
    (this.options.backend ?? protectedRootBackend).assertAvailable();
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
    if(found && (found.txId!==entry.txId||found.agentId!==entry.agentId||found.sessionId!==entry.sessionId||found.rootId!==entry.rootId||found.relativePath!==entry.relativePath)) {
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
