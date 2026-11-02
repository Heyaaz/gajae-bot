import { beforeEach, describe, expect, it, vi } from "vitest";

const upload = vi.hoisted(() => ({
  read: vi.fn(),
  prompt: vi.fn(),
}));

vi.mock("./gjc-sdk-image-prompt.js", async (load) => {
  const actual = await load<typeof import("./gjc-sdk-image-prompt.js")>();
  return { ...actual, readUploadImages: upload.read, promptWithImages: upload.prompt };
});

const { GjcSdkController } = await import("./gjc-sdk-controller.js");
const { ImagePromptNotSentError } = await import("./gjc-sdk-image-prompt.js");

const IMAGE = { mimeType: "image/png" as const, bytes: Buffer.from("png") };
const input = {
  text: "what is on screen?",
  images: [{ id: "img-1", name: "shot.png", mimeType: "image/png", data: "", nativePath: "/attachments/shot.png" }],
  files: [],
};

function harness(operations: string[]) {
  const controller = new GjcSdkController({ workspace: "/repo", emit: vi.fn() } as never);
  const cli = {
    executable: "gjc",
    env: {},
    send: vi.fn(async () => ({ operationRef: "fallback-ref", status: "accepted" })),
  };
  const internals = controller as any;
  internals.cli = cli;
  internals.startup = Promise.resolve();
  internals.generation = 1;
  internals.sessions.set("s1", {
    id: "s1", title: "Test", subtitle: "repo", workspace: "/repo", runtime: "gjc", status: "idle",
    updatedAt: "now", pinned: false, unread: false, accent: "#ff8a34", ownership: "gajae", attachment: "attached",
  });
  internals.sessionCwds.set("s1", "/repo");
  internals.transcripts.set("s1", []);
  internals.messageKeys.set("s1", new Map());
  internals.attachedSessions.add("s1");
  internals.sessionSdkOperations.set("s1", new Set(operations));
  internals.awaitPromptSettlement = vi.fn(async () => undefined);
  return { controller, cli, internals };
}

beforeEach(() => {
  upload.read.mockReset().mockResolvedValue([IMAGE]);
  upload.prompt.mockReset().mockResolvedValue({ turnId: "turn-1" });
});

describe("sending a message with images", () => {
  it("uploads them to a GJC that stages images, without the read-tool paths block", async () => {
    const { controller, cli, internals } = harness(["turn.prompt", "turn.image.begin"]);
    await controller.sendMessage("s1", input);
    expect(cli.send).not.toHaveBeenCalled();
    const [, sessionId, prompt] = upload.prompt.mock.calls[0]!;
    expect(sessionId).toBe("s1");
    expect(prompt).toMatchObject({ text: "what is on screen?", images: [IMAGE] });
    expect(internals.awaitPromptSettlement).toHaveBeenCalledWith("s1", prompt.clientRef, expect.any(Function));
    expect(internals.echoedPromptTexts.get("s1")).toEqual(["what is on screen?"]);
    controller.dispose();
  });

  it("sends the paths the old way when GJC ran nothing, and expects that text echoed", async () => {
    upload.prompt.mockRejectedValue(new ImagePromptNotSentError("Too many concurrent image uploads.", "busy"));
    const { controller, cli, internals } = harness(["turn.prompt", "turn.image.begin"]);
    await controller.sendMessage("s1", input);
    const [, text] = cli.send.mock.calls[0] as unknown as [string, string];
    expect(text).toContain("<local-images>");
    expect(internals.echoedPromptTexts.get("s1")?.[0]).toContain("<local-images>");
    expect(internals.awaitPromptSettlement).toHaveBeenCalledWith("s1", "fallback-ref", expect.any(Function));
    controller.dispose();
  });

  it("keeps the paths block for a GJC without image uploads", async () => {
    const { controller, cli } = harness(["turn.prompt"]);
    await controller.sendMessage("s1", input);
    expect(upload.prompt).not.toHaveBeenCalled();
    expect((cli.send.mock.calls[0] as unknown as [string, string])[1]).toContain("<local-images>");
    controller.dispose();
  });
});
