"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ApiResponse } from "@/lib/api/wrappers";

const endpoint = "/api/v1/ai/customer-memory/candidates";
const categoryLabels = {
  preference: "客户偏好",
  confirmed_fact: "客户事实",
  communication_context: "沟通背景",
};
type MemoryDraft = { category: keyof typeof categoryLabels; body: string };
type Candidate = MemoryDraft & {
  id: string;
  status: "pending" | "confirmed" | "rejected";
  source: { message_id: string; quote: string; sent_at: string } | null;
  fact_id: string | null;
};
type CandidateList = { conversation_id: string | null; candidates: Candidate[] };
type Decision = { decision: "confirm" | "reject"; candidate: Candidate; revision?: MemoryDraft };

class CandidateRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super("customer_memory_candidate_request_failed");
  }
}

function candidateErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof CandidateRequestError)) return fallback;
  if (error.status === 401 || error.status === 403)
    return "当前账号无权处理此联系人的记忆候选。";
  switch (error.code) {
    case "source_not_found":
      return "当前没有可访问的历史单聊。";
    case "source_changed":
      return "原消息已变更或撤回，请重新提取候选。";
    case "contact_not_found":
    case "candidate_not_found":
      return "当前联系人或候选已无法访问，请刷新页面。";
    case "decision_conflict":
      return "此候选的审核状态已变化，请核对当前结果。";
    case "invalid_evidence":
    case "model_output_invalid":
      return "模型结果未通过证据校验，请重新提取。";
    case "model_unavailable":
    case "upstream_unavailable":
      return "暂时无法提取候选，请稍后重试。";
    default:
      return fallback;
  }
}

async function requestCandidates<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
  if (!response.ok)
    throw new CandidateRequestError(response.status, payload && "error" in payload ? payload.error.code : "");
  if (!payload || !("data" in payload)) throw new Error("customer_memory_candidate_response_missing");
  return payload.data;
}

function CandidateReview({
  candidate,
  busy,
  onDecision,
}: {
  candidate: Candidate;
  busy: boolean;
  onDecision: (decision: Decision) => void;
}) {
  const [revision, setRevision] = useState<MemoryDraft | null>(null);
  const canConfirm = !busy && candidate.source !== null;
  return (
    <article
      className="space-y-2 rounded-md border p-3 text-sm"
      aria-label={`待审候选：${candidate.body}`}
    >
      <p className="text-muted-foreground">{categoryLabels[candidate.category]} · 待审核</p>
      <p className="break-words whitespace-pre-wrap">{candidate.body}</p>
      {candidate.source ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">客户原文</p>
          <blockquote className="break-words whitespace-pre-wrap border-l-2 pl-3">
            {candidate.source.quote}
          </blockquote>
          <time className="text-xs text-muted-foreground" dateTime={candidate.source.sent_at}>
            {new Date(candidate.source.sent_at).toLocaleString("zh-CN")}
          </time>
        </div>
      ) : (
        <p className="text-muted-foreground">候选来源已失效，可以驳回此候选。</p>
      )}
      {revision && candidate.source ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (canConfirm && revision.body.trim())
              onDecision({ decision: "confirm", candidate, revision });
          }}
        >
          <label className="block">
            <span>候选类型</span>
            <select
              className="ml-2 rounded-md border bg-background p-2"
              value={revision.category}
              disabled={busy}
              onChange={(event) =>
                setRevision({ ...revision, category: event.target.value as MemoryDraft["category"] })
              }
            >
              {Object.entries(categoryLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span>改写后的记忆内容</span>
            <Textarea
              value={revision.body}
              maxLength={2000}
              disabled={busy}
              onChange={(event) => setRevision({ ...revision, body: event.target.value })}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={!canConfirm || !revision.body.trim()}>
              改写后确认
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setRevision(null)}>
              取消改写
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {candidate.source && (
            <>
              <Button type="button" size="sm" disabled={!canConfirm} onClick={() => onDecision({ decision: "confirm", candidate })}>
                确认候选
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canConfirm}
                onClick={() => setRevision({ category: candidate.category, body: candidate.body })}
              >
                改写候选
              </Button>
            </>
          )}
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onDecision({ decision: "reject", candidate })}>
            驳回候选
          </Button>
        </div>
      )}
    </article>
  );
}

