import { describe, expect, it } from "vitest";
import { chatClaudeMessage, ChatClaudeStream, claudeToChat } from "../src/claude-openai.ts";
import { claudeEventStream } from "../src/claude-responses.ts";

describe("Claude to Chat Completions", () => {
  it("translates system, turns, tool calls and results, images and settings as CPA does", () => {
    const { body, stream } = claudeToChat(
      {
        model: "kimi",
        max_tokens: 512,
        temperature: 0.3,
        stream: true,
        stop_sequences: ["END"],
        thinking: { type: "enabled", budget_tokens: 2000 },
        system: [{ type: "text", text: "x-anthropic-billing-header: v" }, { type: "text", text: "Be brief." }],
        tools: [{ name: "Bash", description: "Run", input_schema: { type: "object" } }, { type: "web_search_20250305", name: "web_search" }],
        tool_choice: { type: "any", disable_parallel_tool_use: true },
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "s" }, { type: "text", text: "Running." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a.txt" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iV" } }] }, { type: "text", text: "next" }] },
        ],
      },
      "vendor/kimi-k2",
    );
    expect(stream).toBe(true);
    expect(body).toMatchObject({ model: "vendor/kimi-k2", max_tokens: 512, temperature: 0.3, stop: ["END"], reasoning_effort: "medium", stream_options: { include_usage: true }, tool_choice: "required", parallel_tool_calls: false });
    expect(body.tools).toEqual([{ type: "function", function: { name: "Bash", description: "Run", parameters: { type: "object", properties: {} } } }]);
    expect(body.messages).toEqual([
      { role: "system", content: [{ type: "text", text: "Be brief." }] },
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "Running." }], reasoning_content: "hmm", tool_calls: [{ id: "t1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } }] },
      { role: "tool", tool_call_id: "t1", content: "a.txt" },
      { role: "user", content: [{ type: "text", text: "Images returned by the preceding tool call(s):" }, { type: "image_url", image_url: { url: "data:image/png;base64,iV" } }, { type: "text", text: "next" }] },
    ]);
  });
});

function chunks(events: unknown[]): ReadableStream<Uint8Array> {
  const text = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(text).body as ReadableStream<Uint8Array>;
}

describe("Chat Completions stream to Claude", () => {
  it("streams reasoning and text, and sends split tool calls whole with usage at the end", async () => {
    const out = await new Response(
      claudeEventStream(
        chunks([
          { id: "chatcmpl-1", choices: [{ delta: { role: "assistant", reasoning_content: "think" } }] },
          { id: "chatcmpl-1", choices: [{ delta: { content: "Hel" } }] },
          { id: "chatcmpl-1", choices: [{ delta: { content: "lo" } }] },
          { id: "chatcmpl-1", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "Bash", arguments: '{"comm' } }] } }] },
          { id: "chatcmpl-1", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
          { id: "chatcmpl-1", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          { id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 50, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 20 } } },
        ]),
        new ChatClaudeStream("kimi"),
      ),
    ).text();
    const events = out.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[0]).toMatchObject({ message: { id: "msg_1", model: "kimi" } });
    expect(events[8]).toEqual({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call_a", name: "Bash", input: {} } });
    expect(events[9]).toMatchObject({ delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } });
    expect(events[11]).toEqual({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 30, output_tokens: 9, cache_read_input_tokens: 20 } });
  });

  it("passes an in-stream error on and turns a whole response into a message", async () => {
    const out = await new Response(claudeEventStream(chunks([{ error: { message: "rate limited" } }]), new ChatClaudeStream("kimi"))).text();
    expect(out).toContain('"type":"error","error":{"type":"api_error","message":"rate limited"}');
    expect(
      chatClaudeMessage({ id: "chatcmpl-9", choices: [{ message: { content: "Hi", tool_calls: [{ id: "c", function: { name: "f", arguments: "{bad" } }] }, finish_reason: "length" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }, "kimi"),
    ).toEqual({
      id: "msg_9",
      type: "message",
      role: "assistant",
      model: "kimi",
      content: [{ type: "text", text: "Hi" }, { type: "tool_use", id: "c", name: "f", input: {} }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 },
    });
  });
});
