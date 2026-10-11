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

export function sessionBrief(d) {
  return [
    `PEKA is active. Your memory in ${d.memory} is global: every project reads and writes the same store, and its index MEMORY.md is already in your context.`,
    `- Before starting a task, scan the index for entries that apply (this project, the user's preferences, the tools involved) and read those files. Follow them without being asked.`,
    `- When the user corrects you, states a preference, teaches you how to do something, or asks you to remember something, run /peka:remember right away; do not save the memory yourself. PEKA decides whether it becomes a memory or a skill. When they ask for a procedure to be saved as a skill, run /peka:skill. Do not write skills into ~/.claude/skills unless the user asks for a personal skill there.`,
    `- In project-specific memories, name the project, since all projects share them.`,
    `- A memory can be out of date. If it conflicts with what you observe now, trust what you observe and fix the memory.`,
    `- Skills PEKA learned are in your skill list. Use one whenever its description fits the task.`,
  ].join("\n");
}

export function learnerInstruction({ digest, mode, d, model }) {
  return [
    `Launch the \`peka:learner\` agent now. ${modelLine(model)} Give it this prompt: fill in the Request: line as described and copy the other lines exactly.`,
    ``,
    `Request: <the user's words: what they want remembered or saved, plus anything from this conversation the request refers to>`,
    `Mode: ${mode}`,
    `Digest: ${digest ?? "none"}`,
    `Memory dir: ${d.memory}`,
    `Skills dir: ${d.skills}`,
    `Actions file: ${path.join(d.state, "learner-actions.json")}`,
    ``,
    `When it finishes, tell the user in one line what was saved and where (memory or skill).`,
  ].join("\n");
}
