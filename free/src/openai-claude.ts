import { isObject, text, type EventTranslator, type Json } from "./claude-responses.ts";

// Translation between OpenAI Chat Completions clients and Anthropic Messages, for Claude API
// keys, ported from CPA's translator/claude/openai/chat-completions.

export const DEFAULT_MAX_TOKENS = 32000;
export const FABLE_MAX_TOKENS = 64000;
// Claude 4.5 and older take a thinking budget; newer models think adaptively at an effort.
const BUDGET_THINKING = /^claude-(?:3|(?:opus|sonnet|haiku)-4(?:-[0-5])?(?:-\d{8})?$|(?:opus|sonnet|haiku)-4-[0-5]-)/i;
const EFFORT_BUDGET: Record<string, number> = { minimal: 512, low: 1024, medium: 8192, high: 24576, xhigh: 32768, max: 128000 };

// Claude's tool names and IDs: letters, digits, _ and -, names up to 64 long.
export function claudeName(name: string): string {
  if (name === "") return "";
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "_";
}

export function toolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_") || `toolu_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export function withCache(block: Json, from: Json): Json {
  return isObject(from.cache_control) ? { ...block, cache_control: from.cache_control } : block;
}

export function dataUrl(url: string): { mediaType: string; data: string } | null {
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma === -1) return null;
  return { mediaType: url.slice(5, comma).split(";")[0] || "application/octet-stream", data: url.slice(comma + 1) };
}

function contentPart(part: Json): Json | null {
  switch (part.type) {
    case "text":
      return text(part.text).trim() === "" ? null : { type: "text", text: text(part.text) };
    case "image_url": {
      const url = isObject(part.image_url) ? text(part.image_url.url) : text(part.image_url);
      if (url === "") return null;
      const inline = dataUrl(url);
      return inline === null ? { type: "image", source: { type: "url", url } } : { type: "image", source: { type: "base64", media_type: inline.mediaType, data: inline.data } };
    }
    case "file": {
      const inline = dataUrl(isObject(part.file) ? text(part.file.file_data) : "");
      return inline === null ? null : { type: "document", source: { type: "base64", media_type: inline.mediaType, data: inline.data } };
    }
    default:
      return null;
  }
}

function toolResultContent(content: unknown): string | Json[] {
  if (typeof content === "string") return content;
  if (isObject(content)) {
    const part = contentPart(content);
    return part === null ? JSON.stringify(content) : [part];
  }
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    if (typeof item === "string") return item.trim() === "" ? [] : [{ type: "text", text: item }];
    const part = isObject(item) ? contentPart(item) : null;
    return part === null ? [] : [part];
  });
}

// Structured output has no Claude field, so CPA asks for it in the system prompt.
export function formatInstruction(format: unknown): string {
  if (!isObject(format)) return "";
  const plain = "You must format your entire response as a valid JSON object. Do not include any explanations, markdown code blocks (such as ```json), or any text outside of the JSON object.";
  const type = text(format.type).trim().toLowerCase();
  if (type === "json_object") return plain;
  if (type !== "json_schema") return "";
  const spec = isObject(format.json_schema) ? format.json_schema : {};
  const schema = spec.schema ?? format.schema;
  if (schema === undefined) return plain;
  const lines = ["You must format your entire response as valid JSON that conforms strictly to the following JSON schema:"];
  const name = text(spec.name).trim() || text(format.name).trim();
  if (name !== "") lines.push(`Schema Name: ${name}`);
  const description = text(spec.description).trim() || text(format.description).trim();
  if (description !== "") lines.push(`Schema Description: ${description}`);
  lines.push("JSON Schema:", JSON.stringify(schema), "Do not include any explanations, markdown code blocks (such as ```json), or any text outside of the JSON object.");
  return lines.join("\n");
}

// Claude wants an object schema without a root-level union: object branches are merged in.
export function inputSchema(raw: unknown): Json {
  if (!isObject(raw)) return { type: "object", properties: {} };
  const { anyOf, oneOf, allOf, ...schema } = raw;
  const properties: Json = isObject(schema.properties) ? { ...schema.properties } : {};
  for (const [union, branches] of [["anyOf", anyOf], ["oneOf", oneOf], ["allOf", allOf]] as const) {
    if (branches === undefined) continue;
    for (const branch of Array.isArray(branches) ? branches.filter(isObject) : []) {
      const type = branch.type;
      if (type !== undefined && type !== "object" && !(Array.isArray(type) && type.includes("object"))) continue;
      for (const [name, property] of Object.entries(isObject(branch.properties) ? branch.properties : {})) if (!Object.hasOwn(properties, name)) properties[name] = property;
      if (union === "allOf" && Array.isArray(branch.required)) {
        const required = Array.isArray(schema.required) ? schema.required : [];
        schema.required = [...new Set([...required, ...branch.required])];
      }
    }
  }
  return { ...schema, type: "object", properties };
}

