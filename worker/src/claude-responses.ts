// Translation between Anthropic Messages (what Claude Code speaks) and OpenAI Responses (what
// ChatGPT logins and Codex keys take), ported from CPA's translator/codex/claude.

export type Json = Record<string, unknown>;

const NAME_LIMIT = 64;
// Codex reasoning items carry Fernet tokens; anything else (a Claude signature from an earlier
// turn on another model) can't be replayed to OpenAI.
const CODEX_SIGNATURE = /^gAAAA/;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// OpenAI caps tool names at 64 characters; long MCP names keep their last segment, as in CPA.
function baseShortName(name: string): string {
  if (name.length <= NAME_LIMIT) return name;
  if (name.startsWith("mcp__")) {
    const index = name.lastIndexOf("__");
    if (index > 0) return `mcp__${name.slice(index + 2)}`.slice(0, NAME_LIMIT);
  }
  return name.slice(0, NAME_LIMIT);
}

// Original tool name to the name sent upstream, unique within the request.
export function shortToolNames(names: readonly string[]): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  for (const name of names) {
    let candidate = baseShortName(name);
    for (let index = 1; used.has(candidate); index += 1) {
      const suffix = `_${index}`;
      candidate = baseShortName(name).slice(0, NAME_LIMIT - suffix.length) + suffix;
    }
    used.add(candidate);
    map.set(name, candidate);
  }
  return map;
}

// Claude tool ids can exceed the Responses call_id limit; a hash suffix keeps them distinct.
async function callId(id: string): Promise<string> {
  if (id.length <= NAME_LIMIT) return id;
  const suffix = `_${(await sha256Hex(id)).slice(0, 16)}`;
  return id.slice(0, NAME_LIMIT - suffix.length) + suffix;
}

function effortFromBudget(budget: number): string {
  if (budget === 0) return "low";
  if (budget < 0) return "medium";
  if (budget <= 1024) return "low";
  if (budget <= 8192) return "medium";
  if (budget <= 24576) return "high";
  return "xhigh";
}

export function reasoningEffort(body: Json): string {
  const config = isObject(body.output_config) ? body.output_config : {};
  let effort = text(config.effort).trim().toLowerCase();
  if (effort === "max") effort = "xhigh";
  const thinking = body.thinking;
  if (!isObject(thinking)) return effort || "medium";
  switch (thinking.type) {
    case "enabled":
      return typeof thinking.budget_tokens === "number" ? effortFromBudget(thinking.budget_tokens) : "medium";
    case "adaptive":
    case "auto":
      return effort || "high";
    case "disabled":
      return "low";
    default:
      return "medium";
  }
}

// JSON Schema keywords OpenAI's function parameters refuse.
function cleanSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanSchema);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => (key === "$schema" || key === "$id" ? [] : [[key, cleanSchema(child)]])));
}

export function toolParameters(schema: unknown): Json {
  if (!isObject(schema)) return { type: "object", properties: {} };
  const cleaned = cleanSchema(schema) as Json;
  if (cleaned.type === undefined || cleaned.type === null || cleaned.type === "") cleaned.type = "object";
  const isObjectType = cleaned.type === "object" || (Array.isArray(cleaned.type) && cleaned.type.includes("object"));
  if (isObjectType && !isObject(cleaned.properties)) cleaned.properties = {};
  return cleaned;
}

function imagePart(source: unknown): Json | null {
  if (!isObject(source)) return null;
  const data = text(source.data) || text(source.base64);
  if (data !== "") return { type: "input_image", image_url: `data:${text(source.media_type) || text(source.mime_type) || "application/octet-stream"};base64,${data}` };
  const url = text(source.url).trim();
  if (source.type === "url" && /^https?:\/\//i.test(url)) return { type: "input_image", image_url: url };
  if (source.type === "file" && text(source.file_id) !== "") return { type: "input_image", file_id: text(source.file_id) };
  return null;
}

function documentPart(part: Json): Json | null {
  const source = isObject(part.source) ? part.source : {};
  const mediaType = text(source.media_type).trim();
  const data = text(source.data) || text(source.base64);
  if (source.type !== "base64" || mediaType.toLowerCase() !== "application/pdf" || data === "") return null;
  return { type: "input_file", file_data: `data:${mediaType};base64,${data}`, filename: "document.pdf" };
}

function toolResultOutput(content: unknown): unknown {
  if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content ?? "");
  const parts = content.flatMap((item): Json[] => {
    if (!isObject(item)) return [];
    if (item.type === "text") return [{ type: "input_text", text: text(item.text) }];
    if (item.type === "image") {
      const image = imagePart(item.source);
      return image === null ? [] : [image];
    }
    return [];
  });
  return parts.length > 0 ? parts : "";
}

