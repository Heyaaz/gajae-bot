import { useCallback, useEffect, useRef, useState } from "react";
import type { GjcUpdateStatus } from "../../shared/agent-contract";
import type { RemoteClientStatus } from "../../shared/remote-protocol";
import type { AgentBackend } from "../backend/agent-backend";
import type { BackendConnection } from "../backend/types";
import { isDeclinedConfirmation } from "./format";

export function useRemoteStatus(backend: AgentBackend) {
  // A browser is the remote client of a host: the shell keeps its status so an
  // unpaired device sees the pairing screen and a view-only device cannot type
  // into a composer the host would refuse anyway.
  const remoteBridge = backend.remoteAccess;
  const [remoteStatus, setRemoteStatus] = useState<RemoteClientStatus | null>(
    remoteBridge ? null : { state: "connected" },
  );

  useEffect(() => {
    const bridge = backend.remoteAccess;
    if (!bridge) return;
    let active = true;
    void bridge.getStatus().then((status) => {
      if (active) setRemoteStatus(status);
    });
    const unsubscribe = bridge.subscribe((status) => setRemoteStatus(status));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [backend]);

  return remoteStatus;
}

export function useGjcUpdate(
  settingsBridge: NonNullable<Window["agentControlDesktop"]>["settings"] | undefined,
  connectionState: BackendConnection["state"],
  setSettingsOpen: (open: boolean) => void,
) {
  const [updateStatus, setUpdateStatus] = useState<GjcUpdateStatus | null>(
    null,
  );
  const [updateBusy, setUpdateBusy] = useState<
    "checking" | "installing" | null
  >(null);
  const [updateError, setUpdateError] = useState("");
  const updateCheckedRef = useRef(false);

  const checkForUpdate = useCallback(async (): Promise<void> => {
    if (!settingsBridge) return;
    setUpdateBusy("checking");
    setUpdateError("");
    try {
      setUpdateStatus(await settingsBridge.checkGjcUpdate());
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdateBusy(null);
    }
  }, [settingsBridge]);

  const installUpdate = useCallback(async (): Promise<void> => {
    if (!settingsBridge || !updateStatus?.updateAvailable) return;
    setUpdateBusy("installing");
    setUpdateError("");
    try {
      setUpdateStatus(await settingsBridge.installGjcUpdate());
    } catch (error) {
      if (isDeclinedConfirmation(error)) return;
      setUpdateError(error instanceof Error ? error.message : String(error));
      setSettingsOpen(true);
    } finally {
      setUpdateBusy(null);
    }
  }, [settingsBridge, updateStatus]);

  useEffect(() => {
    if (updateCheckedRef.current) return;
    // `gjc update --check` is its own process. Starting it while the broker
    // index is still the reachability probe competes with the first session
    // list, so it waits until that connection attempt has settled.
    if (connectionState === "connecting") return;
    updateCheckedRef.current = true;
    queueMicrotask(() => void checkForUpdate());
  }, [checkForUpdate, connectionState]);

  return { updateStatus, updateBusy, updateError, checkForUpdate, installUpdate };
}
