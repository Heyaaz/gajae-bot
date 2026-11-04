import { useEffect, useState, type FormEvent } from "react";
import { Check, ChevronRight, CircleHelp, ExternalLink, Globe, KeyRound } from "lucide-react";
import {
  RECOMMENDED_SIGN_IN_PROVIDER_ID,
  SIGN_IN_PROVIDERS,
  type OnboardingDesktopBridge,
  type OnboardingStep,
  type SignInProvider,
} from "../../shared/onboarding";
import { t } from "../i18n";
import gajaeIconUrl from "../assets/gajae-icon-ui.png";

type Stage =
  | {
      stage: "install";
      running: boolean;
      receivedBytes?: number;
      totalBytes?: number;
      error?: string;
    }
  | { stage: "choose" }
  | { stage: "help" }
  | {
      stage: "sign-in";
      provider: SignInProvider;
      url?: string;
      instructions?: string;
      prompt?: string;
      answering: boolean;
      error?: string;
    }
  | { stage: "ready"; provider: SignInProvider; switchedModel: boolean };

function initialStage(step: OnboardingStep): Stage {
  return step === "install" ? { stage: "install", running: false } : { stage: "choose" };
}

function errorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  // Electron prefixes errors that cross IPC with where they were raised.
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "");
}

const RECOMMENDED_PROVIDER =
  SIGN_IN_PROVIDERS.find((provider) => provider.id === RECOMMENDED_SIGN_IN_PROVIDER_ID) ?? SIGN_IN_PROVIDERS[0];

const megabytes = (bytes: number): string => (bytes / 1_000_000).toFixed(0);

/**
 * First-run setup for someone who has never used GJC: install it, sign in to one
 * provider, start a conversation. Nothing here needs a terminal.
 *
 * `reentry` opens the same provider list and sign-in later, from settings, `/login`
 * or the sidebar, to add a provider or renew a token. It is not setup, so closing
 * it only closes it: first-run setup stays as the user left it.
 */
