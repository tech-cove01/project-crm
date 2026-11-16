/** Exact objects selected by the workbench, in addition to organization/pipeline authorization. */
export interface WorkbenchTargetScope {
  leadId?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
}

const TARGET_KEYS = {
  lead_id: "leadId",
  contact_id: "contactId",
  conversation_id: "conversationId",
} as const;

const TARGET_KINDS = {
  lead: "leadId",
  contact: "contactId",
  conversation: "conversationId",
} as const;

// These handlers cannot constrain their complete response to the selected
// objects. Conversation lists filter by contact only after organization-wide
// pagination; even a matching contact argument leaves an unscoped cursor.
const BROAD_CRM_READS = new Set([
  "crm_list_leads",
  "crm_list_conversations",
  "crm_search_contacts",
]);

function hasSelectedTarget(scope: WorkbenchTargetScope | undefined): boolean {
  return !!scope && Object.values(scope).some((id) => typeof id === "string" && id.length > 0);
}

/** Shared by tool mounting and execution; hiding a tool alone is not a guard. */
export function allowsWorkbenchTool(
  scope: WorkbenchTargetScope | undefined,
  toolName: string,
): boolean {
  return !hasSelectedTarget(scope) || !BROAD_CRM_READS.has(toolName);
}

/**
 * A selected object must not turn into another object in the same pipeline.
 * This covers the catalog's explicit CRM IDs and its polymorphic tag target;
 * it does not resolve indirect IDs (for example appointment_id) or filter lists.
 * Call allowsWorkbenchTool as well to reject reads that cannot honor this scope.
 * Non-workbench turns and workbench runs without selected objects retain their
 * existing organization, role and pipeline checks.
 */
export function allowsWorkbenchTarget(
  scope: WorkbenchTargetScope | undefined,
  args: Record<string, unknown>,
): boolean {
  if (!scope || !hasSelectedTarget(scope))
    return true;

  const matches = (actual: unknown, key: keyof WorkbenchTargetScope) => {
    const selected = scope[key];
    return typeof actual === "string" && typeof selected === "string" &&
      actual.length > 0 && actual.toLowerCase() === selected.toLowerCase();
  };
  for (const [argument, key] of Object.entries(TARGET_KEYS)) {
    if (args[argument] !== undefined && !matches(args[argument], key)) return false;
  }
  if (args.target_kind !== undefined || args.target_id !== undefined) {
    const kind = args.target_kind;
    if (typeof kind !== "string" || !Object.hasOwn(TARGET_KINDS, kind)) return false;
    if (!matches(args.target_id, TARGET_KINDS[kind as keyof typeof TARGET_KINDS])) return false;
  }
  return true;
}
