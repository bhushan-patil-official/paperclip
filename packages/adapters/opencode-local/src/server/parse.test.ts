import { describe, expect, it } from "vitest";
import { isOpenCodeRateLimited } from "./parse.js";

describe("isOpenCodeRateLimited", () => {
  it("detects FreeUsageLimitError in stdout", () => {
    expect(
      isOpenCodeRateLimited(
        '{"type":"error","error":{"name":"FreeUsageLimitError","message":"limit reached"}}\n',
        "",
      ),
    ).toBe(true);
  });

  it("detects HTTP 429 style failures", () => {
    expect(isOpenCodeRateLimited("", "Error: 429 Too Many Requests")).toBe(true);
  });

  it("ignores unrelated failures", () => {
    expect(isOpenCodeRateLimited("", "connection reset by peer")).toBe(false);
  });
});
