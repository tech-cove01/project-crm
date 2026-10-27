import { randomUUID } from "node:crypto";
import { executeReversibleLeadUpdate } from "@/lib/ai/agents/reversible-lead-update";
import { workbenchToolEffect } from "@/lib/ai/agents/tool-effects";

type ExecutableTool = {
  execute: (args: unknown, options: {
    toolCallId: string; messages: never[]; context: object;
  }) => Promise<unknown>;
};

export class NonCompensableWorkbenchWriteError extends Error {
  constructor() {
    super("workbench_reversible_write_has_no_compensation");
  }
}

/** A tool explicitly refused before applying the requested business action. */
export class WorkbenchToolRejectedError extends Error {
  constructor() {
    super("workbench_tool_rejected");
  }
}

/** An approval never downgrades a reversible CRM write to a raw write. */
export async function executeApprovedWorkbenchTool(input: {
  toolName: string;
  args: unknown;
  tools: Record<string, ExecutableTool | undefined>;
}): Promise<{
  output: unknown;
  reversible: Awaited<ReturnType<typeof executeReversibleLeadUpdate>>;
}> {
  const effect = workbenchToolEffect(input.toolName);
  if (!effect) throw new Error("workbench_approved_tool_unclassified");
  const tool = input.tools[input.toolName];
  if (!tool?.execute) throw new Error("workbench_approved_tool_missing");
  if (effect.effect === "reversible_write") {
    if (input.toolName !== "crm_update_lead")
      throw new NonCompensableWorkbenchWriteError();
    const reversible = await executeReversibleLeadUpdate({
      args: input.args,
      tools: input.tools,
    });
    if (!reversible) throw new NonCompensableWorkbenchWriteError();
    return { output: reversible.result, reversible };
  }
  const output = await tool.execute(input.args, {
    toolCallId: randomUUID(), messages: [], context: {},
  });
  const result = output as {
    isError?: boolean; ok?: boolean; error?: unknown; permitido?: boolean; agendado?: boolean;
  } | null;
  // These are explicit pre-write refusals: the scope guard denied the tool, or
  // scheduling returned a business refusal without creating a follow-up.
  if (result?.permitido === false ||
      (input.toolName === "crm_schedule_followup" && result?.agendado === false))
    throw new WorkbenchToolRejectedError();
  // MCP's in-process bridge also returns {error} rather than throwing. An
  // exception can happen after a side effect, so its outcome remains unknown.
  if (result?.isError || result?.ok === false || result?.error != null)
    throw new Error("crm_tool_reported_error");
  return { output, reversible: null };
}