export function thinking(effort: string, model: string, maxTokens: number): Json | null {
  if (effort === "") return null;
  if (effort === "none") return { thinking: { type: "disabled" } };
  if (!BUDGET_THINKING.test(model)) {
    if (effort === "auto") return { thinking: { type: "adaptive" } };
    const level = effort === "minimal" ? "low" : effort === "xhigh" ? "max" : effort;
    return ["low", "medium", "high", "max"].includes(level) ? { thinking: { type: "adaptive" }, output_config: { effort: level } } : null;
  }
  const budget = effort === "auto" ? 10000 : EFFORT_BUDGET[effort];
  if (budget === undefined) return null;
  // A budget must stay under max_tokens and at 1024 or above.
  const capped = Math.min(budget, maxTokens - 1);
  return capped < 1024 ? null : { thinking: { type: "enabled", budget_tokens: capped } };
}

export interface ClaudeRequest {
  readonly body: Json;
  readonly stream: boolean;
  // Claude tool name to the client's, for the response.
  readonly toolNames: Map<string, string>;
}

export function chatToClaude(chat: Json, model: string): ClaudeRequest {
  const toolNames = new Map<string, string>();
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
    if (last !== undefined && last.role === role) {
      last.content.push(...content);
      last.toolUses.push(...toolUses);
    } else turns.push({ role, content, toolUses });
  };
  const messages = Array.isArray(chat.messages) ? chat.messages.filter(isObject) : [];
  // A repeated tool result keeps its first place and its last content, as in CPA.
  const lastResult = new Map<string, Json>();
  for (const message of messages) if (message.role === "tool" && text(message.tool_call_id) !== "") lastResult.set(text(message.tool_call_id), message);
  const emitted = new Set<string>();

  for (const message of messages) {
    const content = message.content;
    switch (message.role) {
      case "system":
      case "developer": {
        const start = system.length;
        if (typeof content === "string") {
          if (content.trim() !== "") system.push(withCache({ type: "text", text: content }, message));
        } else if (Array.isArray(content)) {
          for (const part of content.filter(isObject)) {
            if (part.type === "text" && text(part.text).trim() !== "") system.push(withCache({ type: "text", text: text(part.text) }, part));
          }
          const last = system.at(-1);
          if (system.length > start && last !== undefined && !isObject(last.cache_control)) system[system.length - 1] = withCache(last, message);
        }
        break;
      }
      case "user":
      case "assistant": {
        const role = message.role;
        const blocks: Json[] = [];
        if (typeof content === "string") {
          if (content.trim() !== "") blocks.push({ type: "text", text: content });
        } else if (Array.isArray(content)) {
          for (const part of content.filter(isObject)) {
            const block = contentPart(part);
            if (block !== null) blocks.push(withCache(block, part));
          }
        }
        if (blocks.length > 0 && isObject(message.cache_control)) blocks[blocks.length - 1] = withCache(blocks.at(-1) as Json, message);
        const toolUses: Json[] = [];
        if (role === "assistant" && Array.isArray(message.tool_calls)) {
          for (const call of message.tool_calls.filter(isObject)) {
            if (call.type !== "function") continue;
            const fn = isObject(call.function) ? call.function : {};
            let input: unknown;
            try {
              input = JSON.parse(text(fn.arguments) || "{}");
            } catch {
              input = {};
            }
            toolUses.push({ type: "tool_use", id: toolId(text(call.id)), name: nameOf(text(fn.name)), input: isObject(input) ? input : {} });
          }
        }
        append(role, blocks, toolUses);
        break;
      }
      case "tool": {
        const rawId = text(message.tool_call_id);
        if (rawId !== "") {
          if (emitted.has(rawId)) break;
          emitted.add(rawId);
        }
        const target = lastResult.get(rawId) ?? message;
        // Anthropic refuses cache_control inside a tool result, so it goes on the result itself.
        const parts = Array.isArray(target.content) ? target.content.filter(isObject) : [];
        const partCache = parts.find((part) => isObject(part.cache_control));
        const result = withCache({ type: "tool_result", tool_use_id: toolId(rawId), content: toolResultContent(target.content) }, isObject(target.cache_control) ? target : (partCache ?? {}));
        append("user", [result]);
        break;
      }
      default:
        break;
    }
  }

  const instruction = formatInstruction(chat.response_format);
  if (instruction !== "") system.push({ type: "text", text: instruction });
  // Claude's tool_use blocks close an assistant turn.
  const claudeMessages = turns.map((turn) => ({ role: turn.role, content: [...turn.content, ...turn.toolUses] }));
  if (claudeMessages.length === 0 && system.length > 0) claudeMessages.push({ role: "user", content: [{ type: "text", text: "" }] });

  const maxTokens = typeof chat.max_tokens === "number" ? chat.max_tokens : typeof chat.max_completion_tokens === "number" ? chat.max_completion_tokens : /fable/i.test(model) ? FABLE_MAX_TOKENS : DEFAULT_MAX_TOKENS;
  const stream = chat.stream === true;
  const body: Json = { model, max_tokens: maxTokens, messages: claudeMessages, stream };
  if (system.length > 0) body.system = system;
  if (typeof chat.top_p === "number") body.top_p = chat.top_p;
  if (Array.isArray(chat.stop)) {
    const stops = chat.stop.map(String);
    if (stops.length > 0) body.stop_sequences = stops;
  } else if (typeof chat.stop === "string") body.stop_sequences = [chat.stop];
  Object.assign(body, thinking(text(chat.reasoning_effort).trim().toLowerCase(), model, maxTokens));

  // An allowed_tools choice narrows the tools sent, and then decides the choice.
  const choice = chat.tool_choice;
  let allowed: Set<string> | null = null;
  let allowedMode = "auto";
  if (isObject(choice) && choice.type === "allowed_tools") {
    const spec = isObject(choice.allowed_tools) ? choice.allowed_tools : choice;
    allowed = new Set();
    for (const tool of Array.isArray(spec.tools) ? spec.tools.filter(isObject) : []) {
      const name = (isObject(tool.function) ? text(tool.function.name) : "").trim() || text(tool.name).trim();
      if (name !== "") allowed.add(name).add(claudeName(name));
    }
    allowedMode = text(spec.mode).trim().toLowerCase() || "auto";
  }
  const tools: Json[] = [];
  for (const tool of Array.isArray(chat.tools) ? chat.tools.filter(isObject) : []) {
    if (tool.type !== "function") continue;
    const fn = isObject(tool.function) ? tool.function : {};
    const name = text(fn.name);
    if (allowed !== null && !allowed.has(name) && !allowed.has(claudeName(name))) continue;
    const declared: Json = { name: nameOf(name), description: text(fn.description), input_schema: inputSchema(fn.parameters ?? fn.parametersJsonSchema) };
    const strict = fn.strict ?? tool.strict;
    if (typeof strict === "boolean") declared.strict = strict;
    tools.push(withCache(declared, isObject(tool.cache_control) ? tool : fn));
  }
  if (tools.length > 0) body.tools = tools;

  if (allowed !== null) body.tool_choice = tools.length === 0 ? { type: "none" } : { type: allowedMode === "required" ? "any" : "auto" };
  else {
    const type = isObject(choice) ? text(choice.type) : text(choice);
    if (type === "none" || type === "auto") body.tool_choice = { type };
    else if (type === "required" || type === "any") body.tool_choice = { type: "any" };
    else if (type === "function" && isObject(choice)) {
      const name = (isObject(choice.function) ? text(choice.function.name) : "") || text(choice.name);
      body.tool_choice = name === "" ? { type: "none" } : { type: "tool", name: nameOf(name) };
    }
  }
  if (chat.parallel_tool_calls === false) {
    if (isObject(body.tool_choice)) {
      if (body.tool_choice.type !== "none") body.tool_choice = { ...body.tool_choice, disable_parallel_tool_use: true };
    } else if (tools.length > 0) body.tool_choice = { type: "auto", disable_parallel_tool_use: true };
  }
  return { body, stream, toolNames };
}

