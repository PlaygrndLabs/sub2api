import { describe, expect, it } from "vitest";
import { claudeEventStream, claudeMessage, ClaudeStream, claudeToResponses, shortToolNames } from "../src/claude-responses.ts";

const REQUEST = {
  model: "gpt-5.6-sol",
  max_tokens: 1024,
  stream: true,
  system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2" }, { type: "text", text: "You are Claude Code." }],
  thinking: { type: "enabled", budget_tokens: 4000 },
  tools: [
    { name: "Bash", description: "Run a command", input_schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { command: { type: "string" } } } },
    { name: `mcp__${"server".repeat(12)}__lookup`, input_schema: {} },
    { type: "web_search_20250305", name: "web_search", allowed_domains: ["example.com"] },
  ],
  tool_choice: { type: "auto", disable_parallel_tool_use: true },
  messages: [
    { role: "user", content: "list files" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan", signature: "gAAAAencrypted" },
        { type: "thinking", thinking: "from claude", signature: "EqQBclaude" },
        { type: "text", text: "Running ls." },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "a.txt" }] },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
        { type: "text", text: "now what?" },
      ],
    },
  ],
};

describe("Claude to Responses", () => {
  it("translates system, turns, tools, thinking and settings as CPA does", async () => {
    const { body, toolNames, stream } = await claudeToResponses(REQUEST, "gpt-5.6-sol");
    expect(stream).toBe(true);
    expect(body).toMatchObject({ model: "gpt-5.6-sol", instructions: "", stream: true, store: false, parallel_tool_calls: false, tool_choice: "auto", reasoning: { effort: "medium" } });
    expect(body.include).toEqual(["reasoning.encrypted_content", "web_search_call.action.sources"]);
    expect(body.input).toEqual([
      { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Claude Code." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
      { type: "reasoning", summary: [], content: null, encrypted_content: "gAAAAencrypted" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Running ls." }] },
      { type: "function_call", call_id: "toolu_1", name: "Bash", arguments: '{"command":"ls"}' },
      { type: "function_call_output", call_id: "toolu_1", output: [{ type: "input_text", text: "a.txt" }] },
      { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,iVBOR" }, { type: "input_text", text: "now what?" }] },
    ]);
    const tools = body.tools as Record<string, unknown>[];
    expect(tools[0]).toEqual({ type: "function", name: "Bash", description: "Run a command", strict: false, parameters: { type: "object", properties: { command: { type: "string" } } } });
    expect(tools[1]).toMatchObject({ name: "mcp__lookup", parameters: { type: "object", properties: {} } });
    expect(tools[2]).toEqual({ type: "web_search", filters: { allowed_domains: ["example.com"] } });
    expect(toolNames.get("mcp__lookup")).toBe(`mcp__${"server".repeat(12)}__lookup`);
  });

  it("maps thinking settings to reasoning effort", async () => {
    const effort = async (extra: Record<string, unknown>) => ((await claudeToResponses({ messages: [], ...extra }, "m")).body.reasoning as { effort: string }).effort;
    expect(await effort({})).toBe("medium");
    expect(await effort({ thinking: { type: "enabled", budget_tokens: 32000 } })).toBe("xhigh");
    expect(await effort({ thinking: { type: "adaptive" } })).toBe("high");
    expect(await effort({ thinking: { type: "adaptive" }, output_config: { effort: "max" } })).toBe("xhigh");
    expect(await effort({ thinking: { type: "disabled" } })).toBe("low");
  });

  it("keeps long tool names and call ids within OpenAI's limits, distinct from each other", async () => {
    const long = "t".repeat(80);
    const names = shortToolNames([long, `${long}x`]);
    expect([...names.values()]).toEqual(["t".repeat(64), `${"t".repeat(62)}_1`]);
    const { body } = await claudeToResponses({ messages: [{ role: "assistant", content: [{ type: "tool_use", id: "i".repeat(90), name: "n", input: {} }] }] }, "m");
    const call = (body.input as { call_id: string }[])[0];
    expect(call?.call_id).toHaveLength(64);
  });
});

function upstream(events: unknown[]): ReadableStream<Uint8Array> {
  const text = events.map((event) => `event: e\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  // Split mid-line to check the line buffering.
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 37));
      controller.enqueue(bytes.slice(37));
      controller.close();
    },
  });
}

async function claudeEvents(events: unknown[], toolNames = new Map<string, string>()): Promise<Record<string, unknown>[]> {
  const text = await new Response(claudeEventStream(upstream(events), new ClaudeStream("gpt-5.6-sol", toolNames))).text();
  return text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

describe("Responses stream to Claude", () => {
  it("emits Anthropic's event sequence for reasoning, text and a tool call", async () => {
    const events = await claudeEvents(
      [
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.output_item.added", item: { type: "reasoning" } },
        { type: "response.reasoning_summary_part.added" },
        { type: "response.reasoning_summary_text.delta", delta: "Thinking" },
        { type: "response.output_item.done", item: { type: "reasoning", encrypted_content: "gAAAAsig" } },
        { type: "response.output_item.added", item: { type: "message" } },
        { type: "response.output_text.delta", delta: "Hel" },
        { type: "response.output_text.delta", delta: "lo" },
        { type: "response.output_item.done", item: { type: "message" } },
        { type: "response.output_item.added", item: { type: "function_call", name: "mcp__lookup", call_id: "call_9" } },
        { type: "response.function_call_arguments.delta", delta: '{"q"' },
        { type: "response.output_item.done", item: { type: "function_call", name: "mcp__lookup", call_id: "call_9", arguments: '{"q":1}' } },
        { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 40 } } } },
      ],
      new Map([["mcp__lookup", "mcp__long__lookup"]]),
    );
    expect(events.map((event) => (event.type === "content_block_delta" ? `delta:${(event.delta as { type: string }).type}` : event.type))).toEqual([
      "message_start",
      "content_block_start",
      "delta:thinking_delta",
      "delta:signature_delta",
      "content_block_stop",
      "content_block_start",
      "delta:text_delta",
      "delta:text_delta",
      "content_block_stop",
      "content_block_start",
      "delta:input_json_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[0]).toMatchObject({ message: { id: "resp_1", model: "gpt-5.6-sol", role: "assistant" } });
    expect(events[9]).toEqual({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call_9", name: "mcp__long__lookup", input: {} } });
    expect(events[10]).toMatchObject({ index: 2, delta: { partial_json: '{"q":1}' } });
    expect(events[12]).toEqual({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 60, output_tokens: 7, cache_read_input_tokens: 40 } });
  });

  it("reports failures and a stream cut short as Anthropic errors", async () => {
    const failed = await claudeEvents([{ type: "response.created", response: {} }, { type: "response.failed", response: { error: { message: "usage limit" } } }]);
    expect(failed.at(-1)).toEqual({ type: "error", error: { type: "api_error", message: "usage limit" } });
    const cut = await claudeEvents([{ type: "response.created", response: {} }, { type: "response.output_text.delta", delta: "hi" }]);
    expect(cut.at(-1)).toMatchObject({ type: "error" });
  });

  it("turns a final response into one Anthropic message", () => {
    const message = claudeMessage(
      {
        id: "resp_2",
        output: [
          { type: "reasoning", summary: [{ text: "a" }], encrypted_content: "gAAAAs" },
          { type: "message", content: [{ type: "output_text", text: "Done." }] },
        ],
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 5, output_tokens: 2 },
      },
      "gpt-5.6-sol",
      new Map(),
    );
    expect(message).toEqual({
      id: "resp_2",
      type: "message",
      role: "assistant",
      model: "gpt-5.6-sol",
      content: [{ type: "thinking", thinking: "a", signature: "gAAAAs" }, { type: "text", text: "Done." }],
      stop_reason: "max_tokens",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    });
  });
});
