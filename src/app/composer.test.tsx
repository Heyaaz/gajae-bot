import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MessageInput } from "../backend/types";
import type { FileAttachment, ImageAttachment } from "../../shared/agent-contract";
import {
  consumeQueuePullKey,
  isImmediateSdkCommandSubmission,
  pullQueuedRequest,
  restorePulledDraft,
  withoutReleasedRequest,
} from "../composer-utils";
import type { PendingRequest } from "../composer-utils";
import {
  Composer,
  type ComposerSnapshot,
  FastTierControls,
  fastTierBusy,
  handleComposerEnter,
  QueueChip,
  canReleaseQueue,
  cancelBeforeQueueDiscard,
  mergePreparedAttachments,
  requestFastTier,
  restoreRejectedDraft,
  acknowledgeComposerDraftRecoveries,
  composerDraftRecoveries,
  mergeRecoveredDraft,
  publishComposerDraftRecovery,
  requestQueueReleaseRetry,
  subscribeComposerDraftRecovery,
  subscribeComposerReleaseRetry,
  parkComposerSession,
  saveComposerQueue,
  saveComposerSnapshot,
  composerQueue,
  releaseQueuedSession,
  selectedCommandDraft,
  storePreparedAttachments,
} from "./composer";
import type {
  ComposerEnterEffects,
  ComposerEnterEvent,
  ComposerProps,
  FastTierControlsProps,
} from "./composer";

const FAST = {
  name: "fast",
  description: "Enable or disable priority service tier",
};

function controls(
  overrides: Partial<FastTierControlsProps> = {},
): FastTierControlsProps {
  return {
    commands: [FAST],
    fastMode: false,
    busy: false,
    readOnly: false,
    onSelect: () => undefined,
    ...overrides,
  };
}

function render(props: Partial<FastTierControlsProps> = {}): string {
  return renderToStaticMarkup(createElement(FastTierControls, controls(props)));
}

interface TestElement {
  props: {
    children?: unknown;
    className?: string;
    type?: string;
    "aria-label"?: string;
    onClick?: () => void;
  };
}

/** The buttons hold plain text, so a label finds its own element in either form. */
function childButtons(node: TestElement): TestElement[] {
  const children = Array.isArray(node.props.children)
    ? node.props.children
    : [node.props.children];
  return children.filter(
    (child): child is TestElement =>
      typeof child === "object" && child !== null && "props" in child,
  );
}

