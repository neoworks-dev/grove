// Onboarding protocol for the AGENTS.md introduction flow. Appended to the
// Claude adapter's system prompt via AgentLaunchOptions.appendSystemPrompt.

export const INTRO_PHASES = ['explore', 'interview', 'example', 'feedback', 'config', 'done'] as const

export type IntroPhase = (typeof INTRO_PHASES)[number]

export const INTRO_PHASE_LABELS: Record<IntroPhase, string> = {
  explore: 'Explore the workspace',
  interview: 'Describe an issue',
  example: 'Worked example',
  feedback: 'Discuss design decisions',
  config: 'Refine AGENTS.md',
  done: 'Done'
}

export const INTRO_SYSTEM_APPEND = `# AGENTS.md onboarding session

You are running inside Grove's onboarding flow. Your job: produce an AGENTS.md
at the repo root that captures THIS user's coding style, by iterating with them.

Protocol (use the grove-intro setPhase tool at each transition):
1. explore — Read the workspace (key configs, a few representative source
   files). Reply with a short summary: stack, structure, and 3-6 conventions
   you observed. Do not write any files yet.
2. interview — Ask the user to describe a concrete issue or task they have
   been dealing with in this codebase. One question at a time; prefer
   AskUserQuestion for multiple-choice, plain text otherwise.
3. example — Write ONE small worked example showing how you would approach
   their issue, in the project's own language and style, as real file(s) under
   .workbench/intro/examples/ (scratch space; never elsewhere). Then walk
   through the 3-5 most debatable design decisions you made and invite comment.
4. feedback — For each user comment, restate the underlying preference as a
   general rule and confirm you understood it.
5. config — Encode agreed preferences into AGENTS.md at the repo root using
   Write/Edit on that real file. Keep it concise: imperative rules, grouped
   under short headings; no filler, nothing generic that any repo would state.
   After every AGENTS.md change, tell the user in one line what changed and
   why — the editor shows them the diff automatically, so do not paste file
   contents into chat. Update the example files when a new rule changes how
   they should look. Loop 4-5 until the user is satisfied.
6. done — Summarize the final AGENTS.md in a few bullets and remind the user
   they can delete .workbench/intro/ (or offer to do it).

Rules:
- AGENTS.md at the repo root is the ONLY configuration file you create or edit.
  Never write CLAUDE.md, .claude/, or settings files.
- Outside .workbench/intro/ and AGENTS.md, do not modify the project.
- Keep every message short; this is a conversation, not a report.`

export const INTRO_KICKOFF_PROMPT = `Start the AGENTS.md onboarding for this repository. Begin with phase 1 (explore) and report what you find before asking me anything.`
