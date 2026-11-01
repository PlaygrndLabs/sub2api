import { isAttribution, isObject, reasoningEffort, sse, text, toolParameters, type EventTranslator, type Json } from "./claude-responses.ts";

// Translation between Anthropic Messages and OpenAI Chat Completions, for OpenAI-compatible
// providers such as OpenRouter, ported from CPA's translator/openai/claude.

const IMAGE_RELAY_NOTICE = "Images returned by the preceding tool call(s):";

function contentPart(part: Json): Json | null {
  switch (part.type) {
    case "text": {
      const value = text(part.text);
      return value.trim() === "" || isAttribution(value) ? null : { type: "text", text: value };
    }
    case "image": {
      const source = isObject(part.source) ? part.source : {};
      let url = "";
      if (source.type === "base64" && text(source.data) !== "") url = `data:${text(source.media_type) || "application/octet-stream"};base64,${text(source.data)}`;
      else if (source.type === "url") url = text(source.url);
      return /^(data:|https?:\/\/)/i.test(url) ? { type: "image_url", image_url: { url } } : null;
    }
    case "document": {
      const source = isObject(part.source) ? part.source : {};
      if (source.type !== "base64" || text(source.data) === "") return null;
      return { type: "file", file: { filename: text(part.title) || "document.pdf", file_data: `data:${text(source.media_type) || "application/pdf"};base64,${text(source.data)}` } };
    }
    default:
      return null;
  }
}

// A tool result's text for the tool message; its images go in a user message after it, since
// Chat Completions tool messages carry text only.
function toolResult(content: unknown): { text: string; images: Json[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
  const texts: string[] = [];
  const images: Json[] = [];
  for (const item of content) {
    if (!isObject(item)) continue;
    if (item.type === "text") texts.push(text(item.text));
    else if (item.type === "image") {
      const image = contentPart(item);
      if (image !== null) images.push(image);
    }
  }
  return { text: texts.join("\n"), images };
}

export interface ChatRequest {
  readonly body: Json;
  readonly stream: boolean;
}

export function claudeToChat(claude: Json, model: string): ChatRequest {
  const stream = claude.stream === true;
  const messages: Json[] = [];
  const system = typeof claude.system === "string" ? [{ type: "text", text: claude.system }] : Array.isArray(claude.system) ? claude.system : [];
  const systemParts = system.flatMap((part) => (isObject(part) ? [contentPart(part)].filter((item) => item !== null) : []));
  if (systemParts.length > 0) messages.push({ role: "system", content: systemParts });

  for (const message of Array.isArray(claude.messages) ? claude.messages : []) {
    if (!isObject(message)) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    if (typeof message.content === "string") {
      messages.push({ role, content: message.content });
      continue;
    }
    const parts: Json[] = [];
    const reasoning: string[] = [];
    const toolCalls: Json[] = [];
    const toolMessages: Json[] = [];
    const toolImages: Json[] = [];
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (!isObject(part)) continue;
      if (part.type === "thinking") {
        if (role === "assistant" && text(part.thinking).trim() !== "") reasoning.push(text(part.thinking));
      } else if (part.type === "tool_use") {
        if (role === "assistant") toolCalls.push({ id: text(part.id), type: "function", function: { name: text(part.name), arguments: JSON.stringify(part.input ?? {}) } });
      } else if (part.type === "tool_result") {
        const result = toolResult(part.content);
        toolMessages.push({ role: "tool", tool_call_id: text(part.tool_use_id), content: result.text });
        toolImages.push(...result.images);
      } else {
        const converted = contentPart(part);
        if (converted !== null) parts.push(converted);
      }
    }
    // Tool results answer the previous assistant turn, so they come first.
    messages.push(...toolMessages);
    if (toolImages.length > 0) {
      const relay = [{ type: "text", text: IMAGE_RELAY_NOTICE }, ...toolImages];
      if (role === "user") parts.unshift(...relay);
      else messages.push({ role: "user", content: relay });
    }
    if (role === "assistant") {
      if (parts.length === 0 && reasoning.length === 0 && toolCalls.length === 0) continue;
      const assistant: Json = { role, content: parts.length > 0 ? parts : "" };
      if (reasoning.length > 0) assistant.reasoning_content = reasoning.join("\n\n");
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      messages.push(assistant);
    } else if (parts.length > 0) {
      messages.push({ role, content: parts });
    }
  }

  const body: Json = { model, messages, stream };
  if (typeof claude.max_tokens === "number") body.max_tokens = claude.max_tokens;
  if (typeof claude.temperature === "number") body.temperature = claude.temperature;
  else if (typeof claude.top_p === "number") body.top_p = claude.top_p;
  if (Array.isArray(claude.stop_sequences) && claude.stop_sequences.length > 0) body.stop = claude.stop_sequences;
  if (isObject(claude.thinking)) body.reasoning_effort = reasoningEffort(claude);
  if (stream) body.stream_options = { include_usage: true };
  const tools = Array.isArray(claude.tools) ? claude.tools.filter(isObject).filter((tool) => text(tool.name) !== "" && !/^web_search_\d+$/.test(text(tool.type))) : [];
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({ type: "function", function: { name: text(tool.name), description: text(tool.description), parameters: toolParameters(tool.input_schema) } }));
    const choice = claude.tool_choice;
    const type = isObject(choice) ? text(choice.type) : text(choice);
    if (type === "any") body.tool_choice = "required";
    else if (type === "none") body.tool_choice = "none";
    else if (type === "tool" && isObject(choice) && text(choice.name) !== "") body.tool_choice = { type: "function", function: { name: text(choice.name) } };
    if (isObject(choice) && choice.disable_parallel_tool_use === true) body.parallel_tool_calls = false;
  }
  return { body, stream };
}

