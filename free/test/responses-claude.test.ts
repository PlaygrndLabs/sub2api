import { describe, expect, it } from "vitest";
import { claudeEventStream } from "../src/claude-responses.ts";
import { responsesResponse, ResponsesStream, responsesToClaude } from "../src/responses-claude.ts";

function events(stream: string): { event: string; data: Record<string, unknown> }[] {
  return stream
    .trim()
    .split("\n\n")
    .map((block) => {
      const [event = "", data = ""] = block.split("\n");
      return { event: event.slice(7), data: JSON.parse(data.slice(6)) as Record<string, unknown> };
    });
}

function run(input: Record<string, unknown>[], customTools = new Set<string>()): string {
  const stream = new ResponsesStream("claude-sonnet-5-5", new Map([["fs_read", "fs.read"]]), customTools);
  return input.map((event) => stream.event(event)).join("") + stream.end();
}

describe("Responses to Claude", () => {
  it("translates instructions, items, reasoning, tool calls and settings as CPA does", () => {
    const { body, stream, toolNames, customTools } = responsesToClaude(
      {
        model: "claude-sonnet-4-5",
        stream: true,
        instructions: "Be brief.",
        max_output_tokens: 4000,
        reasoning: { effort: "high" },
        text: { format: { type: "json_schema", name: "answer", schema: { type: "object" } } },
        parallel_tool_calls: false,
        input: [
          { role: "developer", content: [{ type: "input_text", text: "Use tools." }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: "data:image/png;base64,iV" }, { type: "input_file", filename: "a.pdf", file_data: "JVBER" }] },
          { type: "reasoning", summary: [{ type: "summary_text", text: "thought" }], encrypted_content: "sig-claude" },
          { type: "reasoning", summary: [{ type: "summary_text", text: "openai" }], encrypted_content: "gAAAAopenai" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Running." }] },
          { type: "function_call", call_id: "call.1", name: "fs.read", arguments: '{"path":"a"}' },
          { type: "custom_tool_call", call_id: "call_2", name: "apply_patch", input: "*** Begin Patch" },
          { type: "function_call", call_id: "call_3", name: "fs.read", arguments: "{oops" },
          { type: "function_call_output", call_id: "call.1", output: "old" },
          { type: "custom_tool_call_output", call_id: "call_2", output: [{ type: "input_text", text: "done" }] },
          { type: "function_call_output", call_id: "call.1", output: "new" },
          { type: "function_call_output", call_id: "orphan", output: "lost" },
          { type: "web_search_call", id: "ws_1" },
          { role: "user", content: "next" },
        ],
        tools: [
          { type: "function", name: "fs.read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } }, strict: true },
          { type: "custom", name: "apply_patch", description: "Patch" },
          { type: "web_search" },
        ],
      },
      "claude-sonnet-4-5",
    );
    expect(stream).toBe(true);
    expect(toolNames.get("fs_read")).toBe("fs.read");
    expect([...customTools]).toEqual(["apply_patch"]);
    expect(body).toEqual({
      model: "claude-sonnet-4-5",
      max_tokens: 4000,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 3999 },
      system: [
        { type: "text", text: "Be brief." },
        { type: "text", text: "Use tools." },
        { type: "text", text: expect.stringContaining("Schema Name: answer") },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "iV" } },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBER" } },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "thought", signature: "sig-claude" },
            { type: "text", text: "Running." },
            { type: "tool_use", id: "call_1", name: "fs_read", input: { path: "a" } },
            { type: "tool_use", id: "call_2", name: "apply_patch", input: { input: "*** Begin Patch" } },
            { type: "tool_use", id: "call_3", name: "fs_read", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "new" },
            { type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: "done" }] },
            { type: "tool_result", tool_use_id: "call_3", content: "Tool call was interrupted before any output was recorded.", is_error: true },
            { type: "text", text: "Tool result orphan: lost" },
            { type: "text", text: "next" },
          ],
        },
      ],
      tools: [
        { name: "fs_read", description: "Read", input_schema: { type: "object", properties: { path: { type: "string" } } }, strict: true },
        { name: "apply_patch", description: "Patch", input_schema: { type: "object", properties: { input: { type: "string" } }, required: ["input"] } },
      ],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    });
  });

  it("takes a plain string input, adaptive effort, tool choices, and drops a trailing thought", () => {
    expect(responsesToClaude({ input: "hi", reasoning: { effort: "xhigh" }, tool_choice: "required", tools: [{ type: "function", name: "f" }] }, "claude-opus-5-5").body).toMatchObject({
      max_tokens: 32000,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
      tool_choice: { type: "any" },
    });
    const prefilled = responsesToClaude(
      { input: [{ role: "user", content: "q" }, { role: "assistant", content: "Sure" }, { type: "reasoning", summary: [], encrypted_content: "sig" }], tool_choice: { type: "custom", name: "apply_patch" } },
      "claude-fable-5-1",
    ).body;
    expect(prefilled.max_tokens).toBe(64000);
    expect(prefilled.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "text", text: "Sure" }] },
    ]);
    expect(prefilled.tool_choice).toEqual({ type: "tool", name: "apply_patch" });
    // A trailing tool call gets an interrupted result, so the request stays valid.
    const pending = responsesToClaude({ input: [{ type: "function_call", call_id: "c", name: "f", arguments: "{}" }] }, "claude-opus-5-5").body;
    expect(pending.messages).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "c", name: "f", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "Tool call was interrupted before any output was recorded.", is_error: true }] },
    ]);
    expect(responsesToClaude({ input: [] }, "claude-opus-5-5").body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "" }] }]);
  });
});

