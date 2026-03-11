/**
 * ai-client.ts
 * ─────────────────────────────────────────────────────────────
 * Unified AI client that prefers Claude claude-opus-4-5 when ANTHROPIC_API_KEY
 * is available, and gracefully falls back to GPT-4o when it isn't.
 *
 * Usage:
 *   import { callAI, streamAI, AI_MODEL } from "@/lib/ai-client";
 *
 *   const text = await callAI({ system, userMessage, maxTokens: 1024 });
 *   const text = await callAI({ system, userMessage, tools, toolName });
 *
 * The caller gets back a plain string (for text responses) or an object
 * (for tool-use responses). This hides all SDK differences from the routes.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// ── Which providers are available? ──────────────────────────────────────────

export const HAS_CLAUDE = !!process.env.ANTHROPIC_API_KEY;
export const HAS_OPENAI = !!process.env.OPENAI_API_KEY;

export const AI_PROVIDER: "claude" | "openai" = HAS_CLAUDE ? "claude" : "openai";
export const AI_MODEL = HAS_CLAUDE ? "claude-opus-4-6" : (process.env.OPENAI_MODEL || "gpt-4o");

// ── Quota / credit error detection ──────────────────────────────────────────

/**
 * Returns true if the error is an Anthropic billing/quota/credit error.
 * These are HTTP 529 (overloaded), 402 (payment required), or 400/401
 * errors whose message contains credit/quota keywords.
 */
function isClaudeQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as any;
  // Anthropic SDK surfaces status as e.status
  if (e.status === 402) return true;   // Payment Required (out of credits)
  if (e.status === 529) return true;   // Anthropic overload / credit exhausted
  // Some versions surface a nested error object
  const msg: string = (e.message ?? e.error?.message ?? "").toLowerCase();
  if (msg.includes("credit") || msg.includes("quota") || msg.includes("billing") ||
      msg.includes("insufficient") || msg.includes("overloaded") ||
      msg.includes("rate limit") || msg.includes("capacity")) {
    return true;
  }
  return false;
}

// ── Lazy client singletons ──────────────────────────────────────────────────

let _anthropic: Anthropic | null = null;
let _openai: OpenAI | null = null;

function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface CallAIOptions {
  system: string;
  userMessage: string;
  maxTokens?: number;
  temperature?: number;
  /** If provided, forces tool-use mode and returns the tool input object */
  tool?: {
    name: string;
    description: string;
    schema: Record<string, any>; // JSON Schema object for the tool parameters
  };
}

export interface CallAIResult {
  /** Plain text response (when no tool) */
  text: string;
  /** Tool input object (when tool was provided) */
  toolInput?: Record<string, any>;
}

// ── Core callAI() ───────────────────────────────────────────────────────────

/**
 * Make a single AI call. Returns { text, toolInput? }.
 * Prefers Claude when ANTHROPIC_API_KEY is set.
 * If Claude returns a quota/credit error at runtime, automatically retries
 * with GPT-4o so the user never sees a billing error.
 */
export async function callAI(opts: CallAIOptions): Promise<CallAIResult> {
  const { system, userMessage, maxTokens = 2048, temperature, tool } = opts;

  if (AI_PROVIDER === "claude") {
    try {
      return await _callClaude({ system, userMessage, maxTokens, temperature, tool });
    } catch (err) {
      if (isClaudeQuotaError(err) && HAS_OPENAI) {
        console.warn("[ai-client] Claude quota/credit error — falling back to GPT-4o", err);
        return _callOpenAI({ system, userMessage, maxTokens, temperature, tool });
      }
      throw err;
    }
  }

  return _callOpenAI({ system, userMessage, maxTokens, temperature, tool });
}

// ── Claude implementation ───────────────────────────────────────────────────

