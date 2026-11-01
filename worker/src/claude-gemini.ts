import { isAttribution, isObject, sse, text, type EventTranslator, type Json } from "./claude-responses.ts";

// Translation between Anthropic Messages and Gemini generateContent, for Gemini API keys,
// ported from CPA's translator/gemini/claude. Unlike CPA, Google's default safety settings are
// left in place rather than switched off.

// Gemini wants a thought signature on replayed function calls; CPA sends this documented bypass
// value since Claude history carries none.
const SKIP_SIGNATURE = "skip_thought_signature_validator";

// Gemini function names: letters, digits, _ . : -, starting with a letter or underscore, 64 long.
export function geminiName(name: string): string {
  let sanitized = name.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  if (sanitized === "") return "_";
  if (!/^[a-zA-Z_]/.test(sanitized)) sanitized = `_${sanitized.slice(0, 63)}`;
  return sanitized.slice(0, 64);
}

function cleanSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanSchema);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => (key === "$schema" || key === "$id" ? [] : [[key, cleanSchema(child)]])));
}

function inlineData(source: unknown): Json | null {
  if (!isObject(source) || source.type !== "base64" || text(source.media_type) === "" || text(source.data) === "") return null;
  return { inline_data: { mime_type: text(source.media_type), data: text(source.data) } };
}

// A tool result's text, plus its images as their own parts.
function toolResult(content: unknown): { result: string; images: Json[] } {
  if (typeof content === "string") return { result: content, images: [] };
  if (!Array.isArray(content)) return { result: "", images: [] };
  const texts: string[] = [];
  const images: Json[] = [];
  for (const item of content) {
    if (!isObject(item)) continue;
    if (item.type === "text") texts.push(text(item.text));
    else if (item.type === "image") {
      const image = inlineData(item.source);
      if (image !== null) images.push(image);
    }
  }
  return { result: texts.join("\n"), images };
}

export interface GeminiRequest {
  readonly body: Json;
  readonly stream: boolean;
  // Gemini function name to the client's, for the response.
  readonly toolNames: Map<string, string>;
}

// Gemini 3 takes a thinking level (low or high, and on Flash also minimal or medium); Claude's
// higher efforts have no level above high.
function thinkingLevel(effort: string): string {
  if (effort === "minimal" || effort === "low" || effort === "medium") return effort;
  return "high";
}

