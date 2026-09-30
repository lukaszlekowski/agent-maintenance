import type { AgentInventory, AgentId, InventorySession } from '../types.ts';
import type { ArchiveRecord } from '../storage/contracts.ts';
import type { TuiServices, ActionResult } from '../tui/contracts.ts';

export interface GuiInstanceRecord {
  readonly version: 1;
  readonly instanceId: string;
  readonly pid: number;
  readonly processStartTime: string;
  readonly port: number;
  readonly authToken: string;
  readonly startedAt: string;
}

export interface GuiSnapshot {
  readonly inventory: AgentInventory;
  readonly archives: readonly ArchiveRecord[];
  readonly archiveAvailable: boolean;
  readonly archiveReason?: string;
}

export type GuiCommand =
  | { readonly kind: 'session'; readonly action: 'archive' | 'soft-delete' | 'temp-move' | 'terminate'; readonly agentId: AgentId; readonly sessionId: string }
  | { readonly kind: 'restore'; readonly archiveId: string }
  | { readonly kind: 'trust-add' | 'trust-prune'; readonly agentId: AgentId; readonly path: string }
  | { readonly kind: 'trust-sync'; readonly agentId: AgentId; readonly path: string }
  | { readonly kind: 'settings-save'; readonly settings: unknown };

export interface GuiCommandResult extends ActionResult { readonly outcomes?: readonly { readonly agentId: AgentId; readonly ok: boolean; readonly message: string }[] }

export interface GuiApi {
  snapshot(): Promise<GuiSnapshot>;
  dispatch(command: GuiCommand): Promise<GuiCommandResult>;
  loadSettings(): ReturnType<TuiServices['settings']['load']>;
}

export type GuiMutationGuard = <T>(operation: () => Promise<T>) => Promise<T>;

export interface GuiHealthChallenge {
  readonly instanceId: string;
  readonly port: number;
  readonly authToken: string;
}

export interface ChildServerConfig {
  readonly instanceId: string;
  readonly authToken: string;
  readonly port: number;
  readonly root: string;
  readonly processStartTime: string;
}

export interface StartedGuiServer {
  readonly pid: number;
  readonly processStartTime: string;
}

export interface ProcessProbe {
  identity(pid: number): { readonly pid: number; readonly startTime: string; readonly command: string } | null;
}

export type { InventorySession };
