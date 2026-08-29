import ReactMarkdown from "react-markdown";
import gajaeIconUrl from "../assets/gajae-icon.png";
import remarkGfm from "remark-gfm";
import type { ArtifactContent, GeneratedFilePreview } from "../../shared/agent-contract";
import type { ToolActivity, TranscriptItem } from "../backend/types";
import { compactToolCommand, compactToolText } from "../composer-utils";
import {
  attachmentSummaryText,
  copyableMessageText,
  groupTranscriptItems,
  isNearTranscriptBottom,
  recentUserRequests,
} from "../transcript-utils";
import {
  Brain,
  Check,
  ChevronDown,
  Clock3,
  FileSearch,
  GitFork,
  ListChecks,
  Paperclip,
  ShieldCheck,
  Shrink,
  TerminalSquare,
  X,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { httpUrls, humanRuntimeText, toolDisplayName, toolStatusLabel } from "./format";
import { DiffView, LinkPreviewCard, MessageCopyButton } from "./primitives";

export interface TranscriptProps {
  items: TranscriptItem[];
  compacting?: boolean;
  revealItemId?: string;
  onRevealComplete?: (itemId: string) => void;
  onResolveTool: (toolId: string, optionId: string) => void;
  onReadArtifact?: (artifactId: string) => Promise<ArtifactContent>;
  onPreviewFile?: (path: string) => Promise<GeneratedFilePreview>;
}

export function Transcript({
  items,
  compacting = false,
  revealItemId,
  onRevealComplete,
  onResolveTool,
  onReadArtifact,
  onPreviewFile,
}: TranscriptProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    if (!followingRef.current) return;
    const frame = requestAnimationFrame(() => {
      const transcript = transcriptRef.current;
      if (!transcript) return;
      transcript.scrollTop = transcript.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [items]);

  useEffect(() => {
    if (!revealItemId || !items.some((item) => item.id === revealItemId))
      return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(
        `transcript-${encodeURIComponent(revealItemId)}`,
      );
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      target?.classList.add("is-search-reveal");
      window.setTimeout(
        () => target?.classList.remove("is-search-reveal"),
        2200,
      );
      onRevealComplete?.(revealItemId);
    });
    return () => cancelAnimationFrame(frame);
  }, [items, onRevealComplete, revealItemId]);

  function updateScrollFollowing(): void {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const nearBottom = isNearTranscriptBottom(
      transcript.scrollHeight,
      transcript.scrollTop,
      transcript.clientHeight,
    );
    followingRef.current = nearBottom;
    setFollowing(nearBottom);
  }

  function scrollToLatest(): void {
    followingRef.current = true;
    setFollowing(true);
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
  }

  if (items.length === 0 && !compacting) {
    return (
      <div className="empty-conversation">
        <span className="empty-conversation__mark">
          <img src={gajaeIconUrl} alt="" />
        </span>
        <h2>Gajae에게 어떤 작업을 맡길까요?</h2>
      </div>
    );
  }

  return (
    <div
      className="transcript"
      aria-live="polite"
      ref={transcriptRef}
      onScroll={updateScrollFollowing}
    >
      <div className="transcript-column">
        {groupTranscriptItems(items).map((block) =>
          block.kind === "item" ? (
            <div
              className="transcript-entry"
              id={`transcript-${encodeURIComponent(block.item.id)}`}
              key={block.id}
            >
              <TranscriptItemView
                item={block.item}
                onResolveTool={onResolveTool}
                onReadArtifact={onReadArtifact}
                onPreviewFile={onPreviewFile}
              />
            </div>
          ) : (
            <div className="transcript-entry tool-run" key={block.id}>
              {block.items.map((tool) => (
                <div
                  className="tool-run-entry"
                  id={`transcript-${encodeURIComponent(tool.id)}`}
                  key={tool.id}
                >
                  <TranscriptItemView
                    item={tool}
                    onResolveTool={onResolveTool}
                    onReadArtifact={onReadArtifact}
                    onPreviewFile={onPreviewFile}
                  />
                </div>
              ))}
            </div>
          ),
        )}
        {compacting && (
          <article className="compaction-card compaction-card--progress">
            <header>
              <Shrink size={15} />
              <strong>compaction</strong>
              <span>압축 중</span>
            </header>
            <p className="compaction-progress">
              <span className="mini-spinner" />
              세션 context를 압축하고 있습니다
            </p>
          </article>
        )}
        <div ref={endRef} />
      </div>
      {!following && (
        <button
          className="scroll-to-latest"
          type="button"
          onClick={scrollToLatest}
        >
          최신 내용으로
        </button>
      )}
    </div>
  );
}