// Claude Code adds a billing attribution line to its system prompt that means nothing upstream.
export function isAttribution(line: string): boolean {
  return line.startsWith("x-anthropic-billing-header:");
}

export interface TranslatedRequest {
  readonly body: Json;
  // Upstream tool name to the client's, for the response.
  readonly toolNames: Map<string, string>;
  readonly stream: boolean;
}

export async function claudeToResponses(claude: Json, model: string): Promise<TranslatedRequest> {
  const tools = Array.isArray(claude.tools) ? claude.tools.filter(isObject) : [];
  const names = shortToolNames(tools.flatMap((tool) => (text(tool.name) === "" ? [] : [text(tool.name)])));
  const shortName = (name: string) => names.get(name) ?? baseShortName(name);
  const input: Json[] = [];

  const system = typeof claude.system === "string" ? [{ type: "text", text: claude.system }] : Array.isArray(claude.system) ? claude.system : [];
  const systemParts = system.flatMap((part) => (isObject(part) && part.type === "text" && text(part.text) !== "" && !isAttribution(text(part.text)) ? [{ type: "input_text", text: text(part.text) }] : []));
  if (systemParts.length > 0) input.push({ type: "message", role: "developer", content: systemParts });

  for (const message of Array.isArray(claude.messages) ? claude.messages : []) {
    if (!isObject(message)) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const textType = role === "assistant" ? "output_text" : "input_text";
    let parts: Json[] = [];
    const flush = () => {
      if (parts.length > 0) input.push({ type: "message", role, content: parts });
      parts = [];
    };
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      if (!isObject(part)) continue;
      switch (part.type) {
        case "text":
          parts.push({ type: textType, text: text(part.text) });
          break;
        case "image": {
          const image = imagePart(part.source);
          if (image !== null) parts.push(image);
          break;
        }
        case "document": {
          const document = documentPart(part);
          if (document !== null) parts.push(document);
          break;
        }
        case "thinking": {
          const signature = text(part.signature);
          if (role !== "assistant" || !CODEX_SIGNATURE.test(signature)) break;
          flush();
          input.push({ type: "reasoning", summary: [], content: null, encrypted_content: signature });
          break;
        }
        case "tool_use":
          flush();
          input.push({ type: "function_call", call_id: await callId(text(part.id)), name: shortName(text(part.name)), arguments: JSON.stringify(part.input ?? {}) });
          break;
        case "tool_result":
          flush();
          input.push({ type: "function_call_output", call_id: await callId(text(part.tool_use_id)), output: toolResultOutput(part.content) });
          break;
        default:
          break;
      }
    }
    flush();
  }

  const body: Json = { model, instructions: "", input };
  if (tools.length > 0) {
    let webSearch = false;
    body.tools = tools.map((tool) => {
      if (/^web_search_\d+$/.test(text(tool.type))) {
        webSearch = true;
        const search: Json = { type: "web_search" };
        if (Array.isArray(tool.allowed_domains)) search.filters = { allowed_domains: tool.allowed_domains };
        if (isObject(tool.user_location)) search.user_location = tool.user_location;
        return search;
      }
      const converted: Json = { type: "function", name: shortName(text(tool.name)), parameters: toolParameters(tool.input_schema), strict: false };
      if (typeof tool.description === "string") converted.description = tool.description;
      return converted;
    });
    body.tool_choice = toolChoice(claude.tool_choice, shortName);
    if (webSearch) body.include = ["reasoning.encrypted_content", "web_search_call.action.sources"];
  }
  const choice = isObject(claude.tool_choice) ? claude.tool_choice : {};
  body.parallel_tool_calls = choice.disable_parallel_tool_use !== true;
  body.reasoning = { effort: reasoningEffort(claude) };
  body.include ??= ["reasoning.encrypted_content"];
  body.stream = true;
  body.store = false;
  const format = isObject(claude.output_config) && isObject(claude.output_config.format) ? claude.output_config.format : null;
  if (format !== null && format.type === "json_schema" && isObject(format.schema)) {
    body.text = { format: { type: "json_schema", name: text(format.name) || "structured_output", strict: false, schema: format.schema } };
  }
  return { body, toolNames: new Map([...names].map(([original, short]) => [short, original])), stream: claude.stream === true };
}