describe("Claude events to Responses", () => {
  it("streams reasoning, text and tool calls as Responses items, in order", () => {
    const out = events(
      run([
        { type: "message_start", message: { id: "msg_abc", usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hmm" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } },
        { type: "content_block_stop", index: 1 },
        { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "fs_read", input: {} } },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"a"}' } },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
        { type: "message_stop" },
      ]),
    );
    expect(out.map((event) => event.event)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(out.map((event) => event.data.sequence_number)).toEqual(out.map((_, index) => index));
    expect(out[0]?.data.response).toMatchObject({ id: "resp_abc", status: "in_progress", model: "claude-sonnet-5-5" });
    expect(out.at(-1)?.data.response).toMatchObject({
      id: "resp_abc",
      status: "completed",
      output: [
        { id: "rs_abc_0", type: "reasoning", summary: [{ type: "summary_text", text: "Hmm" }], encrypted_content: "sig" },
        { id: "msg_abc_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi" }] },
        { id: "fc_abc_2", type: "function_call", call_id: "toolu_1", name: "fs.read", arguments: '{"path":"a"}', status: "completed" },
      ],
      usage: { input_tokens: 16, input_tokens_details: { cached_tokens: 5 }, output_tokens: 7, total_tokens: 23 },
    });
  });

  it("sends custom tool calls whole, marks max_tokens incomplete, and fails a cut-off stream", () => {
    const custom = events(
      run(
        [
          { type: "message_start", message: { id: "msg_c" } },
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_2", name: "apply_patch", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"input":"*** Begin"}' } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "max_tokens" } },
          { type: "message_stop" },
        ],
        new Set(["apply_patch"]),
      ),
    );
    expect(custom.map((event) => event.event)).toContain("response.custom_tool_call_input.done");
    expect(custom.at(-1)).toMatchObject({
      event: "response.incomplete",
      data: { response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "custom_tool_call", call_id: "toolu_2", name: "apply_patch", input: "*** Begin" }] } },
    });
    const cut = events(run([{ type: "message_start", message: { id: "msg_d" } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }]));
    expect(cut.at(-1)).toMatchObject({ event: "response.failed", data: { response: { status: "failed", error: { message: "The upstream stream ended early." } } } });
    const failed = events(run([{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]));
    expect(failed.map((event) => event.event)).toEqual(["response.created", "response.in_progress", "response.failed"]);
  });

  it("re-encodes an Anthropic SSE body as it arrives", async () => {
    const body = new Response('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n').body;
    const text = await new Response(claudeEventStream(body as ReadableStream<Uint8Array>, new ResponsesStream("m", new Map()))).text();
    expect(events(text).map((event) => event.event)).toEqual(["response.created", "response.in_progress", "response.completed"]);
  });

  it("converts a whole message for a client that didn't stream", () => {
    const response = responsesResponse(
      {
        id: "msg_w",
        content: [
          { type: "thinking", thinking: "Hmm", signature: "sig" },
          { type: "text", text: "Hi" },
          { type: "tool_use", id: "toolu_1", name: "fs_read", input: { path: "a" } },
          { type: "tool_use", id: "toolu_2", name: "apply_patch", input: { input: "p" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 3, output_tokens: 2 },
      },
      "claude-sonnet-5-5",
      new Map([["fs_read", "fs.read"]]),
      new Set(["apply_patch"]),
    );
    expect(response).toMatchObject({
      id: "resp_w",
      object: "response",
      status: "completed",
      model: "claude-sonnet-5-5",
      output: [
        { type: "reasoning", summary: [{ text: "Hmm" }], encrypted_content: "sig" },
        { type: "message", content: [{ type: "output_text", text: "Hi" }] },
        { type: "function_call", call_id: "toolu_1", name: "fs.read", arguments: '{"path":"a"}' },
        { type: "custom_tool_call", call_id: "toolu_2", name: "apply_patch", input: "p" },
      ],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
  });
});
