import type { ArtifactContent } from "../../shared/agent-contract";
import type { ToolActivity } from "../backend/types";
import { compactToolCommand, compactToolText } from "../composer-utils";
import { ChevronDown, ShieldCheck, TerminalSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { humanRuntimeText, toolDisplayName, toolStatusLabel } from "./format";
import { DiffView } from "./primitives";
import { t } from "../i18n";

export interface ToolCardProps {
  tool: ToolActivity;
  onResolve: (toolId: string, optionId: string) => void;
  onReadArtifact?: (artifactId: string) => Promise<ArtifactContent>;
  /**
   * Shown on a denied call when the current permission mode is what denied it,
   * rather than a user's own reject decision -- the app has no reverse channel to
   * ask an external controller for a decision (README, Permission handling), so a
   * session not in "always allow" mode has every call auto-denied by GJC itself.
   */
  autoDenyHint?: { message: string; onOpenSettings?: () => void };
  /**
   * Opens the session info panel to this call's own card, for a task/subagent
   * call -- that panel is where its step-by-step progress lives, not here.
   */
  onRevealInspector?: (toolId: string) => void;
}

const SUBAGENT_TOOL_NAME = /^(task|subagent)$/iu;

type ToolBodyField = "input" | "output";

interface ToolBodyState {
  key: string;
  status: "loading" | "loaded" | "error";
  text?: string;
  error?: string;
}

function toolBodyKey(
  tool: ToolActivity,
  artifactId: string | undefined,
): string | undefined {
  return artifactId
    ? JSON.stringify([tool.sessionId, tool.id, artifactId])
    : undefined;
}

export function ToolCard({
  tool,
  onResolve,
  onReadArtifact,
  autoDenyHint,
  onRevealInspector,
}: ToolCardProps) {
  const approvalRequired = tool.status === "approval-required";
  const isSubagentCall = SUBAGENT_TOOL_NAME.test(tool.name);
  const [expanded, setExpanded] = useState(false);
  const [inputBody, setInputBody] = useState<ToolBodyState>();
  const [outputBody, setOutputBody] = useState<ToolBodyState>();
  const [inputRetry, setInputRetry] = useState(0);
  const [outputRetry, setOutputRetry] = useState(0);
  const [manualArtifact, setManualArtifact] = useState<{
    toolKey: string;
    artifactId: string;
    artifact: ArtifactContent;
  }>();
  const [manualArtifactError, setManualArtifactError] = useState<{
    toolKey: string;
    artifactId: string;
    error: string;
  }>();
  const onReadArtifactRef = useRef(onReadArtifact);
  onReadArtifactRef.current = onReadArtifact;
  const inputKey = toolBodyKey(tool, tool.inputArtifactId);
  const outputKey = toolBodyKey(tool, tool.outputArtifactId);
  const toolKey = JSON.stringify([tool.sessionId, tool.id]);
  const bodyIdentityRef = useRef({ inputKey, outputKey, expanded });
  bodyIdentityRef.current = { inputKey, outputKey, expanded };
  const manualArtifactRequestRef = useRef(0);
  const manualToolKeyRef = useRef(toolKey);
  manualToolKeyRef.current = toolKey;
  const manualArtifactIdsRef = useRef(new Set(tool.artifactRefs ?? []));
  manualArtifactIdsRef.current = new Set(tool.artifactRefs ?? []);
  const manualExpandedRef = useRef(expanded);
  manualExpandedRef.current = expanded;
  const retryVersionRef = useRef({ input: 0, output: 0 });
  const command = tool.command ? compactToolCommand(tool.command) : undefined;
  const output = tool.output
    ? compactToolText(humanRuntimeText(tool.output))
    : undefined;
  const currentInputBody = inputBody?.key === inputKey ? inputBody : undefined;
  const currentOutputBody = outputBody?.key === outputKey ? outputBody : undefined;
  const currentManualArtifact =
    manualArtifact?.toolKey === toolKey &&
    manualArtifactIdsRef.current.has(manualArtifact.artifactId)
      ? manualArtifact
      : undefined;
  const currentManualArtifactError =
    manualArtifactError?.toolKey === toolKey &&
    manualArtifactIdsRef.current.has(manualArtifactError.artifactId)
      ? manualArtifactError
      : undefined;
  const hasDetails = Boolean(
    command?.fullText ||
      output?.fullText ||
      tool.inputArtifactId ||
      tool.outputArtifactId,
  );

  useEffect(() => {
    if (!expanded) return;
    const readArtifact = onReadArtifactRef.current;
    if (!readArtifact) return;

    let active = true;
    const started: { field: ToolBodyField; key: string }[] = [];
    const start = (
      field: ToolBodyField,
      artifactId: string | undefined,
      key: string | undefined,
      retryVersion: number,
      state: ToolBodyState | undefined,
      setState: (state: ToolBodyState | undefined) => void,
    ) => {
      if (!artifactId || !key) return;
      const retryRequested = retryVersion !== retryVersionRef.current[field];
      retryVersionRef.current[field] = retryVersion;
      if (
        !retryRequested &&
        state?.key === key &&
        (state.status === "loaded" || state.status === "error" || state.status === "loading")
      ) {
        return;
      }

      started.push({ field, key });
      setState({ key, status: "loading" });
      void readArtifact(artifactId)
        .then((content) => {
          const currentKey =
            bodyIdentityRef.current[field === "input" ? "inputKey" : "outputKey"];
          if (!active || !bodyIdentityRef.current.expanded || currentKey !== key) return;
          setState({ key, status: "loaded", text: content.text });
        })
        .catch((error: unknown) => {
          const currentKey =
            bodyIdentityRef.current[field === "input" ? "inputKey" : "outputKey"];
          if (!active || !bodyIdentityRef.current.expanded || currentKey !== key) return;
          setState({
            key,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };

    start("input", tool.inputArtifactId, inputKey, inputRetry, inputBody, setInputBody);
    start("output", tool.outputArtifactId, outputKey, outputRetry, outputBody, setOutputBody);

    return () => {
      active = false;
      for (const { field, key } of started) {
        const setState = field === "input" ? setInputBody : setOutputBody;
        setState((current) =>
          current?.key === key && current.status === "loading" ? undefined : current,
        );
      }
    };
  }, [
    expanded,
    tool.sessionId,
    tool.id,
    tool.inputArtifactId,
    tool.outputArtifactId,
    inputKey,
    outputKey,
    inputRetry,
    outputRetry,
  ]);

  const openBodyArtifact = (field: ToolBodyField) => {
    const state = field === "input" ? currentInputBody : currentOutputBody;
    const isExpandedLoadActive = expanded && state?.status === "loading";
    setExpanded(true);
    if (state?.status === "loaded" || isExpandedLoadActive) return;
    if (field === "input") setInputRetry((retry) => retry + 1);
    else setOutputRetry((retry) => retry + 1);
  };

  const readManualArtifact = (artifactId: string) => {
    const readArtifact = onReadArtifactRef.current;
    if (!readArtifact) return;
    const request = ++manualArtifactRequestRef.current;
    const requestToolKey = toolKey;
    const wasExpanded = expanded;
    setManualArtifact(undefined);
    setManualArtifactError(undefined);
    void readArtifact(artifactId)
      .then((artifact) => {
        if (
          request !== manualArtifactRequestRef.current ||
          requestToolKey !== manualToolKeyRef.current ||
          !manualArtifactIdsRef.current.has(artifactId) ||
          wasExpanded !== manualExpandedRef.current
        ) {
          return;
        }
        setManualArtifact({ toolKey: requestToolKey, artifactId, artifact });
      })
      .catch((error: unknown) => {
        if (
          request !== manualArtifactRequestRef.current ||
          requestToolKey !== manualToolKeyRef.current ||
          !manualArtifactIdsRef.current.has(artifactId) ||
          wasExpanded !== manualExpandedRef.current
        ) {
          return;
        }
        setManualArtifactError({
          toolKey: requestToolKey,
          artifactId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };
  return (
    <>
      <div className="activity-progress">
        <strong>gajae</strong>
        <span>{tool.description}</span>
      </div>
      <article
        className={`tool-card ${approvalRequired ? "tool-card--approval" : ""}`}
      >
        <header>
          <span className="tool-icon">
            <TerminalSquare size={16} />
          </span>
          <span>
            <strong>{toolDisplayName(tool.name)}</strong>
            <small>{tool.description}</small>
          </span>
          <span className={`tool-status tool-status--${tool.status}`}>
            {toolStatusLabel(tool.status)}
          </span>
        </header>
        {isSubagentCall && onRevealInspector && (
          <button
            type="button"
            className="tool-reveal-inspector"
            onClick={() => onRevealInspector(tool.id)}
          >
            {t("세션 정보에서 보기")} </button>
        )}
        {tool.subagents && tool.subagents.length > 0 && (
          <div className="tool-full-details">
            <section>
              <strong>{t("요청된 서브에이전트")}</strong>
              {/* What the call asked for, not what those agents are doing now: their
                  status is inferred from the parent and is not authoritative here. */}
              {tool.subagents.map((subagent) => (
                <p key={subagent.id}>
                  {subagent.label}
                  {subagent.role ? ` · ${subagent.role}` : ""}
                  {subagent.objective ? ` — ${subagent.objective}` : ""}
                </p>
              ))}
            </section>
          </div>
        )}
        {command?.preview && <code>{command.preview}</code>}
        {tool.diff && <DiffView diff={tool.diff} path={tool.targetPath} />}
        {tool.images?.map((image, index) => (
          <img
            key={`${tool.id}-image-${index}`}
            className="tool-image"
            src={image.dataUrl}
            alt={tool.targetPath ?? t("도구가 읽은 이미지")}
          />
        ))}
        {!tool.diff && output?.text && (
          <div className="tool-output-preview">
            {output.omittedLines > 0 && (
              <small>{t("앞부분")} {output.omittedLines}{t("줄 생략")}</small>
            )}
            <pre>{output.text}</pre>
          </div>
        )}
        {hasDetails && (
          <button
            className="tool-expand"
            type="button"
            onClick={() => {
              if (expanded) manualArtifactRequestRef.current += 1;
              setExpanded(!expanded);
            }}
          >
            {expanded ? t("상세 내용 닫기") : t("상세 내용 보기")}{" "}
            <ChevronDown size={12} />
          </button>
        )}
        {expanded && (
          <div className="tool-full-details">
            {(command?.fullText || tool.inputArtifactId) && (
              <section>
                <strong>{t("입력")}</strong>
                {tool.inputArtifactId ? (
                  currentInputBody?.status === "loaded" ? (
                    <pre>{currentInputBody.text}</pre>
                  ) : currentInputBody?.status === "error" ? (
                    <>
                      <small className="artifact-error">
                        {t("입력 원문을 불러오지 못했습니다: {0}", {
                          0: currentInputBody.error ?? t("읽을 수 없음"),
                        })}
                      </small>
                      <button
                        type="button"
                        className="tool-body-retry tool-body-retry--input"
                        onClick={() => setInputRetry((retry) => retry + 1)}
                      >
                        {t("입력 원문 다시 시도")}
                      </button>
                    </>
                  ) : (
                    <small>{t("입력 원문 불러오는 중…")}</small>
                  )
                ) : (
                  command?.fullText && <pre>{command.fullText}</pre>
                )}
              </section>
            )}
            {(output?.fullText || tool.outputArtifactId) && (
              <section>
                <strong>{t("출력")}</strong>
                {tool.outputArtifactId ? (
                  currentOutputBody?.status === "loaded" ? (
                    <pre>{currentOutputBody.text}</pre>
                  ) : currentOutputBody?.status === "error" ? (
                    <>
                      <small className="artifact-error">
                        {t("출력 원문을 불러오지 못했습니다: {0}", {
                          0: currentOutputBody.error ?? t("읽을 수 없음"),
                        })}
                      </small>
                      <button
                        type="button"
                        className="tool-body-retry tool-body-retry--output"
                        onClick={() => setOutputRetry((retry) => retry + 1)}
                      >
                        {t("출력 원문 다시 시도")}
                      </button>
                    </>
                  ) : (
                    <small>{t("출력 원문 불러오는 중…")}</small>
                  )
                ) : (
                  output?.fullText && <pre>{output.fullText}</pre>
                )}
              </section>
            )}
          </div>
        )}
        {(tool.inputArtifactId ||
          tool.outputArtifactId ||
          tool.artifactRefs?.length) && (
          <div className="artifact-links">
            {tool.inputArtifactId && (
              <button
                type="button"
                onClick={() => openBodyArtifact("input")}
              >
                {t("입력 원문")}
              </button>
            )}
            {tool.outputArtifactId && (
              <button
                type="button"
                onClick={() => openBodyArtifact("output")}
              >
                {t("출력 원문")}
              </button>
            )}
            {(tool.artifactRefs ?? [])
              .filter(
                (id) => id !== tool.inputArtifactId && id !== tool.outputArtifactId,
              )
              .map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => readManualArtifact(id)}
                >
                  {id.startsWith("artifact://") ? id : `artifact://${id}`}
                </button>
              ))}
          </div>
        )}
        {currentManualArtifactError && (
          <small className="artifact-error">{currentManualArtifactError.error}</small>
        )}
        {currentManualArtifact && (
          <div className="tool-full-details">
            <section>
              <strong>
                Artifact {currentManualArtifact.artifact.artifactId}{" "}
                {currentManualArtifact.artifact.complete ? "" : t("(미완료)")}
              </strong>
              <pre>{currentManualArtifact.artifact.text}</pre>
              <small>
                {currentManualArtifact.artifact.complete
                  ? t("전체 내용")
                  : t`일부만 로드됨 · ${currentManualArtifact.artifact.totalBytes} bytes`}
              </small>
            </section>
          </div>
        )}
        {autoDenyHint && (
          <footer className="tool-card-auto-deny">
            <span>
              <ShieldCheck size={14} /> {autoDenyHint.message}
            </span>
            {autoDenyHint.onOpenSettings && (
              <button
                type="button"
                className="button-secondary"
                onClick={autoDenyHint.onOpenSettings}
              >
                {t("설정 열기")} </button>
            )}
          </footer>
        )}
        {approvalRequired && (
          <footer>
            <span>
              <ShieldCheck size={14} /> {t("승인이 필요합니다")} </span>
            <div className="permission-options">
              {(tool.permissionOptions ?? []).map((option) => (
                <button
                  key={option.optionId}
                  type="button"
                  className={
                    option.kind.startsWith("reject")
                      ? "button-secondary"
                      : "button-primary"
                  }
                  onClick={() => onResolve(tool.id, option.optionId)}
                >
                  {option.name}
                </button>
              ))}
            </div>
          </footer>
        )}
      </article>
    </>
  );
}
