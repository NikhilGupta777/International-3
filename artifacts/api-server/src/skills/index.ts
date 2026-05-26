/**
 * Agent Skills Registry
 *
 * Skills are domain-specific knowledge packs injected into the agent's system prompt
 * when activated for a session. Each skill provides:
 * - A system prompt addendum with complete domain knowledge
 * - Optional additional tool definitions
 * - Metadata (name, description, icon, category)
 *
 * To add a new skill:
 * 1. Create a new file in this directory: `skill-<name>.ts`
 * 2. Export a SkillDefinition from it
 * 3. Register it in the SKILLS_REGISTRY below
 */

export interface SkillDefinition {
  /** Unique skill ID (kebab-case) */
  id: string;
  /** Display name */
  name: string;
  /** Short description shown in UI */
  description: string;
  /** Lucide icon name for the frontend */
  icon: string;
  /** Category for grouping */
  category: "creation" | "editing" | "ai" | "utility";
  /** Complete knowledge/instructions injected into system prompt */
  systemPrompt: string;
  /** Suggested starter prompts when this skill is active */
  starters?: string[];
  /** Tags for filtering */
  tags?: string[];
}

// Import individual skills
import { hyperframesSkill } from "./skill-hyperframes";

/**
 * Central skills registry — add new skills here
 */
export const SKILLS_REGISTRY: Record<string, SkillDefinition> = {
  hyperframes: hyperframesSkill,
};

/**
 * Get a skill by ID, returns undefined if not found
 */
export function getSkill(id: string): SkillDefinition | undefined {
  return SKILLS_REGISTRY[id];
}

/**
 * Get all registered skills as an array
 */
export function getAllSkills(): SkillDefinition[] {
  return Object.values(SKILLS_REGISTRY);
}

/**
 * Build the skill system prompt addendum for active skills
 * Returns empty string if no skills are active
 */
export function buildSkillPrompt(activeSkillIds: string[]): string {
  if (!activeSkillIds.length) return "";

  const parts: string[] = [];
  parts.push("\n\n# ACTIVE SKILLS\n");
  parts.push("The following skills are activated for this session. You have deep expertise in these domains and MUST follow the skill-specific instructions below.\n");

  for (const id of activeSkillIds) {
    const skill = SKILLS_REGISTRY[id];
    if (!skill) continue;
    parts.push(`\n## Skill: ${skill.name}\n`);
    parts.push(skill.systemPrompt);
  }

  return parts.join("");
}

/**
 * Get the skills list for the frontend (metadata only, no prompt content)
 */
export function getSkillsManifest(): Array<{
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  starters?: string[];
  tags?: string[];
}> {
  return getAllSkills().map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
    icon: s.icon,
    category: s.category,
    starters: s.starters,
    tags: s.tags,
  }));
}
