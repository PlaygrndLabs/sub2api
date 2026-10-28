import { isObject, sse, text, type EventTranslator, type Json } from "./claude-responses.ts";
import { claudeName, dataUrl, DEFAULT_MAX_TOKENS, FABLE_MAX_TOKENS, formatInstruction, inputSchema, mergeUsage, thinking, toolId, type ClaudeRequest, type Usage } from "./openai-claude.ts";

// Translation between OpenAI Responses clients and Anthropic Messages, ported from CPA's
// translator/claude/openai/responses. Other providers are reached by translating the Claude
// request on again.

// OpenAI's encrypted reasoning (a Fernet token) can't be replayed to Claude.
const OPENAI_REASONING = /^gAAAA/;
const INTERRUPTED = "Tool call was interrupted before any output was recorded.";
// A custom (free-form) tool takes one string, which Claude sees as a one-field object.
const CUSTOM_SCHEMA: Json = { type: "object", properties: { input: { type: "string" } }, required: ["input"] };

export interface ResponsesRequest extends ClaudeRequest {
  // Claude names of the client's custom tools, whose calls go back as custom_tool_call.
  readonly customTools: Set<string>;
}

function inputPart(part: Json): Json | null {
  switch (part.type) {
    case "input_text":
    case "output_text":
    case "text":
      return text(part.text) === "" ? null : { type: "text", text: text(part.text) };
    case "refusal":
      return text(part.refusal) === "" ? null : { type: "text", text: text(part.refusal) };
    case "input_image": {
      const url = isObject(part.image_url) ? text(part.image_url.url) : text(part.image_url);
      if (url === "") return null;
      const inline = dataUrl(url);
      return inline === null ? { type: "image", source: { type: "url", url } } : { type: "image", source: { type: "base64", media_type: inline.mediaType, data: inline.data } };
    }
    case "input_file": {
      const data = text(part.file_data);
      const inline = dataUrl(data);
      if (inline !== null) return { type: "document", source: { type: "base64", media_type: inline.mediaType, data: inline.data } };
      if (data !== "" && /\.pdf$/i.test(text(part.filename))) return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
      const url = text(part.file_url);
      return url === "" ? null : { type: "document", source: { type: "url", url } };
    }
    default:
      return null;
  }
}

function parts(content: unknown): Json[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (typeof part === "string") return part === "" ? [] : [{ type: "text", text: part }];
    const block = isObject(part) ? inputPart(part) : null;
    return block === null ? [] : [block];
  });
}

