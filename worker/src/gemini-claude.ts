import { isObject, text, type EventTranslator, type Json } from "./claude-responses.ts";
import { claudeName, DEFAULT_MAX_TOKENS, FABLE_MAX_TOKENS, formatInstruction, inputSchema, mergeUsage, thinking, toolId, type ClaudeRequest, type Usage } from "./openai-claude.ts";

// Translation between Gemini generateContent clients and Anthropic Messages, ported from CPA's
// translator/claude/gemini. Other providers are reached by translating the Claude request on.

function inline(part: Json): Json | null {
  const data = isObject(part.inlineData) ? part.inlineData : isObject(part.inline_data) ? part.inline_data : null;
  if (data === null) return null;
  const mediaType = text(data.mimeType) || text(data.mime_type);
  const payload = text(data.data);
  if (mediaType === "" || payload === "") return null;
  const source = { type: "base64", media_type: mediaType, data: payload };
  return mediaType.startsWith("image/") ? { type: "image", source } : { type: "document", source };
}

function fileReference(part: Json): Json | null {
  const file = isObject(part.fileData) ? part.fileData : isObject(part.file_data) ? part.file_data : null;
  const url = file === null ? "" : text(file.fileUri) || text(file.file_uri);
  if (!/^https:\/\//i.test(url)) return null;
  const mediaType = file === null ? "" : text(file.mimeType) || text(file.mime_type);
  return mediaType.startsWith("image/") ? { type: "image", source: { type: "url", url } } : { type: "document", source: { type: "url", url } };
}

function responseContent(response: unknown): string {
  if (typeof response === "string") return response;
  if (isObject(response) && Object.keys(response).length === 1) {
    const only = response.output ?? response.result ?? response.content;
    if (typeof only === "string") return only;
  }
  return JSON.stringify(response ?? {});
}

function systemText(value: unknown): Json[] {
  if (typeof value === "string") return value.trim() === "" ? [] : [{ type: "text", text: value }];
  if (!isObject(value)) return [];
  return (Array.isArray(value.parts) ? value.parts.filter(isObject) : []).flatMap((part) => (text(part.text).trim() === "" ? [] : [{ type: "text", text: text(part.text) }]));
}

// Gemini's thinking settings as an effort: a level as is, a budget by its size.
function effortOf(config: Json): string {
  const level = text(config.thinkingLevel ?? config.thinking_level).toLowerCase();
  if (level !== "") return level;
  const budget = config.thinkingBudget ?? config.thinking_budget;
  if (typeof budget !== "number") return config.includeThoughts === true || config.include_thoughts === true ? "auto" : "";
  if (budget < 0) return "auto";
  if (budget === 0) return "none";
  return budget <= 1024 ? "low" : budget <= 8192 ? "medium" : budget <= 24576 ? "high" : "xhigh";
}

export function geminiToClaude(request: Json, model: string, stream: boolean): ClaudeRequest {
  const toolNames = new Map<string, string>();
  const nameOf = (name: string) => {
    const short = claudeName(name);
    toolNames.set(short, name);
    return short;
  };
  const system = systemText(request.systemInstruction ?? request.system_instruction);
  const messages: { role: string; content: Json[] }[] = [];
  // Gemini calls carry no ID unless the client set one, so results pair with calls by name, in order.
  const pending = new Map<string, string[]>();
  let synthesized = 0;
  for (const content of Array.isArray(request.contents) ? request.contents.filter(isObject) : []) {
    const role = content.role === "model" ? "assistant" : "user";
    const blocks: Json[] = [];
    const results: Json[] = [];
    for (const part of Array.isArray(content.parts) ? content.parts.filter(isObject) : []) {
      // Gemini's own thoughts and signatures can't be replayed to Claude.
      if (part.thought === true) continue;
      if (typeof part.text === "string") {
        if (part.text !== "") blocks.push({ type: "text", text: part.text });
        continue;
      }
      const call = isObject(part.functionCall) ? part.functionCall : isObject(part.function_call) ? part.function_call : null;
      if (call !== null && role === "assistant") {
        const name = text(call.name);
        const id = text(call.id) === "" ? `toolu_gemini_${synthesized++}` : toolId(text(call.id));
        pending.set(name, [...(pending.get(name) ?? []), id]);
        blocks.push({ type: "tool_use", id, name: nameOf(name), input: isObject(call.args) ? call.args : {} });
        continue;
      }
      const answer = isObject(part.functionResponse) ? part.functionResponse : isObject(part.function_response) ? part.function_response : null;
      if (answer !== null) {
        const name = text(answer.name);
        const queue = pending.get(name) ?? [];
        const wanted = text(answer.id) === "" ? "" : toolId(text(answer.id));
        const at = wanted === "" ? 0 : queue.indexOf(wanted);
        const id = at >= 0 ? queue.splice(at, 1)[0] : undefined;
        const content = responseContent(answer.response);
        results.push(id === undefined ? { type: "text", text: `Tool result ${name}: ${content}` } : { type: "tool_result", tool_use_id: id, content });
        continue;
      }
      const media = inline(part) ?? fileReference(part);
      if (media !== null) blocks.push(media);
    }
    const ordered = [...results, ...blocks];
    if (ordered.length === 0) continue;
    const last = messages.at(-1);
    if (last !== undefined && last.role === role) last.content.push(...ordered);
    else messages.push({ role, content: ordered });
  }
  // Calls left unanswered get an error result, so Claude always sees each call answered.
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as { role: string; content: Json[] };
    if (message.role !== "assistant") continue;
    const ids = message.content.filter((block) => block.type === "tool_use").map((block) => text(block.id));
    if (ids.length === 0) continue;
    let next = messages[index + 1];
    if (next?.role !== "user") {
      next = { role: "user", content: [] };
      messages.splice(index + 1, 0, next);
    }
    const answered = new Set(next.content.filter((block) => block.type === "tool_result").map((block) => text(block.tool_use_id)));
    const missing = ids.filter((id) => !answered.has(id)).map((id) => ({ type: "tool_result", tool_use_id: id, content: "Tool call was interrupted before any output was recorded.", is_error: true }));
    next.content.unshift(...missing);
  }
  if (messages.length === 0) messages.push({ role: "user", content: [{ type: "text", text: "" }] });

  const config = isObject(request.generationConfig) ? request.generationConfig : isObject(request.generation_config) ? request.generation_config : {};
  const requestedMax = config.maxOutputTokens ?? config.max_output_tokens;
  const maxTokens = typeof requestedMax === "number" ? requestedMax : /fable/i.test(model) ? FABLE_MAX_TOKENS : DEFAULT_MAX_TOKENS;
  const body: Json = { model, max_tokens: maxTokens, messages, stream };
  const mime = text(config.responseMimeType ?? config.response_mime_type);
  if (mime === "application/json") {
    const schema = config.responseJsonSchema ?? config.response_json_schema ?? config.responseSchema ?? config.response_schema;
    const instruction = formatInstruction(schema === undefined ? { type: "json_object" } : { type: "json_schema", schema });
    system.push({ type: "text", text: instruction });
  }
  if (system.length > 0) body.system = system;
  const topP = config.topP ?? config.top_p;
  if (typeof topP === "number") body.top_p = topP;
  const stops = config.stopSequences ?? config.stop_sequences;
  if (Array.isArray(stops) && stops.length > 0) body.stop_sequences = stops.map(String);
  const thinkingConfig = config.thinkingConfig ?? config.thinking_config;
  Object.assign(body, thinking(isObject(thinkingConfig) ? effortOf(thinkingConfig) : "", model, maxTokens));

  const tools: Json[] = [];
  for (const group of Array.isArray(request.tools) ? request.tools.filter(isObject) : []) {
    const declarations = group.functionDeclarations ?? group.function_declarations;
    for (const declaration of Array.isArray(declarations) ? declarations.filter(isObject) : []) {
      if (text(declaration.name) === "") continue;
      tools.push({ name: nameOf(text(declaration.name)), description: text(declaration.description), input_schema: inputSchema(lowerTypes(declaration.parametersJsonSchema ?? declaration.parameters)) });
    }
  }
  if (tools.length > 0) body.tools = tools;
  const toolConfig = isObject(request.toolConfig) ? request.toolConfig : isObject(request.tool_config) ? request.tool_config : {};
  const calling = isObject(toolConfig.functionCallingConfig) ? toolConfig.functionCallingConfig : isObject(toolConfig.function_calling_config) ? toolConfig.function_calling_config : {};
  const mode = text(calling.mode).toUpperCase();
  const allowed = calling.allowedFunctionNames ?? calling.allowed_function_names;
  if (mode === "NONE") body.tool_choice = { type: "none" };
  else if ((mode === "ANY" || mode === "VALIDATED") && tools.length > 0) {
    const names = Array.isArray(allowed) ? allowed.map(String) : [];
    body.tool_choice = names.length === 1 ? { type: "tool", name: nameOf(names[0] ?? "") } : { type: "any" };
  }
  return { body, stream, toolNames };
}

