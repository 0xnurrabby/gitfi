import { config } from "./config.js";

export function heuristicSummary(
  repoName: string,
  description: string | null,
  readme: string | null,
  topics: string[] = [],
): string[] {
  const text = stripMarkdown(readme ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const desc = (description ?? "").trim();
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 35 && s.length < 260 && !/badge|license|contribut|sponsor/i.test(s));
  const topicText = topics.slice(0, 4).join(", ");
  const intro = sentences[0] ?? desc;
  const solves =
    intro && intro.length > 20
      ? trimSentence(intro, 150)
      : `Ships ${repoName}, a focused open-source project${topicText ? ` built around ${topicText}` : ""}.`;
  const whoPool = [
    /developer|engineer|programmer|api|sdk/i.test(text) ? "developers and technical teams" : "",
    /cli|terminal|command/i.test(text) ? "CLI-first builders" : "",
    /ai|llm|model|agent/i.test(text) ? "AI product teams" : "",
    /self.?host|privacy/i.test(text) ? "privacy-conscious operators" : "",
  ].filter(Boolean);
  const who = whoPool.length
    ? `Built for ${[...new Set(whoPool)].slice(0, 2).join(" and ")}.`
    : desc && desc.length > 20
      ? `Built for people who need ${lowerFirst(trimSentence(desc, 90))}.`
      : "Built for developers who prefer small, legible tools over full platforms.";
  const whyPool = [
    /fast|speed|performance|lightning/i.test(text) ? "The edge is speed: less waiting, tighter feedback loops." : "",
    /simple|minimal|lightweight/i.test(text) ? "It removes layers instead of adding them, which keeps the codebase honest." : "",
    /open.?source|community|contribut/i.test(text) ? "A public codebase creates a compounding distribution loop around every improvement." : "",
    /type.?safe|typescript|rust|reliab/i.test(text) ? "Strong foundations make it safe to build on without owning the maintenance burden." : "",
  ].filter(Boolean);
  const why = whyPool[0] ?? `The public repository is the product surface — updates, contributors and demand are observable in real time.`;
  return [solves, who, why];
}

function trimSentence(text: string, max: number): string {
  const clean = text.replace(/[`#>*_\[\]()]/g, "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean.endsWith(".") ? clean : `${clean}.`;
  return `${clean.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function stripMarkdown(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*_~>`]/g, "")
    .replace(/\|[-:| ]+\|/g, " ");
}

function parseAiBullets(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 20)
    .slice(0, 3)
    .map((line) => {
      const clean = line.replace(/\*\*/g, "");
      return clean.endsWith(".") ? clean : `${clean}.`;
    });
}

export async function generateSummary(
  repoName: string,
  description: string | null,
  readme: string | null,
  topics: string[] = [],
): Promise<string[]> {
  if (!config.openaiKey) return heuristicSummary(repoName, description, readme, topics);
  try {
    const content = (readme ?? "").slice(0, 14_000);
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openaiKey}`,
      },
      body: JSON.stringify({
        model: config.openaiModel,
        temperature: 0.2,
        max_tokens: 220,
        messages: [
          {
            role: "system",
            content:
              "You write three terse, concrete bullets for a trading terminal. No hype, no marketing language, no emoji. Each bullet answers one: what it solves, who it is for, why it matters. One sentence each, under 24 words.",
          },
          {
            role: "user",
            content: `Repository: ${repoName}\nDescription: ${description ?? "none"}\nREADME:\n${content}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const bullets = parseAiBullets(json.choices?.[0]?.message?.content ?? "");
    if (bullets.length === 3) return bullets;
    return heuristicSummary(repoName, description, readme, topics);
  } catch {
    return heuristicSummary(repoName, description, readme, topics);
  }
}
