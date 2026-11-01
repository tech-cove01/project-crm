import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CollaborationReviewPanel, type ReviewSummary } from "./CollaborationReviewPanel";
const review: ReviewSummary = { version: 1, revision: 2, status: "pending", planKey: "opportunity_review_v1", childRunIds: ["child-one"], conflicts: [{ code: "stale_state", field: "lead:synthetic", message: "旧观察需要重新核对。" }], checkedAt: "2026-11-01T00:00:00Z", unavailable: 1, observations: [] };
describe("collaboration review controls", () => {
  it("requires an explicit reason and calls only reread, with no approval/execution control", async () => {
    const callback = vi.fn(async () => {}), user = userEvent.setup();
    render(<CollaborationReviewPanel review={review} runStatus="partial" busy={false} onReread={callback} />);
    expect(callback).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "重新取证并复核（不执行动作）" });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText("协作复核理由"), "核对当前来源状态"); await user.click(button);
    expect(callback).toHaveBeenCalledExactlyOnceWith("核对当前来源状态");
    expect(screen.queryByRole("button", { name: /批准|执行旧/ })).not.toBeInTheDocument();
  });
  it("shows a resolved review as a new-task boundary, never a permission to replay old proposals", () => {
    render(<CollaborationReviewPanel review={{ ...review, status: "resolved" }} runStatus="partial" busy={false} onReread={vi.fn()} />);
    expect(screen.getByText("当前证据已重读复核")).toBeInTheDocument();
    expect(screen.getByText(/继续办理须创建新任务/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