export function CompactionCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "compaction" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const tokens = item.tokensBefore.toLocaleString("en-US");
  const preview = item.shortSummary || item.summary;
  return (
    <article className={`compaction-card ${expanded ? "is-expanded" : ""}`}>
      <header>
        <Shrink size={15} />
        <strong>compaction</strong>
        <span>{tokens} 토큰에서 압축됨</span>
      </header>
      <button
        type="button"
        className="compaction-toggle"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "요약 접기" : "요약 펼치기"}
      </button>
      {expanded ? (
        <div className="compaction-summary markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {item.summary}
          </ReactMarkdown>
        </div>
      ) : (
        preview && (
          <div className="compaction-short markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview}</ReactMarkdown>
          </div>
        )
      )}
    </article>
  );
}

export function BranchSummaryCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "branch_summary" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article className={`compaction-card ${expanded ? "is-expanded" : ""}`}>
      <header>
        <GitFork size={15} />
        <strong>branch</strong>
        <span>분기 요약</span>
      </header>
      <button
        type="button"
        className="compaction-toggle"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "요약 접기" : "요약 펼치기"}
      </button>
      {expanded && (
        <div className="compaction-summary markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {item.summary}
          </ReactMarkdown>
        </div>
      )}
    </article>
  );
}

export function SystemNoticeCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "system" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = item.content.split("\n").slice(0, 4).join("\n");
  const truncated = item.content !== preview;
  return (
    <article className="system-card">
      <header>
        <TerminalSquare size={15} />
        <strong>{item.title}</strong>
      </header>
      <div className="system-card-body markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {expanded ? item.content : preview}
        </ReactMarkdown>
      </div>
      {truncated && (
        <button
          type="button"
          className="compaction-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "접기" : "더 보기"}
        </button>
      )}
    </article>
  );
}

export function ThoughtCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "thought" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const open = item.streaming || expanded;
  return (
    <article className={`thought-card ${item.streaming ? "is-streaming" : ""}`}>
      <header>
        <Brain size={15} />
        <strong>Gajae</strong>
        <span>{item.streaming ? "생각 중…" : "추론"}</span>
        {item.streaming && <span className="mini-spinner" />}
        {!item.streaming && (
          <button
            type="button"
            className="thought-toggle"
            onClick={() => setExpanded((value) => !value)}
          >
            {open ? "접기" : "펼치기"}
          </button>
        )}
      </header>
      {open && (
        <div
          className={`thought-content ${item.streaming ? "is-streaming" : "markdown-body"}`}
        >
          {item.streaming ? (
            item.content
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {item.content}
            </ReactMarkdown>
          )}
        </div>
      )}
    </article>
  );
}