async function _callClaude(opts: {
  system: string;
  userMessage: string;
  maxTokens: number;
  temperature?: number;
  tool?: CallAIOptions["tool"];
}): Promise<CallAIResult> {
  const client = getAnthropic();
  const { system, userMessage, maxTokens, tool } = opts;
  // Claude's API requires temperature=1 when using tool_choice
  // For regular calls, any temperature is fine but Claude defaults well at 1
  const temperature = 1;

  if (tool) {
    const anthropicTool: Anthropic.Tool = {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object" as const,
        ...tool.schema,
      },
    };

    const res = await client.messages.create({
      model: AI_MODEL,
      max_tokens: maxTokens,
      temperature,
      system,
      tool_choice: { type: "tool", name: tool.name },
      tools: [anthropicTool],
      messages: [{ role: "user", content: userMessage }],
    });

    const toolBlock = res.content?.find((b: any) => b.type === "tool_use") as any;
    if (toolBlock?.input) {
      return { text: "", toolInput: toolBlock.input };
    }
    // Fallback to text if tool block not found
    const textBlock = res.content?.find((b: any) => b.type === "text") as any;
    return { text: textBlock?.text ?? "", toolInput: undefined };
  }

  const res = await client.messages.create({
    model: AI_MODEL,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = res.content?.find((b: any) => b.type === "text") as any;
  return { text: textBlock?.text ?? "" };
}

// ── OpenAI implementation ───────────────────────────────────────────────────

async function _callOpenAI(opts: {
  system: string;
  userMessage: string;
  maxTokens: number;
  temperature?: number;
  tool?: CallAIOptions["tool"];
}): Promise<CallAIResult> {
  const client = getOpenAI();
  const { system, userMessage, maxTokens, temperature = 0.3, tool } = opts;

  if (tool) {
    const openaiTool: any = {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          ...tool.schema,
        },
      },
    };

    const res = await client.chat.completions.create({
      model: AI_MODEL,
      max_tokens: maxTokens,
      temperature,
      tool_choice: { type: "function", function: { name: tool.name } },
      tools: [openaiTool],
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
    });

    const toolCall = res.choices?.[0]?.message?.tool_calls?.[0] as any;
    if (toolCall?.function?.arguments) {
      try {
        const toolInput = JSON.parse(toolCall.function.arguments);
        return { text: "", toolInput };
      } catch {
        return { text: "" };
      }
    }
    const content = res.choices?.[0]?.message?.content ?? "";
    return { text: content };
  }

  const res = await client.chat.completions.create({
    model: AI_MODEL,
    max_tokens: maxTokens,
    temperature,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMessage },
    ],
  });

  return { text: res.choices?.[0]?.message?.content ?? "" };
}

// ── Streaming ───────────────────────────────────────────────────────────────

export interface StreamAIOptions {
  system: string;
  userMessage: string;
  maxTokens?: number;
  onDelta: (delta: string) => void;
}

/**
 * Stream a text response, calling onDelta for each token.
 * Returns the full accumulated text when complete.
 * If Claude hits a quota/credit error, falls back to GPT-4o streaming.
 */
export async function streamAI(opts: StreamAIOptions): Promise<string> {
  const { system, userMessage, maxTokens = 200, onDelta } = opts;

  async function streamOpenAI(): Promise<string> {
    const client = getOpenAI();
    const stream = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o",
      max_tokens: maxTokens,
      stream: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
    });
    let full = "";
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      if (delta) { full += delta; onDelta(delta); }
    }
    return full;
  }

  if (AI_PROVIDER === "claude") {
    try {
      const client = getAnthropic();
      const stream = client.messages.stream({
        model: AI_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userMessage }],
      });

      let full = "";
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const delta = event.delta.text ?? "";
          if (delta) { full += delta; onDelta(delta); }
        }
      }
      return full;
    } catch (err) {
      if (isClaudeQuotaError(err) && HAS_OPENAI) {
        console.warn("[ai-client] Claude quota/credit error in streamAI — falling back to GPT-4o", err);
        return streamOpenAI();
      }
      throw err;
    }
  }

  return streamOpenAI();
}
