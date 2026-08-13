import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { ensureQaSession, loadAuthState, signOutIfSupported } from "./auth";
import { AuthScreen } from "./AuthScreen";
import { OperationsPanel } from "./OperationsPanel";
import { ProjectsCommandCenter } from "./ProjectsCommandCenter";
import { CreateProjectPage } from "./CreateProjectPage";
import { ProjectEmptyState } from "./ProjectEmptyState";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { GlobalPage } from "./GlobalRail";
import type { GlobalDestination } from "./GlobalRail";
import { GlobalActivityPage } from "./GlobalActivityPage";
import { ApprovalsPage } from "./ApprovalsPage";
import { SettingsPage } from "./SettingsPage";
import { countPendingDecisions } from "./globalFeed";
import { draftFromBrief } from "./conversation";
import { describeRuntime, describeVersions } from "./stacks";
import { starterProjectDraft, starterRunDraft, stateCopy, taskTypeOptions, workspaceTabs } from "./data";
import {
  countOpenRecommendations,
  countOpenRisks,
  getActiveRun,
  getEnvironmentName,
  getProjectById,
  getRunPhases,
  getRunProgress,
  getRunStateNarrative,
  getRunSystemReaction,
  taskTypeToTitle,
} from "./lib";
import { workspaceRepository } from "./repository";
import { isAuthGateRequired, isDemoModeAllowed, isMisconfiguredProduction, resolveOpsEnv } from "./env";
import { createSeedWorkspace } from "./seed";
import type {
  AuthState,
  Organization,
  Project,
  ProjectDraft,
  Recommendation,
  RepositoryHealth,
  Run,
  RunDraft,
  WorkspaceTab,
  WorkspaceView,
} from "./types";