function parsedArguments(raw: unknown): Json {
  if (isObject(raw)) return raw;
  try {
    const value: unknown = JSON.parse(text(raw) || "{}");
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

// Every tool_use is answered at the start of the next user turn, as Claude requires: missing
// results are filled in as errors, and results without a call become plain text.
function orphaned(block: Json, calls: readonly string[]): Json {
  if (block.type !== "tool_result" || calls.includes(text(block.tool_use_id))) return block;
  return { type: "text", text: `Tool result ${text(block.tool_use_id)}: ${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}` };
}

function pairToolResults(messages: Json[]): Json[] {
  const paired: Json[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as Json & { content: Json[] };
    if (message.role === "user") {
      paired.push({ ...message, content: message.content.map((block) => orphaned(block, [])) });
      continue;
    }
    paired.push(message);
    const ids = message.content.filter((block) => block.type === "tool_use").map((block) => text(block.id));
    if (ids.length === 0) continue;
    const next = messages[index + 1] as (Json & { content: Json[] }) | undefined;
    const answers = next?.role === "user" ? next.content : [];
    const results = ids.map((id) => answers.find((block) => block.type === "tool_result" && block.tool_use_id === id) ?? { type: "tool_result", tool_use_id: id, content: INTERRUPTED, is_error: true });
    const rest = answers.filter((block) => !(block.type === "tool_result" && ids.includes(text(block.tool_use_id)))).map((block) => orphaned(block, ids));
    paired.push({ role: "user", content: [...results, ...rest] });
    if (next?.role === "user") index += 1;
  }
  return paired;
}

export function responsesToClaude(request: Json, model: string): ResponsesRequest {
  const toolNames = new Map<string, string>();
  const customTools = new Set<string>();
  const nameOf = (name: string) => {
    const short = claudeName(name);
    toolNames.set(short, name);
    return short;
  };
  const system: Json[] = [];
  const turns: { role: string; content: Json[]; toolUses: Json[] }[] = [];
  const append = (role: string, content: Json[], toolUses: Json[] = []) => {
    if (content.length === 0 && toolUses.length === 0) return;
    const last = turns.at(-1);
    if (last !== undefined && last.role === role && (role === "user" || last.toolUses.length === 0 || content.length === 0)) {
      last.content.push(...content);
      last.toolUses.push(...toolUses);
    } else turns.push({ role, content, toolUses });
  };
  if (text(request.instructions).trim() !== "") system.push({ type: "text", text: text(request.instructions) });

  const items = typeof request.input === "string" ? [{ role: "user", content: request.input }] : Array.isArray(request.input) ? request.input.filter(isObject) : [];
  // A repeated tool output keeps its first place and its last content, as in CPA.
  const lastOutput = new Map<string, Json>();
  for (const item of items) if ((item.type === "function_call_output" || item.type === "custom_tool_call_output") && text(item.call_id) !== "") lastOutput.set(text(item.call_id), item);
  const emitted = new Set<string>();

  for (const item of items) {
    const type = text(item.type) || "message";
    switch (type) {
      case "message": {
        const role = text(item.role);
        if (role === "system" || role === "developer") {
          for (const part of parts(item.content)) if (text(part.text).trim() !== "") system.push(part);
        } else if (role === "user" || role === "assistant") append(role, parts(item.content));
        break;
      }
      case "reasoning": {
        // Only a Claude signature from an earlier turn can be replayed; without it the thought is dropped.
        const signature = text(item.encrypted_content);
        if (signature === "" || OPENAI_REASONING.test(signature)) break;
        const summary = (Array.isArray(item.summary) ? item.summary.filter(isObject) : []).map((part) => text(part.text)).join("\n\n");
        append("assistant", [summary === "" ? { type: "redacted_thinking", data: signature } : { type: "thinking", thinking: summary, signature }]);
        break;
      }
      case "function_call":
        append("assistant", [], [{ type: "tool_use", id: toolId(text(item.call_id) || text(item.id)), name: nameOf(text(item.name)), input: parsedArguments(item.arguments) }]);
        break;
      case "custom_tool_call":
        append("assistant", [], [{ type: "tool_use", id: toolId(text(item.call_id) || text(item.id)), name: nameOf(text(item.name)), input: { input: text(item.input) } }]);
        break;
      case "function_call_output":
      case "custom_tool_call_output": {
        const rawId = text(item.call_id);
        if (rawId !== "") {
          if (emitted.has(rawId)) break;
          emitted.add(rawId);
        }
        const target = lastOutput.get(rawId) ?? item;
        const output = typeof target.output === "string" ? target.output : parts(target.output);
        const result: Json = { type: "tool_result", tool_use_id: toolId(rawId), content: output };
        if (target.status === "incomplete") result.is_error = true;
        append("user", [result]);
        break;
      }
      default:
        // Built-in tool items (web search, file search, computer use) have no Claude equivalent.
        break;
    }
  }

  const format = isObject(request.text) ? request.text.format : undefined;
  const instruction = formatInstruction(format);
  if (instruction !== "") system.push({ type: "text", text: instruction });
  let messages = pairToolResults(turns.map((turn) => ({ role: turn.role, content: [...turn.content, ...turn.toolUses] })));
  // A prefilled assistant turn can't end in a thought.
  const last = messages.at(-1);
  if (last?.role === "assistant") {
    const content = [...(last.content as Json[])];
    while (content.length > 0 && (content.at(-1)?.type === "thinking" || content.at(-1)?.type === "redacted_thinking")) content.pop();
    messages = content.length === 0 ? messages.slice(0, -1) : [...messages.slice(0, -1), { ...last, content }];
  }
  if (messages.length === 0) messages.push({ role: "user", content: [{ type: "text", text: "" }] });

  const maxTokens = typeof request.max_output_tokens === "number" ? request.max_output_tokens : /fable/i.test(model) ? FABLE_MAX_TOKENS : DEFAULT_MAX_TOKENS;
  const stream = request.stream === true;
  const body: Json = { model, max_tokens: maxTokens, messages, stream };
  if (system.length > 0) body.system = system;
  if (typeof request.top_p === "number") body.top_p = request.top_p;
  const reasoning = isObject(request.reasoning) ? request.reasoning : {};
  Object.assign(body, thinking(text(reasoning.effort).trim().toLowerCase(), model, maxTokens));

  const choice = request.tool_choice;
  let allowed: Set<string> | null = null;
  let allowedMode = "auto";
  if (isObject(choice) && choice.type === "allowed_tools") {
    allowed = new Set();
    for (const tool of Array.isArray(choice.tools) ? choice.tools.filter(isObject) : []) if (text(tool.name) !== "") allowed.add(text(tool.name));
    allowedMode = text(choice.mode).trim().toLowerCase() || "auto";
  }
  const tools: Json[] = [];
  for (const tool of Array.isArray(request.tools) ? request.tools.filter(isObject) : []) {
    const name = text(tool.name);
    if ((tool.type !== "function" && tool.type !== "custom") || name === "" || (allowed !== null && !allowed.has(name))) continue;
    const declared: Json = { name: nameOf(name), description: text(tool.description) };
    if (tool.type === "custom") {
      customTools.add(declared.name as string);
      declared.input_schema = CUSTOM_SCHEMA;
    } else {
      declared.input_schema = inputSchema(tool.parameters);
      if (typeof tool.strict === "boolean") declared.strict = tool.strict;
    }
    tools.push(declared);
  }
  if (tools.length > 0) body.tools = tools;

  if (allowed !== null) body.tool_choice = tools.length === 0 ? { type: "none" } : { type: allowedMode === "required" ? "any" : "auto" };
  else {
    const type = isObject(choice) ? text(choice.type) : text(choice);
    if (type === "none" || type === "auto") body.tool_choice = { type };
    else if (type === "required") body.tool_choice = { type: "any" };
    else if ((type === "function" || type === "custom") && isObject(choice) && text(choice.name) !== "") body.tool_choice = { type: "tool", name: nameOf(text(choice.name)) };
  }
  if (request.parallel_tool_calls === false && tools.length > 0) {
    const current = isObject(body.tool_choice) ? body.tool_choice : { type: "auto" };
    if (current.type !== "none") body.tool_choice = { ...current, disable_parallel_tool_use: true };
  }
  return { body, stream, toolNames, customTools };
}

// Claude counts cached input apart; OpenAI counts it inside the input.
function responsesUsage(usage: Usage): Json {
  const input = usage.input + usage.cacheWrite + usage.cacheRead;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage.cacheRead },
    output_tokens: usage.output,
    output_tokens_details: { reasoning_tokens: usage.thinking ?? 0 },
    total_tokens: input + usage.output,
  };
}

