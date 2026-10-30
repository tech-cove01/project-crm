// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readLangfuseObservations } from "./langfuse-readback";
import type { IntegrationBinding } from "./config";

const traceId = "a".repeat(32);
const binding: IntegrationBinding = {
  organization_id: "16155fc5-1304-4fe0-8a86-d5d5cfeac693",
  provider: "langfuse",
  base_url: "https://trace.test",
  public_key: "test-public",
  secret_key: "CANARY_SECRET",
};
const expected = [
  {
    traceId,
    spanId: "1".repeat(16),
    name: "crm.run",
    startTimeUnixNano: "1793260322000000000",
    endTimeUnixNano: "1793260337000000000",
  },
  {
    traceId,
    spanId: "2".repeat(16),
    parentSpanId: "1".repeat(16),
    name: "crm.model",
    startTimeUnixNano: "1793260322242000000",
    endTimeUnixNano: "1793260337785000000",
  },
];
const rows = expected.map((span) => ({
  id: span.spanId,
  traceId,
  name: span.name,
  type: "SPAN",
  parentObservationId: span.parentSpanId ?? null,
  input: null,
  output: null,
}));
const page = (data: unknown[], meta = {}) =>
  new Response(JSON.stringify({ data, meta }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("Langfuse persistence readback", () => {
  it("uses native Response.status and completes a cursor traversal with bounded event timestamps", async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(page([rows[1]], { cursor: "next" }))
      .mockResolvedValueOnce(page([rows[0]]));
    const result = await readLangfuseObservations(binding, expected, http);
    expect(result).toMatchObject({
      complete: true,
      observationCount: 2,
      modelCount: 1,
      privacyVerified: true,
      httpStatuses: [200, 200],
    });
    const first = new URL(String(http.mock.calls[0]![0]));
    const second = new URL(String(http.mock.calls[1]![0]));
    expect(first.searchParams.get("fromStartTime")).toBe("2026-10-29T07:51:02.000Z");
    expect(first.searchParams.get("toStartTime")).toBe("2026-10-29T07:53:17.785Z");
    expect(first.searchParams.get("fields")).toBe("core,basic,io");
    expect(second.searchParams.get("cursor")).toBe("next");
    expect(JSON.stringify(result)).not.toContain("CANARY_SECRET");
  });
  it("reports a persisted root alone as incomplete even when ingestion was acknowledged", async () => {
    const result = await readLangfuseObservations(
      binding,
      expected,
      vi.fn(async () => page([rows[0]])),
    );
    expect(result.complete).toBe(false);
    expect(result.missingSpanIds).toEqual([expected[1]!.spanId]);
  });
  it("uses the newest consistent lifecycle update for a stable root, but rejects identity conflicts", async () => {
    const updated = { ...expected[0]!, endTimeUnixNano: "1793260340000000000" };
    const result = await readLangfuseObservations(
      binding,
      [...expected, updated],
      vi.fn(async () => page(rows)),
    );
    expect(result).toMatchObject({
      complete: true,
      expectedSpanCount: 2,
      toStartTime: "2026-10-29T07:53:20.000Z",
    });
    await expect(
      readLangfuseObservations(binding, [...expected, { ...updated, name: "crm.tool" }], vi.fn()),
    ).rejects.toThrow("expected_span_conflict");
  });
  it("does not accept another parent/name or unexpected IDs as full-chain proof", async () => {
    const result = await readLangfuseObservations(
      binding,
      expected,
      vi.fn(async () =>
        page([
          rows[0],
          { ...rows[1], parentObservationId: null },
          { ...rows[0], id: "3".repeat(16) },
        ]),
      ),
    );
    expect(result.complete).toBe(false);
    expect(result.mismatchedSpanIds).toEqual([expected[1]!.spanId]);
    expect(result.unexpectedSpanIds).toEqual(["3".repeat(16)]);
  });
  it.each([
    { data: [{ ...rows[0], traceId: "b".repeat(32) }], error: "trace_scope_mismatch" },
    { data: [{ ...rows[0], input: "PRIVATE_CANARY" }], error: "private_content_unverified" },
    {
      data: [Object.fromEntries(Object.entries(rows[0]!).filter(([key]) => key !== "input"))],
      error: "private_content_unverified",
    },
    { data: [rows[0], rows[0]], error: "duplicate_observation" },
  ])("fails closed without disclosing raw payload: $error", async ({ data, error }) => {
    await expect(
      readLangfuseObservations(
        binding,
        expected,
        vi.fn(async () => page(data)),
      ),
    ).rejects.toThrow(`langfuse_readback_${error}`);
  });
  it("rejects repeated cursors and preserves fixed HTTP errors", async () => {
    await expect(
      readLangfuseObservations(
        binding,
        expected,
        vi.fn(async () => page([], { cursor: "repeat" })),
      ),
    ).rejects.toThrow("pagination_incomplete");
    await expect(
      readLangfuseObservations(
        binding,
        expected,
        vi.fn(async () => new Response("PRIVATE_ERROR", { status: 422 })),
      ),
    ).rejects.toThrow("integration_http_422");
  });
});
