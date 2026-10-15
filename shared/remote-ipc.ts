export const REMOTE_IPC = {
  getState: "agent-control:remote:get-state",
  setEnabled: "agent-control:remote:set-enabled",
  setPort: "agent-control:remote:set-port",
  issuePairingCode: "agent-control:remote:issue-pairing-code",
  clearPairingCode: "agent-control:remote:clear-pairing-code",
  setDevicePermission: "agent-control:remote:set-device-permission",
  revokeDevice: "agent-control:remote:revoke-device",
  forgetDevice: "agent-control:remote:forget-device",
  refresh: "agent-control:remote:refresh",
} as const;
