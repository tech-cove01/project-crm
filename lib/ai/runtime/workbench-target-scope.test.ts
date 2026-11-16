import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { allowsWorkbenchTarget, allowsWorkbenchTool, type WorkbenchTargetScope } from "./workbench-target-scope";

const fixture = vi.hoisted(() => ({ handler: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: fixture.audit }));
vi.mock("@/lib/mcp/tools", () => {
  const definitions = [
    { name: "crm_get_lead", category: "read", requiresScope: "mcp:read" },
    { name: "crm_get_contact", category: "read", requiresScope: "mcp:read" },
    { name: "crm_list_followups", category: "read", requiresScope: "mcp:read" },
    { name: "crm_list_leads", category: "read", requiresScope: "mcp:read" },
    { name: "crm_list_conversations", category: "read", requiresScope: "mcp:read" },
    { name: "crm_search_contacts", category: "read", requiresScope: "mcp:read" },
    { name: "crm_move_lead_stage", category: "write", requiresScope: "mcp:write" },
  ].map((item) => ({ ...item, description: "fixture", requiresRole: "agent",
    inputSchema: { lead_id: z.string().uuid().optional(), contact_id: z.string().uuid().optional(),
      pipeline_id: z.string().uuid().optional(), query: z.string().optional(), limit: z.number().optional() },
    handler: fixture.handler }));
  return { allTools: definitions, getToolByName: (name: string) => definitions.find((item) => item.name === name) };
});

import { pickToolsFromMcp } from "./tools";
import { resolveAlvoDoRetorno } from "@/lib/followup/retorno-crm";

const LEAD = "a0000000-0000-4000-8000-000000000001";
const OTHER = "b0000000-0000-4000-8000-000000000002";
const CONTACT = "c0000000-0000-4000-8000-000000000003";
const CONVERSATION = "d0000000-0000-4000-8000-000000000004";
const selected = { leadId: LEAD, contactId: CONTACT, conversationId: CONVERSATION };

function mountedTool(toolName: string, targetScope: WorkbenchTargetScope | undefined) {
  const from = vi.fn(() => { throw new Error("scope guard must run before lookup"); });
  const tools = pickToolsFromMcp({
    supabase: { from } as never,
    ctx: { organizationId: "org", actor: { type: "ai_agent", id: "agent" } } as never,
    auth: { role: "ai_operator", scopes: ["mcp:read", "mcp:write"] } as never,
    toolIds: [toolName], handoffToolEnabled: false, handoffSignal: { triggered: false },
    pipelineIds: ["same-pipeline"], targetScope,
  });
  return { from, tool: tools[toolName]! };
}

