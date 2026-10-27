/** Explicit development-mode demo setting intended for local use only.
 * The loopback app URL is a configuration guard, not proof of network isolation.
 * Does not alter organization budgets.
 */
export interface WorkbenchBudget {
  maxSteps?: number | null;
  tokenBudget?: number | null;
  costBudgetCents?: number | null;
  localUnpricedDemo?: boolean;
}

export interface LocalWorkbenchEnvironment {
  NODE_ENV?: string;
  NEXT_PUBLIC_APP_URL?: string;
  CRM_LOCAL_WORKBENCH_UNPRICED_MODE?: string;
}

export function localWorkbenchUnpricedMode(
  env: LocalWorkbenchEnvironment = process.env,
): boolean {
  if (env.NODE_ENV !== "development" || env.CRM_LOCAL_WORKBENCH_UNPRICED_MODE !== "true") return false;
  try {
    const url = new URL(env.NEXT_PUBLIC_APP_URL ?? "");
    return (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Apply only to new, non-Mission DashScope runs with finite token/step caps. */
export function workbenchBudgetForNewRun(
  budget: WorkbenchBudget,
  provider: string,
  isMission: boolean,
  env: LocalWorkbenchEnvironment = process.env,
): WorkbenchBudget {
  if (!localWorkbenchUnpricedMode(env) || provider !== "dashscope" || isMission ||
      typeof budget.maxSteps !== "number" || !Number.isFinite(budget.maxSteps) || budget.maxSteps <= 0 ||
      typeof budget.tokenBudget !== "number" || !Number.isFinite(budget.tokenBudget) || budget.tokenBudget <= 0 ||
      typeof budget.costBudgetCents !== "number") return budget;
  return { ...budget, costBudgetCents: null, localUnpricedDemo: true };
}

/** A durable run must not retain the exemption if the local flag is removed. */
export function assertLocalWorkbenchBudgetAllowed(
  budget: WorkbenchBudget,
  provider: string | undefined,
  missionId: string | null,
  env: LocalWorkbenchEnvironment = process.env,
): void {
  if (!budget.localUnpricedDemo) return;
  if (!localWorkbenchUnpricedMode(env) || provider !== "dashscope" || missionId !== null ||
      budget.costBudgetCents !== null || typeof budget.maxSteps !== "number" ||
      !Number.isFinite(budget.maxSteps) || budget.maxSteps <= 0 ||
      typeof budget.tokenBudget !== "number" || !Number.isFinite(budget.tokenBudget) || budget.tokenBudget <= 0)
    throw new Error("local_workbench_unpriced_mode_unavailable");
}

/** Check an approval before it claims or executes a durable demo proposal. */
export async function localUnpricedApprovalAllowed(input: {
  budget: WorkbenchBudget;
  decision: "approve" | "reject";
  missionId: string | null;
  loadProvider: () => Promise<string | undefined>;
  env?: LocalWorkbenchEnvironment;
}): Promise<boolean> {
  if (input.decision !== "approve" || !input.budget.localUnpricedDemo) return true;
  try {
    const provider = await input.loadProvider();
    assertLocalWorkbenchBudgetAllowed(input.budget, provider, input.missionId, input.env);
    return true;
  } catch {
    return false;
  }
}
