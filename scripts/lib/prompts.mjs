import path from "node:path";

function modelLine(model) {
  return model === "inherit"
    ? "Set its model to the same model you are running on (sonnet, opus, haiku, or fable)."
    : `Set model: "${model}".`;
}

function launch(agent, model, lead, fields) {
  return [
    `${lead} Launch the \`${agent}\` agent now with run_in_background: true. ${modelLine(model)}`,
    `Do not do this work yourself and do not wait for the agent. Give it exactly this prompt:`,
    ``,
    ...fields,
    ``,
    `After launching it, end your turn without further output.`,
    `When the agent finishes, do not comment on it or summarize it unless the user asks.`,
  ].join("\n");
}

export function reviewerInstruction({ digest, focus, d, model }) {
  return launch("peka:reviewer", model, "PEKA learning checkpoint.", [
    `Digest: ${digest}`,
    `Focus: ${focus}`,
    `Memory dir: ${d.memory}`,
    `Skills dir: ${d.skills}`,
  ]);
}

export function curatorInstruction({ report, d, model }) {
  return launch("peka:curator", model, "PEKA maintenance is due.", [
    `Report: ${report}`,
    `Actions file: ${path.join(d.state, "curator-actions.json")}`,
    `Memory dir: ${d.memory}`,
    `Skills dir: ${d.skills}`,
  ]);
}
