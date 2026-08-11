import type { DeployPipeline } from "./types";
import { describeBuildTime, rollbackCopy } from "./stacks";

/**
 * How a project ships. One presentation of the deploy protocol, shown wherever
 * the truth is useful — including before any run exists. It is a description,
 * never a control.
 */
export function ProjectPipelineSummary({
  pipeline,
  heading = "How this ships",
  className = "",
}: {
  pipeline: DeployPipeline | undefined;
  heading?: string;
  className?: string;
}) {
  if (!pipeline) return null;

  const facts: Array<[string, string]> = [
    ["Staging", pipeline.hasStaging ? pipeline.stagingUrl ?? "Linked" : "No staging environment"],
    ["Production", pipeline.productionUrl],
    ["Branch gated", pipeline.branchGated ? "Yes — merges decide releases" : "No branch gate"],
    [
      "Auto deploy",
      `Staging ${pipeline.autoDeployStaging ? "deploys automatically" : "is deployed by hand"} · Production ${
        pipeline.autoDeployProduction ? "deploys automatically" : "is deployed by hand"
      }`,
    ],
    ["Build", describeBuildTime(pipeline)],
    ["Rollback", rollbackCopy[pipeline.rollbackStrategy]],
  ];

  return (
    <section className={`pw-context-block pipeline-summary ${className}`.trim()}>
      <p className="eyebrow">{heading}</p>

      <ol className="pw-pipeline">
        {pipeline.steps.map((step) => (
          <li key={step.kind}>
            <strong>{step.label}</strong>
            <span>{step.detail}</span>
          </li>
        ))}
      </ol>

      <dl className="pipeline-facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