function finishReason(stop: string): string {
  if (stop === "tool_use") return "tool_calls";
  if (stop === "max_tokens" || stop === "model_context_window_exceeded") return "length";
  if (stop === "refusal" || stop === "sensitive") return "content_filter";
  return "stop";
}

export interface Usage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  thinking: number | null;
}

export function mergeUsage(usage: Usage, raw: unknown): boolean {
  if (!isObject(raw)) return false;
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  usage.input = number(raw.input_tokens) ?? usage.input;
  usage.output = number(raw.output_tokens) ?? usage.output;
  usage.cacheWrite = number(raw.cache_creation_input_tokens) ?? usage.cacheWrite;
  usage.cacheRead = number(raw.cache_read_input_tokens) ?? usage.cacheRead;
  const details = isObject(raw.output_tokens_details) ? raw.output_tokens_details : {};
  usage.thinking = number(details.thinking_tokens) ?? usage.thinking;
  return true;
}

// Claude counts cached input apart; OpenAI counts it inside the prompt.
function openaiUsage(usage: Usage): Json {
  const prompt = usage.input + usage.cacheWrite + usage.cacheRead;
  const result: Json = {
    prompt_tokens: prompt,
    completion_tokens: usage.output,
    total_tokens: prompt + usage.output,
    prompt_tokens_details: { cached_tokens: usage.cacheRead, cached_creation_tokens: usage.cacheWrite, cache_write_tokens: usage.cacheWrite },
  };
  if (usage.thinking !== null) result.completion_tokens_details = { reasoning_tokens: usage.thinking };
  return result;
}

