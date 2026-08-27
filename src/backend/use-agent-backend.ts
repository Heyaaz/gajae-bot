import { useContext } from "react";
import { BackendContext } from "./backend-context";
import type { AgentBackend } from "./agent-backend";

export function useAgentBackend(): AgentBackend {
  const backend = useContext(BackendContext);
  if (!backend) throw new Error("Agent backend is not available");
  return backend;
}