function responseId(messageId: string): string {
  return `resp_${messageId.replace(/^msg_/, "") || crypto.randomUUID().replaceAll("-", "")}`;
}

interface Shared {
  readonly model: string;
  readonly toolNames: Map<string, string>;
  readonly customTools: Set<string>;
}

function toolItem(shared: Shared, id: string, callId: string, name: string, args: string, status: string): Json {
  const original = shared.toolNames.get(name) ?? name;
  if (shared.customTools.has(name)) {
    const input = parsedArguments(args).input;
    return { id, type: "custom_tool_call", status, call_id: callId, name: original, input: typeof input === "string" ? input : "" };
  }
  return { id, type: "function_call", status, call_id: callId, name: original, arguments: args || "{}" };
}

function messageItem(id: string, value: string, status: string): Json {
  return { id, type: "message", status, role: "assistant", content: [{ type: "output_text", text: value, annotations: [], logprobs: [] }] };
}

function reasoningItem(id: string, summary: string, signature: string): Json {
  const item: Json = { id, type: "reasoning", summary: summary === "" ? [] : [{ type: "summary_text", text: summary }] };
  if (signature !== "") item.encrypted_content = signature;
  return item;
}

function responseObject(id: string, created: number, model: string, status: string, output: Json[], usage: Json | null, stop: string): Json {
  const response: Json = { id, object: "response", created_at: created, status, error: null, incomplete_details: null, model, output, usage };
  if (status === "incomplete") response.incomplete_details = { reason: stop === "max_tokens" ? "max_output_tokens" : "content_filter" };
  return response;
}

function finalStatus(stop: string): string {
  return stop === "max_tokens" || stop === "model_context_window_exceeded" || stop === "refusal" ? "incomplete" : "completed";
}

