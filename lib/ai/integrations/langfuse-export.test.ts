// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { exportLangfuseEvent, langfuseExportHandler } from "./langfuse";

const org = "a0000000-0000-4000-8000-000000000001";
const row: EventRow = {
  id: "a0000000-0000-4000-8000-000000000002",
  organization_id: org,
  entity_kind: "ai_workbench_run",
  entity_id: "a0000000-0000-4000-8000-000000000003",
  event_type: "ai_integration.langfuse_export",
  metadata: {},
  consumed_by: [],
  attempts: 0,
  payload: {
    version: 1,
    kind: "spans",
    spans: [
      {
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        name: "crm.run",
        kind: 1,
        startTimeUnixNano: "1000000000",
        endTimeUnixNano: "2000000000",
        attributes: [],
        status: { code: 1 },
      },
    ],
  },
};
const pool = { query: vi.fn(async () => ({ rows: [{ enabled: true }] })) } as unknown as Pool;
afterEach(() => vi.unstubAllEnvs());
describe("Langfuse OTLP acknowledgements", () => {
  it.each([
    { body: {}, ok: true },
    { body: { partialSuccess: { rejectedSpans: "0" } }, ok: true },
    { body: { partialSuccess: { rejectedSpans: "0", errorMessage: "WARNING_CANARY" } }, ok: true },
    {
      body: { partialSuccess: { rejectedSpans: 1, errorMessage: "CANARY_PRIVATE" } },
      error: "langfuse_span_receipt_incomplete",
    },
    { body: { partialSuccess: { rejectedSpans: "2" } }, error: "langfuse_span_receipt_incomplete" },
    {
      body: { partialSuccess: { rejectedSpans: "invalid CANARY_PRIVATE" } },
      error: "langfuse_span_receipt_invalid",
    },
  ])("checks the OTLP receipt without logging its raw error", async ({ body, ok, error }) => {
    vi.stubEnv(
      "AI_INTEGRATION_BINDINGS",
      JSON.stringify([
        {
          organization_id: org,
          provider: "langfuse",
          base_url: "https://trace.test",
          public_key: "synthetic",
          secret_key: "CANARY_SECRET",
        },
      ]),
    );
    const request = exportLangfuseEvent(
      row,
      pool,
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
    if (ok) expect(await request).toBe("delivered");
    else await expect(request).rejects.toThrow(error);
  });
  it("does not automatically retry a partially rejected batch", async () => {
    vi.stubEnv(
      "AI_INTEGRATION_BINDINGS",
      JSON.stringify([
        {
          organization_id: org,
          provider: "langfuse",
          base_url: "https://trace.test",
          public_key: "synthetic",
          secret_key: "CANARY_SECRET",
        },
      ]),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              partialSuccess: { rejectedSpans: "1", errorMessage: "CANARY_PRIVATE" },
            }),
            { status: 200 },
          ),
      ),
    );
    const requestPool = await import("@/lib/agent-engine/db/request-pool");
    const spy = vi.spyOn(requestPool, "getRequestPool").mockReturnValue(pool);
    try {
      expect(await langfuseExportHandler.handle(row)).toMatchObject({
        status: "skipped",
        detail: "langfuse_spans_rejected_nonretryable",
      });
    } finally {
      spy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
