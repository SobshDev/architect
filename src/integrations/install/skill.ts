import skill from "../../../skills/architect/SKILL.md" with { type: "text" };
import decisions from "../../../skills/architect/references/decisions.md" with { type: "text" };
import design from "../../../skills/architect/references/design.md" with { type: "text" };
import rules from "../../../skills/architect/references/rules.md" with { type: "text" };

/** The architect skill, embedded so a compiled binary can install it. Paths are relative to the skill folder. */
export const SKILL_FILES: readonly { path: string; content: string }[] = [
  { path: "SKILL.md", content: skill },
  { path: "references/decisions.md", content: decisions },
  { path: "references/design.md", content: design },
  { path: "references/rules.md", content: rules },
];
