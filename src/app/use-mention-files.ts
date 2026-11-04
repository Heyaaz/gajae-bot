import { useEffect, useLayoutEffect } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { mentionCandidates } from "../composer-mentions";
import { humanErrorMessage } from "./format";
import type { MentionFiles } from "./composer-mention-list";

type WorkspaceBridge = NonNullable<Window["agentControlDesktop"]>["gjc"];

export function useMentionFilesLoader(
  mentionOpen: boolean,
  workspaceBridge: WorkspaceBridge | undefined,
  sessionId: string,
  setMentionFiles: Dispatch<SetStateAction<MentionFiles | null>>,
): void {
  // Each opening asks again; the main process serves repeats from its own cache,
  // so files the agent wrote since the last `@` are offered without a reload.
  useEffect(() => {
    if (!mentionOpen || !workspaceBridge) return;
    const owner = sessionId;
    let current = true;
    workspaceBridge.listWorkspaceFiles(owner).then(
      (index) => {
        if (!current) return;
        setMentionFiles({
          sessionId: owner,
          status: "ready",
          candidates: mentionCandidates(index.files),
          truncated: index.truncated,
        });
      },
      (error: unknown) => {
        if (!current) return;
        setMentionFiles({ sessionId: owner, status: "failed", message: humanErrorMessage(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [mentionOpen, sessionId, workspaceBridge, setMentionFiles]);
}

export function useSelectedMentionVisible(
  mentionPaletteRef: RefObject<HTMLDivElement | null>,
  mentionIndex: number,
  mentionMatches: string[],
): void {
  useLayoutEffect(() => {
    mentionPaletteRef.current
      ?.querySelector<HTMLElement>(`[data-mention-index="${mentionIndex}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [mentionPaletteRef, mentionIndex, mentionMatches]);
}
