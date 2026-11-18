import { describe, expect, it } from "vitest";
import { managementKeyFor } from "../src/management-key.ts";

describe("managementKeyFor", () => {
  it("uses MANAGEMENT_KEY when it is set", async () => {
    expect(await managementKeyFor("  set-by-hand-0123456789abcdef0123456789  ", "correct-horse-battery-staple")).toBe("set-by-hand-0123456789abcdef0123456789");
  });

  it("derives a stable key CPA accepts from the dashboard password otherwise", async () => {
    const key = await managementKeyFor(undefined, "correct-horse-battery-staple");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await managementKeyFor("", "correct-horse-battery-staple")).toBe(key);
    expect(await managementKeyFor(undefined, "another-long-password-here")).not.toBe(key);
    expect(key).not.toContain("correct-horse");
  });

  it("gives no key for a missing or short password", async () => {
    expect(await managementKeyFor(undefined, undefined)).toBe("");
    expect(await managementKeyFor(undefined, "short")).toBe("");
  });
});
