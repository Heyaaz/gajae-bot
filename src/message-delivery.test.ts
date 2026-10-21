import { describe, expect, it } from "vitest";
import type { MessageInput, TranscriptItem } from "../shared/agent-contract";
import {
  MESSAGE_DELIVERY_IDLE_GRACE_MS,
  MESSAGE_DELIVERY_UNCONFIRMED_AFTER_MS,
  MessageDeliveryTracker,
  isTrackableMessageInput,
} from "./message-delivery";

const attachedIdle = {
  status: "idle" as const,
  attachment: "attached" as const,
  connection: "connected" as const,
};

const attachedRunning = {
  status: "running" as const,
  attachment: "attached" as const,
  connection: "connected" as const,
};

function input(text: string, overrides: Partial<MessageInput> = {}): MessageInput {
  return { text, images: [], files: [], ...overrides };
}

function user(id: string, content: string, extras: Partial<Extract<TranscriptItem, { kind: "message" }>> = {}): TranscriptItem {
  return {
    id,
    kind: "message",
    sessionId: "session-1",
    role: "user",
    content,
    createdAt: "10:00",
    ...extras,
  };
}

describe("message delivery tracker", () => {
  it("does not infer delivery or failure when the submission history was unavailable", () => {
    const tracker = new MessageDeliveryTracker();
    tracker.submit("session-1", input("repeat"), [], 0, attachedIdle, false);
    tracker.observeUserEvent("session-1", user("replayed-old", "repeat"), 1);
    tracker.observeTranscript("session-1", [], { kind: "latest", complete: true }, 2);
    tracker.advance(60_000);
    expect(tracker.snapshot("session-1")[0]?.state).toBe("pending");
    expect(tracker.nextDeadline()).toBeUndefined();
  });

  it("requires a paged absence check to include the submission boundary", () => {
    const tracker = new MessageDeliveryTracker();
    const fence = user("before-submit", "previous request");
    tracker.submit("session-1", input("lost"), [fence], 0, attachedIdle);
    expect(tracker.coversPendingAttempts("session-1", [user("newer", "unrelated")], true)).toBe(false);
    expect(tracker.coversPendingAttempts("session-1", [fence, user("newer", "unrelated")], true)).toBe(true);
    const empty = new MessageDeliveryTracker();
    empty.submit("session-1", input("first"), [], 0, attachedIdle);
    expect(empty.coversPendingAttempts("session-1", [], true)).toBe(false);
    expect(empty.coversPendingAttempts("session-1", [], false)).toBe(true);
  });

  it("shows a dropped request only after a fresh complete idle read and grace period", () => {
    const tracker = new MessageDeliveryTracker();
    const id = tracker.submit("session-1", input("lost request"), [], 1_000, attachedIdle);
    tracker.acceptSubmission(id, 1_000, tracker.submissionGeneration(id)!);

    tracker.observeTranscript("session-1", [], { kind: "other", complete: true }, 1_001);
    tracker.advance(1_000 + MESSAGE_DELIVERY_IDLE_GRACE_MS);
    expect(tracker.snapshot("session-1")[0]?.state).toBe("pending");
    expect(tracker.nextDeadline()).toBeUndefined();

    tracker.observeTranscript("session-1", [], { kind: "latest", complete: true }, 1_001);
    tracker.advance(1_000 + MESSAGE_DELIVERY_IDLE_GRACE_MS - 1);
    expect(tracker.snapshot("session-1")[0]).toMatchObject({ id, state: "pending" });

    tracker.advance(1_000 + MESSAGE_DELIVERY_IDLE_GRACE_MS);
    expect(tracker.snapshot("session-1")[0]).toMatchObject({ id, state: "failed" });
    expect(tracker.beginRetry(id)).toMatchObject({ input: input("lost request") });
  });

  it("keeps authoritative not-executed outcomes visible while the session keeps working", () => {
    const tracker = new MessageDeliveryTracker();
    const id = tracker.submit("session-1", input("rejected request"), [], 0, attachedRunning);
    const generation = tracker.submissionGeneration(id)!;
    tracker.markNotExecuted(id, "Prompt preflight cancelled", generation, 1);

    for (const [state, now] of [
      [{ ...attachedRunning, status: "running" as const }, 2],
      [{ ...attachedRunning, phase: "compacting" }, 3],
      [{ ...attachedRunning, connection: "disconnected" as const }, 4],
    ] as const) {
      tracker.observeSession("session-1", state, now);
      tracker.advance(now + 60_000);
      expect(tracker.snapshot("session-1")).toMatchObject([{
        id,
        state: "failed",
        failure: { kind: "not_executed", detail: "Prompt preflight cancelled" },
      }]);
    }
    expect(tracker.beginRetry(id)?.input).toEqual(input("rejected request"));
  });

  it("ignores a late old send response after a manual retry has locked the attempt", () => {
    const tracker = new MessageDeliveryTracker();
    const id = tracker.submit("session-1", input("retry me"), [], 0, attachedRunning);
    const originalGeneration = tracker.submissionGeneration(id)!;
    tracker.markNotExecuted(id, "first attempt rejected", originalGeneration, 1);
    expect(tracker.beginRetry(id)).toBeDefined();
    const retryGeneration = tracker.submissionGeneration(id)!;

    tracker.acceptSubmission(id, 2, originalGeneration);
    tracker.markNotExecuted(id, "late old rejection", originalGeneration, 3);

    expect(retryGeneration).toBeGreaterThan(originalGeneration);
    expect(tracker.snapshot("session-1")).toMatchObject([{
      id,
      state: "pending",
      retrying: true,
      submitting: true,
    }]);
    expect(tracker.snapshot("session-1")[0]?.failure).toBeUndefined();
  });

  it("shows an honest unconfirmed retry state while active instead of claiming failure", () => {
    const tracker = new MessageDeliveryTracker();
    const id = tracker.submit("session-1", input("still working"), [], 0, attachedRunning);
    tracker.acceptSubmission(id, 1, tracker.submissionGeneration(id)!);
    tracker.observeTranscript("session-1", [], { kind: "latest", complete: true, requestedAt: 2 }, 3);

    expect(tracker.needsLatestRead("session-1")).toBe(true);
    expect(tracker.nextDeadline()).toBe(MESSAGE_DELIVERY_UNCONFIRMED_AFTER_MS);
    for (let now = 5_000; now < MESSAGE_DELIVERY_UNCONFIRMED_AFTER_MS; now += 5_000) {
      tracker.observeSession("session-1", attachedRunning, now);
      expect(tracker.nextDeadline()).toBe(MESSAGE_DELIVERY_UNCONFIRMED_AFTER_MS);
    }
    tracker.advance(MESSAGE_DELIVERY_UNCONFIRMED_AFTER_MS - 1);
    expect(tracker.snapshot("session-1")[0]?.state).toBe("pending");
    tracker.advance(MESSAGE_DELIVERY_UNCONFIRMED_AFTER_MS);
    expect(tracker.snapshot("session-1")).toMatchObject([{
      id,
      state: "unconfirmed",
      submitting: false,
    }]);
    expect(tracker.snapshot("session-1")[0]?.state).not.toBe("failed");
    expect(tracker.beginRetry(id)?.input).toEqual(input("still working"));
  });

  it("requires a latest read requested after submission before showing an active outcome as unknown", () => {
    const tracker = new MessageDeliveryTracker();
    const id = tracker.submit("session-1", input("fresh read required"), [], 10_000, attachedRunning);
    tracker.acceptSubmission(id, 10_001, tracker.submissionGeneration(id)!);
    tracker.observeTranscript("session-1", [], { kind: "latest", complete: true, requestedAt: 9_999 }, 10_002);

    tracker.advance(10_000 + MESSAGE_DELIVERY_UNCONFIRMED_AFTER_MS);

    expect(tracker.snapshot("session-1")).toMatchObject([{ id, state: "pending" }]);
  });

  it("does not infer absence while compacting or from an unknown initial baseline", () => {
    const compacting = new MessageDeliveryTracker();
    const id = compacting.submit("session-1", input("compacting"), [], 0, attachedRunning);
    compacting.observeTranscript("session-1", [], { kind: "latest", complete: true, requestedAt: 1 }, 2);
    compacting.observeSession("session-1", { ...attachedRunning, phase: "compacting" }, 3);
    compacting.advance(MESSAGE_DELIVERY_UNCONFIRMED_AFTER_MS);
    expect(compacting.needsLatestRead("session-1")).toBe(false);
    expect(compacting.snapshot("session-1")).toMatchObject([{ id, state: "pending" }]);

    const unknownBaseline = new MessageDeliveryTracker();
    unknownBaseline.submit("session-1", input("unknown baseline"), [], 0, attachedRunning, false);
    unknownBaseline.observeTranscript("session-1", [], { kind: "latest", complete: true }, 1);
    unknownBaseline.advance(MESSAGE_DELIVERY_UNCONFIRMED_AFTER_MS * 2);
    expect(unknownBaseline.needsLatestRead("session-1")).toBe(false);
    expect(unknownBaseline.snapshot("session-1")[0]?.state).toBe("pending");
  });

  it("clears a failed request when matching durable evidence arrives later", () => {
    const tracker = new MessageDeliveryTracker();
    const id = tracker.submit("session-1", input("eventually persisted"), [], 0, attachedRunning);
    tracker.markNotExecuted(id, "request rejected", tracker.submissionGeneration(id)!, 1);

    tracker.observeUserEvent("session-1", user("durable-after-reject", "eventually persisted"), 2);

    expect(tracker.snapshot("session-1")).toEqual([]);
  });

  it("skips permanent failures but keeps the submission fence for unconfirmed snapshot reconciliation", () => {
    const fence = user("old-fence", "previous request");
    const failed = new MessageDeliveryTracker();
    const failedId = failed.submit("session-1", input("rejected"), [fence], 0, attachedRunning);
    failed.markNotExecuted(failedId, "preflight cancelled", failed.submissionGeneration(failedId)!, 1);
    expect(failed.coversPendingAttempts("session-1", [user("tail", "newer")], true)).toBe(true);

    const uncertain = new MessageDeliveryTracker();
    const uncertainId = uncertain.submit("session-1", input("unknown"), [fence], 0, attachedRunning);
    uncertain.acceptSubmission(uncertainId, 1, uncertain.submissionGeneration(uncertainId)!);
    uncertain.observeTranscript("session-1", [fence], { kind: "latest", complete: true, requestedAt: 2 }, 3);
    uncertain.advance(MESSAGE_DELIVERY_UNCONFIRMED_AFTER_MS);
    expect(uncertain.snapshot("session-1")[0]?.state).toBe("unconfirmed");
    expect(uncertain.coversPendingAttempts("session-1", [user("tail", "newer")], true)).toBe(false);
    expect(uncertain.coversPendingAttempts("session-1", [fence, user("tail", "newer")], true)).toBe(true);
  });

  it("reconciles an unconfirmed attempt against a later durable snapshot if its live event was missed", () => {
    const fence = user("old-fence", "previous request");
    const tracker = new MessageDeliveryTracker();
    const id = tracker.submit("session-1", input("persisted during work"), [fence], 0, attachedRunning);
    tracker.acceptSubmission(id, 1, tracker.submissionGeneration(id)!);
    tracker.observeTranscript("session-1", [fence], { kind: "latest", complete: true, requestedAt: 2 }, 3);
    tracker.advance(MESSAGE_DELIVERY_UNCONFIRMED_AFTER_MS);
    expect(tracker.snapshot("session-1")[0]?.state).toBe("unconfirmed");
    expect(tracker.needsLatestRead("session-1")).toBe(true);

    tracker.observeTranscript(
      "session-1",
      [fence, user("missed-live-event", "persisted during work")],
      { kind: "latest", complete: true, requestedAt: MESSAGE_DELIVERY_UNCONFIRMED_AFTER_MS + 1 },
      MESSAGE_DELIVERY_UNCONFIRMED_AFTER_MS + 2,
    );

    expect(tracker.snapshot("session-1")).toEqual([]);
  });

  it("confirms normal sends, steers, and queued follow-ups only from durable user rows", () => {
    for (const [request, content] of [
      ["do the work", "do the work"],
      ["/steer change direction", "change direction"],
      ["/queue after this", "after this"],
    ]) {
      const tracker = new MessageDeliveryTracker();
      const id = tracker.submit("session-1", input(request), [], 0, attachedIdle);
      tracker.observeUserEvent("session-1", user(`durable-${id}`, content), 1);
      expect(tracker.snapshot("session-1")).toEqual([]);
    }
  });

  it("consumes repeated identical requests one occurrence at a time across reconciliations", () => {
    const tracker = new MessageDeliveryTracker();
    tracker.submit("session-1", input("repeat"), [], 0, attachedIdle);
    const second = tracker.submit("session-1", input("repeat"), [], 1, attachedIdle);
    const firstRow = user("durable-1", "repeat");

    tracker.observeTranscript("session-1", [firstRow], { kind: "latest", complete: true }, 2);
    expect(tracker.snapshot("session-1")).toHaveLength(1);
    expect(tracker.snapshot("session-1")[0]).toMatchObject({ id: second, state: "pending" });
    tracker.observeTranscript("session-1", [firstRow], { kind: "latest", complete: true }, 3);
    tracker.advance(4);
    expect(tracker.snapshot("session-1")).toHaveLength(1);

    tracker.observeTranscript("session-1", [firstRow, user("durable-2", "repeat")], { kind: "latest", complete: true }, 5);
    expect(tracker.snapshot("session-1")).toEqual([]);

    const inlineImages = new MessageDeliveryTracker();
    inlineImages.submit("session-1", input("inspect", {
      images: [{ id: "image-inline", name: "source.png", mimeType: "image/png", data: "AQID" }],
    }), [], 0, attachedIdle);
    inlineImages.observeUserEvent("session-1", user("durable-inline", "inspect", {
      images: [{ id: "image-inline", name: "source.png", mimeType: "image/png", data: "AQID" }],
    }), 1);
    expect(inlineImages.snapshot("session-1")).toEqual([]);
  });

  it("does not treat optimistic local echoes or a historical request as delivery proof", () => {
    const historical = user("durable-old", "same text");
    const tracker = new MessageDeliveryTracker();
    const id = tracker.submit("session-1", input("same text"), [historical], 10, attachedIdle);

    tracker.observeUserEvent("session-1", user("local-prompt-2", "same text"), 11);
    tracker.observeTranscript(
      "session-1",
      [historical, user("local-prompt-renderer-2", "same text")],
      { kind: "latest", complete: true },
      12,
    );
    tracker.advance(20);
    expect(tracker.snapshot("session-1")[0]).toMatchObject({ id, state: "pending" });

    tracker.observeUserEvent("session-1", user("durable-new", "same text"), 21);
    expect(tracker.snapshot("session-1")).toEqual([]);
  });

  it("restarts idle grace and requires fresh latest evidence after running or an unsafe state", () => {
    const tracker = new MessageDeliveryTracker();
    const id = tracker.submit("session-1", input("wait"), [], 0, attachedIdle);
    tracker.observeTranscript("session-1", [], { kind: "latest", complete: true }, 1);
    tracker.observeSession("session-1", { ...attachedIdle, status: "running" }, 9_000);
    tracker.observeSession("session-1", attachedIdle, 10_000);
    tracker.advance(19_000);
    expect(tracker.snapshot("session-1")[0]).toMatchObject({ id, state: "pending" });

    tracker.observeTranscript("session-1", [], { kind: "latest", complete: true }, 19_001);
    tracker.advance(10_000 + MESSAGE_DELIVERY_IDLE_GRACE_MS - 1);
    expect(tracker.snapshot("session-1")[0]?.state).toBe("pending");
    tracker.advance(10_000 + MESSAGE_DELIVERY_IDLE_GRACE_MS);
    expect(tracker.snapshot("session-1")[0]?.state).toBe("failed");

    tracker.observeSession("session-1", { ...attachedIdle, phase: "compacting" }, 31_000);
    expect(tracker.snapshot("session-1")[0]?.state).toBe("pending");
    tracker.observeSession("session-1", { ...attachedIdle, attachment: "recovering" }, 32_000);
    tracker.advance(60_000);
    expect(tracker.snapshot("session-1")[0]?.state).toBe("pending");
  });

  it("matches serialized file/image attachments and retries a copied original input", () => {
    const original = input("inspect these", {
      images: [{ id: "image-1", name: "screen.png", mimeType: "image/png", data: "AQID" }],
      files: [{ id: "file-1", name: "report.pdf", mimeType: "application/pdf", size: 4, token: "token-1" }],
    });
    const tracker = new MessageDeliveryTracker();
    tracker.submit("session-1", original, [], 0, attachedIdle);
    original.text = "changed after submit";
    original.images[0]!.data = "changed";

    tracker.observeUserEvent(
      "session-1",
      user("durable-attached", [
        "inspect these",
        '<local-files>\n- "report.pdf"\n</local-files>',
        '<local-images>\n- "screen.png"\n</local-images>',
      ].join("\n\n"), {
        images: [{ id: "image-1", name: "screen.png", mimeType: "image/png", data: "AQID" }],
      }),
      1,
    );
    expect(tracker.snapshot("session-1")).toEqual([]);

    const another = new MessageDeliveryTracker();
    const failedId = another.submit("session-1", input("retry", {
      images: [{ id: "image-2", name: "x.png", mimeType: "image/png", data: "AQID" }],
      files: [{ id: "file-2", name: "x.txt", mimeType: "text/plain", size: 3, token: "token-2" }],
    }), [], 0, attachedIdle);
    another.observeTranscript("session-1", [], { kind: "latest", complete: true }, 1);
    another.advance(MESSAGE_DELIVERY_IDLE_GRACE_MS);
    const retry = another.beginRetry(failedId);
    expect(retry?.input).toMatchObject({
      text: "retry",
      images: [{ name: "x.png", data: "AQID" }],
      files: [{ name: "x.txt", token: "token-2" }],
    });
  });

  it("does not track SDK control commands as prompts", () => {
    expect(isTrackableMessageInput(input("/steer do it"))).toBe(true);
    expect(isTrackableMessageInput(input("/queue do it"))).toBe(true);
    expect(isTrackableMessageInput(input("/compact"))).toBe(false);
    expect(isTrackableMessageInput(input("/fast on"))).toBe(false);
    expect(isTrackableMessageInput(input("/context"), [{ name: "context" }])).toBe(false);
    expect(isTrackableMessageInput(input("ordinary prompt"))).toBe(true);
  });
});
