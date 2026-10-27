import { describe, expect, it, vi } from "vitest";
import { assertLocalWorkbenchBudgetAllowed, localUnpricedApprovalAllowed, localWorkbenchUnpricedMode, workbenchBudgetForNewRun } from "./local-workbench-budget";

const local = { NODE_ENV: "development", NEXT_PUBLIC_APP_URL: "http://localhost:3000", CRM_LOCAL_WORKBENCH_UNPRICED_MODE: "true" };
const normal = { maxSteps: 12, tokenBudget: 36000, costBudgetCents: 75 };

describe("local Workbench budget mode", () => {
  it("requires the explicit local flag, development mode and a loopback application URL", () => {
    expect(localWorkbenchUnpricedMode(local)).toBe(true);
    expect(localWorkbenchUnpricedMode({ ...local, NODE_ENV: "production" })).toBe(false);
    expect(localWorkbenchUnpricedMode({ ...local, NODE_ENV: "test" })).toBe(false);
    expect(localWorkbenchUnpricedMode({ ...local, NODE_ENV: undefined })).toBe(false);
    expect(localWorkbenchUnpricedMode({ ...local, CRM_LOCAL_WORKBENCH_UNPRICED_MODE: "false" })).toBe(false);
    expect(localWorkbenchUnpricedMode({ ...local, NEXT_PUBLIC_APP_URL: "https://example.com" })).toBe(false);
    expect(localWorkbenchUnpricedMode({ ...local, NEXT_PUBLIC_APP_URL: "not-a-url" })).toBe(false);
  });
  it("only exempts a new ordinary DashScope run while retaining token and step limits", () => {
    const result = workbenchBudgetForNewRun(normal, "dashscope", false, local);
    expect(result).toEqual({ ...normal, costBudgetCents: null, localUnpricedDemo: true });
    expect(workbenchBudgetForNewRun(normal, "openai", false, local)).toEqual(normal);
    expect(workbenchBudgetForNewRun(normal, "dashscope", true, local)).toEqual(normal);
    expect(workbenchBudgetForNewRun({ ...normal, tokenBudget: null }, "dashscope", false, local)).toEqual({ ...normal, tokenBudget: null });
    expect(workbenchBudgetForNewRun({ ...normal, maxSteps: 0 }, "dashscope", false, local)).toEqual({ ...normal, maxSteps: 0 });
  });
  it("checks the live demo flag and model before approval but never blocks rejection", async () => {
    const budget = workbenchBudgetForNewRun(normal, "dashscope", false, local);
    const loadProvider = vi.fn(async () => "dashscope");
    expect(await localUnpricedApprovalAllowed({ budget, decision: "approve", missionId: null, loadProvider, env: local })).toBe(true);
    expect(await localUnpricedApprovalAllowed({ budget, decision: "approve", missionId: null, loadProvider, env: { ...local, NODE_ENV: "production" } })).toBe(false);
    expect(await localUnpricedApprovalAllowed({ budget, decision: "approve", missionId: null, loadProvider: async () => "openai", env: local })).toBe(false);
    expect(await localUnpricedApprovalAllowed({ budget, decision: "approve", missionId: null, loadProvider: async () => { throw new Error(); }, env: local })).toBe(false);
    loadProvider.mockClear();
    expect(await localUnpricedApprovalAllowed({ budget, decision: "reject", missionId: null, loadProvider, env: {} })).toBe(true);
    expect(loadProvider).not.toHaveBeenCalled();
    expect(await localUnpricedApprovalAllowed({ budget: normal, decision: "approve", missionId: null, loadProvider, env: {} })).toBe(true);
    expect(loadProvider).not.toHaveBeenCalled();
  });
  it("refuses a durable exemption if mode, provider, mission or finite limits change", () => {
    const budget = workbenchBudgetForNewRun(normal, "dashscope", false, local);
    expect(() => assertLocalWorkbenchBudgetAllowed(budget, "dashscope", null, local)).not.toThrow();
    expect(() => assertLocalWorkbenchBudgetAllowed(budget, "openai", null, local)).toThrow("local_workbench_unpriced_mode_unavailable");
    expect(() => assertLocalWorkbenchBudgetAllowed(budget, "dashscope", "mission", local)).toThrow();
    expect(() => assertLocalWorkbenchBudgetAllowed(budget, "dashscope", null, { ...local, NODE_ENV: "production" })).toThrow();
    expect(() => assertLocalWorkbenchBudgetAllowed(budget, "dashscope", null, { ...local, CRM_LOCAL_WORKBENCH_UNPRICED_MODE: "false" })).toThrow();
    expect(() => assertLocalWorkbenchBudgetAllowed({ ...budget, tokenBudget: null }, "dashscope", null, local)).toThrow();
    expect(() => assertLocalWorkbenchBudgetAllowed(normal, "openai", null, {})).not.toThrow();
  });
});