export function claudeToGemini(claude: Json, model: string): GeminiRequest {
  const toolNames = new Map<string, string>();
  const nameOf = (name: string) => {
    const short = geminiName(name);
    toolNames.set(short, name);
    return short;
  };
  const body: Json = {};
  const system = typeof claude.system === "string" ? [{ type: "text", text: claude.system }] : Array.isArray(claude.system) ? claude.system : [];
  const systemParts = system.flatMap((part) => (isObject(part) && part.type === "text" && text(part.text) !== "" && !isAttribution(text(part.text)) ? [{ text: text(part.text) }] : []));
  if (systemParts.length > 0) body.systemInstruction = { role: "user", parts: systemParts };

  const contents: { role: string; parts: Json[] }[] = [];
  const toolNameById = new Map<string, string>();
  for (const message of Array.isArray(claude.messages) ? claude.messages : []) {
    if (!isObject(message)) continue;
    const role = message.role === "assistant" ? "model" : "user";
    const parts: Json[] = [];
    if (typeof message.content === "string") {
      if (message.content !== "") parts.push({ text: message.content });
    } else {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (!isObject(part)) continue;
        switch (part.type) {
          case "text":
            if (text(part.text) !== "") parts.push({ text: text(part.text) });
            break;
          case "tool_use": {
            const id = text(part.id);
            const name = text(part.name);
            if (id !== "" && name !== "") toolNameById.set(id, name);
            const call: Json = { name: nameOf(name), args: isObject(part.input) ? part.input : {} };
            if (id !== "") call.id = id;
            parts.push({ thoughtSignature: SKIP_SIGNATURE, functionCall: call });
            break;
          }
          case "tool_result": {
            const id = text(part.tool_use_id);
            if (id === "") break;
            const result = toolResult(part.content);
            parts.push({ functionResponse: { id, name: nameOf(toolNameById.get(id) ?? id), response: { result: result.result } } });
            parts.push(...result.images);
            break;
          }
          case "image":
          case "document": {
            const data = inlineData(part.source);
            if (data !== null) parts.push(data);
            break;
          }
          default:
            break;
        }
      }
    }
    if (parts.length === 0) continue;
    // Gemini wants a user turn's prompt text ahead of its function responses.
    if (role === "user" && parts.some((part) => isObject(part.functionResponse))) parts.sort((a, b) => Number("text" in b) - Number("text" in a));
    const previous = contents.at(-1);
    if (previous !== undefined && previous.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts });
  }
  body.contents = contents;

  const tools = Array.isArray(claude.tools) ? claude.tools.filter((tool): tool is Json => isObject(tool) && isObject(tool.input_schema) && text(tool.name) !== "") : [];
  if (tools.length > 0) {
    body.tools = [{ functionDeclarations: tools.map((tool) => ({ name: nameOf(text(tool.name)), description: text(tool.description), parametersJsonSchema: cleanSchema(tool.input_schema) })) }];
  }
  const choice = claude.tool_choice;
  const choiceType = isObject(choice) ? text(choice.type) : text(choice);
  if (choiceType === "none") body.toolConfig = { functionCallingConfig: { mode: "NONE" } };
  else if (choiceType === "any") body.toolConfig = { functionCallingConfig: { mode: "ANY" } };
  else if (choiceType === "tool" && isObject(choice)) body.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [nameOf(text(choice.name))] } };

  const generation: Json = {};
  const thinking = isObject(claude.thinking) ? claude.thinking : null;
  if (thinking?.type === "enabled" && typeof thinking.budget_tokens === "number") generation.thinkingConfig = { thinkingBudget: thinking.budget_tokens, includeThoughts: true };
  else if (thinking?.type === "adaptive" || thinking?.type === "auto") {
    const config = isObject(claude.output_config) ? claude.output_config : {};
    // Gemini 2.x has no levels; a budget of -1 lets it decide, as adaptive thinking does.
    generation.thinkingConfig = /^gemini-2\./.test(model) ? { thinkingBudget: -1, includeThoughts: true } : { thinkingLevel: thinkingLevel(text(config.effort).trim().toLowerCase()), includeThoughts: true };
  }
  if (typeof claude.max_tokens === "number") generation.maxOutputTokens = claude.max_tokens;
  if (typeof claude.temperature === "number") generation.temperature = claude.temperature;
  if (typeof claude.top_p === "number") generation.topP = claude.top_p;
  if (typeof claude.top_k === "number") generation.topK = claude.top_k;
  if (Array.isArray(claude.stop_sequences) && claude.stop_sequences.length > 0) generation.stopSequences = claude.stop_sequences;
  if (Object.keys(generation).length > 0) body.generationConfig = generation;
  return { body, stream: claude.stream === true, toolNames };
}

function stopReason(finish: string, toolUse: boolean): string {
  if (toolUse) return "tool_use";
  if (finish === "MAX_TOKENS") return "max_tokens";
  if (finish === "SAFETY" || finish === "RECITATION" || finish === "PROHIBITED_CONTENT" || finish === "BLOCKLIST" || finish === "SPII") return "refusal";
  return "end_turn";
}

function geminiUsage(raw: unknown): Json {
  const usage = isObject(raw) ? raw : {};
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const cached = number(usage.cachedContentTokenCount);
  const result: Json = { input_tokens: Math.max(0, number(usage.promptTokenCount) - cached), output_tokens: number(usage.candidatesTokenCount) + number(usage.thoughtsTokenCount) };
  if (cached > 0) result.cache_read_input_tokens = cached;
  return result;
}

function toolUseId(call: Json, index: number): string {
  return text(call.id) || `toolu_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}${index}`;
}

// Turns Gemini stream chunks into Anthropic events. Each chunk carries parts of the one
// candidate: thoughts and text stream as they come, function calls arrive whole.
export class GeminiClaudeStream implements EventTranslator {
  private index = -1;
  private open: "text" | "thinking" | null = null;
  private started = false;
  private finished = false;
  private toolUse = false;
  private finish = "";
  private usage: Json = { input_tokens: 0, output_tokens: 0 };

