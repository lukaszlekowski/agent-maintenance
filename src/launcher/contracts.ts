export interface GuiLaunchResult {
  readonly launched: boolean;
  readonly reason?: string;
}

/** Shared launch seam for the authenticated local browser GUI. */
export interface GuiLauncher {
  launch(): Promise<GuiLaunchResult>;
}

export const unavailableGuiLauncher: GuiLauncher = Object.freeze({
  async launch() {
    return Object.freeze({ launched: false, reason: 'No GUI launcher is configured for this service instance' });
  },
});