function buttonMarkup(markup: string, label: string): string {
  const found = [...markup.matchAll(/<button\b[^>]*>[^<]*<\/button>/gu)]
    .map((match) => match[0])
    .find((html) => html.endsWith(`>${label}</button>`));
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

function buttonElement(
  props: Partial<FastTierControlsProps>,
  label: string,
): TestElement {
  const group = FastTierControls(controls(props)) as unknown as TestElement;
  const found = childButtons(group).find(
    (child) => child.props.children === label,
  );
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

describe("Composer Fast tier controls", () => {
  it("offers both tiers only when the runtime advertises /fast", () => {
    // The tier belongs to the runtime, so a backend that publishes no `/fast`
    // command gets no buttons rather than a control that could never apply.
    expect(render({ commands: [{ name: "model" }, { name: "context" }] })).toBe(
      "",
    );
    const markup = render();
    expect(markup).toContain('class="config-option-menu-fast"');
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="Fast 모드"');
    expect(buttonMarkup(markup, "Fast on")).toBeTruthy();
    expect(buttonMarkup(markup, "Fast off")).toBeTruthy();
  });

  it("marks the tier the session reports instead of a local guess", () => {
    const off = render({ fastMode: false });
    expect(buttonMarkup(off, "Fast on")).toContain('aria-pressed="false"');
    expect(buttonMarkup(off, "Fast off")).toContain('aria-pressed="true"');

    const on = render({ fastMode: true });
    expect(buttonMarkup(on, "Fast on")).toContain('aria-pressed="true"');
    expect(buttonMarkup(on, "Fast off")).toContain('aria-pressed="false"');
  });

  it("refuses a press only on a view-only device or while one is in flight", () => {
    // A running turn is deliberately not one of those reasons: the runtime applies
    // the tier to the open session, so no running state is passed to this control.
    for (const blocked of [{ readOnly: true }, { busy: true }]) {
      const markup = render(blocked);
      expect(buttonMarkup(markup, "Fast on")).toContain("disabled");
      expect(buttonMarkup(markup, "Fast off")).toContain("disabled");
    }
    const idle = render();
    expect(buttonMarkup(idle, "Fast on")).not.toContain("disabled");
    expect(buttonMarkup(idle, "Fast off")).not.toContain("disabled");
  });

  it("asks for one tier per press and leaves the menu to the caller", () => {
    const picks: boolean[] = [];
    const on = buttonElement({ onSelect: (fast) => picks.push(fast) }, "Fast on");
    on.props.onClick!();
    const off = buttonElement(
      { onSelect: (fast) => picks.push(fast) },
      "Fast off",
    );
    off.props.onClick!();
    expect(picks).toEqual([true, false]);
    // Reaching Fast is the whole contract of these buttons: neither carries a close
    // or navigation handler, so the model list the popover was opened for is still
    // there afterwards.
    expect(Object.keys(on.props).filter((key) => key.startsWith("on"))).toEqual([
      "onClick",
    ]);
  });
});

describe("requestFastTier", () => {
  it("sends the tier as a bare runtime command with no attachments", async () => {
    const sent: MessageInput[] = [];
    const send = async (input: MessageInput) => {
      sent.push(input);
      return "prompt" as const;
    };
    await requestFastTier({ fast: true, send, report: () => undefined });
    await requestFastTier({ fast: false, send, report: () => undefined });
    // Attachments are what decide whether the runtime reads this as its own
    // service-tier control or as prompt text steered into the open turn.
    expect(sent).toEqual([
      { text: "/fast on", images: [], files: [] },
      { text: "/fast off", images: [], files: [] },
    ]);
  });

  it("reports a refused request and consumes its rejection", async () => {
    const reported: string[] = [];
    await expect(
      requestFastTier({
        fast: true,
        send: async () => {
          throw new Error("service_tier.set is not advertised");
        },
        report: (message) => reported.push(message),
      }),
    ).resolves.toBeUndefined();
    expect(reported).toEqual(["service_tier.set is not advertised"]);

    // A runtime that rejects with something other than an Error still has to reach
    // the composer's error line as text.
    await requestFastTier({
      fast: false,
      send: async () => {
        throw "refused";
      },
      report: (message) => reported.push(message),
    });
    expect(reported).toEqual([
      "service_tier.set is not advertised",
      "refused",
    ]);
  });
});

describe("fastTierBusy", () => {
  it("keeps an unfinished request from another session out of this one", () => {
    // One composer serves every session, so a request sent from a row the user has
    // left behind must not hold the next row's buttons disabled.
    expect(fastTierBusy({ sessionId: "session-a" }, "session-b")).toBe(false);
    expect(fastTierBusy({ sessionId: "session-b" }, "session-b")).toBe(true);
    expect(fastTierBusy(null, "session-b")).toBe(false);
  });
});

describe("prepared attachment drafts", () => {
  it("keeps late preparations with their origin session", () => {
    const drafts = new Map<
      string,
      { value: string; images: ImageAttachment[]; files: FileAttachment[] }
    >();
    storePreparedAttachments(drafts, "session-a", "images", [
      { id: "a-image" } as unknown as ImageAttachment,
    ]);

    expect(drafts.get("session-b")).toBeUndefined();
    expect(drafts.get("session-a")?.images).toEqual([{ id: "a-image" }]);
  });

  it("composes concurrent preparations and respects the attachment limit", () => {
    const first = [{ id: "first" }];
    const second = [{ id: "second" }];

    expect(mergePreparedAttachments(first, second, 6)).toEqual([
      { id: "first" },
      { id: "second" },
    ]);
    expect(mergePreparedAttachments(first, second, 1)).toEqual(first);
  });
});

describe("selectedCommandDraft", () => {
  it("ends the palette query for a skill that advertises no hint", () => {
    // A hint-less `skill:*` left the textarea on exactly the `/skill:name` value the
    // palette matched, so the palette stayed open for it and the next Enter
    // re-selected the skill instead of submitting it.
    expect(selectedCommandDraft("skill:deep-interview")).toBe(
      "/skill:deep-interview ",
    );
    expect(selectedCommandDraft("skill:ralplan")).toBe("/skill:ralplan ");

    // And the skill stays agent work: it is not one of the controls that fire
    // straight at the runtime, so the draft is what actually gets submitted.
    expect(
      isImmediateSdkCommandSubmission(
        selectedCommandDraft("skill:deep-interview"),
        [{ name: "skill:deep-interview" }],
        false,
      ),
    ).toBe(false);
  });
});

function composerProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    sessionId: "session-1",
    running: false,
    sessionTitle: "Session",
    workspace: "/repo",
    workspaces: ["/repo"],
    commands: [],
    configOptions: [],
    onSend: async () => undefined,
    onCancel: async () => undefined,
    onFlushQueued: async () => undefined,
    onCompact: () => undefined,
    onNewSession: () => undefined,
    onWorkspaceChange: () => undefined,
    onConfigChange: () => undefined,
    onCycleThinking: () => undefined,
    ...overrides,
  };
}