interface OpenBlock {
  readonly kind: "text" | "thinking" | "redacted" | "tool";
  readonly id: string;
  readonly output: number;
  value: string;
  signature: string;
  readonly callId: string;
  readonly name: string;
}

// Turns Anthropic events into a Responses event stream: each Claude content block becomes one
// output item, text and reasoning streamed as they come.
export class ResponsesStream implements EventTranslator {
  private id = "";
  private readonly created = Math.floor(Date.now() / 1000);
  private sequence = 0;
  private readonly output: Json[] = [];
  private readonly blocks = new Map<number, OpenBlock>();
  private readonly usage: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, thinking: null };
  private stop = "";
  private started = false;
  private finished = false;
  private readonly shared: Shared;

  constructor(model: string, toolNames: Map<string, string>, customTools: Set<string> = new Set()) {
    this.shared = { model, toolNames, customTools };
  }

  private send(type: string, data: Json): string {
    return sse(type, { type, sequence_number: this.sequence++, ...data });
  }

  private response(status: string): Json {
    return responseObject(this.id, this.created, this.shared.model, status, this.output, status === "in_progress" ? null : responsesUsage(this.usage), this.stop);
  }

  private begin(messageId: string): string {
    if (this.started) return "";
    this.started = true;
    this.id = responseId(messageId);
    return this.send("response.created", { response: this.response("in_progress") }) + this.send("response.in_progress", { response: this.response("in_progress") });
  }

  event(event: Json): string {
    if (this.finished) return "";
    const index = typeof event.index === "number" ? event.index : 0;
    const delta = isObject(event.delta) ? event.delta : {};
    switch (event.type) {
      case "message_start": {
        const message = isObject(event.message) ? event.message : {};
        mergeUsage(this.usage, message.usage);
        return this.begin(text(message.id));
      }
      case "content_block_start":
        return this.begin("") + this.open(index, isObject(event.content_block) ? event.content_block : {});
      case "content_block_delta": {
        const block = this.blocks.get(index);
        if (block === undefined) return "";
        const at = { item_id: block.id, output_index: block.output };
        if (delta.type === "text_delta" && block.kind === "text") {
          block.value += text(delta.text);
          return this.send("response.output_text.delta", { ...at, content_index: 0, delta: text(delta.text), logprobs: [] });
        }
        if (delta.type === "thinking_delta" && block.kind === "thinking") {
          block.value += text(delta.thinking);
          return this.send("response.reasoning_summary_text.delta", { ...at, summary_index: 0, delta: text(delta.thinking) });
        }
        if (delta.type === "signature_delta") block.signature += text(delta.signature);
        if (delta.type === "input_json_delta" && block.kind === "tool") {
          block.value += text(delta.partial_json);
          // A custom tool's input is the string inside the JSON, known only once it is complete.
          if (!this.shared.customTools.has(block.name)) return this.send("response.function_call_arguments.delta", { ...at, delta: text(delta.partial_json) });
        }
        return "";
      }
      case "content_block_stop":
        return this.close(index);
      case "message_delta":
        mergeUsage(this.usage, event.usage);
        if (typeof delta.stop_reason === "string") this.stop = delta.stop_reason;
        return "";
      case "message_stop": {
        this.finished = true;
        const closing = [...this.blocks.keys()].map((open) => this.close(open)).join("");
        const status = finalStatus(this.stop);
        return this.begin("") + closing + this.send(status === "completed" ? "response.completed" : "response.incomplete", { response: this.response(status) });
      }
      case "error": {
        const error = isObject(event.error) ? event.error : {};
        return this.fail(text(error.message) || "The response failed upstream.");
      }
      default:
        return "";
    }
  }

  private open(index: number, block: Json): string {
    const output = this.output.length + this.blocks.size;
    const suffix = `${this.id.slice(5)}_${output}`;
    switch (block.type) {
      case "text": {
        const id = `msg_${suffix}`;
        this.blocks.set(index, { kind: "text", id, output, value: "", signature: "", callId: "", name: "" });
        const item = { id, type: "message", status: "in_progress", role: "assistant", content: [] };
        return this.send("response.output_item.added", { output_index: output, item }) + this.send("response.content_part.added", { item_id: id, output_index: output, content_index: 0, part: { type: "output_text", text: "", annotations: [], logprobs: [] } });
      }
      case "thinking":
      case "redacted_thinking": {
        const id = `rs_${suffix}`;
        const redacted = block.type === "redacted_thinking";
        this.blocks.set(index, { kind: redacted ? "redacted" : "thinking", id, output, value: "", signature: redacted ? text(block.data) : "", callId: "", name: "" });
        const added = this.send("response.output_item.added", { output_index: output, item: { id, type: "reasoning", summary: [] } });
        return redacted ? added : added + this.send("response.reasoning_summary_part.added", { item_id: id, output_index: output, summary_index: 0, part: { type: "summary_text", text: "" } });
      }
      case "tool_use": {
        const id = `fc_${suffix}`;
        const name = text(block.name);
        const input = isObject(block.input) && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : "";
        this.blocks.set(index, { kind: "tool", id, output, value: input, signature: "", callId: text(block.id), name });
        const item = toolItem(this.shared, id, text(block.id), name, "", "in_progress");
        if (item.type === "function_call") item.arguments = "";
        return this.send("response.output_item.added", { output_index: output, item });
      }
      default:
        return "";
    }
  }

  private close(index: number): string {
    const block = this.blocks.get(index);
    if (block === undefined) return "";
    this.blocks.delete(index);
    const at = { item_id: block.id, output_index: block.output };
    let events = "";
    let item: Json;
    switch (block.kind) {
      case "text":
        item = messageItem(block.id, block.value, "completed");
        events =
          this.send("response.output_text.done", { ...at, content_index: 0, text: block.value, logprobs: [] }) +
          this.send("response.content_part.done", { ...at, content_index: 0, part: { type: "output_text", text: block.value, annotations: [], logprobs: [] } });
        break;
      case "thinking":
        item = reasoningItem(block.id, block.value, block.signature);
        events = this.send("response.reasoning_summary_text.done", { ...at, summary_index: 0, text: block.value }) + this.send("response.reasoning_summary_part.done", { ...at, summary_index: 0, part: { type: "summary_text", text: block.value } });
        break;
      case "redacted":
        item = reasoningItem(block.id, "", block.signature);
        break;
      case "tool":
        item = toolItem(this.shared, block.id, block.callId, block.name, block.value, "completed");
        events =
          item.type === "custom_tool_call"
            ? this.send("response.custom_tool_call_input.delta", { ...at, delta: item.input }) + this.send("response.custom_tool_call_input.done", { ...at, input: item.input })
            : this.send("response.function_call_arguments.done", { ...at, name: item.name, arguments: item.arguments });
        break;
    }
    this.output[block.output] = item;
    return events + this.send("response.output_item.done", { output_index: block.output, item });
  }

  private fail(message: string): string {
    this.finished = true;
    const response = { ...this.response("failed"), error: { code: "server_error", message } };
    return this.begin("") + this.send("response.failed", { response });
  }

  end(): string {
    if (this.finished) return "";
    return this.fail("The upstream stream ended early.");
  }
}

