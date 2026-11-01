import { describe, expect, it } from "vitest";
import { geminiResponse, GeminiStream, geminiToClaude } from "../src/gemini-claude.ts";

const INTERRUPTED = "Tool call was interrupted before any output was recorded.";

describe("Gemini to Claude", () => {
  it("translates contents, calls and results, media, tools and settings as CPA does", () => {
    const { body, stream, toolNames } = geminiToClaude(
      {
        systemInstruction: { parts: [{ text: "Be brief." }] },
        contents: [
          { role: "user", parts: [{ text: "hi" }, { inlineData: { mimeType: "image/png", data: "iV" } }, { inline_data: { mime_type: "application/pdf", data: "JVBER" } }, { fileData: { mimeType: "image/jpeg", fileUri: "https://example.com/a.jpg" } }] },
          { role: "model", parts: [{ text: "plan", thought: true, thoughtSignature: "s" }, { text: "Running." }, { functionCall: { name: "fs.read", args: { path: "a" } } }, { functionCall: { name: "fs.read", args: { path: "b" } } }, { functionCall: { name: "grep", args: {}, id: "call.9" } }] },
          { role: "user", parts: [{ functionResponse: { name: "fs.read", response: { output: "A" } } }, { functionResponse: { name: "fs.read", response: { lines: 2 } } }, { functionResponse: { name: "nobody", response: "x" } }] },
          { role: "user", parts: [{ text: "next" }] },
        ],
        tools: [{ functionDeclarations: [{ name: "fs.read", description: "Read", parameters: { type: "OBJECT", properties: { path: { type: "STRING" } } } }, { name: "grep", parametersJsonSchema: { type: "object" } }] }, { googleSearch: {} }],
        toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["grep"] } },
        generationConfig: { maxOutputTokens: 4000, topP: 0.9, stopSequences: ["END"], thinkingConfig: { thinkingBudget: 2048 }, responseMimeType: "application/json" },
      },
      "claude-sonnet-4-5",
      true,
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
        { type: "text", text: expect.stringContaining("valid JSON object") },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "iV" } },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBER" } },
            { type: "image", source: { type: "url", url: "https://example.com/a.jpg" } },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Running." },
            { type: "tool_use", id: "toolu_gemini_0", name: "fs_read", input: { path: "a" } },
            { type: "tool_use", id: "toolu_gemini_1", name: "fs_read", input: { path: "b" } },
            { type: "tool_use", id: "call_9", name: "grep", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_9", content: INTERRUPTED, is_error: true },
            { type: "tool_result", tool_use_id: "toolu_gemini_0", content: "A" },
            { type: "tool_result", tool_use_id: "toolu_gemini_1", content: '{"lines":2}' },
            { type: "text", text: "Tool result nobody: x" },
            { type: "text", text: "next" },
          ],
        },
      ],
      tools: [
        { name: "fs_read", description: "Read", input_schema: { type: "object", properties: { path: { type: "string" } } } },
        { name: "grep", description: "", input_schema: { type: "object", properties: {} } },
      ],
      tool_choice: { type: "tool", name: "grep" },
    });
  });

  it("maps thinking levels on adaptive models, and fills in defaults", () => {
    expect(geminiToClaude({ contents: [], generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } } }, "claude-opus-5-5", false).body).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 32000,
      stream: false,
      messages: [{ role: "user", content: [{ type: "text", text: "" }] }],
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    });
    expect(geminiToClaude({ contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 0 } }, toolConfig: { functionCallingConfig: { mode: "NONE" } } }, "claude-fable-5-1", false).body).toMatchObject({
      max_tokens: 64000,
      thinking: { type: "disabled" },
      tool_choice: { type: "none" },
    });
    // A file reference that isn't https is dropped.
    expect(geminiToClaude({ contents: [{ role: "user", parts: [{ fileData: { fileUri: "gs://bucket/a" } }, { text: "hi" }] }] }, "claude-opus-5-5", false).body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });
});

const EVENTS = [
  { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, cache_read_input_tokens: 4 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hmm" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "fs_read", input: {} } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];

describe("Claude events to Gemini", () => {
  it("streams SSE chunks with thoughts, text, calls and a final usage chunk", () => {
    const stream = new GeminiStream("claude-sonnet-5-5", new Map([["fs_read", "fs.read"]]), true);
    const out = EVENTS.map((event) => stream.event(event)).join("") + stream.end();
    const chunks = out
      .split("\r\n\r\n")
      .filter((chunk) => chunk !== "")
      .map((chunk) => JSON.parse(chunk.slice(6)) as { candidates: { content: { parts: unknown[] }; finishReason?: string }[]; usageMetadata?: unknown });
    expect(chunks.map((chunk) => chunk.candidates[0]?.content.parts)).toEqual([[{ text: "Hmm", thought: true }], [{ text: "Hi" }], [{ functionCall: { name: "fs.read", args: { path: "a" }, id: "toolu_1" } }], []]);
    expect(chunks.at(-1)).toMatchObject({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 5, totalTokenCount: 19, cachedContentTokenCount: 4 }, responseId: "msg_1" });
  });

  it("writes one JSON array without ?alt=sse, and closes it on a cut-off stream", () => {
    const stream = new GeminiStream("m", new Map(), false);
    const out = EVENTS.map((event) => stream.event(event)).join("") + stream.end();
    expect((JSON.parse(out) as unknown[]).length).toBe(4);
    const cut = new GeminiStream("m", new Map(), false);
    const partial = cut.event(EVENTS[0] ?? {}) + cut.event(EVENTS[4] ?? {}) + cut.event(EVENTS[5] ?? {}) + cut.end();
    expect(JSON.parse(partial)).toEqual([expect.objectContaining({ candidates: expect.any(Array) }), { error: { code: 502, message: "The upstream stream ended early.", status: "UNAVAILABLE" } }]);
    const empty = new GeminiStream("m", new Map(), false);
    expect(JSON.parse(empty.event({ type: "message_stop" }) || "null")).toEqual([]);
  });

  it("converts a whole message", () => {
    expect(
      geminiResponse(
        { id: "msg_2", content: [{ type: "text", text: "Hi" }, { type: "tool_use", id: "toolu_1", name: "fs_read", input: { path: "a" } }], stop_reason: "max_tokens", usage: { input_tokens: 3, output_tokens: 2 } },
        "claude-sonnet-5-5",
        new Map([["fs_read", "fs.read"]]),
      ),
    ).toEqual({
      candidates: [{ content: { role: "model", parts: [{ text: "Hi" }, { functionCall: { name: "fs.read", args: { path: "a" }, id: "toolu_1" } }] }, finishReason: "MAX_TOKENS", index: 0 }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      modelVersion: "claude-sonnet-5-5",
      responseId: "msg_2",
    });
  });
});
