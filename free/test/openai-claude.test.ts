import { describe, expect, it } from "vitest";
import { claudeEventStream } from "../src/claude-responses.ts";
import { chatCompletion, ChatStream, chatToClaude, claudeName } from "../src/openai-claude.ts";

describe("Chat Completions to Claude", () => {
  it("translates system, turns, tool calls and results, images and settings as CPA does", () => {
    const { body, stream, toolNames } = chatToClaude(
      {
        model: "claude-sonnet-4-5",
        stream: true,
        max_completion_tokens: 4000,
        top_p: 0.9,
        stop: "END",
        reasoning_effort: "high",
        response_format: { type: "json_object" },
        parallel_tool_calls: false,
        messages: [
          { role: "system", content: "Be brief." },
          { role: "developer", content: [{ type: "text", text: "Use tools.", cache_control: { type: "ephemeral" } }] },
          { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,iV" } }] },
          { role: "assistant", content: "Running.", tool_calls: [{ id: "call.1", type: "function", function: { name: "fs.read", arguments: '{"path":"a"}' } }, { id: "call_2", type: "function", function: { name: "bad", arguments: "{oops" } }] },
          { role: "tool", tool_call_id: "call.1", content: "old" },
          { role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: "two" }] },
          { role: "tool", tool_call_id: "call.1", content: "new" },
          { role: "user", content: "next" },
        ],
        tools: [{ type: "function", function: { name: "fs.read", description: "Read", parameters: { anyOf: [{ type: "object", properties: { path: { type: "string" } } }, { type: "string" }] } } }],
      },
      "claude-sonnet-4-5",
    );
    expect(stream).toBe(true);
    expect(toolNames.get("fs_read")).toBe("fs.read");
    expect(body).toEqual({
      model: "claude-sonnet-4-5",
      max_tokens: 4000,
      stream: true,
      top_p: 0.9,
      stop_sequences: ["END"],
      thinking: { type: "enabled", budget_tokens: 3999 },
      system: [
        { type: "text", text: "Be brief." },
        { type: "text", text: "Use tools.", cache_control: { type: "ephemeral" } },
        { type: "text", text: expect.stringContaining("valid JSON object") },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iV" } }] },
        { role: "assistant", content: [{ type: "text", text: "Running." }, { type: "tool_use", id: "call_1", name: "fs_read", input: { path: "a" } }, { type: "tool_use", id: "call_2", name: "bad", input: {} }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "new" },
            { type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: "two" }] },
            { type: "text", text: "next" },
          ],
        },
      ],
      tools: [{ name: "fs_read", description: "Read", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    });
  });

  it("thinks adaptively on newer models and maps tool choices", () => {
    const base = { messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "a" } }, { type: "function", function: { name: "b" } }] };
    const adaptive = chatToClaude({ ...base, reasoning_effort: "xhigh", tool_choice: "required" }, "claude-opus-4-7").body;
    expect(adaptive).toMatchObject({ max_tokens: 32000, thinking: { type: "adaptive" }, output_config: { effort: "max" }, tool_choice: { type: "any" } });
    expect(chatToClaude({ ...base, reasoning_effort: "none" }, "claude-fable-5-1").body).toMatchObject({ max_tokens: 64000, thinking: { type: "disabled" } });
    const named = chatToClaude({ ...base, tool_choice: { type: "function", function: { name: "b" } } }, "claude-sonnet-5-5").body;
    expect(named.tool_choice).toEqual({ type: "tool", name: "b" });
    const allowed = chatToClaude({ ...base, tool_choice: { type: "allowed_tools", allowed_tools: { mode: "required", tools: [{ type: "function", function: { name: "b" } }] } } }, "claude-sonnet-5-5").body;
    expect(allowed).toMatchObject({ tools: [{ name: "b" }], tool_choice: { type: "any" } });
    expect(claudeName("mcp:server/tool")).toBe("mcp_server_tool");
  });
});

function events(list: unknown[]): ReadableStream<Uint8Array> {
  return new Response(list.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join("")).body as ReadableStream<Uint8Array>;
}

describe("Claude stream to Chat Completions", () => {
  it("streams text and reasoning, sends tool calls whole, then usage and [DONE]", async () => {
    const out = await new Response(
      claudeEventStream(
        events([
          { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, cache_read_input_tokens: 5 } } },
          { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
          { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } },
          { type: "content_block_start", index: 1, content_block: { type: "text" } },
          { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } },
          { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t1", name: "fs_read" } },
          { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"pa' } },
          { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: 'th":"a"}' } },
          { type: "content_block_stop", index: 2 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
          { type: "message_stop" },
        ]),
        new ChatStream("gpt-ish", new Map([["fs_read", "fs.read"]])),
      ),
    ).text();
    const lines = out.split("\n\n").filter((line) => line !== "");
    expect(lines.at(-1)).toBe("data: [DONE]");
    const chunks = lines.slice(0, -1).map((line) => JSON.parse(line.slice(6)) as { choices: { delta: unknown; finish_reason: unknown }[]; usage?: unknown });
    expect(chunks.map((chunk) => chunk.choices[0]?.delta)).toEqual([
      { role: "assistant" },
      { reasoning_content: "hm" },
      { content: "Hi" },
      { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "fs.read", arguments: '{"path":"a"}' } }] },
      {},
      undefined,
    ]);
    expect(chunks[4]?.choices[0]?.finish_reason).toBe("tool_calls");
    expect(chunks[5]?.usage).toEqual({ prompt_tokens: 15, completion_tokens: 7, total_tokens: 22, prompt_tokens_details: { cached_tokens: 5, cached_creation_tokens: 0, cache_write_tokens: 0 } });
  });

  it("passes an error on and turns a whole message into a completion", async () => {
    const out = await new Response(claudeEventStream(events([{ type: "error", error: { type: "overloaded_error", message: "busy" } }]), new ChatStream("m", new Map()))).text();
    expect(out).toBe('data: {"error":{"message":"busy","type":"overloaded_error"}}\n\ndata: [DONE]\n\n');
    const completion = chatCompletion(
      { id: "msg_9", content: [{ type: "thinking", thinking: "a" }, { type: "text", text: "Hi" }, { type: "tool_use", id: "t", name: "fs_read", input: { p: 1 } }], stop_reason: "tool_use", usage: { input_tokens: 3, output_tokens: 2 } },
      "m",
      new Map([["fs_read", "fs.read"]]),
    );
    expect(completion).toMatchObject({
      id: "msg_9",
      object: "chat.completion",
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "Hi", reasoning_content: "a", tool_calls: [{ id: "t", type: "function", function: { name: "fs.read", arguments: '{"p":1}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  });
});