// A whole Anthropic message as one Responses object, for a client that didn't stream.
export function responsesResponse(message: Json, model: string, toolNames: Map<string, string>, customTools: Set<string>): Json {
  const shared: Shared = { model, toolNames, customTools };
  const id = responseId(text(message.id));
  const suffix = id.slice(5);
  const output: Json[] = [];
  for (const block of Array.isArray(message.content) ? message.content.filter(isObject) : []) {
    const itemId = `${suffix}_${output.length}`;
    if (block.type === "text") output.push(messageItem(`msg_${itemId}`, text(block.text), "completed"));
    else if (block.type === "thinking") output.push(reasoningItem(`rs_${itemId}`, text(block.thinking), text(block.signature)));
    else if (block.type === "redacted_thinking") output.push(reasoningItem(`rs_${itemId}`, "", text(block.data)));
    else if (block.type === "tool_use") output.push(toolItem(shared, `fc_${itemId}`, text(block.id), text(block.name), JSON.stringify(isObject(block.input) ? block.input : {}), "completed"));
  }
  const usage: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, thinking: null };
  mergeUsage(usage, message.usage);
  const stop = text(message.stop_reason);
  return responseObject(id, Math.floor(Date.now() / 1000), model, finalStatus(stop), output, responsesUsage(usage), stop);
}
