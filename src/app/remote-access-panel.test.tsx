import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RemoteAccessState } from "../../shared/remote-protocol";
import {
  RemoteAccessPanelView,
  writeClipboard,
  type RemoteAccessPanelActions,
  type RemoteAccessPanelViewProps,
} from "./remote-access-panel";

/**
 * The panel renders from its props, which is what lets these tests cover the states
 * a user actually sees — loading, disabled, enabled, error, paired — without an
 * Electron bridge or a DOM.
 */

function noop(): void {}

const actions: RemoteAccessPanelActions = {
  toggle: noop,
  refresh: noop,
  editPort: noop,
  applyPort: noop,
  issueCode: noop,
  clearCode: noop,
  setDevicePermission: noop,
  revokeDevice: noop,
};

const ADDRESS = "https://mac.tailnet-abcd.ts.net";

function remoteState(overrides: Partial<RemoteAccessState> = {}): RemoteAccessState {
  return {
    enabled: false,
    running: false,
    port: 8791,
    tailscale: {
      installed: true,
      connected: true,
      serveEnabled: true,
      serveOrigin: ADDRESS,
      dnsName: "mac.tailnet-abcd.ts.net",
      version: "1.80.0",
    },
    devices: [],
    pairing: null,
    ...overrides,
  };
}

function render(overrides: Partial<RemoteAccessPanelViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(RemoteAccessPanelView, {
      state: null,
      busy: null,
      error: "",
      qr: "",
      portDraft: "8791",
      actions,
      ...overrides,
    }),
  );
}

/** The opening tag of the button whose label is `label`, or an empty string. */
function buttonElement(markup: string, label: string): string {
  const pattern = new RegExp(`<button[^>]*>(?:(?!</button>).)*?${label}`, "su");
  return markup.match(pattern)?.[0] ?? "";
}