function chunk(data: Json): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// Turns Anthropic events into Chat Completions chunks. Text and thinking stream as they come;
// a tool call is sent whole once its block closes.
export class ChatStream implements EventTranslator {
  private id = "";
  private created = Math.floor(Date.now() / 1000);
  private readonly usage: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, thinking: null };
  private hasUsage = false;
  private finished = false;
  private nextTool = 0;
  private readonly tools = new Map<number, { id: string; name: string; index: number; args: string }>();

  constructor(
    private readonly model: string,
    private readonly toolNames: Map<string, string>,
  ) {}

  private delta(delta: Json, finish: string | null = null, usage?: Json): string {
    const data: Json = { id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finish }] };
    if (usage !== undefined) data.usage = usage;
    return chunk(data);
  }

  event(event: Json): string {
    if (this.finished) return "";
    const index = typeof event.index === "number" ? event.index : 0;
    const delta = isObject(event.delta) ? event.delta : {};
    switch (event.type) {
      case "message_start": {
        const message = isObject(event.message) ? event.message : {};
        this.id = text(message.id);
        this.hasUsage = mergeUsage(this.usage, message.usage) || this.hasUsage;
        return this.delta({ role: "assistant" });
      }
      case "content_block_start": {
        const block = isObject(event.content_block) ? event.content_block : {};
        if (block.type === "tool_use") this.tools.set(index, { id: text(block.id), name: text(block.name), index: this.nextTool++, args: "" });
        return "";
      }
      case "content_block_delta":
        if (delta.type === "text_delta") return this.delta({ content: text(delta.text) });
        if (delta.type === "thinking_delta") return this.delta({ reasoning_content: text(delta.thinking) });
        if (delta.type === "input_json_delta") {
          const tool = this.tools.get(index);
          if (tool !== undefined) tool.args += text(delta.partial_json);
        }
        return "";
      case "content_block_stop": {
        const tool = this.tools.get(index);
        if (tool === undefined) return "";
        this.tools.delete(index);
        return this.delta({ tool_calls: [{ index: tool.index, id: tool.id, type: "function", function: { name: this.toolNames.get(tool.name) ?? tool.name, arguments: tool.args || "{}" } }] });
      }
      case "message_delta": {
        const finish = typeof delta.stop_reason === "string" ? finishReason(delta.stop_reason) : null;
        if (mergeUsage(this.usage, event.usage)) {
          this.hasUsage = true;
          return this.delta({}, finish, openaiUsage(this.usage));
        }
        return this.delta({}, finish);
      }
      case "message_stop":
        this.finished = true;
        return (this.hasUsage ? chunk({ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [], usage: openaiUsage(this.usage) }) : "") + "data: [DONE]\n\n";
      case "error": {
        this.finished = true;
        const error = isObject(event.error) ? event.error : {};
        return chunk({ error: { message: text(error.message), type: text(error.type) } }) + "data: [DONE]\n\n";
      }
      default:
        return "";
    }
  }

  end(): string {
    if (this.finished) return "";
    this.finished = true;
    return "data: [DONE]\n\n";
  }
}

// A whole Anthropic message as one chat completion, for a client that didn't stream.
export function chatCompletion(message: Json, model: string, toolNames: Map<string, string>): Json {
  const texts: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: Json[] = [];
  for (const block of Array.isArray(message.content) ? message.content.filter(isObject) : []) {
    if (block.type === "text") texts.push(text(block.text));
    else if (block.type === "thinking") reasoning.push(text(block.thinking));
    else if (block.type === "tool_use") toolCalls.push({ id: text(block.id), type: "function", function: { name: toolNames.get(text(block.name)) ?? text(block.name), arguments: JSON.stringify(isObject(block.input) ? block.input : {}) } });
  }
  const answer: Json = { role: "assistant", content: texts.join("") };
  if (reasoning.length > 0) answer.reasoning_content = reasoning.join("");
  if (toolCalls.length > 0) answer.tool_calls = toolCalls;
  let finish = finishReason(text(message.stop_reason));
  if (toolCalls.length > 0 && finish !== "length") finish = "tool_calls";
  const usage: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, thinking: null };
  const hasUsage = mergeUsage(usage, message.usage);
  return {
    id: text(message.id),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: answer, finish_reason: finish }],
    usage: hasUsage ? openaiUsage(usage) : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
