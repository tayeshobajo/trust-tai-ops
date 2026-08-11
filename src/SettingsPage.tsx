import type { AuthState, Organization, RepositoryHealth } from "./types";

type Props = {
  workspace: Organization;
  authState: AuthState;
  repositoryHealth: RepositoryHealth;
};

export function SettingsPage({ workspace, authState, repositoryHealth }: Props) {
  return (
    <div className="global-surface">
      <header className="global-surface-head">
        <p className="eyebrow">Workspace</p>
        <h1>Settings</h1>
        <p className="global-surface-lede">
          A small, deliberate set of controls. Everything about how the agent works safely stays under the hood.
        </p>
      </header>

      <section className="set-block">
        <h2>Workspace</h2>
        <dl className="set-rows">
          <div className="set-row">
            <dt>Display name</dt>
            <dd>{workspace.name}</dd>
          </div>
          <div className="set-row">
            <dt>Descriptor</dt>
            <dd>{workspace.descriptor}</dd>
          </div>
          <div className="set-row">
            <dt>Projects</dt>
            <dd>{workspace.projects.length}</dd>
          </div>
          <div className="set-row">
            <dt>Signed in as</dt>
            <dd>{authState.userEmail ?? "Local operator"}{authState.role ? ` · ${authState.role.replace(/_/g, " ")}` : ""}</dd>
          </div>
        </dl>
        <p className="set-note">Workspace naming is read-only in this version.</p>
      </section>

      <section className="set-block">
        <h2>Notifications</h2>
        <ul className="set-list">
          <li>
            <span>Email me when the agent needs a decision</span>
            <span className="status-chip tone-quiet">Coming later</span>
          </li>
          <li>
            <span>Daily summary of completed work</span>
            <span className="status-chip tone-quiet">Coming later</span>
          </li>
        </ul>
        <p className="set-note">These are placeholders. Nothing is sent and nothing is saved yet.</p>
      </section>

      <section className="set-block">
        <h2>Security &amp; execution</h2>
        <ul className="set-facts">
          <li>Credentials you share are sealed server-side and are never readable from this browser.</li>
          <li>High-risk changes stop and wait for your explicit approval.</li>
          <li>Backups are confirmed before anything is changed on a live site.</li>
          <li>Every action the agent takes is recorded with evidence you can review in Activity.</li>
        </ul>
      </section>

      <section className="set-block">
        <h2>About</h2>
        <dl className="set-rows">
          <div className="set-row">
            <dt>Environment</dt>
            <dd>{import.meta.env.MODE}</dd>
          </div>
          <div className="set-row">
            <dt>Data source</dt>
            <dd>{repositoryHealth.adapter}</dd>
          </div>
          <div className="set-row">
            <dt>Status</dt>
            <dd>{repositoryHealth.message}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}