describe("RemoteAccessPanelView states", () => {
  it("reports loading on the switch instead of inventing an off state", () => {
    const markup = render();
    const toggle = buttonElement(markup, "불러오는 중");
    expect(markup).toContain('role="status"');
    expect(markup).toContain("원격 접속 상태를 불러오는 중입니다");
    expect(toggle).toContain('role="switch"');
    expect(toggle).toContain('aria-checked="false"');
    expect(toggle).toContain("disabled");
    // Loading is not the same as "no devices are paired yet".
    expect(markup).not.toContain("연결된 기기가 없습니다");
    // No address has arrived yet, so none is invented for the user to open.
    expect(markup).not.toContain("https://");
  });

  it("shows an off, disabled switch and the empty device list when remote access is off", () => {
    const markup = render({ state: remoteState() });
    const toggle = buttonElement(markup, "꺼짐");
    expect(toggle).toContain('role="switch"');
    expect(toggle).toContain('aria-labelledby="remote-enabled-heading"');
    expect(toggle).toContain('aria-checked="false"');
    expect(markup).toContain("연결된 기기가 없습니다");
    expect(markup).toContain("아직 접속 주소가 없습니다");
    // Codes cannot be minted while the host is off.
    expect(buttonElement(markup, "보기 전용 코드")).toContain("disabled");
    expect(buttonElement(markup, "조작 가능 코드")).toContain("disabled");
  });

  it("marks the switch as on and keeps the address to one field plus its link", () => {
    const markup = render({
      state: remoteState({
        enabled: true,
        running: true,
        baseUrl: `${ADDRESS}/`,
      }),
    });
    const toggle = buttonElement(markup, "켜짐");
    expect(toggle).toContain('aria-checked="true"');
    expect(toggle).not.toContain("disabled");
    // The value and the open link, and nothing repeating it in a paragraph.
    expect(markup.split(ADDRESS).length - 1).toBe(2);
    expect(markup).toContain('href="https://mac.tailnet-abcd.ts.net"');
    expect(markup).toContain('rel="noreferrer"');
    expect(markup).toContain('aria-label="주소 복사"');
    expect(markup).toContain('aria-label="주소 열기"');
    expect(markup).toContain('aria-label="상태 다시 확인"');
    expect(markup).toContain("같은 Tailscale 계정");
    expect(markup).toContain("다른 계정·기기");
    expect(buttonElement(markup, "보기 전용 코드")).not.toContain("disabled");
  });

  it("surfaces a failed state read as an alert and drops the loading note", () => {
    const markup = render({ error: "Tailscale 상태를 확인하지 못했습니다." });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Tailscale 상태를 확인하지 못했습니다.");
    expect(markup).not.toContain("원격 접속 상태를 불러오는 중입니다");
  });

  it("surfaces the host's own error without hiding the panel", () => {
    const markup = render({
      state: remoteState({
        enabled: true,
        error: "원격 웹 클라이언트가 아직 빌드되지 않았습니다.",
      }),
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("원격 웹 클라이언트가 아직 빌드되지 않았습니다.");
    expect(markup).toContain("고급 설정");
  });

  it("warns when access is on but no server is listening", () => {
    const markup = render({ state: remoteState({ enabled: true, running: false }) });
    expect(markup).toContain("원격 접속이 켜져 있지만 서버가 실행되지 않았습니다.");
    expect(markup).toContain('role="status"');
  });

  it("renders a live pairing code with its permission, expiry, and QR", () => {
    const markup = render({
      state: remoteState({
        enabled: true,
        running: true,
        baseUrl: `${ADDRESS}/`,
        pairing: {
          code: "ABCD2345",
          permission: "control",
          // Mid-minute on purpose: the label is a floor, so the assertion cannot
          // flip between "3분" and "4분" when the render lands on a boundary.
          expiresAt: new Date(Date.now() + 3 * 60_000 + 30_000).toISOString(),
        },
        devices: [
          {
            id: "device-1",
            name: "iPhone",
            permission: "view",
            createdAt: "2026-10-15T01:00:00.000Z",
            clientAddress: "100.64.0.9",
          },
          {
            id: "device-2",
            name: "iPad",
            permission: "control",
            createdAt: "2026-10-15T01:00:00.000Z",
            lastSeenAt: "2026-10-15T02:00:00.000Z",
          },
        ],
      }),
      qr: '<svg data-qr="1"></svg>',
    });
    expect(markup).toContain("ABCD2345");
    expect(markup).toContain("조작 가능 · 3분 남음");
    expect(markup).toContain('aria-label="연결 코드 복사"');
    expect(markup).toContain('aria-label="연결 코드 취소"');
    expect(markup).toContain('role="img"');
    expect(markup).toContain('data-qr="1"');
    // Both devices are listed with a labelled permission control and a revoke.
    expect(markup).toContain('aria-label="iPhone 권한"');
    expect(markup).toContain('aria-label="iPhone 접근 해제"');
    expect(markup).toContain('aria-label="iPad 권한"');
    expect(markup).toContain('aria-label="iPad 접근 해제"');
    expect(markup).toContain("아직 사용되지 않음");
    expect(markup).toContain("100.64.0.9");
    expect(markup).not.toContain("연결된 기기가 없습니다");
  });

  it("shows an expired code as expired and withholds its QR", () => {
    const markup = render({
      state: remoteState({
        enabled: true,
        running: true,
        baseUrl: `${ADDRESS}/`,
        pairing: {
          code: "ABCD2345",
          permission: "view",
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        },
      }),
      qr: '<svg data-qr="1"></svg>',
    });
    expect(markup).toContain("만료됨");
    expect(markup).toContain("is-expired");
    expect(markup).toContain("코드가 만료되었습니다");
    expect(markup).not.toContain('data-qr="1"');
    expect(markup).not.toContain('role="img"');
  });

  it("keeps the loopback port reachable as an advanced setting", () => {
    const markup = render({ state: remoteState({ port: 8791 }) });
    expect(markup).toContain("고급 설정");
    expect(markup).toContain("loopback 포트 8791");
    expect(markup).toContain('aria-label="원격 접속 포트"');
    // Unchanged draft: applying it would be a no-op.
    expect(buttonElement(markup, "적용")).toContain('disabled=""');
  });
});

describe("writeClipboard", () => {
  it("refuses when the browser has no clipboard instead of faking a copy", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    try {
      await expect(writeClipboard("ABCD2345")).rejects.toThrow(
        "클립보드를 사용할 수 없습니다",
      );
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it("writes through the clipboard when it is available", async () => {
    const written: string[] = [];
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          written.push(text);
        },
      },
      configurable: true,
    });
    try {
      await writeClipboard("ABCD2345");
      expect(written).toEqual(["ABCD2345"]);
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it("reports a rejected write as a failure", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async () => Promise.reject(new Error("denied")) },
      configurable: true,
    });
    try {
      await expect(writeClipboard("ABCD2345")).rejects.toThrow(
        "복사하지 못했습니다",
      );
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});
