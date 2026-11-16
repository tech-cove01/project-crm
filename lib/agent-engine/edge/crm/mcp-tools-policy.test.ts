import { describe, expect, it } from "vitest";
import { resolveMcpTurnToolIds } from "./mcp-tools";

const HARNESS_ACTIONS = ["crm_send_whatsapp_message", "crm_request_human_handoff"];
const CONVERSATION_READS = ["crm_get_conversation", "crm_get_conversation_history"];

describe("MCP harness-action mount policy", () => {
  it("keeps all harness actions out of production Agent turns", () => {
    const resolved = resolveMcpTurnToolIds(HARNESS_ACTIONS);
    expect(resolved.allowed).toEqual([]);
    expect(resolved.blocked).toEqual(HARNESS_ACTIONS);
  });

  it("allows only handoff as a sandbox proposal, never direct message sending", () => {
    const resolved = resolveMcpTurnToolIds(HARNESS_ACTIONS, { workbenchProposalTools: true });
    expect(resolved.allowed).toEqual(["crm_request_human_handoff"]);
    expect([...resolved.proposalTools]).toEqual(["crm_request_human_handoff"]);
    expect(resolved.blocked).toEqual(["crm_send_whatsapp_message"]);
  });

  it("mounts only the exact handoff action when processing its approval", () => {
    const resolved = resolveMcpTurnToolIds(HARNESS_ACTIONS, { confirmationTools: ["crm_request_human_handoff"] });
    expect(resolved.allowed).toEqual(["crm_request_human_handoff"]);
    expect(resolved.blocked).toEqual(["crm_send_whatsapp_message"]);
  });

  it("requires a selected conversation to expose exact conversation reads in a workbench inspection", () => {
    const ids = ["crm_get_contact", ...CONVERSATION_READS];
    expect(resolveMcpTurnToolIds(ids, { readOnly: true, targetScope: { contactId: "contact" } }).allowed)
      .toEqual(["crm_get_contact"]);
    expect(resolveMcpTurnToolIds(ids, { readOnly: true, targetScope: { conversationId: "conversation" } }).allowed)
      .toEqual(ids);
    expect(resolveMcpTurnToolIds(ids, { readOnly: true }).allowed).toEqual(ids);
    expect(resolveMcpTurnToolIds(ids, { targetScope: {} }).allowed).toEqual(ids);
  });
});