export function CustomerMemoryCandidates({
  contactId,
  onConfirmed,
}: {
  contactId: string;
  onConfirmed: (signal: AbortSignal) => Promise<void>;
}) {
  const [data, setData] = useState<CandidateList | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const mutating = useRef(false);
  const url = `${endpoint}?contact_id=${encodeURIComponent(contactId)}`;

  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    void requestCandidates<CandidateList>(url, { signal: current.signal })
      .then((rows) => { if (!current.signal.aborted) setData(rows); })
      .catch((error: unknown) => {
        if (!current.signal.aborted) setError(candidateErrorMessage(error, "无法读取待审候选。"));
      });
    return () => current.abort();
  }, [url]);

  async function handleAction(action?: Decision) {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || !data || mutating.current) return;
    if (!action && !data.conversation_id) return;
    mutating.current = true;
    setBusy(true);
    setNotice("");
    setError("");
    const init: RequestInit = {
      headers: { "Content-Type": "application/json" },
      signal,
    };
    try {
      if (!action) {
        const result = await requestCandidates<CandidateList>(endpoint, {
          ...init,
          method: "POST",
          body: JSON.stringify({ contact_id: contactId, conversation_id: data.conversation_id }),
        });
        if (signal.aborted) return;
        try {
          const rows = await requestCandidates<CandidateList>(url, { signal });
          if (signal.aborted) return;
          setData(rows);
          setNotice(result.candidates.some((row) => row.status === "pending")
            ? "提取完成，请核对原文并审核候选。"
            : "本次没有新的待审候选。");
        } catch {
          if (signal.aborted) return;
          setData(null);
          setError("提取请求已完成，列表刷新失败。请刷新页面查看。");
        }
      } else {
        const payload = {
          contact_id: contactId,
          candidate_id: action.candidate.id,
          decision: action.decision,
          ...action.revision,
        };
        const decided = await requestCandidates<Candidate>(endpoint, {
          ...init,
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        if (signal.aborted) return;
        setData({ ...data, candidates: data.candidates.filter((row) => row.id !== action.candidate.id) });
        setNotice(decided.status === "confirmed" ? "候选已确认并写入客户记忆。" : "候选已驳回。");
        if (decided.status === "confirmed") {
          try {
            await onConfirmed(signal);
          } catch {
            if (!signal.aborted) setError("客户记忆已保存，列表刷新失败。请刷新页面查看。");
          }
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof CandidateRequestError) {
        if (error.status === 401 || error.status === 403 || error.code === "contact_not_found") {
          setData(null);
        } else if (action && ["source_changed", "candidate_not_found", "decision_conflict"].includes(error.code)) {
          try {
            const rows = await requestCandidates<CandidateList>(url, { signal });
            if (!signal.aborted) setData(rows);
          } catch {
            if (!signal.aborted) setData(null);
          }
        }
      }
      if (!signal.aborted) setError(candidateErrorMessage(error, "操作未完成，请刷新页面并核对结果。"));
    } finally {
      mutating.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  const pending = data?.candidates.filter((row) => row.status === "pending") ?? [];
  return (
    <section aria-label="待审记忆候选" className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">待审记忆候选</h3>
        <Button type="button" size="sm" variant="outline" disabled={busy || !data?.conversation_id}
          onClick={() => void handleAction()}>
          从历史单聊提取候选
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">确认后才会写入客户记忆。</p>
      {!data && !error && <p role="status" className="text-sm text-muted-foreground">正在加载候选…</p>}
      {data && !data.conversation_id && (
        <p className="text-sm text-muted-foreground">没有可用的历史单聊。</p>
      )}
      {data?.conversation_id && pending.length === 0 && !busy && !notice && (
        <p className="text-sm text-muted-foreground">尚无待审候选。</p>
      )}
      {busy && <p role="status" className="text-sm text-muted-foreground">正在处理候选…</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {pending.map((candidate) => (
        <CandidateReview
          key={candidate.id}
          candidate={candidate}
          busy={busy}
          onDecision={(decision) => void handleAction(decision)}
        />
      ))}
    </section>
  );
}