export const TranscriptItemView = memo(function TranscriptItemView({
  item,
  onResolveTool,
  onReadArtifact,
  onPreviewFile,
}: {
  item: TranscriptItem;
  onResolveTool: TranscriptProps["onResolveTool"];
  onReadArtifact: TranscriptProps["onReadArtifact"];
  onPreviewFile: TranscriptProps["onPreviewFile"];
}) {
  if (item.kind === "message") {
    const copyText = copyableMessageText(item.content);
    const attachments = attachmentSummaryText(item.content);
    return (
      <article className={`message message--${item.role}`}>
        {item.role === "assistant" && (
          <div className="message-author">
            <span className="assistant-mark">
              <img src={gajaeIconUrl} alt="" />
            </span>
            <strong>Gajae</strong>
            <time>{item.createdAt}</time>
          </div>
        )}
        {(item.content || item.streaming) && (
          <div
            className={`message-body ${item.role === "assistant" && !item.streaming ? "markdown-body" : ""}`}
          >
            {item.content ? (
              item.role === "assistant" ? (
                item.streaming ? (
                  item.content
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {item.content}
                  </ReactMarkdown>
                )
              ) : (
                copyText || item.content
              )
            ) : (
              <span className="typing-dots">
                <i />
                <i />
                <i />
              </span>
            )}
            {item.streaming && <span className="streaming-caret" />}
          </div>
        )}
        {item.images && item.images.length > 0 && (
          <div className="message-images">
            {item.images.map((image) => (
              <img
                key={image.id}
                src={`data:${image.mimeType};base64,${image.data}`}
                alt={image.name}
                title={image.name}
              />
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <ul className="message-attachments">
            {attachments.map((name) => (
              <li key={name}>
                <Paperclip size={12} aria-hidden />
                <span>{name}</span>
              </li>
            ))}
          </ul>
        )}
        {item.role === "user" &&
          httpUrls(item.content).map((url) => (
            <LinkPreviewCard key={url} url={url} />
          ))}
        {item.role === "user" && (
          <div className="message-meta">
            <time className="user-time">{item.createdAt}</time>
            {copyText ? <MessageCopyButton text={copyText} /> : null}
          </div>
        )}
        {item.role === "assistant" && !item.streaming && copyText ? (
          <div className="message-meta message-meta--assistant">
            <MessageCopyButton text={copyText} />
          </div>
        ) : null}
      </article>
    );
  }

  if (item.kind === "notice") {
    return (
      <article className={`notice-card notice-card--${item.tone}`}>
        <Check size={16} />
        <span>
          <strong>{item.title}</strong>
          <small>{item.content}</small>
        </span>
      </article>
    );
  }

  if (item.kind === "compaction") {
    return <CompactionCard item={item} />;
  }

  if (item.kind === "branch_summary") {
    return <BranchSummaryCard item={item} />;
  }

  if (item.kind === "system") {
    return <SystemNoticeCard item={item} />;
  }

  if (item.kind === "thought") {
    return <ThoughtCard item={item} />;
  }

  if (item.kind === "plan") {
    return (
      <article className="plan-card">
        <header>
          <ListChecks size={15} />
          <strong>계획</strong>
          <span>
            {
              item.entries.filter((entry) => entry.status === "completed")
                .length
            }
            /{item.entries.length}
          </span>
        </header>
        <ol>
          {item.entries.map((entry, index) => (
            <li
              key={`${index}-${entry.content}`}
              className={`plan-entry--${entry.status}`}
            >
              <span />
              {entry.content}
            </li>
          ))}
        </ol>
      </article>
    );
  }

  return (
    <ToolCard
      tool={item}
      onResolve={onResolveTool}
      onReadArtifact={onReadArtifact}
      onPreviewFile={onPreviewFile}
    />
  );
});

export interface ToolCardProps {
  tool: ToolActivity;
  onResolve: (toolId: string, optionId: string) => void;
  onReadArtifact?: (artifactId: string) => Promise<ArtifactContent>;
  onPreviewFile?: (path: string) => Promise<GeneratedFilePreview>;
}

export function ToolCard({
  tool,
  onResolve,
  onReadArtifact,
  onPreviewFile,
}: ToolCardProps) {
  const approvalRequired = tool.status === "approval-required";
  const [expanded, setExpanded] = useState(false);
  const [artifact, setArtifact] = useState<ArtifactContent | null>(null);
  const [artifactError, setArtifactError] = useState("");
  const [preview, setPreview] = useState<GeneratedFilePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const command = tool.command ? compactToolCommand(tool.command) : undefined;
  const output = tool.output
    ? compactToolText(humanRuntimeText(tool.output))
    : undefined;
  const hasDetails = Boolean(command?.fullText || output?.fullText);
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
            {tool.status === "running" && <span className="mini-spinner" />}
            {toolStatusLabel(tool.status)}
          </span>
        </header>
        {command?.preview && <code>{command.preview}</code>}
        {tool.diff && <DiffView diff={tool.diff} path={tool.targetPath} />}
        {tool.images?.map((image, index) => (
          <img
            key={`${tool.id}-image-${index}`}
            className="tool-image"
            src={image.dataUrl}
            alt={tool.targetPath ?? "도구가 읽은 이미지"}
          />
        ))}
        {tool.targetPath && /^(write|edit)$/iu.test(tool.name) && (
          <button
            className="generated-preview-button"
            type="button"
            disabled={previewBusy}
            onClick={() => {
              if (!onPreviewFile) return;
              setPreviewBusy(true);
              void onPreviewFile(tool.targetPath!)
                .then(setPreview)
                .catch((error) =>
                  setArtifactError(
                    error instanceof Error ? error.message : String(error),
                  ),
                )
                .finally(() => setPreviewBusy(false));
            }}
          >
            <FileSearch size={12} />
            {previewBusy ? "미리보기 여는 중…" : "결과물 미리보기"}
          </button>
        )}
        {!tool.diff && output?.text && (
          <div className="tool-output-preview">
            {output.omittedLines > 0 && (
              <small>앞부분 {output.omittedLines}줄 생략</small>
            )}
            <pre>{output.text}</pre>
          </div>
        )}
        {hasDetails && (
          <button
            className="tool-expand"
            type="button"
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "상세 내용 닫기" : "상세 내용 보기"}{" "}
            <ChevronDown size={12} />
          </button>
        )}
        {expanded && (
          <div className="tool-full-details">
            {command?.fullText && (
              <section>
                <strong>입력</strong>
                <pre>{command.fullText}</pre>
              </section>
            )}
            {output?.fullText && (
              <section>
                <strong>출력</strong>
                <pre>{output.fullText}</pre>
              </section>
            )}
          </div>
        )}
        {(tool.inputArtifactId ||
          tool.outputArtifactId ||
          tool.artifactRefs?.length) && (
          <div className="artifact-links">
            {[
              tool.inputArtifactId,
              tool.outputArtifactId,
              ...(tool.artifactRefs ?? []),
            ]
              .filter((id): id is string => Boolean(id))
              .map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    if (!onReadArtifact) return;
                    setArtifactError("");
                    void onReadArtifact(id)
                      .then(setArtifact)
                      .catch((e) =>
                        setArtifactError(
                          e instanceof Error ? e.message : String(e),
                        ),
                      );
                  }}
                >
                  {id.startsWith("artifact://") ? id : `artifact://${id}`}
                </button>
              ))}
          </div>
        )}
        {artifactError && (
          <small className="artifact-error">{artifactError}</small>
        )}
        {artifact && (
          <div className="tool-full-details">
            <section>
              <strong>
                Artifact {artifact.artifactId}{" "}
                {artifact.complete ? "" : "(미완료)"}
              </strong>
              <pre>{artifact.text}</pre>
              <small>
                {artifact.complete
                  ? "전체 내용"
                  : `일부만 로드됨 · ${artifact.totalBytes} bytes`}
              </small>
            </section>
          </div>
        )}
        {approvalRequired && (
          <footer>
            <span>
              <ShieldCheck size={14} /> 승인이 필요합니다
            </span>
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
      {preview && (
        <GeneratedPreviewModal
          preview={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

export function GeneratedPreviewModal({
  preview,
  onClose,
}: {
  preview: GeneratedFilePreview;
  onClose: () => void;
}) {
  return (
    <div className="preview-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="generated-preview"
        role="dialog"
        aria-label={`${preview.name} 미리보기`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span>
            <strong>{preview.name}</strong>
            <small>
              {preview.path} · {(preview.size / 1024).toFixed(1)} KB
            </small>
          </span>
          <button className="icon-button" type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="generated-preview-body">
          {preview.kind === "image" && preview.dataUrl && (
            <img src={preview.dataUrl} alt={preview.name} />
          )}
          {preview.kind === "pdf" && preview.dataUrl && (
            <iframe src={preview.dataUrl} title={preview.name} />
          )}
          {preview.kind === "markdown" && preview.content !== undefined && (
            <article className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {preview.content}
              </ReactMarkdown>
            </article>
          )}
          {preview.kind === "html" && (
            <iframe sandbox="" srcDoc={preview.content} title={preview.name} />
          )}
          {preview.kind === "text" && <pre>{preview.content}</pre>}
          {preview.kind === "unsupported" && (
            <p>
              이 파일 형식은 앱에서 미리 볼 수 없습니다. 경로는 GJC에서 계속
              사용할 수 있습니다.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

export function RecentRequestStrip({
  items,
  onReveal,
}: {
  items: TranscriptItem[];
  onReveal: (id: string) => void;
}) {
  const requests = useMemo(() => recentUserRequests(items), [items]);
  if (requests.length === 0) return null;
  return (
    <section className="recent-requests" aria-label="최근 요청">
      <header>
        <Clock3 size={11} />
        <strong>최근 요청</strong>
      </header>
      <div>
        {requests.map((request, index) => (
          <button
            type="button"
            key={request.id}
            title={request.text}
            onClick={() => onReveal(request.id)}
          >
            <span>{index + 1}</span>
            <strong>{request.text}</strong>
            <time>{request.createdAt}</time>
          </button>
        ))}
      </div>
    </section>
  );
}
