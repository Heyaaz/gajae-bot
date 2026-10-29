import { Camera, CornerDownLeft, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type {
  QuickInputCapture,
  QuickInputDesktopBridge,
} from "../../shared/quick-input";
import { imeOwnsKey } from "../composer-utils";
import { t } from "../i18n";
import { humanErrorMessage } from "./format";
import { projectNameOf } from "./project-model";
import "./quick-input.css";

type Notice =
  | { kind: "none" }
  | { kind: "permission" }
  | { kind: "error"; message: string };

const MAX_CAPTURES = 6;

/**
 * The window the global shortcut opens over another app.
 *
 * It only collects: Enter hands the text, the project and the screenshots to the
 * main window's new-session dialog, and nothing is sent until the user confirms
 * there and presses send in the new session.
 */
export function QuickInput({ bridge }: { bridge: QuickInputDesktopBridge }) {
  const [projects, setProjects] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [prompt, setPrompt] = useState("");
  const [captures, setCaptures] = useState<QuickInputCapture[]>([]);
  const [notice, setNotice] = useState<Notice>({ kind: "none" });
  const [busy, setBusy] = useState<"capturing" | "submitting" | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    const refresh = () => {
      textareaRef.current?.focus();
      bridge.state().then(
        (state) => {
          setProjects(state.projects);
          setWorkspace((current) =>
            state.projects.includes(current) ? current : (state.projects[0] ?? ""),
          );
        },
        (error: unknown) =>
          setNotice({ kind: "error", message: humanErrorMessage(error) }),
      );
    };
    refresh();
    return bridge.onShown(refresh);
  }, [bridge]);

  async function capture(): Promise<void> {
    if (busy || captures.length >= MAX_CAPTURES) return;
    setBusy("capturing");
    setNotice({ kind: "none" });
    try {
      const result = await bridge.capture();
      if (result.outcome === "captured")
        setCaptures((current) => [...current, result.capture]);
      else if (result.outcome === "permission-denied")
        setNotice({ kind: "permission" });
      else if (result.outcome === "failed")
        setNotice({ kind: "error", message: result.message });
    } catch (error) {
      setNotice({ kind: "error", message: humanErrorMessage(error) });
    } finally {
      setBusy(null);
      textareaRef.current?.focus();
    }
  }

  async function submit(): Promise<void> {
    if (busy || !workspace || (!prompt.trim() && captures.length === 0)) return;
    setBusy("submitting");
    setNotice({ kind: "none" });
    try {
      await bridge.submit({
        workspace,
        prompt: prompt.trim(),
        captureIds: captures.map((capture) => capture.id),
      });
      setPrompt("");
      setCaptures([]);
    } catch (error) {
      setNotice({ kind: "error", message: humanErrorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      void bridge.dismiss();
      return;
    }
    // Enter that confirms a Korean or Japanese composition is not a submit, and
    // Enter on the camera button or project select belongs to that control.
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      event.target === textareaRef.current &&
      !imeOwnsKey({
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.keyCode,
        composing: composingRef.current,
        compositionEndedAt: compositionEndedAtRef.current,
        now: performance.now(),
      })
    ) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <main
      className="quick-input"
      onKeyDown={handleKeyDown}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
        compositionEndedAtRef.current = performance.now();
      }}
    >
      <textarea
        ref={textareaRef}
        autoFocus
        aria-label={t("빠른 입력")}
        placeholder={t("무엇을 할까요? Enter를 누르면 새 세션 창이 열립니다.")}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      {captures.length > 0 && (
        <div className="quick-input-captures">
          {captures.map((capture) => (
            <span key={capture.id}>
              <img src={`data:image/png;base64,${capture.data}`} alt={capture.name} />
              <button
                type="button"
                aria-label={t("캡처 빼기")}
                onClick={() =>
                  setCaptures((current) =>
                    current.filter((item) => item.id !== capture.id),
                  )
                }
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {notice.kind === "permission" && (
        <p className="quick-input-notice" role="alert">
          <span>
            {t("화면을 캡처하려면 시스템 설정 > 개인정보 보호 및 보안 > 화면 기록에서 Gajae를 켜 주세요. 켠 뒤에는 Gajae를 다시 열어야 할 수 있습니다.")}
          </span>
          <button
            type="button"
            onClick={() => void bridge.openScreenRecordingSettings()}
          >
            {t("설정 열기")}
          </button>
        </p>
      )}
      {notice.kind === "error" && (
        <p className="quick-input-notice is-error" role="alert">
          <span>{notice.message}</span>
        </p>
      )}
      <footer>
        <select
          aria-label={t("프로젝트")}
          title={workspace}
          value={workspace}
          onChange={(event) => setWorkspace(event.target.value)}
        >
          {projects.length === 0 && <option value="">{t("프로젝트 없음")}</option>}
          {projects.map((project) => (
            <option key={project} value={project} title={project}>
              {projectNameOf(project)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="quick-input-icon"
          aria-label={t("화면 캡처 첨부")}
          title={t("화면 캡처 첨부")}
          disabled={busy !== null || captures.length >= MAX_CAPTURES}
          onClick={() => void capture()}
        >
          <Camera size={15} />
        </button>
        <small>{t("Enter 새 세션 · Shift+Enter 줄바꿈 · Esc 닫기")}</small>
        <button
          type="button"
          className="quick-input-icon is-primary"
          aria-label={t("새 세션으로 넘기기")}
          title={t("새 세션으로 넘기기")}
          disabled={
            busy !== null || !workspace || (!prompt.trim() && captures.length === 0)
          }
          onClick={() => void submit()}
        >
          <CornerDownLeft size={15} />
        </button>
      </footer>
    </main>
  );
}
