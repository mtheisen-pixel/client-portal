// Perceived brand tone analysis (Creative Audit) and the qualitative
// AI-summarizability note (Technical Audit's GEO section). Both need actual
// reading comprehension of the copy's register, not keyword matching, so
// both are real Claude calls — the first time client-portal itself calls
// an LLM (every other Claude call in this whole system lives in the
// separate `audit` app). Needs its own ANTHROPIC_API_KEY set on this
// Netlify site — a different app, a different env var, even if it's the
// same underlying Anthropic account as the audit app's key.

import Anthropic from "@anthropic-ai/sdk";

let cachedClient: Anthropic | null = null;
/** Set once, the first time anthropicClient() reads the env var — a masked (never the real secret) diagnostic for describeAnthropicFailure, since a bare "was rejected" gives no way to tell "no key at all" from "some wrong/corrupted value" from "the right key, wrong deploy context" apart. */
let lastApiKeyDiagnostic = "(never read)";

function anthropicClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const rawKey = process.env.ANTHROPIC_API_KEY;
  // Stripped to printable ASCII, not just .trim()'d — a real key is plain
  // ASCII (letters/digits/hyphens), and .trim() alone still failed on a live
  // retest with the identical "invalid x-api-key" error, which points at
  // something .trim() doesn't catch: a non-whitespace invisible character
  // (a smart quote, zero-width space, or BOM picked up from copy-pasting
  // into Netlify's env var UI) rather than plain leading/trailing
  // whitespace. This removes any character outside the printable-ASCII
  // range instead of only leading/trailing whitespace.
  const apiKey = rawKey?.replace(/[^\x21-\x7e]/g, "");
  lastApiKeyDiagnostic = apiKey ? `key read: starts with "${apiKey.slice(0, 8)}", ${apiKey.length} chars` : "no ANTHROPIC_API_KEY value found in this function's environment";
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set — tone analysis needs an Anthropic API key configured on this Netlify site.");
  }
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

/**
 * Turns an Anthropic call failure into a short, human-readable note safe to
 * embed directly in a report — never the raw SDK error (which for an auth
 * failure is literally `401 {"type":"error","error":{...}}`, unreadable to a
 * client and not actionable without knowing this is an env var problem).
 * `checkLabel` names the specific check for the reader (e.g.
 * "AI-summarizability check", "Perceived Tone analysis").
 */
export function describeAnthropicFailure(err: unknown, checkLabel: string): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return `${checkLabel} unavailable — the Anthropic API key configured on this Netlify site was rejected (${lastApiKeyDiagnostic}). Netlify scopes environment variables per deploy context (Production / Deploy Previews / Branch deploys can each have a different value, or none at all) — confirm ANTHROPIC_API_KEY is set for the specific context this function is actually running in, and that the key itself is still active in the Anthropic Console.`;
  }
  const message = err instanceof Error ? err.message : "unknown error";
  return `${checkLabel} unavailable — ${message}`;
}

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

export interface ToneDescriptor {
  descriptor: string;
  justification: string;
}

const TONE_SYSTEM_PROMPT = `You are analyzing the actual written tone of a website's copy for a brand audit. You are given raw page text extracted from a live site.

Read the copy the way a person would experience it, and generate 5-6 single-word or short-phrase tone descriptors that characterize how the writing actually reads (e.g. "playful," "corporate," "earnest," "premium," "approachable," "clinical," "irreverent," "technical"). This needs real reading comprehension of register, word choice, sentence rhythm, and what the copy chooses to emphasize — not keyword spotting.

For each descriptor, write one specific sentence justifying it, pointing to something concrete in the copy (a phrase, a section, a contrast between two parts of the site) — not a generic restatement of the descriptor. Contradictory descriptors are fine and often the most useful finding (e.g. both "playful" and "corporate" can legitimately apply to different sections of the same site) — that inconsistency is itself worth surfacing, not something to resolve into one tidy answer.

Call the record_tone tool with a "descriptors" array of exactly 5-6 objects, each with:
- "descriptor": a single word or short phrase (2-3 words max)
- "justification": one sentence, specific and concrete, pointing to actual copy`;

const TONE_TOOL = {
  name: "record_tone",
  description: "Record 5-6 perceived tone descriptors for the site's copy, each with a specific justification.",
  input_schema: {
    type: "object" as const,
    properties: {
      descriptors: {
        type: "array",
        minItems: 5,
        maxItems: 6,
        items: {
          type: "object",
          properties: {
            descriptor: { type: "string" },
            justification: { type: "string" },
          },
          required: ["descriptor", "justification"],
        },
      },
    },
    required: ["descriptors"],
  },
};

function toolInput(message: Anthropic.Message): unknown {
  const block = message.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("Claude response contained no tool_use content.");
  return block.input;
}

function isToneDescriptor(value: unknown): value is ToneDescriptor {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.descriptor === "string" && typeof v.justification === "string";
}

/**
 * `siteLabel` is a plain description ("Loop & Loom's own site" / "Parachute
 * (competitor)") used only to give the model context in the prompt — it has
 * no bearing on output shape.
 */
export async function analyzeTone(siteLabel: string, pagesText: string): Promise<ToneDescriptor[]> {
  const client = anthropicClient();
  const userPrompt = `Site: ${siteLabel}

Extracted page copy:
${pagesText.slice(0, 15000)}

Generate the tone descriptors now.`;

  const message = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: TONE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    tools: [TONE_TOOL],
    tool_choice: { type: "tool", name: TONE_TOOL.name },
  });

  const input = toolInput(message);
  const descriptors = input && typeof input === "object" ? (input as Record<string, unknown>).descriptors : undefined;
  if (!Array.isArray(descriptors)) {
    throw new Error(`Tone analysis returned no descriptors array.\n\nRaw tool input: ${JSON.stringify(input)}`);
  }
  const valid = descriptors.filter(isToneDescriptor);
  if (valid.length === 0) {
    throw new Error(`Tone analysis returned no valid descriptors.\n\nRaw tool input: ${JSON.stringify(input)}`);
  }
  return valid;
}

export function toneMarkdownSection(descriptors: ToneDescriptor[]): string {
  return [
    "## Perceived Tone",
    "",
    ...descriptors.map((d) => `- **${d.descriptor}** — ${d.justification}`),
  ].join("\n\n");
}

const GEO_SYSTEM_PROMPT = `You are assessing whether a page's content is structured clearly enough for an AI system (a search engine's generative answer, an LLM summarizing the page) to accurately extract and summarize it. You are given raw extracted page text.

This is a qualitative judgment, not a hard metric. Look for: clear, direct factual statements versus vague marketing language; a logical structure a summarizer could follow; whether key facts (what the business does, who it's for, what makes it different) are stated plainly somewhere rather than only implied.

Respond with 2-3 sentences of plain assessment — no headers, no bullet list, no JSON. Be specific: name what helps or hurts summarization, not a generic verdict.`;

export async function analyzeGeoReadability(pagesText: string): Promise<string> {
  const client = anthropicClient();
  const message = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 300,
    system: GEO_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Extracted page copy:\n${pagesText.slice(0, 15000)}\n\nAssess AI-summarizability now.` }],
  });
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("GEO readability check returned no text.");
  return textBlock.text.trim();
}
