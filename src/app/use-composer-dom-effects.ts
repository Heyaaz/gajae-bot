import { useEffect, useLayoutEffect } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

export function useTextareaAutosize(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  value: string,
): void {
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    // Measuring the live field at height:auto temporarily shrinks its flex sibling,
    // the transcript. The browser can clamp scrollTop during that layout read even
    // when the final textarea height is unchanged. Measure outside the layout flow.
    const measure = textarea.cloneNode(false) as HTMLTextAreaElement;
    measure.removeAttribute("id");
    measure.removeAttribute("name");
    measure.setAttribute("aria-hidden", "true");
    measure.tabIndex = -1;
    Object.assign(measure.style, {
      position: "fixed",
      visibility: "hidden",
      pointerEvents: "none",
      width: `${textarea.offsetWidth}px`,
      height: "0px",
      minHeight: "0px",
      maxHeight: "none",
      overflow: "hidden",
      transition: "none",
    });
    measure.value = value;
    textarea.parentElement!.appendChild(measure);
    const height = measure.scrollHeight;
    measure.remove();
    const nextHeight = `${Math.min(Math.max(height, 52), 196)}px`;
    if (textarea.style.height !== nextHeight) textarea.style.height = nextHeight;
    textarea.style.overflowY = height > 196 ? "auto" : "hidden";
  }, [textareaRef, value]);
}

export function useSelectedCommandVisible(
  commandPaletteRef: RefObject<HTMLDivElement | null>,
  commandIndex: number,
  commandQuery: string | null,
  matchingCount: number,
): void {
  useLayoutEffect(() => {
    const palette = commandPaletteRef.current;
    const selected = palette?.querySelector<HTMLElement>(
      `[data-command-index="${commandIndex}"]`,
    );
    if (!palette || !selected) return;
    const selectedTop = selected.offsetTop;
    const selectedBottom = selectedTop + selected.offsetHeight;
    const visibleTop = palette.scrollTop;
    const visibleBottom = visibleTop + palette.clientHeight;
    if (selectedTop < visibleTop) palette.scrollTop = selectedTop;
    else if (selectedBottom > visibleBottom)
      palette.scrollTop = selectedBottom - palette.clientHeight;
  }, [commandPaletteRef, commandIndex, commandQuery, matchingCount]);
}

export function useClosePopovers(
  composerRef: RefObject<HTMLFormElement | null>,
  setWorkspaceOpen: Dispatch<SetStateAction<boolean>>,
  setConfigMenu: Dispatch<SetStateAction<string | null>>,
): void {
  useEffect(() => {
    function closePopovers(event: Event): void {
      if (
        event.type === "pointerdown" &&
        composerRef.current?.contains(event.target as Node)
      )
        return;
      setWorkspaceOpen(false);
      setConfigMenu(null);
    }
    window.addEventListener("pointerdown", closePopovers);
    window.addEventListener("blur", closePopovers);
    return () => {
      window.removeEventListener("pointerdown", closePopovers);
      window.removeEventListener("blur", closePopovers);
    };
  }, [composerRef, setWorkspaceOpen, setConfigMenu]);
}

export function useAppShellFileDrop(
  composerRef: RefObject<HTMLFormElement | null>,
  setDragActive: Dispatch<SetStateAction<boolean>>,
  addDroppedAttachments: (dropped: FileList | readonly File[]) => Promise<void>,
): void {
  useEffect(() => {
    const candidate = composerRef.current?.closest(".app-shell");
    if (!(candidate instanceof HTMLElement)) return;
    const dropTarget = candidate;
    let dragDepth = 0;
    function hasFiles(event: DragEvent): boolean {
      return event.dataTransfer?.types.includes("Files") ?? false;
    }
    function handleDragEnter(event: DragEvent): void {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      dropTarget.classList.add("is-dragging-files");
      setDragActive(true);
    }
    function handleDragOver(event: DragEvent): void {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
    function handleDragLeave(event: DragEvent): void {
      if (dragDepth === 0) return;
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth > 0) return;
      dropTarget.classList.remove("is-dragging-files");
      setDragActive(false);
    }
    function handleDrop(event: DragEvent): void {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      dragDepth = 0;
      dropTarget.classList.remove("is-dragging-files");
      setDragActive(false);
      void addDroppedAttachments(event.dataTransfer.files);
    }
    dropTarget.addEventListener("dragenter", handleDragEnter);
    dropTarget.addEventListener("dragover", handleDragOver);
    dropTarget.addEventListener("dragleave", handleDragLeave);
    dropTarget.addEventListener("drop", handleDrop);
    return () => {
      dropTarget.classList.remove("is-dragging-files");
      dropTarget.removeEventListener("dragenter", handleDragEnter);
      dropTarget.removeEventListener("dragover", handleDragOver);
      dropTarget.removeEventListener("dragleave", handleDragLeave);
      dropTarget.removeEventListener("drop", handleDrop);
    };
  }, [composerRef, setDragActive, addDroppedAttachments]);
}