function stopReason(finish: string, toolUse: boolean): string {
  if (toolUse || finish === "tool_calls" || finish === "function_call") return "tool_use";
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter") return "refusal";
  return "end_turn";
}

function chatUsage(raw: unknown): Json {
  const usage = isObject(raw) ? raw : {};
  const details = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const cached = number(details.cached_tokens);
  const result: Json = { input_tokens: Math.max(0, number(usage.prompt_tokens) - cached), output_tokens: number(usage.completion_tokens) };
  if (cached > 0) result.cache_read_input_tokens = cached;
  return result;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

// Turns Chat Completions chunks into Anthropic events. Text and reasoning stream as they come;
// tool calls are collected by index and sent whole once the choice finishes, since providers
// interleave and split them differently.
export class ChatClaudeStream implements EventTranslator {
  private index = -1;
  private open: "text" | "thinking" | null = null;
  private started = false;
  private finished = false;
  private finish = "";
  private usage: Json = { input_tokens: 0, output_tokens: 0 };
  private readonly calls = new Map<number, ToolCall>();

  constructor(private readonly model: string) {}

  private start(block: Json, kind: "text" | "thinking"): string {
    this.index += 1;
    this.open = kind;
    return sse("content_block_start", { type: "content_block_start", index: this.index, content_block: block });
  }

  private stop(): string {
    if (this.open === null) return "";
    this.open = null;
    return sse("content_block_stop", { type: "content_block_stop", index: this.index });
  }

  private messageStart(id: string): string {
    if (this.started) return "";
    this.started = true;
    const message = { id: id ? `msg_${id.replace(/^chatcmpl-/, "")}` : `msg_${crypto.randomUUID().replaceAll("-", "")}`, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
    return sse("message_start", { type: "message_start", message });
  }

  private complete(): string {
    this.finished = true;
    let out = this.stop();
    for (const call of [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
      this.index += 1;
      out += sse("content_block_start", { type: "content_block_start", index: this.index, content_block: { type: "tool_use", id: call.id || `call_${this.index}`, name: call.name, input: {} } });
      if (call.arguments !== "") out += sse("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "input_json_delta", partial_json: call.arguments } });
      out += sse("content_block_stop", { type: "content_block_stop", index: this.index });
    }
    out += sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason(this.finish, this.calls.size > 0), stop_sequence: null }, usage: this.usage });
    return out + sse("message_stop", { type: "message_stop" });
  }

  event(event: Json): string {
    if (this.finished) return "";
    if (isObject(event.error)) {
      this.finished = true;
      return sse("error", { type: "error", error: { type: "api_error", message: text(event.error.message) || "The upstream failed." } });
    }
    let out = this.messageStart(text(event.id));
    if (isObject(event.usage)) this.usage = chatUsage(event.usage);
    const choice = Array.isArray(event.choices) && isObject(event.choices[0]) ? event.choices[0] : null;
    if (choice === null) return out;
    const delta = isObject(choice.delta) ? choice.delta : {};
    const reasoning = text(delta.reasoning_content) || text(delta.reasoning);
    if (reasoning !== "") {
      if (this.open !== "thinking") out += this.stop() + this.start({ type: "thinking", thinking: "" }, "thinking");
      out += sse("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "thinking_delta", thinking: reasoning } });
    }
    if (text(delta.content) !== "") {
      if (this.open !== "text") out += this.stop() + this.start({ type: "text", text: "" }, "text");
      out += sse("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "text_delta", text: text(delta.content) } });
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!isObject(call)) continue;
      const position = typeof call.index === "number" ? call.index : this.calls.size;
      const current = this.calls.get(position) ?? { id: "", name: "", arguments: "" };
      const fn = isObject(call.function) ? call.function : {};
      if (text(call.id) !== "") current.id = text(call.id);
      if (text(fn.name) !== "") current.name = text(fn.name);
      current.arguments += text(fn.arguments);
      this.calls.set(position, current);
    }
    if (text(choice.finish_reason) !== "") this.finish = text(choice.finish_reason);
    return out;
  }

  // Chat streams end with [DONE], often after a usage-only chunk, so the message closes here.
  end(): string {
    if (this.finished) return "";
    return this.messageStart("") + this.complete();
  }
}

export function chatClaudeMessage(response: Json, model: string): Json {
  const choice = Array.isArray(response.choices) && isObject(response.choices[0]) ? response.choices[0] : {};
  const message = isObject(choice.message) ? choice.message : {};
  const content: Json[] = [];
  const reasoning = text(message.reasoning_content) || text(message.reasoning);
  if (reasoning !== "") content.push({ type: "thinking", thinking: reasoning, signature: "" });
  if (text(message.content) !== "") content.push({ type: "text", text: text(message.content) });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isObject) : [];
  for (const call of calls) {
    const fn = isObject(call.function) ? call.function : {};
    let input: unknown;
    try {
      input = JSON.parse(text(fn.arguments) || "{}");
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: text(call.id), name: text(fn.name), input });
  }
  return {
    id: `msg_${text(response.id).replace(/^chatcmpl-/, "") || crypto.randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason(text(choice.finish_reason), calls.length > 0),
    stop_sequence: null,
    usage: chatUsage(response.usage),
  };
}
