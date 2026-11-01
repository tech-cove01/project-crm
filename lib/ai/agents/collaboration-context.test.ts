import { describe, expect, it } from "vitest";
import { formatCollaborationContext } from "./collaboration-runtime";
import type { AgentCollaborationOutcome } from "./collaboration";

describe("typed collaboration source references", () => {
  it("distinguishes child UUIDs and knowledge receipts from provider sources and CRM call keys", () => {
    const child = "b76280dd-b69b-4ea5-a93d-88d68f8b4870";
    const receipt = "0dfbcaad-58f0-4df5-9ab2-0246f8c5b023";
    const source = "6c9a5685-c0ba-48d9-b1fc-e5ed7a8c9194";
    const nestedMemory = "18d15802-17e8-4b9c-b414-2069845c3a16";
    const outcome = { planKey: "test", status: "complete", results: [{ childRunId: child,
      specialistKey: "customer_evidence", status: "complete", summary: "保留原始专家结论。", missingMaterial: [],
      toolCalls: 2, evidence: [
        { id: "customer_evidence:call-1", namespace: "crm_records", kind: "crm_record", title: "Contact",
          excerpt: "fact", locator: { provider: "crm_tool", sourceId: "call-1" } },
        { id: receipt, namespace: "organization_wiki", kind: "wiki_page", title: "Policy", excerpt: "policy",
          locator: { provider: "weknora", sourceId: source }, metadata: { page_id: "page", page_version: 3 } },
      ], claims: [{ subject: { resource: "contact", id: nestedMemory } }],
      usage: { inputTokens: 1, outputTokens: 1, costCents: null, modelTurns: 2 } }], conflicts: [],
      usage: { toolCalls: 2, inputTokens: 1, outputTokens: 1, costCents: null, modelTurns: 2 },
    } as unknown as AgentCollaborationOutcome;
    const context = formatCollaborationContext(outcome);
    const refs = context.split("\n").filter(line => line.startsWith('{"sourceType":')).map(line => JSON.parse(line));

    expect(refs).toEqual([{ sourceType: "specialist", sourceId: child },
      { sourceType: "knowledge", sourceId: receipt, receiptId: receipt, provider: "weknora", providerSourceId: source,
        pageId: "page", pageVersion: 3 }]);
    expect(refs.some(ref => ref.sourceId === source || ref.sourceId === nestedMemory)).toBe(false);
    expect(context).not.toContain("customer_evidence:call-1");
    expect(context).toContain("保留原始专家结论。");
    expect(context).toContain("assertions 最多 4 项");
  });
});
