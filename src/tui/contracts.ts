import type { AgentInventory, AgentId, InventorySession, MaintenanceError } from '../types.ts';
import type { ArchiveRecord } from '../storage/contracts.ts';
import type { GuiLauncher } from '../launcher/contracts.ts';
import type { MaintenanceConfig } from '../core/config.ts';
import type { SettingsStore } from './settings.ts';
import type { SessionMaintenanceAction } from '../core/action-policy.ts';

export interface ArchiveListing {
  readonly records: readonly ArchiveRecord[];
  readonly available: boolean;
  readonly reason?: string;
}

export type SessionAction = SessionMaintenanceAction;
export interface ActionResult { readonly ok: boolean; readonly message: string }
export interface TrustSyncResult { readonly agentId: AgentId; readonly ok: boolean; readonly message: string }

export interface TuiServices {
  loadInventory(): Promise<AgentInventory>;
  listArchives(): Promise<ArchiveListing>;
  performSessionAction(action: SessionAction, session: InventorySession): Promise<ActionResult>;
  restoreArchive(agentId: AgentId, sessionId: string, archiveId?: string): Promise<ActionResult>;
  pruneTrust(agentId: AgentId, path: string): Promise<ActionResult>;
  addTrustedPath(agentId: AgentId, path: string): Promise<ActionResult>;
  syncTrust(sourceAgentId: AgentId, path: string): Promise<readonly TrustSyncResult[]>;
  readonly settings: SettingsStore;
  readonly guiLauncher: GuiLauncher;
}

export type UiProblem = Pick<MaintenanceError, 'code' | 'message'>;

export type TuiModal =
  | { readonly kind: 'confirm'; readonly title: string; readonly message: string; readonly intent: TuiIntent }
  | { readonly kind: 'field'; readonly title: string; readonly field: 'tempFolder' | 'defaultPort' | 'trustPath'; readonly value: string; readonly agentId?: AgentId }
  | { readonly kind: 'notice'; readonly title: string; readonly message: string };

export type TuiIntent =
  | { readonly kind: 'session'; readonly action: SessionAction; readonly session: InventorySession }
  | { readonly kind: 'restore'; readonly archive: ArchiveRecord }
  | { readonly kind: 'prune'; readonly agentId: AgentId; readonly path: string }
  | { readonly kind: 'trust-add'; readonly agentId: AgentId; readonly path: string }
  | { readonly kind: 'trust-sync'; readonly agentId: AgentId; readonly path: string }
  | { readonly kind: 'launch-gui' };

export type TuiTab = 'Overview' | 'Sessions' | 'Storage' | 'Trust' | 'Settings' | 'Help';
export interface TuiState {
  readonly tab: TuiTab;
  readonly selected: number;
  readonly selectedKey: string | null;
  readonly page: number;
  readonly agentFilter: AgentId | null;
  readonly trustFilter: AgentId | null;
  readonly expandedAgents: ReadonlySet<AgentId>;
  readonly modal: TuiModal | null;
  readonly modalOffset: number;
  readonly statusMessage: string;
  readonly settings: MaintenanceConfig;
}
