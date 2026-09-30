export interface GuiLaunchResult {
  readonly launched: boolean;
  readonly reason?: string;
}

/** Shared launch seam. Phase 6 supplies the authenticated server/desktop implementation. */
export interface GuiLauncher {
  launch(): Promise<GuiLaunchResult>;
}

export const unavailableGuiLauncher: GuiLauncher = Object.freeze({
  async launch() {
    return Object.freeze({ launched: false, reason: 'The authenticated GUI server and desktop launcher are scheduled for Phase 6' });
  },
});
