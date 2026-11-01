import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { allowsWorkbenchTarget } from "./workbench-target-scope";

const fixture = vi.hoisted(() => ({ handler: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: fixture.audit }));
vi.mock("@/lib/mcp/tools", () => {
  const definitions = [
    { name: "crm_get_lead", category: "read", requiresScope: "mcp:read" },
    { name: "crm_move_lead_stage", category: "write", requiresScope: "mcp:write" },
  ].map((item) => ({ ...item, description: "fixture", requiresRole: "agent",
    inputSchema: { lead_id: z.string().uuid() }, handler: fixture.handler }));
  return { allTools: definitions, getToolByName: (name: string) => definitions.find((item) => item.name === name) };
});

import { pickToolsFromMcp } from "./tools";

const LEAD = "a0000000-0000-4000-8000-000000000001";
const OTHER = "b0000000-0000-4000-8000-000000000002";
const CONTACT = "c0000000-0000-4000-8000-000000000003";
const CONVERSATION = "d0000000-0000-4000-8000-000000000004";
const selected = { leadId: LEAD, contactId: CONTACT, conversationId: CONVERSATION };

describe("workbench selected CRM targets", () => {
  it("refuses another lead even when a pipeline check would allow it", () => {
    expect(allowsWorkbenchTarget(selected, { lead_id: OTHER })).toBe(false);
  });

  it.each([
    { contact_id: OTHER }, { conversation_id: OTHER },
    { lead_id: LEAD, contact_id: OTHER },
    { target_kind: "lead", target_id: OTHER },
    { target_kind: "contact", target_id: OTHER },
    { target_kind: "conversation", target_id: OTHER },
  ])("refuses explicit mismatched catalog target %j", (args) => {
    expect(allowsWorkbenchTarget(selected, args)).toBe(false);
  });

  it("does not invent a selected object in another target namespace", () => {
    expect(allowsWorkbenchTarget({ leadId: LEAD }, { contact_id: CONTACT })).toBe(false);
    expect(allowsWorkbenchTarget(selected, { contact_id: null })).toBe(false);
  });

  it("accepts the selected objects, including PostgreSQL UUID case equivalence", () => {
    expect(allowsWorkbenchTarget(selected, { lead_id: LEAD.toUpperCase(), contact_id: CONTACT, conversation_id: CONVERSATION })).toBe(true);
    expect(allowsWorkbenchTarget(selected, { target_kind: "contact", target_id: CONTACT })).toBe(true);
  });

  it("leaves ordinary turns and unselected workbench context with existing authorization", () => {
    expect(allowsWorkbenchTarget(undefined, { lead_id: OTHER })).toBe(true);
    expect(allowsWorkbenchTarget({}, { lead_id: OTHER })).toBe(true);
    expect(allowsWorkbenchTarget({ leadId: null }, { lead_id: OTHER })).toBe(true);
  });

  it("ignores prose, and requires a valid complete polymorphic target when supplied", () => {
    expect(allowsWorkbenchTarget(selected, { body: OTHER, reason: OTHER })).toBe(true);
    expect(allowsWorkbenchTarget(selected, { target_id: LEAD })).toBe(false);
    expect(allowsWorkbenchTarget(selected, { target_kind: "__proto__", target_id: LEAD })).toBe(false);
  });

  it.each(["crm_get_lead", "crm_move_lead_stage"])("blocks %s before any handler or pipeline lookup", async (toolName) => {
    fixture.handler.mockClear();
    fixture.audit.mockClear();
    const from = vi.fn(() => { throw new Error("wrong target must be refused before lookup"); });
    const tools = pickToolsFromMcp({
      supabase: { from } as never,
      ctx: { organizationId: "org", actor: { type: "ai_agent", id: "agent" } } as never,
      auth: { role: "ai_operator", scopes: ["mcp:read", "mcp:write"] } as never,
      toolIds: [toolName], handoffToolEnabled: false, handoffSignal: { triggered: false },
      pipelineIds: ["same-pipeline"], targetScope: selected,
    });
    await expect(tools[toolName].execute!({ lead_id: OTHER }, { toolCallId: "call", messages: [] } as never))
      .resolves.toMatchObject({ permitido: false, motivo: "workbench_target_out_of_scope" });
    expect(fixture.handler).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorMessage: "workbench_target_out_of_scope" }));
  });
});