  constructor(
    private readonly model: string,
    private readonly toolNames: Map<string, string>,
  ) {}

  private block(kind: "text" | "thinking"): string {
    if (this.open === kind) return "";
    const out = this.stop();
    this.index += 1;
    this.open = kind;
    return out + sse("content_block_start", { type: "content_block_start", index: this.index, content_block: kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" } });
  }

  private stop(): string {
    if (this.open === null) return "";
    this.open = null;
    return sse("content_block_stop", { type: "content_block_stop", index: this.index });
  }

  private messageStart(id: string): string {
    if (this.started) return "";
    this.started = true;
    const message = { id: `msg_${id || crypto.randomUUID().replaceAll("-", "")}`, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
    return sse("message_start", { type: "message_start", message });
  }

  event(event: Json): string {
    if (this.finished) return "";
    if (isObject(event.error)) {
      this.finished = true;
      return sse("error", { type: "error", error: { type: "api_error", message: text(event.error.message) || "The upstream failed." } });
    }
    let out = this.messageStart(text(event.responseId));
    if (isObject(event.usageMetadata)) this.usage = geminiUsage(event.usageMetadata);
    const candidate = Array.isArray(event.candidates) && isObject(event.candidates[0]) ? event.candidates[0] : null;
    if (candidate === null) return out;
    const content = isObject(candidate.content) ? candidate.content : {};
    for (const part of Array.isArray(content.parts) ? content.parts : []) {
      if (!isObject(part)) continue;
      if (isObject(part.functionCall)) {
        this.toolUse = true;
        const call = part.functionCall;
        const name = text(call.name);
        out += this.stop();
        this.index += 1;
        out += sse("content_block_start", { type: "content_block_start", index: this.index, content_block: { type: "tool_use", id: toolUseId(call, this.index), name: this.toolNames.get(name) ?? name, input: {} } });
        out += sse("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "input_json_delta", partial_json: JSON.stringify(isObject(call.args) ? call.args : {}) } });
        out += sse("content_block_stop", { type: "content_block_stop", index: this.index });
      } else if (text(part.text) !== "") {
        const kind = part.thought === true ? "thinking" : "text";
        out += this.block(kind);
        out += sse("content_block_delta", { type: "content_block_delta", index: this.index, delta: kind === "text" ? { type: "text_delta", text: text(part.text) } : { type: "thinking_delta", thinking: text(part.text) } });
      }
    }
    if (text(candidate.finishReason) !== "") this.finish = text(candidate.finishReason);
    return out;
  }

  // The stream has no closing event of its own: the message ends when the body does.
  end(): string {
    if (this.finished) return "";
    this.finished = true;
    const close = sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason(this.finish, this.toolUse), stop_sequence: null }, usage: this.usage });
    return this.messageStart("") + this.stop() + close + sse("message_stop", { type: "message_stop" });
  }
}

export function geminiClaudeMessage(response: Json, model: string, toolNames: Map<string, string>): Json {
  const candidate = Array.isArray(response.candidates) && isObject(response.candidates[0]) ? response.candidates[0] : {};
  const parts = isObject(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts.filter(isObject) : [];
  const content: Json[] = [];
  let toolUse = false;
  for (const [index, part] of parts.entries()) {
    if (isObject(part.functionCall)) {
      toolUse = true;
      const name = text(part.functionCall.name);
      content.push({ type: "tool_use", id: toolUseId(part.functionCall, index), name: toolNames.get(name) ?? name, input: isObject(part.functionCall.args) ? part.functionCall.args : {} });
    } else if (text(part.text) !== "") {
      const last = content.at(-1);
      const kind = part.thought === true ? "thinking" : "text";
      if (last !== undefined && last.type === kind) last[kind] = text(last[kind]) + text(part.text);
      else content.push(kind === "text" ? { type: "text", text: text(part.text) } : { type: "thinking", thinking: text(part.text), signature: "" });
    }
  }
  return {
    id: `msg_${text(response.responseId) || crypto.randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason(text(candidate.finishReason), toolUse),
    stop_sequence: null,
    usage: geminiUsage(response.usageMetadata),
  };
}
