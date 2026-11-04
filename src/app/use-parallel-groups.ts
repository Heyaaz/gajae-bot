import { useEffect, useState } from "react";
import type { ParallelDesktopBridge } from "../../shared/parallel-ipc";
import type { ParallelGroup } from "../../shared/parallel-run";

export function useParallelGroups(
  parallelBridge: ParallelDesktopBridge | null,
): ParallelGroup[] {
  const [parallelGroups, setParallelGroups] = useState<ParallelGroup[]>([]);
  useEffect(() => {
    if (!parallelBridge) return;
    let active = true;
    const unsubscribe = parallelBridge.onChanged((groups) => {
      active = false;
      setParallelGroups(groups);
    });
    void parallelBridge
      .list()
      .then((groups) => {
        if (active) setParallelGroups(groups);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [parallelBridge]);

  return parallelGroups;
}