function toolChoice(choice: unknown, shortName: (name: string) => string): unknown {
  const type = isObject(choice) ? text(choice.type) : text(choice);
  if (type === "any") return "required";
  if (type === "none") return "none";
  if (type === "tool" && isObject(choice) && text(choice.name) !== "") return { type: "function", name: shortName(text(choice.name)) };
  return "auto";
}

function stopReason(response: Json, toolUse: boolean): string {
  if (toolUse) return "tool_use";
  const details = isObject(response.incomplete_details) ? response.incomplete_details : {};
  const reason = text(details.reason);
  if (reason === "max_output_tokens") return "max_tokens";
  if (reason === "content_filter") return "refusal";
  return "end_turn";
}

export function usage(response: Json): Json {
  const raw = isObject(response.usage) ? response.usage : {};
  const details = isObject(raw.input_tokens_details) ? raw.input_tokens_details : {};
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const cached = number(details.cached_tokens);
  const result: Json = { input_tokens: Math.max(0, number(raw.input_tokens) - cached), output_tokens: number(raw.output_tokens) };
  if (cached > 0) result.cache_read_input_tokens = cached;
  return result;
}

export function sse(event: string, data: Json): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Turns a Responses event stream into Anthropic's, one upstream event at a time.
export class ClaudeStream implements EventTranslator {
  private index = -1;
  private open: "text" | "thinking" | "tool" | null = null;
  private toolUse = false;
  private started = false;
  private finished = false;

  constructor(
    private readonly model: string,
    private readonly toolNames: Map<string, string>,
  ) {}

  private start(block: Json, kind: "text" | "thinking" | "tool"): string {
    this.index += 1;
    this.open = kind;
    return sse("content_block_start", { type: "content_block_start", index: this.index, content_block: block });
  }

  private stop(): string {
    if (this.open === null) return "";
    this.open = null;
    return sse("content_block_stop", { type: "content_block_stop", index: this.index });
  }

  private delta(delta: Json): string {
    return sse("content_block_delta", { type: "content_block_delta", index: this.index, delta });
  }

