"use client";
import { useState } from "react";

export type ReviewSummary = {
  version: number;
  revision: number;
  status: "pending" | "resolved";
  planKey: string;
  childRunIds: string[];
  conflicts: Array<{ code: string; field?: string; message: string }>;
  checkedAt: string;
  unavailable: number;
  reviewedBy?: string;
  observations: Array<{ identity: string; revision: string; fieldHashes: Record<string, string> }>;
};
export function CollaborationReviewPanel({
  review,
  runStatus,
  busy,
  onReread,
}: {
  review: ReviewSummary;
  runStatus: string;
  busy: boolean;
  onReread: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const pending = review.status === "pending";
  return (
    <section aria-label="协作证据复核" className="space-y-3 rounded-lg border p-3 text-sm">
      <p className="font-semibold">
        {pending ? "协作证据待复核 · 动作已阻断" : "当前证据已重读复核"}
      </p>
      <p className="text-xs text-muted-foreground">
        计划：{review.planKey} · 复核版本：{review.revision} ·{" "}
        {new Date(review.checkedAt).toLocaleString("zh-CN")}
      </p>
      <p>
        原子任务结果保留为历史观察。复核不会批准、执行或重新发送旧提案；继续办理须创建新任务并按当前事实重新提案。
      </p>
      {review.conflicts.length > 0 && (
        <ul className="list-inside list-disc space-y-1">
          {review.conflicts.map((item, index) => (
            <li key={`${item.code}:${index}`}>
              {item.message}
              {item.field ? `（${item.field}）` : ""}
            </li>
          ))}
        </ul>
      )}
      {review.unavailable > 0 && (
        <p role="status">有 {review.unavailable} 项事实或来源无法重新核实，保持待复核。</p>
      )}
      {review.observations.length > 0 && (
        <details>
          <summary className="cursor-pointer">当前观察的身份、版本与字段哈希</summary>
          <ul className="mt-2 space-y-1 text-xs break-all">
            {review.observations.map((item) => (
              <li key={item.identity}>
                {item.identity} · {item.revision} ·{" "}
                {Object.entries(item.fieldHashes)
                  .map(([field, hash]) => `${field}: ${hash.slice(0, 12)}…`)
                  .join("、")}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-xs text-muted-foreground">
        子运行：{review.childRunIds.join("、")}。可在下方实际知识证据中查看当前仍授权的来源。
      </p>
      {pending && runStatus === "partial" && (
        <div className="space-y-2">
          <label className="block">
            复核理由
            <input
              aria-label="协作复核理由"
              value={reason}
              maxLength={1000}
              onChange={(event) => setReason(event.target.value)}
              disabled={busy}
              className="mt-1 block w-full rounded border bg-background px-2 py-1"
            />
          </label>
          <button
            type="button"
            disabled={busy || !reason.trim()}
            onClick={() => void onReread(reason.trim())}
            className="rounded border px-3 py-2 disabled:opacity-50"
          >
            重新取证并复核（不执行动作）
          </button>
        </div>
      )}
    </section>
  );
}