const broadReads = [
  { name: "crm_list_leads", args: { pipeline_id: OTHER, limit: 50 } },
  { name: "crm_list_conversations", args: { contact_id: CONTACT, limit: 10 } },
  { name: "crm_search_contacts", args: { query: "customer", limit: 10 } },
];

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

  it.each(broadReads)("refuses $name even if it is directly mounted or supplied matching IDs", async ({ name, args }) => {
    fixture.handler.mockClear();
    fixture.audit.mockClear();
    const { from, tool } = mountedTool(name, selected);
    for (const input of [{}, args, { ...args, lead_id: LEAD, contact_id: CONTACT }]) {
      await expect(tool.execute!(input, { toolCallId: "scope-call", messages: [] } as never))
        .resolves.toMatchObject({ permitido: false, motivo: "workbench_target_out_of_scope" });
    }
    expect(fixture.handler).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({
      toolName: name, success: false, errorMessage: "workbench_target_out_of_scope",
    }));
  });

  it.each(broadReads)("keeps $name available without a selected workbench object", async ({ name, args }) => {
    for (const scope of [undefined, {}, { leadId: null }]) {
      fixture.handler.mockReset();
      fixture.handler.mockResolvedValue({ records: [] });
      expect(allowsWorkbenchTool(scope, name)).toBe(true);
      const { tool } = mountedTool(name, scope);
      await expect(tool.execute!(args, { toolCallId: "ordinary-call", messages: [] } as never))
        .resolves.toEqual({ records: [] });
      expect(fixture.handler).toHaveBeenCalledOnce();
    }
  });

  it.each([
    { name: "crm_get_lead", args: { lead_id: LEAD.toUpperCase() } },
    { name: "crm_get_contact", args: { contact_id: CONTACT } },
    { name: "crm_list_followups", args: { lead_id: LEAD, contact_id: CONTACT } },
  ])("keeps the selected $name read executable", async ({ name, args }) => {
    fixture.handler.mockReset();
    fixture.handler.mockResolvedValue({ selected: true });
    const { tool } = mountedTool(name, selected);
    await expect(tool.execute!(args, { toolCallId: "selected-call", messages: [] } as never))
      .resolves.toEqual({ selected: true });
    expect(fixture.handler).toHaveBeenCalledOnce();
  });

  it.each([
    { lead_id: LEAD, contact_id: CONTACT, limit: 5 },
    { contact_id: CONTACT, limit: 5 },
    {},
  ])("pins follow-up reads to the selected lead without a contact fallback: %j", async (args) => {
    fixture.handler.mockReset();
    fixture.handler.mockResolvedValue({ retornos: [] });
    const before = { ...args };
    const { tool } = mountedTool("crm_list_followups", selected);
    await tool.execute!(args, { toolCallId: "followup-call", messages: [] } as never);
    const executed = fixture.handler.mock.calls[0]![0];
    expect(executed).toEqual({ ...args, lead_id: LEAD, contact_id: undefined });
    expect(executed).not.toHaveProperty("contact_id");
    expect(args).toEqual(before);
  });

  it.each([undefined, {}, { contactId: CONTACT }])("preserves contact-level follow-ups without a selected lead: %j", async (scope) => {
    fixture.handler.mockReset();
    fixture.handler.mockResolvedValue({ retornos: [] });
    const args = { contact_id: CONTACT, limit: 5 };
    const { tool } = mountedTool("crm_list_followups", scope);
    await tool.execute!(args, { toolCallId: "contact-followup-call", messages: [] } as never);
    expect(fixture.handler).toHaveBeenCalledWith(args, expect.anything());
  });

  it.each([{ lead_id: OTHER, contact_id: CONTACT }, { contact_id: OTHER }])(
    "does not rewrite an explicitly wrong follow-up target into an allowed one: %j", async (args) => {
      fixture.handler.mockReset();
      const { tool } = mountedTool("crm_list_followups", selected);
      await expect(tool.execute!(args, { toolCallId: "wrong-followup-call", messages: [] } as never))
        .resolves.toMatchObject({ permitido: false, motivo: "workbench_target_out_of_scope" });
      expect(fixture.handler).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])("resolves only the selected follow-up lead, including when it no longer exists: %s", async (exists) => {
    fixture.handler.mockReset();
    const query = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: exists ? { id: LEAD, contact_id: CONTACT } : null, error: null }),
    };
    const from = vi.fn((table: string) => {
      if (table !== "crm_leads") throw new Error("must not fall back to contact lookup");
      return query;
    });
    fixture.handler.mockImplementation((args: Record<string, string>) => resolveAlvoDoRetorno(
      { from } as never, "org", { leadId: args.lead_id, contactId: args.contact_id },
    ));
    const { tool } = mountedTool("crm_list_followups", selected);
    await expect(tool.execute!({ contact_id: CONTACT }, { toolCallId: "resolve-followup-call", messages: [] } as never))
      .resolves.toEqual(exists
        ? { ok: true, alvo: { leadId: LEAD, contactId: CONTACT } }
        : { ok: false, codigo: "negocio_nao_encontrado" });
    expect(from).toHaveBeenCalledExactlyOnceWith("crm_leads");
    expect(query.eq).toHaveBeenCalledWith("organization_id", "org");
    expect(query.eq).toHaveBeenCalledWith("id", LEAD);
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
    await expect(tools[toolName]!.execute!({ lead_id: OTHER }, { toolCallId: "call", messages: [] } as never))
      .resolves.toMatchObject({ permitido: false, motivo: "workbench_target_out_of_scope" });
    expect(fixture.handler).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorMessage: "workbench_target_out_of_scope" }));
  });
});