  private messageStart(id: string): string {
    if (this.started) return "";
    this.started = true;
    const message = { id: id || `msg_${crypto.randomUUID().replaceAll("-", "")}`, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
    return sse("message_start", { type: "message_start", message });
  }

  event(event: Json): string {
    if (this.finished) return "";
    const item = isObject(event.item) ? event.item : {};
    switch (event.type) {
      case "response.created":
        return this.messageStart(text(isObject(event.response) ? event.response.id : ""));
      case "response.output_item.added":
        return this.messageStart("") + this.stop();
      case "response.reasoning_summary_part.added":
        if (this.open === "thinking") return this.delta({ type: "thinking_delta", thinking: "\n\n" });
        return this.messageStart("") + this.stop() + this.start({ type: "thinking", thinking: "" }, "thinking");
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const opened = this.open === "thinking" ? "" : this.stop() + this.start({ type: "thinking", thinking: "" }, "thinking");
        return this.messageStart("") + opened + this.delta({ type: "thinking_delta", thinking: text(event.delta) });
      }
      case "response.output_text.delta": {
        const opened = this.open === "text" ? "" : this.stop() + this.start({ type: "text", text: "" }, "text");
        return this.messageStart("") + opened + this.delta({ type: "text_delta", text: text(event.delta) });
      }
      case "response.output_item.done":
        // Parallel calls can interleave their argument deltas, so each call is sent whole once done.
        if (item.type === "function_call") {
          this.toolUse = true;
          const name = text(item.name);
          const block = this.stop() + this.start({ type: "tool_use", id: text(item.call_id), name: this.toolNames.get(name) ?? name, input: {} }, "tool");
          const args = text(item.arguments);
          return this.messageStart("") + block + (args === "" ? "" : this.delta({ type: "input_json_delta", partial_json: args })) + this.stop();
        }
        if (item.type === "reasoning") {
          const signature = text(item.encrypted_content);
          if (signature === "") return this.stop();
          // The encrypted reasoning rides along as the thinking block's signature, so Claude Code
          // sends it back next turn and the model keeps its chain of thought.
          const opened = this.open === "thinking" ? "" : this.stop() + this.start({ type: "thinking", thinking: "" }, "thinking");
          return opened + this.delta({ type: "signature_delta", signature }) + this.stop();
        }
        return this.stop();
      case "response.completed":
      case "response.incomplete": {
        this.finished = true;
        const response = isObject(event.response) ? event.response : {};
        const end = sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason(response, this.toolUse), stop_sequence: null }, usage: usage(response) });
        return this.messageStart(text(response.id)) + this.stop() + end + sse("message_stop", { type: "message_stop" });
      }
      case "response.failed":
      case "error": {
        this.finished = true;
        const response = isObject(event.response) ? event.response : event;
        const error = isObject(response.error) ? response.error : {};
        return sse("error", { type: "error", error: { type: "api_error", message: text(error.message) || text(event.message) || "The response failed upstream." } });
      }
      default:
        return "";
    }
  }

  // Closes the stream properly if the upstream ended without a final event.
  end(): string {
    if (this.finished) return "";
    this.finished = true;
    return sse("error", { type: "error", error: { type: "api_error", message: "The upstream stream ended early." } });
  }
}

// Turns one upstream event (already parsed from its SSE data line) into Anthropic SSE text.
export interface EventTranslator {
  event(event: Json): string;
  end(): string;
}

// Re-encodes an upstream SSE body as Anthropic SSE, line by line as it arrives.
export function claudeEventStream(upstream: ReadableStream<Uint8Array>, translator: EventTranslator): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const translate = (line: string): string => {
    if (!line.startsWith("data:")) return "";
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") return "";
    try {
      const event: unknown = JSON.parse(data);
      return isObject(event) ? translator.event(event) : "";
    } catch {
      return "";
    }
  };
  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        const out = lines.map((line) => translate(line.replace(/\r$/, ""))).join("");
        if (out !== "") controller.enqueue(encoder.encode(out));
      },
      flush(controller) {
        const out = translate(buffer.trim()) + translator.end();
        if (out !== "") controller.enqueue(encoder.encode(out));
      },
    }),
  );
}

// A final Responses object as one Anthropic message, for a client that didn't stream.
export function claudeMessage(response: Json, model: string, toolNames: Map<string, string>): Json {
  const content: Json[] = [];
  let toolUse = false;
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (!isObject(item)) continue;
    if (item.type === "message") {
      const joined = (Array.isArray(item.content) ? item.content : []).map((part) => (isObject(part) && part.type === "output_text" ? text(part.text) : "")).join("");
      if (joined !== "") content.push({ type: "text", text: joined });
    } else if (item.type === "reasoning") {
      const summary = (Array.isArray(item.summary) ? item.summary : []).map((part) => (isObject(part) ? text(part.text) : "")).join("\n\n");
      const signature = text(item.encrypted_content);
      if (summary !== "" || signature !== "") content.push({ type: "thinking", thinking: summary, signature });
    } else if (item.type === "function_call") {
      toolUse = true;
      let input: unknown;
      try {
        input = JSON.parse(text(item.arguments) || "{}");
      } catch {
        input = {};
      }
      const name = text(item.name);
      content.push({ type: "tool_use", id: text(item.call_id), name: toolNames.get(name) ?? name, input });
    }
  }
  return { id: text(response.id) || `msg_${crypto.randomUUID().replaceAll("-", "")}`, type: "message", role: "assistant", model, content, stop_reason: stopReason(response, toolUse), stop_sequence: null, usage: usage(response) };
}
