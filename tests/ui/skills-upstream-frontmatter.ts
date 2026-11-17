/**
 * Frontmatter from two upstream SKILL.md files that the parser once rejected.
 * Each description is a multiline plain scalar whose text starts on the line
 * after `description:`. The frontmatter is copied byte for byte. The body is
 * a short stand-in, not the upstream instructions.
 *
 * Source: mrhinkle/master-skills at 9b6af03fc38f7dd70dc74d089d931f667a141047
 * - skills/vercel-composition-patterns/SKILL.md, blob 5852486400e4fbd4851d664e7f5cd7a3764c8ff8
 * - skills/vercel-react-native-skills/SKILL.md, blob 8a2cea3ba8e7ae60661c9dba797d6dcab8d31e0c
 */

export const UPSTREAM_BODY = "# Stand-in body\n\nFollow the rules in references/.\n";

export const compositionPatterns = {
  dir: "skills/vercel-composition-patterns",
  raw: [
    "---",
    "name: vercel-composition-patterns",
    "description:",
    "  React composition patterns that scale. Use when refactoring components with",
    "  boolean prop proliferation, building flexible component libraries, or",
    "  designing reusable APIs. Triggers on tasks involving compound components,",
    "  render props, context providers, or component architecture. Includes React 19",
    "  API changes.",
    "license: MIT",
    "metadata:",
    "  author: vercel",
    "  version: '1.0.0'",
    "category: Design & Frontend",
    "owner: mark-hinkle",
    "version: 1.0.0",
    "last_updated: 2026-07-17",
    "tags: [react, composition, patterns, architecture]",
    "---",
    "",
  ].join("\n") + UPSTREAM_BODY,
  description:
    "React composition patterns that scale. Use when refactoring components with boolean prop proliferation, " +
    "building flexible component libraries, or designing reusable APIs. Triggers on tasks involving compound " +
    "components, render props, context providers, or component architecture. Includes React 19 API changes.",
  tags: ["react", "composition", "patterns", "architecture"],
};

export const reactNative = {
  dir: "skills/vercel-react-native-skills",
  raw: [
    "---",
    "name: vercel-react-native-skills",
    "description:",
    "  React Native and Expo best practices for building performant mobile apps. Use",
    "  when building React Native components, optimizing list performance,",
    "  implementing animations, or working with native modules. Triggers on tasks",
    "  involving React Native, Expo, mobile performance, or native platform APIs.",
    "license: MIT",
    "metadata:",
    "  author: vercel",
    "  version: '1.0.0'",
    "category: Design & Frontend",
    "owner: mark-hinkle",
    "version: 1.0.0",
    "last_updated: 2026-07-17",
    "tags: [react-native, expo, mobile, performance]",
    "---",
    "",
  ].join("\n") + UPSTREAM_BODY,
  description:
    "React Native and Expo best practices for building performant mobile apps. Use when building React Native " +
    "components, optimizing list performance, implementing animations, or working with native modules. Triggers " +
    "on tasks involving React Native, Expo, mobile performance, or native platform APIs.",
  tags: ["react-native", "expo", "mobile", "performance"],
};