export function OnboardingView({
  bridge,
  step,
  reentry = false,
  onClose,
  onStartConversation,
}: {
  bridge: OnboardingDesktopBridge;
  step: OnboardingStep;
  reentry?: boolean;
  onClose: () => void;
  onStartConversation: () => void;
}) {
  const [stage, setStage] = useState<Stage>(() => initialStage(step));
  const [answer, setAnswer] = useState("");

  useEffect(
    () =>
      bridge.onEvent((event) =>
        setStage((current) => {
          if (event.type === "install-progress" && current.stage === "install")
            return { ...current, receivedBytes: event.receivedBytes, totalBytes: event.totalBytes };
          if (event.type === "open-url" && current.stage === "sign-in")
            return { ...current, url: event.url, instructions: event.instructions };
          if (event.type === "prompt" && current.stage === "sign-in")
            return { ...current, prompt: event.message, answering: false };
          return current;
        }),
      ),
    [bridge],
  );

  function install(): void {
    setStage({ stage: "install", running: true });
    bridge.installGjc().then(
      () => setStage({ stage: "choose" }),
      (cause: unknown) => setStage({ stage: "install", running: false, error: errorText(cause) }),
    );
  }

  function signIn(provider: SignInProvider): void {
    setAnswer("");
    setStage({ stage: "sign-in", provider, answering: false });
    bridge.signIn(provider.id).then(
      ({ switchedModel }) => setStage({ stage: "ready", provider, switchedModel }),
      (cause: unknown) =>
        setStage((current) =>
          current.stage === "sign-in" && current.provider.id === provider.id
            ? { ...current, prompt: undefined, answering: false, error: errorText(cause) }
            : current,
        ),
    );
  }

  function submitAnswer(event: FormEvent): void {
    event.preventDefault();
    const text = answer.trim();
    if (!text || stage.stage !== "sign-in") return;
    setStage({ ...stage, answering: true });
    setAnswer("");
    bridge.answer(text).catch((cause: unknown) =>
      setStage((current) =>
        current.stage === "sign-in" ? { ...current, answering: false, error: errorText(cause) } : current,
      ),
    );
  }

  function backToProviders(): void {
    void bridge.cancelSignIn();
    setStage({ stage: "choose" });
  }

  function dismiss(): void {
    if (reentry) void bridge.cancelSignIn();
    else void bridge.dismiss();
    onClose();
  }

  return (
    <div className="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="onboarding-card">
        <span className="workspace-empty__mark">
          <img src={gajaeIconUrl} alt="" />
        </span>
        {stage.stage === "install" && (
          <>
            <h1 id="onboarding-title">{t("가재를 쓰려면 GJC가 필요합니다")}</h1>
            <p className="onboarding-lead">
              {t("GJC는 가재가 AI와 일할 때 쓰는 엔진입니다. 공식 배포본(약 140MB)을 받아 이 Mac에 설치합니다.")}
            </p>
            {stage.running ? (
              <div className="onboarding-progress" role="status">
                <progress
                  value={stage.receivedBytes ?? 0}
                  max={stage.totalBytes ?? 1}
                  aria-label={t("GJC 받는 중")}
                />
                <small>
                  {stage.totalBytes && stage.receivedBytes === stage.totalBytes
                    ? t("설치를 확인하는 중…")
                    : stage.totalBytes
                      ? t`받는 중 ${megabytes(stage.receivedBytes ?? 0)}MB / ${megabytes(stage.totalBytes)}MB`
                      : t("받는 중…")}
                </small>
              </div>
            ) : (
              <>
                {stage.error && (
                  <p className="onboarding-error" role="alert">
                    {t`설치하지 못했습니다. ${stage.error}`}
                  </p>
                )}
                <button className="button-primary onboarding-primary" type="button" onClick={install}>
                  {stage.error ? t("다시 시도") : t("GJC 설치")}
                </button>
              </>
            )}
          </>
        )}

        {stage.stage === "choose" && (
          <>
            <h1 id="onboarding-title">{t("어떤 AI를 쓰시나요?")}</h1>
            <p className="onboarding-lead">{t("이미 쓰고 있는 구독 계정이나 API 키로 로그인하세요.")}</p>
            <ul className="onboarding-providers">
              {SIGN_IN_PROVIDERS.map((provider) => (
                <li key={provider.id}>
                  <button type="button" onClick={() => signIn(provider)}>
                    {provider.method === "browser" ? (
                      <Globe size={15} aria-hidden="true" />
                    ) : (
                      <KeyRound size={15} aria-hidden="true" />
                    )}
                    <span>
                      <strong>{provider.name}</strong>
                      <small>
                        {provider.method === "browser" ? t("브라우저에서 로그인") : t("API 키 붙여넣기")}
                      </small>
                    </span>
                    <ChevronRight size={15} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
            <button className="onboarding-help-entry" type="button" onClick={() => setStage({ stage: "help" })}>
              <CircleHelp size={15} aria-hidden="true" />
              {t("잘 모르겠어요 / 구독이 없어요")}
            </button>
          </>
        )}

        {stage.stage === "help" && (
          <>
            <h1 id="onboarding-title">{t("어떤 AI를 가입하면 되나요?")}</h1>
            <p className="onboarding-lead">
              {t`아직 구독이 없다면 ${RECOMMENDED_PROVIDER.name}를 추천합니다. 가장 흔하고 설정이 쉬워서, 가입한 뒤 이 화면에서 바로 로그인하면 됩니다.`}
            </p>
            <a
              className="button-primary onboarding-primary onboarding-signup"
              href={RECOMMENDED_PROVIDER.signUpUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t`${RECOMMENDED_PROVIDER.name} 가입하기`}
              <ExternalLink size={14} aria-hidden="true" />
            </a>
            <details className="onboarding-details">
              <summary>{t("다른 AI도 쓸 수 있어요")}</summary>
              <ul className="onboarding-signup-list">
                {SIGN_IN_PROVIDERS.filter((provider) => provider.id !== RECOMMENDED_PROVIDER.id).map((provider) => (
                  <li key={provider.id}>
                    <a href={provider.signUpUrl} target="_blank" rel="noreferrer">
                      {provider.name}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
            <button className="onboarding-text-button" type="button" onClick={() => setStage({ stage: "choose" })}>
              {t("가입했어요, 로그인할게요")}
            </button>
          </>
        )}

        {stage.stage === "sign-in" && (
          <>
            <h1 id="onboarding-title">{t`${stage.provider.name}에 로그인`}</h1>
            {stage.error ? (
              <>
                <p className="onboarding-error" role="alert">
                  {t`로그인하지 못했습니다. ${stage.error}`}
                </p>
                <button
                  className="button-primary onboarding-primary"
                  type="button"
                  onClick={() => signIn(stage.provider)}
                >
                  {t("다시 시도")}
                </button>
              </>
            ) : (
              stage.provider.method === "browser" ? (
                <>
                  <p className="onboarding-hint onboarding-waiting" role="status">
                    <span className="mini-spinner" />{" "}
                    {stage.url ? t("브라우저에서 로그인 중…") : t("로그인을 준비하는 중…")}
                  </p>
                  <details className="onboarding-details">
                    <summary>{t("브라우저가 돌아오지 않나요?")}</summary>
                    {stage.url && (
                      <a className="onboarding-link" href={stage.url} target="_blank" rel="noreferrer">
                        {t("브라우저가 열리지 않았다면 여기를 누르세요")}
                      </a>
                    )}
                    {stage.prompt ? (
                      <AnswerForm
                        label={t("브라우저가 이 앱으로 돌아오지 않으면 받은 코드를 붙여 넣으세요")}
                        secret={false}
                        stage={stage}
                        answer={answer}
                        setAnswer={setAnswer}
                        onSubmit={submitAnswer}
                      />
                    ) : (
                      <small>{t("로그인 주소를 받으면 여기에 코드를 붙여 넣는 칸이 나타납니다.")}</small>
                    )}
                    {stage.instructions && <small>{stage.instructions}</small>}
                  </details>
                </>
              ) : (
                <>
                  <p className="onboarding-lead">{t("열린 페이지에서 API 키를 복사해 아래에 붙여 넣으세요.")}</p>
                  {!stage.url && !stage.prompt && (
                    <p className="onboarding-hint" role="status">
                      <span className="mini-spinner" /> {t("로그인을 준비하는 중…")}
                    </p>
                  )}
                  {stage.url && (
                    <a className="onboarding-link" href={stage.url} target="_blank" rel="noreferrer">
                      {t("API 키 페이지 다시 열기")}
                    </a>
                  )}
                  <a className="onboarding-link" href={stage.provider.signUpUrl} target="_blank" rel="noreferrer">
                    {t`계정이 없나요? ${stage.provider.name} 가입하기`}
                  </a>
                  {stage.prompt && (
                    <AnswerForm
                      label={t("API 키")}
                      secret
                      stage={stage}
                      answer={answer}
                      setAnswer={setAnswer}
                      onSubmit={submitAnswer}
                    />
                  )}
                  {stage.instructions && (
                    <details className="onboarding-details">
                      <summary>{t("GJC 안내 보기")}</summary>
                      <small>{stage.instructions}</small>
                    </details>
                  )}
                </>
              )
            )}
            <button className="onboarding-text-button" type="button" onClick={backToProviders}>
              {t("다른 AI 고르기")}
            </button>
          </>
        )}

        {stage.stage === "ready" && (
          <>
            <span className="onboarding-done" aria-hidden="true">
              <Check size={18} />
            </span>
            <h1 id="onboarding-title">{t("준비됐습니다")}</h1>
            <p className="onboarding-lead">
              {!stage.switchedModel
                ? t`${stage.provider.name}에 로그인했습니다. 모델 선택에서 이 제공자의 모델을 고를 수 있습니다.`
                : reentry
                  ? t`${stage.provider.name}의 추천 모델(${stage.provider.preset})로 설정했습니다.`
                  : t`${stage.provider.name}의 추천 모델(${stage.provider.preset})로 설정했습니다. 작업할 폴더를 고르고 첫 대화를 시작하세요.`}
            </p>
            <button
              className="button-primary onboarding-primary"
              type="button"
              onClick={() => {
                onClose();
                if (!reentry) onStartConversation();
              }}
            >
              {reentry ? t("확인") : t("첫 대화 시작")}
            </button>
          </>
        )}

        {stage.stage !== "ready" && (
          <button className="onboarding-text-button onboarding-skip" type="button" onClick={dismiss}>
            {reentry ? t("닫기") : t("나중에 직접 설정할게요")}
          </button>
        )}
      </div>
    </div>
  );
}

function AnswerForm({
  label,
  secret,
  stage,
  answer,
  setAnswer,
  onSubmit,
}: {
  label: string;
  secret: boolean;
  stage: { answering: boolean };
  answer: string;
  setAnswer: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form className="onboarding-answer" onSubmit={onSubmit}>
      <label>
        <small>{label}</small>
        <input
          type={secret ? "password" : "text"}
          value={answer}
          autoComplete="off"
          spellCheck={false}
          disabled={stage.answering}
          onChange={(event) => setAnswer(event.target.value)}
        />
      </label>
      <button className="button-primary" type="submit" disabled={stage.answering || !answer.trim()}>
        {stage.answering ? t("확인 중…") : t("확인")}
      </button>
    </form>
  );
}