// Gemini's OpenAPI schemas spell types in capitals ("OBJECT"); JSON Schema wants them lower.
function lowerTypes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(lowerTypes);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === "type" && typeof child === "string" ? child.toLowerCase() : lowerTypes(child)]));
}

function finishReason(stop: string): string {
  if (stop === "max_tokens" || stop === "model_context_window_exceeded") return "MAX_TOKENS";
  if (stop === "refusal") return "SAFETY";
  return "STOP";
}

function geminiUsage(usage: Usage): Json {
  const prompt = usage.input + usage.cacheWrite + usage.cacheRead;
  const result: Json = { promptTokenCount: prompt, candidatesTokenCount: usage.output, totalTokenCount: prompt + usage.output };
  if (usage.cacheRead > 0) result.cachedContentTokenCount = usage.cacheRead;
  if (usage.thinking !== null) result.thoughtsTokenCount = usage.thinking;
  return result;
}

function functionCall(name: string, args: Json, id: string, toolNames: Map<string, string>): Json {
  return { functionCall: { name: toolNames.get(name) ?? name, args, id } };
}

// Turns Anthropic events into Gemini stream chunks: SSE with ?alt=sse, otherwise one JSON
// array written as it goes, as Google's API does.
export class GeminiStream implements EventTranslator {
  private id = "";
  private readonly usage: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, thinking: null };
  private readonly tools = new Map<number, { id: string; name: string; args: string }>();
  private sent = 0;
  private finished = false;

  constructor(
    private readonly model: string,
    private readonly toolNames: Map<string, string>,
    private readonly sse: boolean,
  ) {}

  private chunk(parts: Json[], finish?: string): string {
    const candidate: Json = { content: { role: "model", parts }, index: 0 };
    const data: Json = { candidates: [candidate], modelVersion: this.model, responseId: this.id };
    if (finish !== undefined) {
      candidate.finishReason = finish;
      data.usageMetadata = geminiUsage(this.usage);
    }
    return this.write(data);
  }

  private write(data: Json): string {
    const json = JSON.stringify(data);
    if (this.sse) return `data: ${json}\r\n\r\n`;
    return `${this.sent++ === 0 ? "[" : ",\r\n"}${json}`;
  }

  private close(): string {
    this.finished = true;
    return this.sse ? "" : this.sent === 0 ? "[]" : "]";
  }

  event(event: Json): string {
    if (this.finished) return "";
    const index = typeof event.index === "number" ? event.index : 0;
    const delta = isObject(event.delta) ? event.delta : {};
    switch (event.type) {
      case "message_start": {
        const message = isObject(event.message) ? event.message : {};
        this.id = text(message.id);
        mergeUsage(this.usage, message.usage);
        return "";
      }
      case "content_block_start": {
        const block = isObject(event.content_block) ? event.content_block : {};
        if (block.type === "tool_use") this.tools.set(index, { id: text(block.id), name: text(block.name), args: "" });
        return "";
      }
      case "content_block_delta":
        if (delta.type === "text_delta" && text(delta.text) !== "") return this.chunk([{ text: text(delta.text) }]);
        if (delta.type === "thinking_delta" && text(delta.thinking) !== "") return this.chunk([{ text: text(delta.thinking), thought: true }]);
        if (delta.type === "input_json_delta") {
          const tool = this.tools.get(index);
          if (tool !== undefined) tool.args += text(delta.partial_json);
        }
        return "";
      case "content_block_stop": {
        const tool = this.tools.get(index);
        if (tool === undefined) return "";
        this.tools.delete(index);
        let args: unknown;
        try {
          args = JSON.parse(tool.args || "{}");
        } catch {
          args = {};
        }
        return this.chunk([functionCall(tool.name, isObject(args) ? args : {}, tool.id, this.toolNames)]);
      }
      case "message_delta":
        mergeUsage(this.usage, event.usage);
        if (typeof delta.stop_reason !== "string") return "";
        return this.chunk([], finishReason(delta.stop_reason));
      case "message_stop":
        return this.close();
      case "error": {
        const error = isObject(event.error) ? event.error : {};
        return this.write({ error: { code: 500, message: text(error.message) || "The response failed upstream.", status: "INTERNAL" } }) + this.close();
      }
      default:
        return "";
    }
  }

  end(): string {
    if (this.finished) return "";
    return this.write({ error: { code: 502, message: "The upstream stream ended early.", status: "UNAVAILABLE" } }) + this.close();
  }
}

// A whole Anthropic message as one generateContent response.
export function geminiResponse(message: Json, model: string, toolNames: Map<string, string>): Json {
  const parts: Json[] = [];
  for (const block of Array.isArray(message.content) ? message.content.filter(isObject) : []) {
    if (block.type === "text" && text(block.text) !== "") parts.push({ text: text(block.text) });
    else if (block.type === "thinking" && text(block.thinking) !== "") parts.push({ text: text(block.thinking), thought: true });
    else if (block.type === "tool_use") parts.push(functionCall(text(block.name), isObject(block.input) ? block.input : {}, text(block.id), toolNames));
  }
  const usage: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, thinking: null };
  mergeUsage(usage, message.usage);
  return {
    candidates: [{ content: { role: "model", parts }, finishReason: finishReason(text(message.stop_reason)), index: 0 }],
    usageMetadata: geminiUsage(usage),
    modelVersion: model,
    responseId: text(message.id),
  };
}
