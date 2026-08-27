import type { ManagementDesktopBridge, ManagementSnapshot, McpServerInput } from "../../shared/agent-contract";
import type { Automation, AutomationInput, AutomationRun } from "../../shared/automation-ipc";
import { Play, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Dropdown } from "./primitives";

export interface ManagementPanelProps {
  tab: "mcp" | "skills" | "usage";
  snapshot: ManagementSnapshot;
  workspace: string;
  bridge: ManagementDesktopBridge;
  onSnapshot: (snapshot: ManagementSnapshot) => void;
  onError: (message: string) => void;
}

export function ManagementPanel({
  tab,
  snapshot,
  workspace,
  bridge,
  onSnapshot,
  onError,
}: ManagementPanelProps) {
  const [busy, setBusy] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpScope, setMcpScope] = useState<"user" | "project">("project");
  const [mcpType, setMcpType] = useState<"stdio" | "http" | "sse">("stdio");
  const [mcpEndpoint, setMcpEndpoint] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");
  const [pluginTarget, setPluginTarget] = useState("");
  const [pluginScope, setPluginScope] = useState<"user" | "project">("project");

  async function mutate(
    label: string,
    operation: () => Promise<ManagementSnapshot>,
  ): Promise<void> {
    setBusy(label);
    onError("");
    try {
      onSnapshot(await operation());
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  function addMcp(event: FormEvent): void {
    event.preventDefault();
    const input: McpServerInput = {
      name: mcpName.trim(),
      scope: mcpScope,
      type: mcpType,
      args: mcpArgs
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
      ...(mcpType === "stdio"
        ? { command: mcpEndpoint.trim() }
        : { url: mcpEndpoint.trim() }),
    };
    void mutate("mcp-add", () => bridge.addMcpServer(workspace, input)).then(
      () => {
        setMcpName("");
        setMcpEndpoint("");
        setMcpArgs("");
      },
    );
  }

  if (tab === "mcp") {
    return (
      <div className="management-panel">
        <form className="management-form" onSubmit={addMcp}>
          <h3>MCP 서버 추가</h3>
          <div>
            <input
              required
              placeholder="서버 이름"
              value={mcpName}
              onChange={(event) => setMcpName(event.target.value)}
            />
            <Dropdown
              value={mcpScope}
              ariaLabel="MCP scope"
              options={[
                { value: "project", label: "Project" },
                { value: "user", label: "User" },
              ]}
              onChange={setMcpScope}
            />
            <Dropdown
              value={mcpType}
              ariaLabel="MCP type"
              options={[
                { value: "stdio", label: "STDIO" },
                { value: "http", label: "HTTP" },
                { value: "sse", label: "SSE" },
              ]}
              onChange={setMcpType}
            />
          </div>
          <input
            required
            placeholder={
              mcpType === "stdio" ? "절대 실행 파일 경로" : "HTTPS URL"
            }
            value={mcpEndpoint}
            onChange={(event) => setMcpEndpoint(event.target.value)}
          />
          {mcpType === "stdio" && (
            <textarea
              placeholder="인수 — 한 줄에 하나"
              value={mcpArgs}
              onChange={(event) => setMcpArgs(event.target.value)}
            />
          )}
          <small>환경변수와 인증 헤더는 보안상 앱에서 입력하지 않습니다.</small>
          <button
            className="button-primary"
            type="submit"
            disabled={Boolean(busy)}
          >
            추가
          </button>
        </form>
        <div className="management-list">
          <h3>등록된 서버</h3>
          {snapshot.mcpServers.length === 0 ? (
            <p>등록된 MCP 서버가 없습니다.</p>
          ) : (
            snapshot.mcpServers.map((server) => (
              <article key={`${server.scope}-${server.name}`}>
                <span>
                  <strong>{server.name}</strong>
                  <small>
                    {server.scope} · {server.type} ·{" "}
                    {server.status ?? (server.enabled ? "enabled" : "disabled")}
                  </small>
                </span>
                <button
                  className="button-danger"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    if (window.confirm(`${server.name} MCP 서버를 제거할까요?`))
                      void mutate(`mcp-${server.name}`, () =>
                        bridge.removeMcpServer(
                          workspace,
                          server.scope,
                          server.name,
                        ),
                      );
                  }}
                >
                  제거
                </button>
              </article>
            ))
          )}
        </div>
      </div>
    );
  }

  if (tab === "skills") {
    return (
      <div className="management-panel">
        <form
          className="management-form"
          onSubmit={(event) => {
            event.preventDefault();
            const target = pluginTarget.trim();
            if (
              !target ||
              !window.confirm(
                `${target} 패키지의 코드를 ${pluginScope} 범위에 설치하고 실행 가능하게 할까요? 신뢰하는 정확한 버전인지 확인하세요.`,
              )
            )
              return;
            void mutate(`plugin-install-${target}`, () =>
              bridge.installPlugin(workspace, target, pluginScope),
            ).then(() => setPluginTarget(""));
          }}
        >
          <h3>Plugin 설치</h3>
          <div>
            <input
              required
              placeholder="정확한 npm 버전: package@1.2.3"
              value={pluginTarget}
              onChange={(event) => setPluginTarget(event.target.value)}
            />
            <Dropdown
              value={pluginScope}
              ariaLabel="Plugin scope"
              options={[
                { value: "project", label: "Project" },
                { value: "user", label: "User" },
              ]}
              onChange={setPluginScope}
            />
            <button
              className="button-primary"
              type="submit"
              disabled={Boolean(busy)}
            >
              검토 후 설치
            </button>
          </div>
          <small>
            태그, latest, Git URL, 로컬 경로는 허용하지 않습니다. 설치된
            플러그인은 GJC 프로세스에서 코드를 실행할 수 있습니다.
          </small>
        </form>
        <div className="management-list">
          <h3>Skills</h3>
          {snapshot.skills.length === 0 ? (
            <p>발견된 스킬이 없습니다.</p>
          ) : (
            snapshot.skills.map((skill) => (
              <article key={`${skill.source}-${skill.name}`}>
                <span>
                  <strong>{skill.name}</strong>
                  <small>
                    {skill.source} · {skill.description || "설명 없음"}
                  </small>
                </span>
              </article>
            ))
          )}
        </div>
        <div className="management-list">
          <h3>Plugins</h3>
          {snapshot.plugins.length === 0 ? (
            <p>설치된 플러그인이 없습니다.</p>
          ) : (
            snapshot.plugins.map((plugin) => (
              <article key={`${plugin.source}-${plugin.name}`}>
                <span>
                  <strong>{plugin.name}</strong>
                  <small>
                    {plugin.source} · {plugin.version ?? "unknown"} ·{" "}
                    {plugin.enabled ? "enabled" : "disabled"}
                  </small>
                </span>
                <div>
                  {plugin.source !== "npm" && (
                    <button
                      className="button-secondary"
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void mutate(`plugin-toggle-${plugin.name}`, () =>
                          bridge.setPluginEnabled(
                            workspace,
                            plugin.name,
                            !plugin.enabled,
                          ),
                        )
                      }
                    >
                      {plugin.enabled ? "비활성화" : "활성화"}
                    </button>
                  )}
                  <button
                    className="button-danger"
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (
                        window.confirm(
                          `${plugin.name} 플러그인을 제거할까요? 설치된 코드가 삭제됩니다.`,
                        )
                      )
                        void mutate(`plugin-remove-${plugin.name}`, () =>
                          bridge.uninstallPlugin(workspace, plugin.name),
                        );
                    }}
                  >
                    제거
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="management-panel">
      <section className="usage-summary">
        <span>
          <strong>{snapshot.usage.requests.toLocaleString()}</strong>
          <small>요청</small>
        </span>
        <span>
          <strong>{snapshot.usage.inputTokens.toLocaleString()}</strong>
          <small>입력 토큰</small>
        </span>
        <span>
          <strong>{snapshot.usage.outputTokens.toLocaleString()}</strong>
          <small>출력 토큰</small>
        </span>
        <span>
          <strong>{(snapshot.usage.cacheRate * 100).toFixed(1)}%</strong>
          <small>캐시율</small>
        </span>
        <span>
          <strong>${snapshot.usage.cost.toFixed(2)}</strong>
          <small>비용</small>
        </span>
      </section>
      <div className="management-list">
        <h3>모델별 사용량</h3>
        {snapshot.usage.models.map((model) => (
          <article key={`${model.provider}-${model.model}`}>
            <span>
              <strong>{model.model}</strong>
              <small>
                {model.provider} · {model.requests.toLocaleString()}회 · $
                {(model.cacheRate * 100).toFixed(1)}% cache
              </small>
            </span>
            <strong>${model.cost.toFixed(2)}</strong>
          </article>
        ))}
      </div>
    </div>
  );
}

export function AutomationPanel({
  defaultWorkspace,
  defaultModel,
}: {
  defaultWorkspace: string;
  defaultModel: string;
}) {
  const bridge = window.agentControlDesktop?.automations;
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [workspace, setWorkspace] = useState(defaultWorkspace);
  const [kind, setKind] = useState<"daily" | "weekdays" | "weekly">("weekdays");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState("1");
  const [modelProfile, setModelProfile] = useState(defaultModel);
  const [thinking, setThinking] = useState("medium");
  const [worktree, setWorktree] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async (): Promise<void> => {
    if (!bridge) return;
    const [items, history] = await Promise.all([
      bridge.list(),
      bridge.listRuns(),
    ]);
    setAutomations(items);
    setRuns(
      history
        .slice()
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
    );
  }, [bridge]);

  useEffect(() => {
    queueMicrotask(
      () =>
        void reload().catch((reason) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
        ),
    );
  }, [reload]);

  async function mutate(
    label: string,
    operation: () => Promise<unknown>,
  ): Promise<void> {
    setBusy(label);
    setError("");
    try {
      await operation();
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  function createAutomation(event: FormEvent): void {
    event.preventDefault();
    if (!bridge) return;
    const input: AutomationInput = {
      name: name.trim(),
      prompt: prompt.trim(),
      workspace: workspace.trim(),
      enabled: true,
      worktree,
      schedule: {
        kind,
        time: time as AutomationInput["schedule"]["time"],
        ...(kind === "weekly" ? { weekday: Number(weekday) } : {}),
      },
      ...(modelProfile.trim() ? { modelProfile: modelProfile.trim() } : {}),
      ...(thinking ? { thinking } : {}),
    };
    void mutate("create", () => bridge.create(input)).then(() => {
      setName("");
      setPrompt("");
    });
  }

  return (
    <div className="automation-panel">
      <form className="automation-form" onSubmit={createAutomation}>
        <h3>예약 작업 만들기</h3>
        <input
          required
          maxLength={200}
          placeholder="자동화 이름"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <textarea
          required
          maxLength={20000}
          placeholder="GJC에 실행할 작업을 구체적으로 작성하세요"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <input
          required
          placeholder="절대 workspace 경로"
          value={workspace}
          onChange={(event) => setWorkspace(event.target.value)}
        />
        <div className="automation-form-grid">
          <Dropdown
            value={kind}
            ariaLabel="자동화 주기"
            options={[
              { value: "daily", label: "매일" },
              { value: "weekdays", label: "평일" },
              { value: "weekly", label: "매주" },
            ]}
            onChange={setKind}
          />
          {kind === "weekly" && (
            <Dropdown
              value={weekday}
              ariaLabel="실행 요일"
              options={[
                { value: "0", label: "일요일" },
                { value: "1", label: "월요일" },
                { value: "2", label: "화요일" },
                { value: "3", label: "수요일" },
                { value: "4", label: "목요일" },
                { value: "5", label: "금요일" },
                { value: "6", label: "토요일" },
              ]}
              onChange={setWeekday}
            />
          )}
          <input
            required
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
          />
        </div>
        <div className="automation-form-grid">
          <input
            placeholder="모델 프로필"
            value={modelProfile}
            onChange={(event) => setModelProfile(event.target.value)}
          />
          <Dropdown
            value={thinking}
            ariaLabel="자동화 추론 effort"
            options={[
              { value: "off", label: "Off" },
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
              { value: "xhigh", label: "XHigh" },
              { value: "max", label: "Max" },
            ]}
            onChange={setThinking}
          />
        </div>
        <label className="automation-check">
          <input
            type="checkbox"
            checked={worktree}
            onChange={(event) => setWorktree(event.target.checked)}
          />
          <span>
            <strong>별도 worktree에서 실행</strong>
            <small>
              예약 작업이 현재 작업 폴더를 직접 건드리지 않게 격리합니다.
            </small>
          </span>
        </label>
        <button
          className="button-primary"
          type="submit"
          disabled={!bridge || Boolean(busy)}
        >
          자동화 추가
        </button>
      </form>
      {error && <p className="diff-error">{error}</p>}
      <section className="automation-list">
        <h3>등록된 자동화</h3>
        {automations.length === 0 && <p>등록된 자동화가 없습니다.</p>}
        {automations.map((automation) => {
          const latest = runs.find((run) => run.automationId === automation.id);
          return (
            <article key={automation.id}>
              <header>
                <span>
                  <strong>{automation.name}</strong>
                  <small>
                    {automation.schedule.kind} · {automation.schedule.time} ·{" "}
                    {automation.worktree ? "worktree" : "workspace"}
                  </small>
                </span>
                <button
                  className={`automation-toggle ${automation.enabled ? "is-enabled" : ""}`}
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    if (bridge)
                      void mutate(`toggle-${automation.id}`, () =>
                        bridge.updateEnabled(
                          automation.id,
                          !automation.enabled,
                        ),
                      );
                  }}
                >
                  {automation.enabled ? "활성" : "중지"}
                </button>
              </header>
              <p>{automation.prompt}</p>
              <small>
                {automation.nextRunAt
                  ? `다음 실행 ${new Date(automation.nextRunAt).toLocaleString("ko-KR")}`
                  : "예약 중지됨"}
                {latest ? ` · 최근 ${latest.status}` : ""}
              </small>
              <footer>
                <button
                  className="button-secondary"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    if (bridge)
                      void mutate(`run-${automation.id}`, () =>
                        bridge.runNow(automation.id),
                      );
                  }}
                >
                  <Play size={12} /> 지금 실행
                </button>
                <button
                  className="button-danger"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    if (
                      bridge &&
                      window.confirm(`${automation.name} 자동화를 삭제할까요?`)
                    )
                      void mutate(`delete-${automation.id}`, () =>
                        bridge.delete(automation.id),
                      );
                  }}
                >
                  <Trash2 size={12} /> 삭제
                </button>
              </footer>
              {latest && (latest.output || latest.error) && (
                <details>
                  <summary>최근 실행 결과</summary>
                  <pre>{latest.output || latest.error}</pre>
                </details>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}
