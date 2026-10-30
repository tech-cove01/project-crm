import { z } from "zod";
import type { IntegrationBinding } from "./config";
import { integrationFetch } from "./http";

export type ExpectedLangfuseSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
};

const pageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().regex(/^[a-f0-9]{16}$/),
      traceId: z.string().regex(/^[a-f0-9]{32}$/),
      name: z.enum(["crm.run", "crm.specialist", "crm.call", "crm.model", "crm.tool"]),
      type: z.enum(["SPAN", "GENERATION", "TOOL", "AGENT"]),
      parentObservationId: z.string().regex(/^[a-f0-9]{16}$/).nullable(),
      input: z.unknown().optional(),
      output: z.unknown().optional(),
    }),
  ),
  meta: z.object({ cursor: z.string().nullable().optional() }),
});
const own = (value: object, key: string) => Object.hasOwn(value, key);

/** Read-only proof of persisted spans, independent of an ingestion HTTP acknowledgement. */
export async function readLangfuseObservations(
  binding: IntegrationBinding,
  expected: ExpectedLangfuseSpan[],
  fetchImpl?: typeof fetch,
) {
  if (
    binding.provider !== "langfuse" ||
    !binding.public_key ||
    !binding.secret_key ||
    !expected.length ||
    expected.length > 2000 ||
    expected.some(
      (span) =>
        !/^[a-f0-9]{32}$/.test(span.traceId) ||
        !/^[a-f0-9]{16}$/.test(span.spanId) ||
        !/^\d+$/.test(span.startTimeUnixNano) ||
        !/^\d+$/.test(span.endTimeUnixNano) ||
        span.traceId !== expected[0]!.traceId,
    )
  )
    throw new Error("langfuse_readback_expected_spans_invalid");
  // Callers supply durable events oldest first. A resumed lifecycle can update the same root.
  const byId = new Map<string, ExpectedLangfuseSpan>();
  for (const span of expected) {
    const previous = byId.get(span.spanId);
    if (previous && (previous.name !== span.name || previous.parentSpanId !== span.parentSpanId))
      throw new Error("langfuse_readback_expected_span_conflict");
    byId.set(span.spanId, span);
  }
  expected = [...byId.values()];
  const times = expected.flatMap((span) => [
    Number(BigInt(span.startTimeUnixNano) / 1_000_000n),
    Number(BigInt(span.endTimeUnixNano) / 1_000_000n),
  ]);
  if (times.some((value) => !Number.isSafeInteger(value) || Math.abs(value) > 8.64e15 - 60_000))
    throw new Error("langfuse_readback_expected_spans_invalid");
  const traceId = expected[0]!.traceId;
  const from = new Date(Math.min(...times) - 60_000).toISOString();
  const to = new Date(Math.max(...times) + 60_000).toISOString();
  const observations: z.infer<typeof pageSchema>["data"] = [];
  const cursors = new Set<string>();
  const httpStatuses: number[] = [];
  const signal = AbortSignal.timeout(20_000);
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({
      traceId,
      fromStartTime: from,
      toStartTime: to,
      fields: "core,basic,io",
      limit: "100",
      ...(cursor ? { cursor } : {}),
    });
    const response = await integrationFetch(
      binding,
      `/api/public/v2/observations?${query}`,
      {
        method: "GET",
        signal,
        headers: {
          Authorization: `Basic ${Buffer.from(`${binding.public_key}:${binding.secret_key}`).toString("base64")}`,
        },
      },
      fetchImpl,
    );
    // Native fetch Response.status is a number; Playwright's status() is a different API.
    httpStatuses.push(response.status);
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new Error("langfuse_readback_response_invalid");
    }
    const parsed = pageSchema.safeParse(raw);
    if (!parsed.success) throw new Error("langfuse_readback_response_invalid");
    if (parsed.data.data.some((row) => row.traceId !== traceId))
      throw new Error("langfuse_readback_trace_scope_mismatch");
    // Omitted I/O is not evidence that private content is absent.
    if (
      parsed.data.data.some(
        (row) =>
          !own(row, "input") || !own(row, "output") || row.input != null || row.output != null,
      )
    )
      throw new Error("langfuse_readback_private_content_unverified");
    observations.push(...parsed.data.data);
    cursor = parsed.data.meta.cursor ?? undefined;
    if (!cursor) break;
    if (cursors.has(cursor) || page === 19)
      throw new Error("langfuse_readback_pagination_incomplete");
    cursors.add(cursor);
  }
  if (new Set(observations.map((row) => row.id)).size !== observations.length)
    throw new Error("langfuse_readback_duplicate_observation");
  const missingSpanIds = expected
    .filter((span) => !observations.some((row) => row.id === span.spanId))
    .map((span) => span.spanId);
  const unexpectedSpanIds = observations
    .filter((row) => !expected.some((span) => row.id === span.spanId))
    .map((row) => row.id);
  const mismatchedSpanIds = expected
    .filter((span) =>
      observations.some(
        (row) =>
          row.id === span.spanId &&
          (row.name !== span.name || row.parentObservationId !== (span.parentSpanId ?? null)),
      ),
    )
    .map((span) => span.spanId);
  return {
    traceId,
    fromStartTime: from,
    toStartTime: to,
    httpStatuses,
    observationCount: observations.length,
    expectedSpanCount: expected.length,
    modelCount: observations.filter((row) => row.name === "crm.model").length,
    toolCount: observations.filter((row) => row.name === "crm.tool").length,
    privacyVerified: true,
    missingSpanIds,
    unexpectedSpanIds,
    mismatchedSpanIds,
    complete: !missingSpanIds.length && !unexpectedSpanIds.length && !mismatchedSpanIds.length,
    observations: observations.map(({ id, name, type, parentObservationId }) => ({
      id,
      name,
      type,
      parentObservationId,
    })),
  };
}
