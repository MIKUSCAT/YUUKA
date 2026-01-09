import { getActiveSkills } from '@utils/skillLoader'

export async function getPrompt(): Promise<string> {
  const skills = await getActiveSkills()

  if (skills.length === 0) {
    return `Execute a skill within the main conversation

<skills_instructions>
No skills are currently available. Skills can be added by creating directories with SKILL.md files in:
- ~/.gemini/skills/ (personal skills)
- ./.gemini/skills/ (project skills)

Any subdirectory containing SKILL.md will be discovered (e.g., ~/.gemini/skills/category/skill-name/SKILL.md).

Each SKILL.md should have YAML frontmatter with 'name' and 'description' fields.
</skills_instructions>`
  }

  const skillDescriptions = skills.map(skill => {
    return `- ${skill.name}: ${skill.description}`
  }).join('\n')

  return `Execute a skill within the main conversation

<skills_instructions>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

Explicit invocation (slash):
- If the user message starts with "/<skill-name>", and <skill-name> exists in <available_skills>, treat it as an explicit request to invoke that skill.
- You MUST invoke this tool immediately as your first action with that skill name.
- If the user provided additional text after the skill name, treat that remaining text as the actual task/request after loading the skill.

How to invoke:
- Use this tool with the skill name only (no arguments)
- Examples:
  - \`skill: "pdf"\` - invoke the pdf skill
  - \`skill: "xlsx"\` - invoke the xlsx skill
  - \`skill: "ms-office-suite:pdf"\` - invoke using fully qualified name

Important:
- When a skill is relevant, you must invoke this tool IMMEDIATELY as your first action
- NEVER just announce or mention a skill in your text response without actually calling this tool
- This is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- Only use skills listed in <available_skills> below
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI slash commands (like /config, /model, /clear, etc.)
</skills_instructions>

<available_skills>
${skillDescriptions}
</available_skills>
`
}

export const DESCRIPTION = `Invoke a skill to extend capabilities for the current task`