/**
 * The submit slot's stop control.
 *
 * With an empty draft the slot renders stop, and `running` is the only thing that
 * enables it -- this is where the shell's derived turn state reaches the surface
 * the user reported: a live stop and an "이어서 보내기" send on a session that had
 * already finished.
 */
function stopButton(markup: string): string {
  const found = markup.match(/<button[^>]*send-button--stop[^>]*>/u)?.[0];
  if (!found) throw new Error("no stop button in the composer markup");
  return found;
}

describe("Composer turn surface", () => {
  it("stops only while the shell reports an open turn", () => {
    vi.stubGlobal("window", {});
    try {
      const live = renderToStaticMarkup(
        createElement(Composer, composerProps({ running: true })),
      );
      expect(stopButton(live)).not.toContain("disabled");

      // A settled turn reads false here even when the transcript still carries a
      // running tool card, which is the row that used to keep the composer holding
      // the next message as a steer.
      const settled = renderToStaticMarkup(
        createElement(Composer, composerProps({ running: false })),
      );
      expect(stopButton(settled)).toContain("disabled");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

interface TestKeyEvent {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  defaultPrevented: boolean;
  preventDefault: () => void;
}

/**
 * A keydown a handler can be driven with. `defaultPrevented` is the field that
 * decides whether the textarea inserts its own newline, so the fake carries it the
 * way the browser would.
 */
function keyEvent(
  key: string,
  overrides: Partial<
    Omit<TestKeyEvent, "key" | "preventDefault" | "defaultPrevented">
  > = {},
): TestKeyEvent {
  const event: TestKeyEvent = {
    key,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
    ...overrides,
  };
  return event;
}

function enterEvent(
  overrides: Partial<ComposerEnterEvent> = {},
): ComposerEnterEvent {
  return {
    key: "Enter",
    shiftKey: false,
    composing: false,
    compositionEndedAt: 0,
    now: 10_000,
    draftEmpty: false,
    paletteOpen: false,
    ...overrides,
  };
}

/**
 * One Enter press: the event, the composer state it lands on, and the effects it
 * reaches for. `submit` is the only path from an Enter to `onSend` or to the
 * pending queue, so a submit spy that stays empty covers both.
 */
function enterPress(overrides: Partial<ComposerEnterEvent> = {}) {
  const key = keyEvent("Enter", { shiftKey: overrides.shiftKey ?? false });
  const input = enterEvent(overrides);
  const effects = {
    preventDefault: () => key.preventDefault(),
    submit: vi.fn(),
    arm: vi.fn(),
    disarm: vi.fn(),
    defer: vi.fn(),
  } satisfies ComposerEnterEffects;
  return { key, input, effects };
}

function heldRequest(
  id: string,
  text: string,
  overrides: Partial<PendingRequest> = {},
): PendingRequest {
  return {
    id,
    text,
    mode: "followUp",
    label: "Queued",
    images: [],
    files: [],
    ...overrides,
  };
}

describe("Composer Enter paths", () => {
  it("leaves Shift+Enter during composition to the textarea", () => {
    // The Korean IME reports the same composing Enter for Shift+Enter as for the
    // submit gesture, and the commit that follows it fired the armed submit: the
    // line break queued the draft instead of breaking the line.
    const { key, input, effects } = enterPress({
      shiftKey: true,
      composing: true,
    });
    expect(handleComposerEnter(input, effects)).toBe(false);
    expect(effects.submit).not.toHaveBeenCalled();
    expect(effects.arm).not.toHaveBeenCalled();
    // Anything an earlier Enter armed goes with it: the commit that ends this
    // composition is the IME closing the new line, not finishing that submit.
    expect(effects.disarm).toHaveBeenCalled();
    // The default is what inserts the \n into the textarea, so it must survive.
    expect(key.defaultPrevented).toBe(false);

    // The same key on an empty draft is not the interrupt-and-release gesture
    // either: that plain-Enter meaning would have released the whole queue.
    const empty = enterPress({
      shiftKey: true,
      composing: true,
      draftEmpty: true,
    });
    expect(handleComposerEnter(empty.input, empty.effects)).toBe(false);
    expect(empty.effects.submit).not.toHaveBeenCalled();
    expect(empty.key.defaultPrevented).toBe(false);
  });

  it("leaves Shift+Enter in the frame after a commit to the textarea", () => {
    const { key, input, effects } = enterPress({
      shiftKey: true,
      composing: false,
      compositionEndedAt: 9_950,
    });
    expect(handleComposerEnter(input, effects)).toBe(false);
    expect(effects.submit).not.toHaveBeenCalled();
    expect(effects.arm).not.toHaveBeenCalled();
    expect(effects.defer).not.toHaveBeenCalled();
    expect(key.defaultPrevented).toBe(false);
  });

  it("still submits a plain Enter and still waits on the IME commit", () => {
    const settled = enterPress();
    expect(handleComposerEnter(settled.input, settled.effects)).toBe(true);
    expect(settled.effects.submit).toHaveBeenCalledTimes(1);
    expect(settled.key.defaultPrevented).toBe(true);

    const composing = enterPress({ composing: true });
    expect(handleComposerEnter(composing.input, composing.effects)).toBe(true);
    expect(composing.effects.arm).toHaveBeenCalledWith(10_000);
    expect(composing.effects.submit).not.toHaveBeenCalled();

    const followUp = enterPress({ compositionEndedAt: 9_950 });
    expect(handleComposerEnter(followUp.input, followUp.effects)).toBe(true);
    expect(followUp.effects.defer).toHaveBeenCalled();
    expect(followUp.effects.submit).not.toHaveBeenCalled();
  });

  it("keeps the empty Enter as the interrupt-and-release gesture", () => {
    const { input, effects } = enterPress({ composing: true, draftEmpty: true });
    expect(handleComposerEnter(input, effects)).toBe(true);
    expect(effects.disarm).toHaveBeenCalled();
    expect(effects.submit).toHaveBeenCalledTimes(1);
    expect(effects.arm).not.toHaveBeenCalled();
  });

  it("leaves a settled Enter to the command palette while it is open", () => {
    const { key, input, effects } = enterPress({ paletteOpen: true });
    expect(handleComposerEnter(input, effects)).toBe(false);
    expect(effects.submit).not.toHaveBeenCalled();
    expect(key.defaultPrevented).toBe(false);
  });
});

describe("Composer queue pull-back", () => {
  const draft = () => ({ value: "", images: [], files: [] });

  it("takes the newest entry on Option+ArrowUp and puts its text in the draft", () => {
    const pending = [heldRequest("a", "첫 지시"), heldRequest("b", "둘째 지시")];
    const event = keyEvent("ArrowUp", { altKey: true });
    const target = consumeQueuePullKey(event, { pending, releasing: false });
    expect(target).toBe("newest");
    expect(event.defaultPrevented).toBe(true);
    const pulled = pullQueuedRequest(pending, target!);
    expect(pulled?.pending.map((entry) => entry.id)).toEqual(["a"]);
    expect(restorePulledDraft(draft(), pulled!.entry).value).toBe("둘째 지시");
  });

  it("takes the oldest entry on Option+ArrowDown", () => {
    const pending = [heldRequest("a", "첫 지시"), heldRequest("b", "둘째 지시")];
    const event = keyEvent("ArrowDown", { altKey: true });
    const target = consumeQueuePullKey(event, { pending, releasing: false });
    expect(target).toBe("oldest");
    expect(event.defaultPrevented).toBe(true);
    const pulled = pullQueuedRequest(pending, target!);
    expect(pulled?.pending.map((entry) => entry.id)).toEqual(["b"]);
    expect(restorePulledDraft(draft(), pulled!.entry).value).toBe("첫 지시");
  });

  it("re-spells a pulled steer at the head of the draft", () => {
    const pending = [
      heldRequest("a", "고쳐줘", { mode: "steer", label: "Steer" }),
    ];
    const event = keyEvent("ArrowDown", { altKey: true });
    const target = consumeQueuePullKey(event, { pending, releasing: false });
    const pulled = pullQueuedRequest(pending, target!);
    expect(
      restorePulledDraft(
        { value: "이미 치던 글", images: [], files: [] },
        pulled!.entry,
      ).value,
    ).toBe("/steer 이미 치던 글\n고쳐줘");
  });

  it("keeps the native Option+Arrow caret movement over an empty queue", () => {
    const event = keyEvent("ArrowUp", { altKey: true });
    expect(
      consumeQueuePullKey(event, { pending: [], releasing: false }),
    ).toBeUndefined();
    expect(event.defaultPrevented).toBe(false);

    // Option+Shift+Arrow selects text, so that chord stays native too.
    const selection = keyEvent("ArrowUp", { altKey: true, shiftKey: true });
    expect(
      consumeQueuePullKey(selection, {
        pending: [heldRequest("a", "첫 지시")],
        releasing: false,
      }),
    ).toBeUndefined();
    expect(selection.defaultPrevented).toBe(false);
  });

  it("pulls nothing while a release is in flight", () => {
    const event = keyEvent("ArrowDown", { altKey: true });
    expect(
      consumeQueuePullKey(event, {
        pending: [heldRequest("a", "첫 지시")],
        releasing: true,
      }),
    ).toBeUndefined();
    expect(event.defaultPrevented).toBe(false);
  });

  it("discards only the entry a chip's × addresses", () => {
    const pulls: string[] = [];
    const discards: string[] = [];
    const chip = QueueChip({
      entry: heldRequest("b", "둘째 지시"),
      onPull: () => pulls.push("pull"),
      onDiscard: () => discards.push("discard"),
    }) as unknown as TestElement;
    const [pullButton, discardButton] = childButtons(chip);
    expect(pullButton?.props.type).toBe("button");
    expect(discardButton?.props.type).toBe("button");
    expect(discardButton?.props["aria-label"]).toBe("대기 항목 버리기");

    discardButton?.props.onClick!();
    expect(discards).toEqual(["discard"]);
    expect(pulls).toEqual([]);

    // The real component renders the affordances the smoke tests and the user
    // actually find: the chip class it always had, its text, and the labelled ×.
    const markup = renderToStaticMarkup(
      createElement(QueueChip, {
        entry: heldRequest("b", "둘째 지시"),
        onPull: () => undefined,
        onDiscard: () => undefined,
      }),
    );
    expect(markup).toContain(
      'class="composer-queue-item composer-queue-item--followUp"',
    );
    expect(markup).toContain("둘째 지시");
    expect(markup).toContain('aria-label="대기 항목 버리기"');

    // And the list op the composer runs for that button keeps everything else.
    expect(
      withoutReleasedRequest(
        [heldRequest("a", "첫 지시"), heldRequest("b", "둘째 지시")],
        "b",
      ).map((entry) => entry.id),
    ).toEqual(["a"]);
  });

  it("labels rejected queued sends as requiring review instead of promising automatic execution", () => {
    const markup = renderToStaticMarkup(createElement(QueueChip, {
      entry: { ...heldRequest("failed", "monitor the PR"), blocked: true },
      onPull: () => undefined,
      onDiscard: () => undefined,
    }));
    expect(markup).toContain("composer-queue-item--blocked");
    expect(markup).toContain("확인 필요");
    expect(markup).toContain("이미 처리됐을 수 있습니다");
    expect(markup).toContain("monitor the PR");
    expect(markup).toContain('aria-label="대기 항목 버리기"');
  });

  it("pulls the entry a chip's body stands for", () => {
    const pulls: string[] = [];
    const chip = QueueChip({
      entry: heldRequest("b", "둘째 지시"),
      onPull: () => pulls.push("pull"),
      onDiscard: () => pulls.push("discard"),
    }) as unknown as TestElement;
    const [pullButton] = childButtons(chip);
    pullButton?.props.onClick!();
    expect(pulls).toEqual(["pull"]);
  });
});

describe("stop queue ownership", () => {
  it("discards held work only after cancellation resolves", async () => {
    let resolveCancel!: () => void;
    const cancel = vi.fn(() => new Promise<void>((resolve) => { resolveCancel = resolve; }));
    const discard = vi.fn();
    const stopping = cancelBeforeQueueDiscard(cancel, discard);
    expect(cancel).toHaveBeenCalledOnce();
    expect(discard).not.toHaveBeenCalled();
    resolveCancel();
    await stopping;
    expect(discard).toHaveBeenCalledOnce();
  });

  it("preserves held work when cancellation fails", async () => {
    const failure = new Error("cancel refused");
    const discard = vi.fn();
    await expect(cancelBeforeQueueDiscard(async () => { throw failure; }, discard))
      .rejects.toBe(failure);
    expect(discard).not.toHaveBeenCalled();
  });
});

describe("rejected submission recovery", () => {
  it("parks a late failure with its originating session", () => {
    const drafts = new Map<string, { value: string; images: ImageAttachment[]; files: FileAttachment[] }>();
    const input: MessageInput = {
      text: "review this",
      images: [{ id: "image-1", name: "proof.png", mimeType: "image/png", data: "aW1hZ2U=" }],
      files: [],
    };
    expect(restoreRejectedDraft("session-b", drafts, "session-a", input)).toBeNull();
    expect(drafts.get("session-a")).toEqual({
      value: input.text,
      images: input.images,
      files: input.files,
    });
    expect(drafts.has("session-b")).toBe(false);
  });

  it("merges a late failure with a draft written after leaving the session", () => {
    const drafts = new Map<string, { value: string; images: ImageAttachment[]; files: FileAttachment[] }>();
    drafts.set("session-a", {
      value: "new draft",
      images: [{ id: "image-new", name: "new.png", mimeType: "image/png", data: "bmV3" }],
      files: [{ id: "file-new", name: "notes.txt", mimeType: "text/plain", size: 5, token: "b".repeat(43) }],
    });
    const input: MessageInput = {
      text: "review this",
      images: [{ id: "image-1", name: "proof.png", mimeType: "image/png", data: "aW1hZ2U=" }],
      files: [],
    };
    expect(restoreRejectedDraft("session-b", drafts, "session-a", input)).toBeNull();
    expect(drafts.get("session-a")).toEqual({
      value: "review this\nnew draft",
      images: [input.images[0], { id: "image-new", name: "new.png", mimeType: "image/png", data: "bmV3" }],
      files: [{ id: "file-new", name: "notes.txt", mimeType: "text/plain", size: 5, token: "b".repeat(43) }],
    });
    expect(drafts.has("session-b")).toBe(false);
  });

  it("delivers a late failure to a composer that mounts afterwards", () => {
    const session = "session-remount-recovery";
    const input: MessageInput = {
      text: "review this",
      images: [{ id: "image-1", name: "proof.png", mimeType: "image/png", data: "aW1hZ2U=" }],
      files: [],
    };
    // The old instance is gone before its send rejects.
    publishComposerDraftRecovery(session, input);
    let notifications = 0;
    const unsubscribe = subscribeComposerDraftRecovery(session, () => {
      notifications += 1;
    });
    expect(notifications).toBe(0);

    // The new instance already has its own draft. Mount applies the queued
    // recovery over that draft instead of replacing it.
    const current = {
      value: "new draft",
      images: [{ id: "image-new", name: "new.png", mimeType: "image/png", data: "bmV3" }],
      files: [],
    };
    const entries = composerDraftRecoveries(session);
    const merged = mergeRecoveredDraft(
      current,
      entries.map((entry) => entry.input),
    );
    expect(merged.value).toBe("review this\nnew draft");
    expect(merged.images.map((image) => image.name)).toEqual(["proof.png", "new.png"]);
    acknowledgeComposerDraftRecoveries(session, entries.at(-1)!.revision);
    expect(composerDraftRecoveries(session)).toEqual([]);
    unsubscribe();
  });

  it("notifies the active instance and keeps the newest draft", () => {
    const session = "session-active-recovery";
    const seen: MessageInput[] = [];
    const unsubscribe = subscribeComposerDraftRecovery(session, () => {
      seen.push(...composerDraftRecoveries(session).map((entry) => entry.input));
    });
    const input: MessageInput = { text: "failed request", images: [], files: [] };
    publishComposerDraftRecovery(session, input);
    expect(seen).toEqual([input]);
    const merged = mergeRecoveredDraft(
      { value: "typed after remount", images: [], files: [] },
      seen,
    );
    expect(merged.value).toBe("failed request\ntyped after remount");
    const [entry] = composerDraftRecoveries(session);
    acknowledgeComposerDraftRecoveries(session, entry!.revision);
    expect(composerDraftRecoveries(session)).toEqual([]);
    unsubscribe();
  });

  it("returns rejected content for immediate restoration in its own session", () => {
    const input: MessageInput = { text: "inspect", images: [], files: [] };
    const drafts = new Map<string, { value: string; images: ImageAttachment[]; files: FileAttachment[] }>();
    expect(restoreRejectedDraft("session-a", drafts, "session-a", input)).toEqual({
      value: "inspect",
      images: [],
      files: [],
    });
    expect(drafts.size).toBe(0);
  });
});

describe("queue release handoff", () => {
  it("retries after a deferred flush outlives the composer", async () => {
    const session = "session-deferred-release";
    const retried: string[] = [];
    const unsubscribe = subscribeComposerReleaseRetry((sessionId) => {
      retried.push(sessionId);
    });
    let resolveFlush!: () => void;
    const flush = new Promise<void>((resolve) => {
      resolveFlush = resolve;
    });
    const release = (async () => {
      await flush;
      // The instance is unmounted by now; its finally hands the lock back.
      requestQueueReleaseRetry(session, [
        heldRequest("queued-1", "later"),
      ]);
    })();
    await Promise.resolve();
    expect(retried).toEqual([]);
    resolveFlush();
    await release;
    expect(retried).toEqual([session]);
    unsubscribe();
  });

  it("does not hand off work whose head is blocked", () => {
    const retried: string[] = [];
    const unsubscribe = subscribeComposerReleaseRetry((sessionId) => {
      retried.push(sessionId);
    });
    requestQueueReleaseRetry("session-blocked-release", [
      heldRequest("queued-1", "uncertain", { blocked: true }),
      heldRequest("queued-2", "later"),
    ]);
    expect(retried).toEqual([]);
    unsubscribe();
  });
});

describe("queue release ownership", () => {
  it("stops an unmounted composer from sending the remounted instance's queue", () => {
    // The old instance's refs still name the session after unmount; only the mount
    // flag separates it from the instance that restored the same queue.
    expect(canReleaseQueue(false, "session-a", "session-a")).toBe(false);
    expect(canReleaseQueue(true, "session-b", "session-a")).toBe(false);
    expect(canReleaseQueue(true, "session-a", "session-a")).toBe(true);
  });
});

describe("session-level queue release", () => {
  it("hands a session's queue over without a mounted composer", async () => {
    saveComposerQueue("session-unmounted", [
      heldRequest("queued-1", "first follow up"),
      heldRequest("queued-2", "second follow up"),
    ]);
    const sent: string[] = [];
    await releaseQueuedSession("session-unmounted", async (request) => {
      sent.push(request.text);
    });
    expect(sent).toEqual(["first follow up", "second follow up"]);
    expect(composerQueue("session-unmounted")).toEqual([]);
  });

  it("lets only one observer release the same queue", async () => {
    saveComposerQueue("session-once", [
      heldRequest("queued-1", "first"),
      heldRequest("queued-2", "second"),
    ]);
    const sent: string[] = [];
    let releaseFirst!: () => void;
    const send = vi.fn(async (request: PendingRequest) => {
      sent.push(request.text);
      if (request.id === "queued-1")
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    const first = releaseQueuedSession("session-once", send);
    const second = releaseQueuedSession("session-once", send);
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(sent).toEqual(["first", "second"]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not restore a queue the shell released while another session was shown", async () => {
    const request = heldRequest("queued-1", "only once");
    saveComposerQueue("session-a", [request]);
    // A -> B parks A in the shared snapshot, not in a component-local map.
    expect(parkComposerSession("session-a", [request], "session-b")).toEqual([]);
    await releaseQueuedSession("session-a", async () => undefined);
    // The shell released A while B was on screen.
    expect(composerQueue("session-a")).toEqual([]);
    // B -> A restores the authoritative queue, so the completed request stays gone.
    expect(parkComposerSession("session-b", [], "session-a")).toEqual([]);
  });

  it("keeps a failed request in the shared queue as blocked", async () => {
    saveComposerQueue("session-failed", [
      heldRequest("queued-1", "uncertain"),
      heldRequest("queued-2", "later"),
    ]);
    await releaseQueuedSession("session-failed", async () => {
      throw new Error("send uncertain");
    });
    expect(composerQueue("session-failed")).toEqual([
      expect.objectContaining({ id: "queued-1", blocked: true }),
      expect.objectContaining({ id: "queued-2" }),
    ]);
  });
});

describe("composer state across unmounts", () => {
  it("retains each session's draft, attachments, and held requests in its snapshot", () => {
    const snapshots = new Map<string, ComposerSnapshot>();
    const snapshot = {
      value: "finish later",
      images: [{ id: "image-1", name: "proof.png", mimeType: "image/png", data: "aW1hZ2U=" }],
      files: [],
      pendingQueue: [heldRequest("queued-1", "follow up")],
    };
    saveComposerSnapshot(snapshots, "session-a", snapshot);
    expect(snapshots.get("session-a")).toEqual(snapshot);
    expect(snapshots.get("session-b")).toBeUndefined();
  });
});
