export const VERSION_LOCK = Object.freeze({
  packIr: 'agentpack.studio/v1alpha1',
  dsh: {
    version: '0.1.1-rc.2',
    gitCommit: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e',
  },
  agentStack: {
    version: '0.7.1',
    gitCommit: '9b59a019aa5dcab76f1d4b9b910db3ea4ba4c435',
  },
  protocols: {
    a2a: '0.3.0',
    a2aJsSdk: '0.3.10',
    acpSdk: '0.25.1',
    mcpSdk: '1.29.0',
  },
} as const)
