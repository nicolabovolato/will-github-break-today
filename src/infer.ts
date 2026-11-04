// Shared by the Worker and scripts/backfill.mjs, so keep it dependency-free.

// Title keywords → status components, for incidents GitHub didn't tag. Every match is kept.
// Product names that are also everyday words (Pages, Issues, Actions, Packages) only match as
// capitalised names, and "Issues with …" is phrasing rather than the product. Titles that match
// nothing (Dependabot, billing, "some GitHub services") stay Unlisted.
const TITLE_HINTS: [RegExp, string][] = [
  [/\b(gpt|claude|gemini|model providers?)\b/i, "Copilot AI Model Providers"],
  [/\bcopilot\b|\bcca\b|\bccr\b/i, "Copilot"],
  [/\bActions\b/, "Actions"],
  [/\bworkflow runs?\b|\brunners?\b/i, "Actions"],
  [/\bcodespaces?\b/i, "Codespaces"],
  [/\bPages\b/, "Pages"],
  [/\bPackages\b/, "Packages"],
  [/\b(container|npm|package) registr(y|ies)\b/i, "Packages"],
  [/\bwebhooks?\b/i, "Webhooks"],
  [/\bpull requests?\b/i, "Pull Requests"],
  [/\bIssues\b(?!\s+(with|affecting|in)\b)/, "Issues"],
  [/\bgit\b/i, "Git Operations"],
  [/\bapi\b/i, "API Requests"],
];

export function inferComponents(title: string): string[] {
  return [...new Set(TITLE_HINTS.filter(([re]) => re.test(title)).map(([, c]) => c))];
}