function App() {
  const opsEnv = resolveOpsEnv();
  const demoAllowed = isDemoModeAllowed(opsEnv);
  const misconfiguredProduction = isMisconfiguredProduction(opsEnv);
  // The first paint must never show demo content: start empty and only fill in
  // once the real workspace has been read.
  const seedWorkspace = createSeedWorkspace();
  const emptyWorkspace: Organization = { ...seedWorkspace, projects: [] };
  const [workspace, setWorkspace] = useState<Organization>(emptyWorkspace);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("active_run");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("home");
  const [isReady, setIsReady] = useState(false);
  const [draft, setDraft] = useState<RunDraft>(starterRunDraft(seedWorkspace.projects[0]?.environments[0]?.id ?? ""));
  const [projectDraft, setProjectDraft] = useState<ProjectDraft>(starterProjectDraft());
  const [saveMessage, setSaveMessage] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [workspaceSurface, setWorkspaceSurface] = useState<"conversation" | "access">("conversation");
  const [startInNewTask, setStartInNewTask] = useState(false);
  const [repositoryHealth, setRepositoryHealth] = useState<RepositoryHealth>({
    adapter: "demo",
    ok: true,
    message: "Loading repository health...",
  });
  const [authState, setAuthState] = useState<AuthState>({
    adapter: "demo",
    isAuthenticated: false,
    userEmail: null,
    userId: null,
    role: null,
    status: "loading",
    message: "Loading auth state...",
  });

  useEffect(() => {
    let cancelled = false;

    const hydrateWorkspace = async () => {
      // Temporary QA mode signs the shared QA account in before anything reads.
      await ensureQaSession();
      const [health, auth] = await Promise.all([
        workspaceRepository.health(),
        loadAuthState(),
      ]);

      if (cancelled) {
        return;
      }

      setRepositoryHealth(health);
      setAuthState(auth);

      try {
        const stored = await workspaceRepository.loadWorkspace();

        if (cancelled) {
          return;
        }

        setWorkspace(stored);
        setSelectedProjectId((current) => current ?? stored.projects[0]?.id ?? null);
        setIsReady(true);
      } catch (error) {
        if (cancelled) {
          return;
        }

        const detail = error instanceof Error ? error.message : "Workspace failed to load.";

        if (demoAllowed) {
          setWorkspace(createSeedWorkspace());
          setSaveMessage(detail);
          setIsReady(true);
          return;
        }

        // Production never degrades into a usable demo workspace.
        setFatalError(detail);
        setIsReady(true);
      }
    };

    void hydrateWorkspace();

    return () => {
      cancelled = true;
    };
    // `demoAllowed` is derived from build-time env and never changes at runtime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedProject = getProjectById(workspace, selectedProjectId);
  const activeRun = getActiveRun(selectedProject);

  useEffect(() => {
    if (!selectedProject) {
      return;
    }

    setDraft((current) => ({
      ...current,
      environmentId: current.environmentId || selectedProject.environments[0]?.id || "",
    }));
  }, [selectedProject]);

  const handleCreateRun = async () => {
    if (!selectedProject) {
      return;
    }

    const nextWorkspace = await workspaceRepository.createRun(selectedProject.id, draft);
    const nextProject = getProjectById(nextWorkspace, selectedProject.id);
    const newRun = nextProject?.runs[0];

    setWorkspace(nextWorkspace);
    setWorkspaceView("workspace");
    setActiveTab("active_run");
    if (newRun) {
      setSaveMessage(`New ${taskTypeToTitle(newRun.taskType).toLowerCase()} run created for ${selectedProject.name}.`);
    }
    setDraft(starterRunDraft(selectedProject.environments[0]?.id ?? ""));
  };

  const handleFirstBrief = async (brief: string) => {
    if (!selectedProject) {
      return;
    }

    const nextWorkspace = await workspaceRepository.createRun(selectedProject.id, draftFromBrief(selectedProject, brief));
    setWorkspace(nextWorkspace);
    setStartInNewTask(false);
    setWorkspaceView("workspace");
  };

  const handleCreateProject = async () => {
    // One project per intent. Without this guard a repeated click (or a
    // key-repeat on the submit button) inserts the same project many times.
    if (creatingProject) return;
    const wantedName = (projectDraft.name || projectDraft.clientName).trim().toLowerCase();

    setCreatingProject(true);
    try {
      const nextWorkspace = await workspaceRepository.createProject(projectDraft);
      // Projects come back ordered by name, so find the one we just created
      // instead of assuming it is first.
      const nextProject =
        nextWorkspace.projects.find((project) => project.name.trim().toLowerCase() === wantedName) ??
        nextWorkspace.projects[0];

      setWorkspace(nextWorkspace);
      setSelectedProjectId(nextProject?.id ?? null);
      setWorkspaceView("project_home");
      setActiveTab("active_run");
      setProjectDraft(starterProjectDraft());
      setSaveMessage(`Project created for ${nextProject?.name ?? "the new site"}.`);
    } catch (error) {
      setSaveMessage(
        `Could not create the project: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } finally {
      setCreatingProject(false);
    }
  };

  const projectEnvironment = selectedProject?.environments.find((environment) => environment.id === activeRun?.environmentId) ?? selectedProject?.environments[0];
  const phaseDetails = activeRun ? stateCopy[activeRun.state] : null;
  const projectRecommendations = selectedProject
    ? [
        ...selectedProject.recommendations,
        ...selectedProject.runs.flatMap((run) => run.recommendations),
      ]
    : [];
  const canCreateRun = authState.isAuthenticated && authState.role !== "viewer";
  // Project creation follows the same gate as the rest of the app: a real
  // session in production, the demo operator only under an explicit demo build.
  const canCreateProject = (authState.isAuthenticated || demoAllowed) && authState.role !== "viewer";

  // Fail closed. The gate is only relaxed by an explicit non-production demo
  // opt-in (`VITE_OPS_REPOSITORY_ADAPTER=demo`); production builds always
  // require a real authenticated session.
  const authGateEnabled = isAuthGateRequired(opsEnv);

  const operatorLabel = authState.userEmail ?? "Operator";
  const approvalsCount = countPendingDecisions(workspace);

  const openProjectById = (projectId: string) => {
    const project = getProjectById(workspace, projectId);
    setSelectedProjectId(projectId);
    setStartInNewTask(false);
    setWorkspaceSurface("conversation");
    setWorkspaceView(project && project.runs.length === 0 ? "project_home" : "workspace");
    setActiveTab("active_run");
  };

  const navigateGlobal = (destination: GlobalDestination) => {
    setSaveMessage("");
    setWorkspaceView(
      destination === "projects"
        ? "home"
        : destination === "activity"
          ? "global_activity"
          : destination === "approvals"
            ? "approvals"
            : "settings",
    );
  };

  if (misconfiguredProduction) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-brand">
            <p className="eyebrow">Ops</p>
            <h1>Configuration required</h1>
            <p>
              This production build has no Supabase configuration. Set the public Supabase URL and
              publishable key for this deployment. Demo data is never served in production.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // A signed-out visitor is the ordinary case, not a failure: the workspace
  // load failing with no session means "sign in", so the gate is checked
  // before any error surface.
  if (authGateEnabled && !authState.isAuthenticated && authState.status !== "loading") {
    return (
      <AuthScreen
        onAuthed={async () => {
          const auth = await loadAuthState();
          setAuthState(auth);
          setFatalError(null);
          try {
            const stored = await workspaceRepository.loadWorkspace();
            setWorkspace(stored);
            setSelectedProjectId(stored.projects[0]?.id ?? null);
          } catch (error) {
            setFatalError(error instanceof Error ? error.message : "Workspace failed to load.");
          }
        }}
      />
    );
  }

  // Signed in, but the workspace could not be read: say so plainly rather than
  // rendering an empty command center that looks like "no projects yet".
  if (fatalError) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-brand">
            <p className="eyebrow">Ops</p>
            <h1>Workspace unavailable</h1>
            <p>{fatalError}</p>
            <p>Check this deployment's Supabase configuration, then reload.</p>
          </div>
        </div>
      </div>
    );
  }

  // Hold the first paint until the real workspace has been read, so nothing
  // stale or placeholder flashes on load.
  if (!isReady) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-brand">
            <p className="eyebrow">Ops</p>
            <h1>Loading workspace</h1>
          </div>
        </div>
      </div>
    );
  }

  return (
    workspaceView === "home" ? (
      <ProjectsCommandCenter
        workspace={workspace}
        authState={authState}
        selectedProjectId={selectedProjectId}
        onSelectProject={(projectId) => {
          setSelectedProjectId(projectId);
          setSaveMessage("");
        }}
        onOpenProject={(projectId) => {
          openProjectById(projectId);
        }}
        onCreateProject={() => {
          setSaveMessage("");
          setWorkspaceView("create_project");
        }}
        onNewTask={(projectId) => {
          setSelectedProjectId(projectId);
          setSaveMessage("");
          setStartInNewTask(true);
          setWorkspaceSurface("conversation");
          setWorkspaceView("workspace");
        }}
        onNavigate={navigateGlobal}
      />
    ) : workspaceView === "global_activity" ? (
      <GlobalPage active="activity" onNavigate={navigateGlobal} operator={operatorLabel} approvalsCount={approvalsCount}>
        <GlobalActivityPage workspace={workspace} onOpenProject={openProjectById} />
      </GlobalPage>
    ) : workspaceView === "approvals" ? (
      <GlobalPage active="approvals" onNavigate={navigateGlobal} operator={operatorLabel} approvalsCount={approvalsCount}>
        <ApprovalsPage workspace={workspace} onOpenProject={openProjectById} />
      </GlobalPage>
    ) : workspaceView === "settings" ? (
      <GlobalPage active="settings" onNavigate={navigateGlobal} operator={operatorLabel} approvalsCount={approvalsCount}>
        <SettingsPage
          workspace={workspace}
          authState={authState}
          repositoryHealth={repositoryHealth}
          onSignOut={async () => {
            await signOutIfSupported();
            setAuthState({
              adapter: authState.adapter,
              isAuthenticated: false,
              userEmail: null,
              userId: null,
              role: null,
              status: "ready",
              message: "Signed out.",
            });
            setWorkspaceView("home");
          }}
        />
      </GlobalPage>
    ) : workspaceView === "create_project" ? (
      <CreateProjectPage
        canCreateProject={canCreateProject}
        isCreating={creatingProject}
        draft={projectDraft}
        onBack={() => {
          setSaveMessage("");
          setWorkspaceView("home");
        }}
        onCreateProject={handleCreateProject}
        onDraftChange={setProjectDraft}
        saveMessage={saveMessage}
      />
    ) : workspaceView === "project_home" && selectedProject ? (
      <ProjectEmptyState
        project={selectedProject}
        onBackToProjects={() => {
          setSaveMessage("");
          setWorkspaceView("home");
        }}
        onSubmitBrief={handleFirstBrief}
        onOpenAccess={() => {
          setWorkspaceSurface("access");
          setWorkspaceView("workspace");
        }}
      />
    ) : workspaceView === "workspace" && selectedProject ? (
      <ProjectWorkspace
        project={selectedProject}
        canWrite={canCreateProject}
        startInNewTask={startInNewTask}
        initialSurface={workspaceSurface}
        onBackToProjects={() => {
          setSaveMessage("");
          setStartInNewTask(false);
          setWorkspaceView("home");
        }}
        onWorkspaceUpdate={(next) => {
          setStartInNewTask(false);
          setWorkspace(next);
        }}
      />
    ) : (
    <div className={`app-shell ${railOpen ? "rail-is-open" : ""}`}>
      <header className="mobile-topbar">
        <button
          className="rail-toggle"
          aria-expanded={railOpen}
          aria-controls="tt-rail"
          onClick={() => setRailOpen((open) => !open)}
        >
          <span className="rail-toggle-bars" aria-hidden="true" />
          {railOpen ? "Close" : "Menu"}
        </button>
        <div className="mobile-topbar-title">
          <p className="eyebrow">Ops</p>
          <strong>{selectedProject?.name ?? "Command center"}</strong>
        </div>
      </header>

      <button
        className="rail-scrim"
        aria-label="Close navigation"
        tabIndex={railOpen ? 0 : -1}
        onClick={() => setRailOpen(false)}
      />

      <aside className="rail" id="tt-rail">
        <div className="rail-brand">
          <img src="/trust-tai-logo-white.png" alt="Trust Tai" className="tt-rail-logo" />
          <p className="eyebrow">Ops</p>
          <h1>Engineering Command Center</h1>
          <p className="rail-copy">
            Calm command center for engineering work. Careful execution, visible guardrails, operator-first design.
          </p>
          <div className="brand-chip">
            <span className="brand-mark">TT</span>
            <div>
              <strong>{workspace.subdomain}</strong>
              <small>Application layer around senior operator behavior</small>
            </div>
          </div>
        </div>

        <section className="rail-section">
          <div className="section-head">
            <div>
              <p className="eyebrow">Navigation</p>
              <h2>Command center</h2>
            </div>
          </div>
          <div className="rail-nav">
            <button
              className="rail-nav-button is-active"
              onClick={() => {
                setWorkspaceView("home");
                setSaveMessage("");
                setRailOpen(false);
              }}
            >
              <strong>Projects</strong>
              <span>Back to the project inbox</span>
            </button>
            <button
              className="rail-nav-button"
              onClick={() => {
                setWorkspaceView("create_project");
                setSaveMessage("");
                setRailOpen(false);
              }}
            >
              <strong>New Project</strong>
              <span>Add a site in under a minute</span>
            </button>
          </div>
        </section>

        <section className="rail-section">
          <div className="section-head">
            <div>
              <p className="eyebrow">Projects</p>
              <h2>Multi-project workspace</h2>
            </div>
            <span className="pill pill-soft">{isReady ? workspace.projects.length : "..."}</span>
          </div>

          <div className="project-list">
            {workspace.projects.map((project) => {
              const openRisks = countOpenRisks(project);
              const openRecommendations = countOpenRecommendations(project);
              const latestRun = project.runs[0];
              const selected = project.id === selectedProjectId;

              return (
                <button
                  key={project.id}
                  className={`project-card ${selected ? "is-selected" : ""}`}
                  onClick={() => {
                    setSelectedProjectId(project.id);
                    setWorkspaceView("workspace");
                    setSaveMessage("");
                    setRailOpen(false);
                  }}
                >
                  <div className="project-top">
                    <div>
                      <strong>{project.name}</strong>
                      <span>{project.primaryDomain}</span>
                    </div>
                    <span className={`health health-${project.environmentHealth}`}>{project.environmentHealth.replace("_", " ")}</span>
                  </div>
                  <p>{latestRun ? latestRun.title : "No active run yet."}</p>
                  <div className="project-metrics">
                    <span>{openRisks} open risks</span>
                    <span>{openRecommendations} recommendations</span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rail-section">
          <div className="section-head">
            <div>
              <p className="eyebrow">Auth</p>
              <h2>Operator identity</h2>
            </div>
          </div>
          <div className="list-card">
            <div className="list-card-top">
              <strong>{authState.role ?? "guest"}</strong>
              <span className={`pill ${authState.isAuthenticated ? "pill-safe" : "pill-high_risk"}`}>
                {authState.isAuthenticated ? "signed in" : "not signed in"}
              </span>
            </div>
            <p>{authState.message}</p>
            {authState.userEmail ? <small>{authState.userEmail}</small> : null}
            {authState.adapter === "supabase" && authState.isAuthenticated ? (
              <button
                className="ghost-button"
                onClick={async () => {
                  await signOutIfSupported();
                  setAuthState(await loadAuthState());
                }}
              >
                Sign out
              </button>
            ) : null}
          </div>
        </section>

        <section className="rail-section">
          <div className="section-head">
            <div>
              <p className="eyebrow">Repository</p>
              <h2>Persistence state</h2>
            </div>
          </div>
          <div className="list-card">
            <div className="list-card-top">
              <strong>{repositoryHealth.adapter}</strong>
              <span className={`pill ${repositoryHealth.ok ? "pill-safe" : "pill-high_risk"}`}>
                {repositoryHealth.ok ? "healthy" : "attention"}
              </span>
            </div>
            <p>{repositoryHealth.message}</p>
          </div>
        </section>

        <section className="rail-section">
          <div className="section-head">
            <div>
              <p className="eyebrow">Guardrails</p>
              <h2>What keeps the site safe</h2>
            </div>
          </div>
          <ul className="bullet-list">
            <li>No risky change before backup confirmation.</li>
            <li>No execution before diagnosis and plan artifacts exist.</li>
            <li>No completion without QA or an approved waiver.</li>
            <li>No project memory crossover between clients.</li>
          </ul>
        </section>
      </aside>

      <main className="workspace">
        {workspaceView === "first_run" && selectedProject ? (
          <FirstRunPage
            canCreateRun={canCreateRun}
            draft={draft}
            project={selectedProject}
            onBackToWorkspace={() => setWorkspaceView("workspace")}
            onCreateRun={handleCreateRun}
            onDraftChange={setDraft}
            saveMessage={saveMessage}
          />
        ) : (
          <>
            <header className="workspace-head card">
              <div>
                <p className="eyebrow">Command Center</p>
                <h2>{selectedProject?.name ?? "Select a project"}</h2>
                <p className="headline-copy">
                  {selectedProject
                    ? `${selectedProject.clientName} runs with project memory, visible run states, and operator-first guardrails.`
                    : "Pick a project to inspect its memory, run state, QA proof, and recommendations."}
                </p>
              </div>

              {selectedProject ? (
                <div className="headline-stats">
                  <div className="stat-card">
                    <span>Primary environment</span>
                    <strong>{projectEnvironment?.name ?? "Unknown"}</strong>
                    <small>{projectEnvironment?.hostingProvider ?? "No host recorded yet"}</small>
                  </div>
                  <div className="stat-card">
                    <span>Current run</span>
                    <strong>{phaseDetails?.label ?? "No active run"}</strong>
                    <small>{activeRun?.riskLevel.replace("_", " ") ?? "No risk level yet"}</small>
                  </div>
                  <div className="stat-card">
                    <span>Operator ask</span>
                    <strong>{activeRun?.nextAction ?? "Start a new run"}</strong>
                    <small>{activeRun?.operatorPrompt ?? "The system will keep the next step obvious."}</small>
                  </div>
                  <div className="stat-card">
                    <span>Permission posture</span>
                    <strong>{canCreateRun ? "Write-capable" : "Read-only / blocked"}</strong>
                    <small>{authState.role ? `Current role: ${authState.role}` : "Auth needs to resolve before risky actions."}</small>
                  </div>
                </div>
              ) : null}
            </header>

            <section className="workspace-grid">
              <div className="main-column">
                <div className="tab-row card">
                  {workspaceTabs.map((tab) => (
                    <button
                      key={tab.id}
                      className={`tab-chip ${tab.id === activeTab ? "is-active" : ""}`}
                      onClick={() => setActiveTab(tab.id)}
                    >
                      <strong>{tab.label}</strong>
                      <span>{tab.detail}</span>
                    </button>
                  ))}
                </div>

                {selectedProject ? (
                  <>
                    {activeTab === "overview" ? <OverviewPanel project={selectedProject} /> : null}
                    {activeTab === "active_run" ? <RunPanel project={selectedProject} run={activeRun} canWrite={canCreateRun} onWorkspaceUpdate={(next) => { setWorkspace(next); }} setSaveMessage={setSaveMessage} /> : null}
                    {activeTab === "qa" ? <QaPanel project={selectedProject} run={activeRun} /> : null}
                    {activeTab === "history" ? <HistoryPanel project={selectedProject} recommendations={projectRecommendations} /> : null}
                    {activeTab === "memory" ? <MemoryPanel project={selectedProject} /> : null}
                  </>
                ) : (
                  <div className="card empty-card">
                    <p>Select a project to begin.</p>
                  </div>
                )}
              </div>

              <div className="side-column">
                <section className="card builder-card">
                  <div className="section-head">
                    <div>
                      <p className="eyebrow">New Run</p>
                      <h3>Guided intake</h3>
                    </div>
                    <span className="pill">V1</span>
                  </div>

                  <div className="field-stack">
                    <label className="field">
                      <span>Run title</span>
                      <input
                        value={draft.title}
                        onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                        placeholder="Example: Malware investigation after suspicious admin user"
                      />
                    </label>

                    <label className="field">
                      <span>Task type</span>
                      <select
                        value={draft.taskType}
                        onChange={(event) => setDraft((current) => ({ ...current, taskType: event.target.value as RunDraft["taskType"] }))}
                      >
                        {taskTypeOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <small>{taskTypeOptions.find((option) => option.value === draft.taskType)?.hint}</small>
                    </label>

                    <label className="field">
                      <span>Task summary</span>
                      <textarea
                        rows={4}
                        value={draft.taskSummary}
                        onChange={(event) => setDraft((current) => ({ ...current, taskSummary: event.target.value }))}
                        placeholder="Describe the issue in plain English so the system can shape the run."
                      />
                    </label>

                    <div className="field two-up">
                      <label>
                        <span>Environment</span>
                        <select
                          value={draft.environmentId}
                          onChange={(event) => setDraft((current) => ({ ...current, environmentId: event.target.value }))}
                        >
                          {(selectedProject?.environments ?? []).map((environment) => (
                            <option key={environment.id} value={environment.id}>
                              {environment.name} · {environment.type}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label>
                        <span>Urgency</span>
                        <select
                          value={draft.urgency}
                          onChange={(event) => setDraft((current) => ({ ...current, urgency: event.target.value as RunDraft["urgency"] }))}
                        >
                          <option value="normal">Normal</option>
                          <option value="urgent">Urgent</option>
                          <option value="critical">Critical</option>
                        </select>
                      </label>
                    </div>

                    <div className="check-grid">
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={draft.accessReady}
                          onChange={(event) => setDraft((current) => ({ ...current, accessReady: event.target.checked }))}
                        />
                        <div>
                          <strong>Required access is on hand</strong>
                          <small>WordPress admin, SFTP, SSH, or portal access is ready enough to validate.</small>
                        </div>
                      </label>

                      <label className="check">
                        <input
                          type="checkbox"
                          checked={draft.backupConfirmed}
                          onChange={(event) => setDraft((current) => ({ ...current, backupConfirmed: event.target.checked }))}
                        />
                        <div>
                          <strong>Backup or restore point confirmed</strong>
                          <small>The run can move past the backup gate if risk requires it.</small>
                        </div>
                      </label>
                    </div>
                  </div>

                  <div className="policy-preview">
                    <strong>System reaction</strong>
                    <p>{getRunSystemReaction(draft)}</p>
                  </div>

                  <button className="primary-button" onClick={handleCreateRun} disabled={!selectedProject || !canCreateRun}>
                    Start structured run
                  </button>

                  {!canCreateRun ? (
                    <p className="save-message">
                      Run creation is blocked until the operator is authenticated with a role above `viewer`.
                    </p>
                  ) : null}

                  {saveMessage ? <p className="save-message">{saveMessage}</p> : null}
                </section>

                <section className="card guidance-card">
                  <div className="section-head">
                    <div>
                      <p className="eyebrow">Agent Needs</p>
                      <h3>Keep the next move obvious</h3>
                    </div>
                  </div>

                  <div className="guidance-stack">
                    <div className="guidance-item">
                      <strong>Human clarity</strong>
                      <p>{activeRun?.operatorPrompt ?? "The agent will translate the run into a clear next step once a project is selected."}</p>
                    </div>
                    <div className="guidance-item">
                      <strong>Guardrail reason</strong>
                      <p>{phaseDetails?.guardrail ?? "Guardrails show up once a run exists."}</p>
                    </div>
                    <div className="guidance-item">
                      <strong>What the system remembers</strong>
                      <p>
                        {selectedProject
                          ? `${selectedProject.memoryEntries.length} durable memory notes, ${selectedProject.qaRules.length} QA rules, and ${selectedProject.accessMethods.length} access paths are available for this project.`
                          : "Project memory loads after project selection."}
                      </p>
                    </div>
                  </div>
                </section>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
    )
  );
}

function FirstRunPage({
  canCreateRun,
  draft,
  project,
  onBackToWorkspace,
  onCreateRun,
  onDraftChange,
  saveMessage,
}: {
  canCreateRun: boolean;
  draft: RunDraft;
  project: Project;
  onBackToWorkspace: () => void;
  onCreateRun: () => void;
  onDraftChange: Dispatch<SetStateAction<RunDraft>>;
  saveMessage: string;
}) {
  const selectedEnvironment = project.environments.find((environment) => environment.id === draft.environmentId) ?? project.environments[0];

  return (
    <section className="create-project-page">
      <div className="create-project-topbar">
        <div className="breadcrumb-row">
          <span>Projects</span>
          <span>/</span>
          <span>{project.name}</span>
          <span>/</span>
          <strong>First Run</strong>
        </div>
        <div className="topbar-status">
          <span className="status-dot" />
          <div>
            <strong>Project created</strong>
            <small>Ready for the first guided pass</small>
          </div>
        </div>
      </div>

      <div className="create-project-shell">
        <div className="create-project-main">
          <button className="back-link" onClick={onBackToWorkspace}>
            Back to workspace
          </button>

          <div className="create-project-hero">
            <div>
              <h2>Start the first run</h2>
              <p>
                The first run should establish truth, not rush into changes. Use it to verify access,
                map the environment, and capture the memory this project will need later.
              </p>
            </div>
            <div className="hero-orbit" aria-hidden="true" />
          </div>

          <section className="create-section">
            <div className="create-section-head">
              <span className="step-badge">1</span>
              <div>
                <h3>Recommended starting posture</h3>
                <p>This first pass is designed to be readable by the operator and safe for the site.</p>
              </div>
            </div>

            <div className="overview-grid">
              <div className="info-card light-surface">
                <span>Project</span>
                <strong>{project.name}</strong>
                <small>{project.primaryDomain}</small>
              </div>
              <div className="info-card light-surface">
                <span>Environment</span>
                <strong>{selectedEnvironment?.name ?? "Production"}</strong>
                <small>{selectedEnvironment?.hostingProvider ?? "Host still being verified"}</small>
              </div>
              <div className="info-card light-surface">
                <span>Access paths</span>
                <strong>{project.accessMethods.length}</strong>
                <small>These are the first doors the system will validate.</small>
              </div>
              <div className="info-card light-surface">
                <span>Default mode</span>
                <strong>Read-only verification</strong>
                <small>Environment Mapping first, before any write-capable run exists.</small>
              </div>
            </div>
          </section>

          <section className="create-section">
            <div className="create-section-head">
              <span className="step-badge">2</span>
              <div>
                <h3>Shape the first run</h3>
                <p>Keep this run focused on access truth, stack truth, and baseline QA truth.</p>
              </div>
            </div>

            <div className="create-form-grid">
              <label className="light-field">
                <span>Run title</span>
                <input
                  value={draft.title}
                  onChange={(event) => onDraftChange((current) => ({ ...current, title: event.target.value }))}
                  placeholder="Initial access verification and environment mapping"
                />
              </label>

              <label className="light-field">
                <span>Task type</span>
                <select
                  value={draft.taskType}
                  onChange={(event) => onDraftChange((current) => ({ ...current, taskType: event.target.value as RunDraft["taskType"] }))}
                >
                  {taskTypeOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <small>{taskTypeOptions.find((option) => option.value === draft.taskType)?.hint}</small>
              </label>
            </div>

            <label className="light-field">
              <span>Run objective</span>
              <textarea
                rows={4}
                value={draft.taskSummary}
                onChange={(event) => onDraftChange((current) => ({ ...current, taskSummary: event.target.value }))}
                placeholder="Describe what the first pass should validate and capture."
              />
            </label>

            <div className="check-grid">
              <label className="check light-check">
                <input
                  type="checkbox"
                  checked={draft.accessReady}
                  onChange={(event) => onDraftChange((current) => ({ ...current, accessReady: event.target.checked }))}
                />
                <div>
                  <strong>Access is ready enough to verify</strong>
                  <small>The system can validate the listed doors instead of starting with access chase.</small>
                </div>
              </label>

              <label className="check light-check">
                <input
                  type="checkbox"
                  checked={draft.backupConfirmed}
                  onChange={(event) => onDraftChange((current) => ({ ...current, backupConfirmed: event.target.checked }))}
                />
                <div>
                  <strong>Backup or restore point is already confirmed</strong>
                  <small>Optional for a read-only first pass, but useful if this run may widen into cautious work.</small>
                </div>
              </label>
            </div>

            <div className="policy-preview light-surface">
              <strong>System reaction</strong>
              <p>{getRunSystemReaction(draft)}</p>
            </div>
          </section>

          <section className="create-section">
            <div className="create-section-head">
              <span className="step-badge">3</span>
              <div>
                <h3>What this run should leave behind</h3>
                <p>The point is not just to inspect. It is to turn inspection into reusable operating context.</p>
              </div>
            </div>

            <div className="split-grid">
              <div className="create-side-card light-card">
                <h3>Memory to capture</h3>
                <div className="step-list">
                  <div className="step-item">
                    <span>1</span>
                    <p>Real environment facts: host, PHP, cache layers, and the current WordPress surface.</p>
                  </div>
                  <div className="step-item">
                    <span>2</span>
                    <p>Fragility notes: custom code hotspots, risky plugins, auth quirks, or missing staging.</p>
                  </div>
                  <div className="step-item">
                    <span>3</span>
                    <p>Baseline QA rules the team should trust before future write-capable work.</p>
                  </div>
                </div>
              </div>

              <div className="create-side-card light-card">
                <h3>Access map in play</h3>
                <div className="stack">
                  {project.accessMethods.length > 0 ? (
                    project.accessMethods.map((access) => (
                      <div key={access.id} className="list-card light-surface">
                        <div className="list-card-top">
                          <strong>{access.label}</strong>
                          <span className={`pill pill-${access.status}`}>{access.status}</span>
                        </div>
                        <p>{access.notes}</p>
                      </div>
                    ))
                  ) : (
                    <div className="list-card light-surface">
                      <strong>No access added yet</strong>
                      <p>This first run will likely open in Access Check so the team can gather the right doors first.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="create-page-actions">
              <button className="text-button" onClick={onBackToWorkspace}>
                Open workspace first
              </button>
              <button className="create-button" onClick={onCreateRun} disabled={!canCreateRun || !draft.title.trim() || !draft.taskSummary.trim()}>
                Start first run
              </button>
            </div>

            {!canCreateRun ? (
              <p className="light-message">
                Run creation is blocked until the operator is authenticated with a role above `viewer`.
              </p>
            ) : null}

            {saveMessage ? <p className="light-message">{saveMessage}</p> : null}
          </section>
        </div>

        <aside className="create-project-sidebar">
          <section className="create-side-card">
            <div className="side-icon">R</div>
            <div>
              <h3>Why this page exists</h3>
              <p>
                New projects fail when onboarding dumps users into a blank dashboard. This handoff keeps the first action obvious and safe.
              </p>
            </div>
          </section>

          <section className="create-side-card side-steps">
            <h3>First-run sequence</h3>
            <div className="step-list">
              <div className="step-item">
                <span>1</span>
                <p>Validate which doors are really open for this environment.</p>
              </div>
              <div className="step-item">
                <span>2</span>
                <p>Map the stack and compare it against what the project claims to be.</p>
              </div>
              <div className="step-item">
                <span>3</span>
                <p>Capture durable memory and sharpen the QA baseline for the team.</p>
              </div>
              <div className="step-item">
                <span>4</span>
                <p>Only then widen into diagnosis or execution-oriented runs if needed.</p>
              </div>
            </div>
          </section>

          <section className="create-side-visual">
            <div className="visual-badge">
              <strong>{draft.taskType === "qa_only" ? "Read-only first pass" : "Custom first run selected"}</strong>
              <small>{draft.backupConfirmed ? "Backup posture is already in hand if this run widens later." : "Backup can stay optional until the run becomes write-capable."}</small>
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

function OverviewPanel({ project }: { project: Project }) {
  const activeRun = getActiveRun(project);

  return (
    <section className="panel-stack">
      <div className="card section-card">
        <div className="section-head">
          <div>
            <p className="eyebrow">Project Overview</p>
            <h3>We already know this project</h3>
          </div>
          <span className={`health health-${project.environmentHealth}`}>{project.environmentHealth.replace("_", " ")}</span>
        </div>

        <div className="overview-grid">
          <div className="info-card">
            <span>Primary domain</span>
            <strong>{project.primaryDomain}</strong>
            <small>{project.clientName}</small>
          </div>
          <div className="info-card">
            <span>Current run state</span>
            <strong>{activeRun ? stateCopy[activeRun.state].label : "No active run"}</strong>
            <small>{activeRun?.title ?? "Start a run to create shared state."}</small>
          </div>
          <div className="info-card">
            <span>Open risk count</span>
            <strong>{countOpenRisks(project)}</strong>
            <small>These risks stay visible outside individual runs.</small>
          </div>
          <div className="info-card">
            <span>Recommended follow-up</span>
            <strong>{countOpenRecommendations(project)}</strong>
            <small>Advice that compounds project wisdom over time.</small>
          </div>
        </div>
      </div>

      <div className="split-grid">
        <div className="card section-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Environments</p>
              <h3>Know exactly what surface you are touching</h3>
            </div>
          </div>
          <div className="stack">
            {project.environments.map((environment) => (
              <div key={environment.id} className="list-card">
                <div className="list-card-top">
                  <strong>{environment.name}</strong>
                  <span className="pill">{environment.type}</span>
                </div>
                <p>{environment.primaryUrl}</p>
                <small>
                  {[environment.hostingProvider, describeVersions(environment), describeRuntime(environment)]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
                <small>{environment.notes}</small>
              </div>
            ))}
          </div>
        </div>

        <div className="card section-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Access Map</p>
              <h3>Which doors are actually open</h3>
            </div>
          </div>
          <div className="stack">
            {project.accessMethods.map((access) => (
              <div key={access.id} className="list-card">
                <div className="list-card-top">
                  <strong>{access.label}</strong>
                  <span className={`pill pill-${access.status}`}>{access.status}</span>
                </div>
                <p>{access.authMethod}</p>
                <small>Last verified: {access.lastVerifiedAt}</small>
                <small>{access.notes}</small>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function RunPanel({ project, run, canWrite, onWorkspaceUpdate, setSaveMessage }: { project: Project; run: Run | null; canWrite: boolean; onWorkspaceUpdate: (next: Organization) => void; setSaveMessage: Dispatch<SetStateAction<string>> }) {
  if (!run) {
    return (
      <div className="card empty-card">
        <p>No active run yet. Use the intake on the right to start one.</p>
      </div>
    );
  }

  const runInbox = project.runs;
  const progress = getRunProgress(run);
  const narrative = getRunStateNarrative(run);
  const backupArtifact = run.artifacts.find((artifact) => artifact.type === "backup_note");
  const latestAction = run.actions[run.actions.length - 1];
  const latestFinding = run.findings[0];
  const latestArtifact = run.artifacts[run.artifacts.length - 1];
  const actionNeededLabel =
    run.state === "paused" || run.approvalRequired
      ? "Action needed"
      : run.state === "complete"
        ? "Run complete"
        : "No action needed";

  const conversationMoments = [
    {
      id: `${run.id}-moment-diagnosis`,
      tone: "agent" as const,
      title: "Engineering Agent",
      time: run.updatedAt,
      body: run.diagnosisSummary,
      detail: run.planSummary,
    },
    {
      id: `${run.id}-moment-operator`,
      tone: "operator" as const,
      title: "Next operator move",
      time: run.startedAt,
      body: run.nextAction,
      detail: run.operatorPrompt,
    },
    {
      id: `${run.id}-moment-status`,
      tone: "agent" as const,
      title: "System status",
      time: run.updatedAt,
      body: backupArtifact
        ? `Backup posture is in hand: ${backupArtifact.summary}`
        : `Backup posture is ${run.backupStatus.replaceAll("_", " ")} for this run.`,
      detail: latestAction?.summary ?? "The run will keep logging meaningful actions as it moves forward.",
    },
  ];

  return (
    <section className="panel-stack">
      <div className="card run-experience-card">
        <aside className="run-conversation-rail">
          <div className="section-head">
            <div>
              <p className="eyebrow">Runs</p>
              <h3>Project feed</h3>
            </div>
          </div>
          <div className="run-conversation-list">
            {runInbox.map((projectRun) => {
              const selected = projectRun.id === run.id;
              const projectRunProgress = getRunProgress(projectRun);

              return (
                <article key={projectRun.id} className={`conversation-preview ${selected ? "is-active" : ""}`}>
                  <div className="conversation-preview-top">
                    <strong>{projectRun.title}</strong>
                    <span className={`pill ${selected ? "pill-soft" : ""}`}>{stateCopy[projectRun.state].label}</span>
                  </div>
                  <p>{projectRun.nextAction}</p>
                  <div className="conversation-preview-meta">
                    <span>{projectRun.updatedAt}</span>
                    <span>{projectRunProgress.progressPercent}%</span>
                  </div>
                </article>
              );
            })}
          </div>
        </aside>

        <div className="run-main-stage">
          <div className="run-stage-head">
            <div>
              <p className="eyebrow">Engineering Agent</p>
              <h3>{run.title}</h3>
              <p className="headline-copy">
                {stateCopy[run.state].tone} {run.taskSummary}
              </p>
            </div>
            <div className="badge-row">
              <span className="pill">{taskTypeToTitle(run.taskType)}</span>
              <span className={`pill pill-risk-${run.riskLevel}`}>{run.riskLevel.replace("_", " ")}</span>
              <span className="pill">{getEnvironmentName(project, run.environmentId)}</span>
            </div>
          </div>

          <div className="run-thread">
            {conversationMoments.map((moment) => (
              <article key={moment.id} className={`thread-card ${moment.tone === "operator" ? "is-operator" : "is-agent"}`}>
                <div className="thread-card-head">
                  <div className={`thread-avatar ${moment.tone === "operator" ? "is-operator" : ""}`}>
                    {moment.tone === "operator" ? "OP" : "AI"}
                  </div>
                  <div>
                    <strong>{moment.title}</strong>
                    <small>{moment.time}</small>
                  </div>
                </div>
                <p>{moment.body}</p>
                <small>{moment.detail}</small>
              </article>
            ))}
          </div>

          <div className="run-progress-card">
            <div className="run-progress-head">
              <div>
                <strong>{progress.currentPhase.label}</strong>
                <small>{narrative.now}</small>
              </div>
              <span>{progress.progressPercent}%</span>
            </div>
            <div className="progress-bar-track">
              <div className="progress-bar-fill" style={{ width: `${progress.progressPercent}%` }} />
            </div>
            <div className="progress-phase-row">
              {progress.phases.map((phase) => (
                <div key={phase.id} className={`progress-phase-chip is-${phase.status}`}>
                  <span className="progress-phase-dot" />
                  <small>{phase.label}</small>
                </div>
              ))}
            </div>
            <div>
              <small className="progress-current-line">Currently: {run.nextAction}</small>
            </div>
          </div>

          <OperationsPanel
            project={project}
            run={run}
            canWrite={canWrite}
            onWorkspaceUpdate={onWorkspaceUpdate}
            setSaveMessage={setSaveMessage}
          />

          <div className="run-composer">
            <input value="" readOnly placeholder="Message the agent..." />
            <div className="run-composer-actions">
              <span>Attach</span>
              <span>Upload</span>
              <span>Terminal</span>
            </div>
          </div>
        </div>

        <aside className="run-task-rail">
          <div className="run-task-card">
            <div>
              <p className="eyebrow">Current Task</p>
              <h3>{run.title}</h3>
              <div className="badge-row">
                <span className={`pill ${run.state === "complete" ? "pill-safe" : run.state === "paused" ? "pill-warning" : "pill-soft"}`}>
                  {actionNeededLabel}
                </span>
              </div>
            </div>
            <div className="run-task-meta">
              <div>
                <span>Started</span>
                <strong>{run.startedAt}</strong>
              </div>
              <div>
                <span>Updated</span>
                <strong>{run.updatedAt}</strong>
              </div>
            </div>

            <div className="run-task-progress">
              <div className="run-task-progress-head">
                <strong>Progress</strong>
                <span>{progress.progressPercent}%</span>
              </div>
              <div className="progress-bar-track is-thin">
                <div className="progress-bar-fill" style={{ width: `${progress.progressPercent}%` }} />
              </div>
            </div>

            <div className="task-phase-list">
              {getRunPhases(run).map((phase) => (
                <div key={phase.id} className={`task-phase-item is-${phase.status}`}>
                  <span className="task-phase-dot" />
                  <div>
                    <strong>{phase.label}</strong>
                    <p>{phase.summary}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="run-side-card">
            <strong>What&apos;s happening now</strong>
            <p>{narrative.now}</p>
            {latestFinding ? (
              <div className="side-note">
                <span className={`pill pill-severity-${latestFinding.severity}`}>{latestFinding.severity}</span>
                <p>{latestFinding.title}</p>
              </div>
            ) : null}
          </div>

          <div className="run-side-card">
            <strong>What happens next</strong>
            <p>{narrative.next}</p>
            <small>{progress.nextPhase ? `Next lawful state: ${progress.nextPhase.label}` : "This run is at the end of its current path."}</small>
          </div>

          <div className="run-side-card">
            <strong>Evidence in play</strong>
            <p>{latestArtifact?.summary ?? "Artifacts and captured proof will surface here as the run matures."}</p>
            <small>{run.approvalRequired ? "This run should surface approval before high-risk execution." : "No extra approval object is blocking the current state."}</small>
          </div>
        </aside>
      </div>
    </section>
  );
}

function QaPanel({ project, run }: { project: Project; run: Run | null }) {
  if (!run) {
    return (
      <div className="card empty-card">
        <p>QA proof appears after the project has a run.</p>
      </div>
    );
  }

  return (
    <section className="panel-stack">
      <div className="card section-card">
        <div className="section-head">
          <div>
            <p className="eyebrow">QA Proof</p>
            <h3>{run.qaReport.verdict.toUpperCase()} verdict</h3>
          </div>
          <span className={`pill pill-verdict-${run.qaReport.verdict}`}>{run.qaReport.verdict}</span>
        </div>
        <p className="headline-copy">{run.qaReport.summary}</p>
      </div>

      <div className="split-grid">
        <div className="card section-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Checks</p>
              <h3>What was tested</h3>
            </div>
          </div>
          <div className="stack">
            {run.qaReport.results.map((result) => (
              <div key={result.id} className="list-card">
                <div className="list-card-top">
                  <strong>{result.name}</strong>
                  <span className={`pill pill-${result.result}`}>{result.result}</span>
                </div>
                <p>{result.notes}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="card section-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Project QA Rules</p>
              <h3>What completion means here</h3>
            </div>
          </div>
          <div className="stack">
            {project.qaRules.map((rule) => (
              <div key={rule.id} className="list-card">
                <div className="list-card-top">
                  <strong>{rule.name}</strong>
                  <span className="pill">{rule.required ? "required" : "optional"}</span>
                </div>
                <p>{rule.description}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card section-card">
        <div className="section-head">
          <div>
            <p className="eyebrow">Residual Risk</p>
            <h3>What still deserves attention</h3>
          </div>
        </div>
        <ul className="bullet-list">
          {run.qaReport.unresolvedRisks.length > 0 ? (
            run.qaReport.unresolvedRisks.map((risk) => <li key={risk}>{risk}</li>)
          ) : (
            <li>No residual QA risk is open in the current report.</li>
          )}
        </ul>
      </div>
    </section>
  );
}

function HistoryPanel({ project, recommendations }: { project: Project; recommendations: Recommendation[] }) {
  return (
    <section className="panel-stack">
      <div className="split-grid">
        <div className="card section-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Recommendations</p>
              <h3>Turn runs into future leverage</h3>
            </div>
          </div>
          <div className="stack">
            {recommendations.map((recommendation) => (
              <div key={recommendation.id} className="list-card">
                <div className="list-card-top">
                  <strong>{recommendation.title}</strong>
                  <div className="badge-row">
                    <span className={`pill pill-priority-${recommendation.priority}`}>{recommendation.priority}</span>
                    <span className="pill">{recommendation.status}</span>
                  </div>
                </div>
                <p>{recommendation.summary}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="card section-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Risk Ledger</p>
              <h3>What is fragile right now</h3>
            </div>
          </div>
          <div className="stack">
            {project.riskFlags.length > 0 ? (
              project.riskFlags.map((risk) => (
                <div key={risk.id} className="list-card">
                  <div className="list-card-top">
                    <strong>{risk.title}</strong>
                    <div className="badge-row">
                      <span className={`pill pill-severity-${risk.severity}`}>{risk.severity}</span>
                      <span className="pill">{risk.status}</span>
                    </div>
                  </div>
                  <p>{risk.summary}</p>
                </div>
              ))
            ) : (
              <p className="muted-copy">No active project-level risks are open.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function MemoryPanel({ project }: { project: Project }) {
  return (
    <section className="panel-stack">
      <div className="card section-card">
        <div className="section-head">
          <div>
            <p className="eyebrow">Project Memory</p>
            <h3>Reusable truth, not noisy run logs</h3>
          </div>
        </div>
        <div className="stack">
          {project.memoryEntries.map((entry) => (
            <div key={entry.id} className="list-card">
              <div className="list-card-top">
                <strong>{entry.title}</strong>
                <div className="badge-row">
                  <span className={`pill pill-priority-${entry.importance}`}>{entry.importance}</span>
                  <span className="pill">{entry.type.replace("_", " ")}</span>
                </div>
              </div>
              <p>{entry.content}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export default App;
