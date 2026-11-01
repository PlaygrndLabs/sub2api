import { describe, expect, it } from "vitest";
import { claudeToGemini, geminiClaudeMessage, GeminiClaudeStream, geminiName } from "../src/claude-gemini.ts";
import { claudeEventStream } from "../src/claude-responses.ts";

describe("Claude to Gemini", () => {
  it("translates system, turns, tool calls and results, images and settings as CPA does", () => {
    const { body, stream, toolNames } = claudeToGemini(
      {
        model: "gemini-2.5-pro",
        max_tokens: 512,
        temperature: 0.3,
        top_k: 40,
        stream: true,
        stop_sequences: ["END"],
        thinking: { type: "enabled", budget_tokens: 2000 },
        system: [{ type: "text", text: "x-anthropic-billing-header: v" }, { type: "text", text: "Be brief." }],
        tools: [{ name: "mcp__srv/run tool", description: "Run", input_schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { a: { type: "string" } } } }, { type: "web_search_20250305", name: "web_search" }],
        tool_choice: { type: "tool", name: "mcp__srv/run tool" },
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "s" }, { type: "text", text: "Running." }, { type: "tool_use", id: "t1", name: "mcp__srv/run tool", input: { a: "ls" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a.txt" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iV" } }] }, { type: "text", text: "next" }] },
          { role: "user", content: "and more" },
        ],
      },
      "gemini-2.5-pro",
    );
    expect(stream).toBe(true);
    expect(toolNames.get("mcp__srv_run_tool")).toBe("mcp__srv/run tool");
    expect(body).toEqual({
      systemInstruction: { role: "user", parts: [{ text: "Be brief." }] },
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        { role: "model", parts: [{ text: "Running." }, { thoughtSignature: "skip_thought_signature_validator", functionCall: { name: "mcp__srv_run_tool", args: { a: "ls" }, id: "t1" } }] },
        { role: "user", parts: [{ text: "next" }, { functionResponse: { id: "t1", name: "mcp__srv_run_tool", response: { result: "a.txt" } } }, { inline_data: { mime_type: "image/png", data: "iV" } }, { text: "and more" }] },
      ],
      tools: [{ functionDeclarations: [{ name: "mcp__srv_run_tool", description: "Run", parametersJsonSchema: { type: "object", properties: { a: { type: "string" } } } }] }],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["mcp__srv_run_tool"] } },
      generationConfig: { thinkingConfig: { thinkingBudget: 2000, includeThoughts: true }, maxOutputTokens: 512, temperature: 0.3, topK: 40, stopSequences: ["END"] },
    });
  });

  it("maps adaptive thinking to a level on Gemini 3 and a dynamic budget on Gemini 2", () => {
    const adaptive = (effort: string) => ({ thinking: { type: "adaptive" }, output_config: { effort }, messages: [] });
    expect(claudeToGemini(adaptive("max"), "gemini-3-pro-preview").body.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "high", includeThoughts: true } });
    expect(claudeToGemini(adaptive("low"), "gemini-3-flash").body.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "low", includeThoughts: true } });
    expect(claudeToGemini(adaptive("low"), "gemini-2.5-flash").body.generationConfig).toEqual({ thinkingConfig: { thinkingBudget: -1, includeThoughts: true } });
  });

  it("makes names Gemini accepts", () => {
    expect(geminiName("9lives")).toBe("_9lives");
    expect(geminiName("a b")).toBe("a_b");
    expect(geminiName("x".repeat(80))).toHaveLength(64);
  });
});

function chunks(events: unknown[]): ReadableStream<Uint8Array> {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("")).body as ReadableStream<Uint8Array>;
}

describe("Gemini stream to Claude", () => {
  it("streams thoughts and text, sends function calls whole and closes with usage at the end", async () => {
    const names = new Map([["mcp__srv_run_tool", "mcp__srv/run tool"]]);
    const out = await new Response(
      claudeEventStream(
        chunks([
          { responseId: "r1", candidates: [{ content: { role: "model", parts: [{ text: "think", thought: true }] } }] },
          { responseId: "r1", candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] },
          { responseId: "r1", candidates: [{ content: { role: "model", parts: [{ text: "lo" }, { functionCall: { name: "mcp__srv_run_tool", args: { a: "ls" } }, thoughtSignature: "sig" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 9, thoughtsTokenCount: 3, cachedContentTokenCount: 20 } },
        ]),
        new GeminiClaudeStream("claude-sonnet-4-5", names),
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
    expect(events[0]).toMatchObject({ message: { id: "msg_r1", model: "claude-sonnet-4-5" } });
    expect(events[2]).toMatchObject({ delta: { type: "thinking_delta", thinking: "think" } });
    expect(events[8]).toMatchObject({ type: "content_block_start", index: 2, content_block: { type: "tool_use", name: "mcp__srv/run tool", input: {} } });
    expect(events[9]).toMatchObject({ delta: { type: "input_json_delta", partial_json: '{"a":"ls"}' } });
    expect(events[11]).toEqual({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { input_tokens: 30, output_tokens: 12, cache_read_input_tokens: 20 } });
  });

  it("passes an in-stream error on and turns a whole response into a message", async () => {
    const out = await new Response(claudeEventStream(chunks([{ error: { code: 429, message: "quota" } }]), new GeminiClaudeStream("m", new Map()))).text();
    expect(out).toContain('"type":"error","error":{"type":"api_error","message":"quota"}');
    expect(out).not.toContain("message_stop");
    const message = geminiClaudeMessage(
      { responseId: "r9", candidates: [{ content: { parts: [{ text: "a", thought: true }, { text: "Hi" }, { text: "!" }] }, finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } },
      "m",
      new Map(),
    );
    expect(message).toEqual({
      id: "msg_r9",
      type: "message",
      role: "assistant",
      model: "m",
      content: [{ type: "thinking", thinking: "a", signature: "" }, { type: "text", text: "Hi!" }],
      stop_reason: "max_tokens",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 },
    });
  });
});
