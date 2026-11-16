import { randomUUID } from "node:crypto";

import type { ToolSet } from "@/lib/agent-engine/edge/llm/run-model-call";
import { executePiTurnModelCall } from "@/lib/agent-engine/agent/pi-turn-execution";
import type { PublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";
import type { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { buildMcpTurnTools } from "@/lib/agent-engine/edge/crm/mcp-tools";
import type { AgentRuntimeEvent, RuntimeMessage } from "@/lib/agent-runtime";
import { adaptAiTools } from "@/lib/agent-runtime/pi/ai-sdk-compat";
import { guardServiceEffect } from "@/lib/atendimento/fronteira-server";
import type {
  AgentCollaborationOutcome,
  AgentCollaborationPlan,
  AgentSpecialistResult,
  AgentSpecialistTask,
} from "@/lib/ai/agents/collaboration";
import {
  BoundedAgentCollaborationRuntime,
  type AgentCollaborationStore,
  type AgentSpecialistExecutor,
  type DurableSpecialistRun,
} from "@/lib/ai/agents/collaboration-runtime";
import { appendWorkbenchEvent } from "@/lib/ai/agents/workbench-events";
import { workbenchToolEffect } from "@/lib/ai/agents/tool-effects";
import type { KnowledgeEvidence } from "@/lib/ai/knowledge/contracts";
import { normalizeKnowledgeEvidence } from "@/lib/ai/knowledge/evidence";
import type { createAdminClient } from "@/lib/supabase/admin";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { extractProductFinalAnswer } from "@/lib/ai/agents/final-answer";
import { extractToolClaims } from "@/lib/ai/agents/evidence-claims";
import { specialistObservationEnvelope } from "@/lib/ai/agents/workbench-state";
import { finishInitialCollaborationReview } from "./workbench-collaboration-review";
import { policyObservationStatus, policyRequirements, policySearchQuestion } from "./workbench-policy-requirements";

type Admin = ReturnType<typeof createAdminClient>;
type TurnDeps = ReturnType<typeof requestTurnDeps>;

interface WorkbenchScope {
  contactId: string | null;
  leadId: string | null;
  conversationId: string | null;
  pipelineId: string | null;
}

interface RootRunMetadata {
  organizationId: string;
  parentRunId: string;
  rootJobId: string;
  agentId: string;
  actorUserId: string | null;
  mode: string;
  task: string;
  scope: WorkbenchScope;
  budget: {
    maxSteps?: number | null;
    tokenBudget?: number | null;
    costBudgetCents?: number | null;
  };
}

function parseSpecialistResult(value: unknown): AgentSpecialistResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Partial<AgentSpecialistResult>;
  if (!(
    typeof result.childRunId === "string" &&
    typeof result.specialistKey === "string" &&
    (result.status === "complete" || result.status === "partial" || result.status === "failed") &&
    typeof result.summary === "string" &&
    Array.isArray(result.evidence) &&
    Array.isArray(result.missingMaterial) &&
    typeof result.toolCalls === "number" &&
    Boolean(result.usage)
  ))
    return null;
  return {
    ...result,
    claims: Array.isArray(result.claims) ? result.claims : [],
  } as AgentSpecialistResult;
}

class SupabaseCollaborationStore implements AgentCollaborationStore {
  constructor(
    private readonly admin: Admin,
    private readonly root: RootRunMetadata,
  ) {}

  async ensureChild(
    plan: AgentCollaborationPlan,
    task: AgentSpecialistTask,
  ): Promise<DurableSpecialistRun> {
    const existing = await this.admin
      .from("ai_workbench_runs")
      .select("id,status,runtime_state")
      .eq("organization_id", this.root.organizationId)
      .eq("parent_run_id", this.root.parentRunId)
      .eq("specialist_key", task.specialist.key)
      .maybeSingle();
    if (existing.error) throw new Error("specialist_run_read_failed");
    if (existing.data) {
      const state = existing.data.runtime_state as { specialistResult?: unknown } | null;
      const parsedResult = parseSpecialistResult(state?.specialistResult);
      return {
        id: existing.data.id,
        status: existing.data.status as DurableSpecialistRun["status"],
        ...(parsedResult ? { result: parsedResult } : {}),
      };
    }
    const id = randomUUID();
    const specialistBudget = {
      maxSteps: plan.maxTurnsPerSpecialist,
      tokenBudget:
        typeof this.root.budget.tokenBudget === "number"
          ? Math.max(
              512,
              Math.floor(
                (this.root.budget.tokenBudget * plan.modelBudgetShare) / plan.specialists.length,
              ),
            )
          : null,
      costBudgetCents:
        typeof this.root.budget.costBudgetCents === "number"
          ? (this.root.budget.costBudgetCents * plan.modelBudgetShare) / plan.specialists.length
          : null,
      maxToolCalls: Math.max(1, Math.floor(plan.maxTotalToolCalls / plan.specialists.length)),
    };
    const { error } = await this.admin.from("ai_workbench_runs").insert({
      id,
      organization_id: this.root.organizationId,
      agent_id: this.root.agentId,
      actor_user_id: this.root.actorUserId,
      task: `${this.root.task}\n\nSpecialist objective: ${task.specialist.objective}`,
      mode: "inspect",
      scope: this.root.scope as never,
      status: "queued",
      budget: specialistBudget as never,
      run_kind: "specialist",
      parent_run_id: this.root.parentRunId,
      specialist_key: task.specialist.key,
      collaboration_key: plan.key,
      runtime_state: {
        parentRunId: this.root.parentRunId,
        planKey: plan.key,
        planRevision: plan.revision,
        specialistKey: task.specialist.key,
      },
    });
    if (error) {
      if (error.code !== "23505") throw new Error("specialist_run_create_failed");
      return this.ensureChild(plan, task);
    }
    await appendWorkbenchEvent(this.admin, {
      organizationId: this.root.organizationId,
      runId: id,
      type: "run_started",
      payload: {
        agentId: this.root.agentId,
        mode: "inspect",
        taskLength: this.root.task.length,
        evalProfile: "specialist_readonly_v1",
        knowledgeNamespaces: task.specialist.knowledgeNamespaces,
      },
    });
    return { id, status: "queued" };
  }

  async claimChild(childRunId: string, leaseSeconds: number): Promise<string> {
    const executionAttemptId = randomUUID();
    const { data, error } = await this.admin.rpc("fn_claim_ai_specialist_run", {
      p_org: this.root.organizationId,
      p_parent: this.root.parentRunId,
      p_run: childRunId,
      p_attempt: executionAttemptId,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw new Error("specialist_run_claim_failed");
    if (!data?.length || data[0]?.execution_attempt_id !== executionAttemptId)
      throw new Error("specialist_lease_busy");
    return executionAttemptId;
  }

  async completeChild(
    childRunId: string,
    executionAttemptId: string,
    result: AgentSpecialistResult,
  ): Promise<void> {
    const status = result.status === "complete" ? "completed" : "partial";
    const { data, error } = await this.admin
      .from("ai_workbench_runs")
      .update({
        status,
        final_text: result.summary || null,
        completed_at: new Date().toISOString(),
        error_code: status === "partial" ? "specialist_partial" : null,
        runtime_state: {
          parentRunId: this.root.parentRunId,
          specialistResult: result,
        } as never,
        execution_lease_expires_at: null,
      })
      .eq("organization_id", this.root.organizationId)
      .eq("id", childRunId)
      .eq("parent_run_id", this.root.parentRunId)
      .eq("status", "running")
      .eq("execution_attempt_id", executionAttemptId)
      .select("id")
      .maybeSingle();
    if (error) throw new Error("specialist_run_complete_failed");
    if (!data) throw new Error("specialist_execution_attempt_stale");
    await appendWorkbenchEvent(this.admin, {
      organizationId: this.root.organizationId,
      runId: childRunId,
      type: status === "completed" ? "run_completed" : "run_partial",
      payload: { status, hasAnswer: Boolean(result.summary), pendingProposals: 0 },
    });
    await appendWorkbenchEvent(this.admin, {
      organizationId: this.root.organizationId,
      runId: childRunId,
      type: "usage_reported",
      payload: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costCents: result.usage.costCents,
        // llm_calls stores a single aggregate for each specialist that ran Pi.
        calls: result.usage.modelTurns > 0 ? 1 : 0,
      },
    });
  }

  async failChild(
    childRunId: string,
    executionAttemptId: string,
    code: string,
    errorType: string,
  ): Promise<void> {
    const { data, error } = await this.admin
      .from("ai_workbench_runs")
      .update({
        status: "failed",
        error_code: code,
        error_summary: errorType,
        completed_at: new Date().toISOString(),
        execution_lease_expires_at: null,
      })
      .eq("organization_id", this.root.organizationId)
      .eq("id", childRunId)
      .eq("parent_run_id", this.root.parentRunId)
      .eq("status", "running")
      .eq("execution_attempt_id", executionAttemptId)
      .select("id")
      .maybeSingle();
    if (error) throw new Error("specialist_run_fail_failed");
    if (!data) throw new Error("specialist_execution_attempt_stale");
    await appendWorkbenchEvent(this.admin, {
      organizationId: this.root.organizationId,
      runId: childRunId,
      type: "run_failed",
      payload: { code, errorType },
    });
  }

  async cancelChild(childRunId: string, executionAttemptId: string): Promise<void> {
    const { data: cancelled, error } = await this.admin
      .from("ai_workbench_runs")
      .update({
        status: "cancelled",
        completed_at: new Date().toISOString(),
        execution_lease_expires_at: null,
      })
      .eq("organization_id", this.root.organizationId)
      .eq("id", childRunId)
      .eq("parent_run_id", this.root.parentRunId)
      .eq("status", "running")
      .eq("execution_attempt_id", executionAttemptId)
      .select("id")
      .maybeSingle();
    if (error) throw new Error("specialist_run_cancel_failed");
    if (cancelled)
      await appendWorkbenchEvent(this.admin, {
        organizationId: this.root.organizationId,
        runId: childRunId,
        type: "run_cancelled",
        payload: {},
      });
  }

  async cancelPendingChildren(): Promise<void> {
    const { data, error } = await this.admin
      .from("ai_workbench_runs")
      .update({
        status: "cancelled",
        completed_at: new Date().toISOString(),
        execution_lease_expires_at: null,
      })
      .eq("organization_id", this.root.organizationId)
      .eq("parent_run_id", this.root.parentRunId)
      .in("status", ["queued", "running"])
      .select("id");
    if (error) throw new Error("specialist_children_cancel_failed");
    await Promise.all(
      (data ?? []).map((child) =>
        appendWorkbenchEvent(this.admin, {
          organizationId: this.root.organizationId,
          runId: child.id,
          type: "run_cancelled",
          payload: {},
        }),
      ),
    );
  }

  appendParentEvent(type: string, payload: Record<string, unknown>): Promise<void> {
    return appendWorkbenchEvent(this.admin, {
      organizationId: this.root.organizationId,
      runId: this.root.parentRunId,
      type: type as Parameters<typeof appendWorkbenchEvent>[1]["type"],
      payload,
    }).then(() => undefined);
  }
}

function textOfMessage(message: Extract<RuntimeMessage, { role: "tool" }>): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function structuredValue(message: Extract<RuntimeMessage, { role: "tool" }>): unknown {
  if (message.details && typeof message.details === "object") return message.details;
  try {
    return JSON.parse(textOfMessage(message));
  } catch {
    return null;
  }
}

function failedToolObservation(message: Extract<RuntimeMessage, { role: "tool" }>): boolean {
  if (message.isError) return true;
  const value = structuredValue(message) as {
    permitido?: boolean; isError?: boolean; ok?: boolean; error?: unknown; erro?: unknown;
  } | null;
  return value?.permitido === false || value?.isError === true ||
    value?.ok === false || value?.error != null || value?.erro != null;
}

function toolEvidence(
  message: Extract<RuntimeMessage, { role: "tool" }>,
  specialistKey: string,
): KnowledgeEvidence[] {
  if (failedToolObservation(message)) return [];
  if (["crm_search_knowledge", "crm_get_org_memory"].includes(message.toolName)) {
    const evidence = normalizeKnowledgeEvidence(structuredValue(message));
    if (evidence.length || message.toolName === "crm_search_knowledge") return evidence;
  }
  const namespace = message.toolName.includes("conversation")
    ? "conversation_history"
    : message.toolName === "crm_get_org_memory"
      ? "organization_memory"
      : "crm_records";
  const kind =
    namespace === "conversation_history"
      ? "conversation"
      : namespace === "organization_memory"
        ? "organization_memory"
        : "crm_record";
  return [
    {
      id: `${specialistKey}:${message.toolCallId}`,
      namespace,
      kind,
      title: message.toolName,
      excerpt: textOfMessage(message).slice(0, 1200),
      locator: { provider: "crm_tool", sourceId: message.toolCallId },
      metadata: { toolName: message.toolName },
    },
  ];
}

const crmFieldRead = String.raw`(?:请\s*)?(?:只|仅)(?:需)?\s*(?:核对|核|确认|查询|查看)\s*`;
const noPolicy = String.raw`(?:无需|不需要|不用|不必)\s*(?:(?:查阅|查询|查|核对|检索)\s*)?(?:(?:公司|企业|组织)\s*)?(?:政策(?:或(?:企业|公司|组织)资料)?|(?:企业|公司|组织)资料)`;
const crmField = String.raw`(?:(?:这笔)?商机的?)?(?:当前的?)?(?:金额|阶段|标题|币种|状态|预计(?:关闭|关单)日期|联系人(?:的)?姓名)`;
const directCrmCheck = new RegExp(
  `^${crmFieldRead}${crmField}(?:\\s*(?:以及|和|及|与|[、,])\\s*${crmField})*` +
    `(?:\\s*[,;。\\n]\\s*${noPolicy})?\\s*[。.!]?$`,
  "i",
);
const crmScopeExclusion = new RegExp(
  `^${crmFieldRead}(?:这(?:两个|几项|些)\\s*)?CRM\\s*字段\\s*[,;]\\s*${noPolicy}$`,
  "i",
);
const crmFieldScope = /^(?:这是)?范围内的\s*CRM\s*核对\s*[;,]\s*(?:只需|仅需|只|仅)(?:回答|核对)指定(?:的)?字段$/i;
const crmFieldDeclaration = /^请(?:取得|获取)(?:实际)?依据并(?:回答|核对)\s*:\s*(.+)$/;
const crmFieldNames = /^(?:stage_id|value_cents|contact_name|lead_title|expected_close_date|currency|status)$/;
const crmReadPresentation = new Set([
  "只处理指定商机与关联客户",
  "备注留有旧销售快照",
  "若与当前结构化字段冲突,按权威的当前 CRM 字段填写",
  "核对这笔商机当前是否仍开放,并确认金额使用的币种",
  "旧备注留有预计关单日期和币种",
  "核对当前权威 CRM 的日期、币种和关联联系人,按当前结构化记录回答",
  "status 使用 CRM 原值,currency 使用币种原值",
  "expected_close_date 若为 null 就留空并引用实际商机;currency 及 contact_name 使用当前原值",
  "fields 逐键填写结果,缺失填 null",
  "sources 使用同一字段键,直接取证可引用实际商机、联系人或知识证据 UUID,来自专家记录的材料可引用该专家 Run UUID;对缺失的政策填 null",
  "sources 用同键引用本次成功观察的 CRM 对象、授权知识回执 UUID 或实际专家 Run UUID",
  "对缺失的政策填 null",
  "正常空政策项的引用填 null",
  "请在结构化 evidence 也给出对应引用",
  "结构化 evidence 同时列出真实引用",
  "不存在的日期、金额或政策不猜测",
  "不提案、不改变任何 CRM 对象、不外发",
  "不提案、不外发",
  "禁止提案、修改、通知或外发",
]);

function crmFieldList(declaration: string): boolean {
  let fields = "";
  let labelDepth = 0;
  for (const char of declaration) {
    if (char === "(") labelDepth += 1;
    else if (char === ")") {
      if (labelDepth === 0) return false;
      labelDepth -= 1;
    } else if (labelDepth === 0) fields += char;
  }
  return labelDepth === 0 && fields.split(/[、,]/).every(key => crmFieldNames.test(key.trim()));
}

function crmFieldsOnly(task: string): boolean {
  const normalized = task.normalize("NFKC").trim();
  if (directCrmCheck.test(normalized)) return true;
  // Keep the older structured field-list contract. Each surrounding clause
  // must be recognized as scope or presentation, regardless of policy keywords.
  let declaredScope = false;
  let selectedFields = false;
  for (const part of normalized.split(/[。!?\r\n]+/)) {
    const clause = part.trim();
    if (!clause || crmReadPresentation.has(clause)) continue;
    if (/^(?:\[[^\]\r\n]+\]\s*)?合成资料的只读销售核对$/.test(clause)) continue;
    if (/^(?:只处理指定)?商机 [\w{}-]+(?:,联系人 | 及关联联系人 )[\w{}-]+$/.test(clause)) continue;
    if (/^请把 submit_workbench_result\.summary 写成纯 JSON 对象(?:,恰有 fields 和 sources 两个对象)?$/.test(clause)) continue;
    const formatFields = /^submit_workbench_result\.summary 只交 JSON 对象,恰含 fields 和 sources,两个对象都使用这些键:(.+)$/.exec(clause)?.[1];
    if (formatFields !== undefined) {
      if (!formatFields.split(/[、,]/).every(key => crmFieldNames.test(key.trim()))) return false;
      continue;
    }
    if (crmFieldScope.test(clause)) {
      declaredScope = true;
      continue;
    }
    const declaration = crmFieldDeclaration.exec(clause)?.[1];
    if (declaration !== undefined) {
      if (/请|判断|政策|折扣|审批|授权|条款|承诺/.test(declaration) || !crmFieldList(declaration)) return false;
      selectedFields = true;
      continue;
    }
    if (crmScopeExclusion.test(clause)) {
      selectedFields = true;
      continue;
    }
    return false;
  }
  return declaredScope && selectedFields;
}

class PiWorkbenchSpecialistExecutor implements AgentSpecialistExecutor {
  constructor(
    private readonly admin: Admin,
    private readonly deps: TurnDeps,
    private readonly root: RootRunMetadata,
    private readonly agentConfig: PublishedAgentConfig,
    private readonly assertJobLease: () => Promise<void>,
  ) {}

  async execute(input: Parameters<AgentSpecialistExecutor["execute"]>[0]) {
    input.signal.throwIfAborted();
    const scopedPolicy = this.root.mode === "inspect" && input.task.specialist.key === "policy_advisor";
    const requirements = scopedPolicy ? policyRequirements(input.task.task) : [];
    if (scopedPolicy && requirements.length === 0 && crmFieldsOnly(input.task.task)) {
      return {
        status: "complete",
        summary: "本次只读任务明确仅核对所列 CRM 字段，政策取证不适用。",
        evidence: [], claims: [], missingMaterial: [], toolCalls: 0,
        usage: { inputTokens: 0, outputTokens: 0, costCents: null, modelTurns: 0 },
      } satisfies Omit<AgentSpecialistResult, "childRunId" | "specialistKey">;
    }
    // Specialists gather the minimum selected evidence; the parent retains
    // broader investigation tools. Never infer extra targets from task prose.
    const scopedTools = input.task.specialist.key === "customer_evidence"
      ? [
          ...(input.task.scope.contactId ? ["crm_get_contact"] : []),
          ...(input.task.scope.conversationId ? ["crm_get_conversation_history"] : []),
        ]
      : input.task.specialist.key === "opportunity_diagnosis"
        ? input.task.scope.leadId ? ["crm_get_lead"] : []
        : requirements.length ? ["crm_search_knowledge"] : input.task.specialist.allowedToolIds;
    const allowed = new Set(input.task.specialist.allowedToolIds.filter((id) => scopedTools.includes(id)));
    const childConfig: PublishedAgentConfig = {
      ...this.agentConfig,
      toolIds: this.agentConfig.toolIds.filter((toolId) => allowed.has(toolId)),
      pipelineIds: this.root.scope.pipelineId ? [this.root.scope.pipelineId] : [],
    };
    const mcp = await buildMcpTurnTools(
      this.deps.crmCfg,
      { organizationId: this.root.organizationId, jobId: input.childRunId },
      childConfig,
      this.deps.log,
      { readOnly: true, targetScope: {
        leadId: this.root.scope.leadId ?? undefined,
        contactId: this.root.scope.contactId ?? undefined,
        conversationId: this.root.scope.conversationId ?? undefined,
      } },
    );
    let toolCalls = 0;
    let toolErrors = 0;
    try {
      const scopeLines = Object.entries(this.root.scope)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
      const tools = Object.fromEntries(
        Object.entries(mcp?.tools ?? {}).filter(([name]) => allowed.has(name)),
      ) as ToolSet;
      const search = tools.crm_search_knowledge;
      if (requirements.length && search?.execute) {
        const execute = search.execute;
        tools.crm_search_knowledge = {
          ...search,
          execute: (args, options) => {
            const original = args as Record<string, unknown>;
            const query = policySearchQuestion(original?.pergunta, requirements);
            return execute(query === undefined ? args : { ...original, pergunta: query }, options);
          },
        };
      }
      const opportunity = input.task.specialist.key === "opportunity_diagnosis";
      const selectedRecords = opportunity || input.task.specialist.key === "customer_evidence";
      const name = "crm_get_lead";
      const leadId = input.task.scope.leadId;
      const leadTool = this.root.mode === "inspect" && opportunity && leadId && leadId === this.root.scope.leadId &&
        workbenchToolEffect(name)?.effect === "read" && tools[name]
        ? adaptAiTools({ [name]: tools[name] })[0]
        : undefined;
      const userMessage = {
        role: "user" as const,
        content: `${input.task.task}\n\n已校验 CRM 范围：\n${scopeLines || "未指定对象"}`,
      };
      let runtimeMessages: RuntimeMessage[] | undefined;
      const onEvent = async ({ type, data }: AgentRuntimeEvent) => {
        const tool = typeof data.tool_name === "string" ? data.tool_name : undefined;
        const toolCallId = typeof data.tool_call_id === "string" ? data.tool_call_id : undefined;
        if (type === "tool_execution_start" && tool)
          await appendWorkbenchEvent(this.admin, {
            organizationId: this.root.organizationId, runId: input.childRunId,
            type: "tool_started", payload: { tool, toolCallId },
          });
        else if (type === "tool_execution_end") {
          toolCalls += 1;
          if (data.is_error) toolErrors += 1;
          await appendWorkbenchEvent(this.admin, {
            organizationId: this.root.organizationId, runId: input.childRunId,
            type: "tool_completed", payload: { tool, toolCallId, status: data.is_error ? "error" : "success" },
          });
        } else if (type === "turn_end")
          await appendWorkbenchEvent(this.admin, {
            organizationId: this.root.organizationId, runId: input.childRunId,
            type: "model_decision", payload: { toolResultCount: toolCalls },
          });
      };
      if (leadTool) {
        // The selected opportunity read is part of the specialist's job. Use
        // the same MCP authorization and tool budget before the one model turn.
        delete tools[name];
        if (input.claimToolCall()) {
          await this.assertJobLease();
          await guardServiceEffect();
          input.signal.throwIfAborted();
          const toolCallId = randomUUID();
          const args = { lead_id: leadId };
          const data = { tool_name: name, tool_call_id: toolCallId };
          await onEvent({ type: "tool_execution_start", data });
          await this.assertJobLease();
          input.signal.throwIfAborted();
          let observation: Extract<RuntimeMessage, { role: "tool" }>;
          try {
            const result = await leadTool.execute(args, { toolCallId, signal: input.signal });
            observation = { ...result, role: "tool", toolName: name, toolCallId };
          } catch {
            observation = { role: "tool", toolName: name, toolCallId, isError: true, content: "读取指定商机失败。" };
          }
          await onEvent({ type: "tool_execution_end", data: { ...data, is_error: failedToolObservation(observation) } });
          input.signal.throwIfAborted();
          runtimeMessages = [
            userMessage,
            { role: "assistant", content: "", toolCalls: [{ id: toolCallId, name, arguments: args }] },
            observation,
            { role: "user", content: "根据工作台为你执行的商机读取结果，输出本角色的取证报告。" },
          ];
        }
        await this.assertJobLease();
      }
      const maxSteps = selectedRecords
        ? Math.min(input.plan.maxTurnsPerSpecialist, Object.keys(tools).length + 1)
        : input.plan.maxTurnsPerSpecialist;
      const modelResult = await executePiTurnModelCall(
        {
          pool: getRequestPool(),
          llmCfg: this.deps.llmCfg,
          log: this.deps.log,
          runtime: this.deps.runtime,
        },
        {
          tenantId: this.root.organizationId,
          jobId: this.root.rootJobId,
          workbenchRunId: input.childRunId,
          agentId: this.root.agentId,
          purpose: "agent_specialist",
          model: childConfig.model,
          llmOverride: {
            provider: childConfig.provider,
            credentialId: childConfig.credentialId,
          },
          system: [
            childConfig.systemPrompt,
            `你是${input.task.specialist.role}，是父 Agent 的只读 specialist。`,
            input.task.specialist.objective,
            ...(requirements.length ? [
              ...requirements.map(requirement =>
                `使用独立搜索词 ${JSON.stringify(requirement.query)} 核验对应资料。${requirement.allowEmpty
                  ? "授权搜索正常且没有匹配时，如实报告该项无匹配及其边界。"
                  : "该项需要授权原文依据，空结果是待解决缺口。"}`),
              "每个指定词独立搜索，分别报告观察和引用，不用另一项资料填补真实缺口。",
            ] : []),
            "父 Agent 的组织安全、权限与来源策略始终有效；通用销售工作清单不能扩大本次专职取证范围。父任务中的其他角色要求只是背景，不由你代做。",
            "只完成当前角色目标。职责中列举的主题不是本次必须逐项读取的清单；未分配给本角色的事实、未选择的会话、未来推进所需材料不能自动当作本次缺口。",
            ...(leadTool ? ["读取指定商机由工作台执行，只依据实际返回的观察报告事实。"] : [
              "只允许使用分配给你的只读工具。必须至少调用一个相关工具取得 observation 后再输出；每个相同范围的工具最多调用一次。",
            ]),
            "如果工具返回空结果，应把空结果作为事实并说明边界；如果没有可用工具或关键字段，应明确列为缺失材料。",
            "最终报告不超过 800 个中文字符；优先保留对象 ID、时间、金额、阶段、引用来源、缺失材料与冲突。",
            "只输出报告正文，不输出内部计划、写作指令或思维过程。不得声称执行了写入。",
          ].join("\n"),
          messages: [userMessage],
          ...(runtimeMessages ? { runtimeMessages } : {}),
          tools,
          maxSteps,
          finalTurn: {
            allowedToolNames: [],
            instruction: "本轮仅根据上文已有的成功工具观察输出你的只读报告正文，不再调用工具。保留真实缺口、拒绝和冲突；没有可用事实时明确说明，不编造或声称完成写入。",
          },
          abortSignal: input.signal,
          beforeToolCall: ({ name }) => {
            const effect = workbenchToolEffect(name);
            if (!allowed.has(name) || effect?.effect !== "read")
              return { block: true, terminate: true, reason: "specialist_read_only_boundary" };
            if (!input.claimToolCall())
              return {
                block: true,
                terminate: true,
                reason: "collaboration_tool_budget_exhausted",
              };
            return undefined;
          },
          shouldStopAfterTurn: ({ cumulativeUsage }) => {
            const allocated =
              typeof this.root.budget.tokenBudget === "number"
                ? Math.max(
                    512,
                    Math.floor(
                      (this.root.budget.tokenBudget * input.plan.modelBudgetShare) /
                        input.plan.specialists.length,
                    ),
                  )
                : null;
            return allocated !== null && cumulativeUsage.totalTokens >= allocated;
          },
          onEvent,
        },
      );
      const messages = modelResult.result.runtimeMessages as RuntimeMessage[];
      const toolMessages = messages.filter(
        (message): message is Extract<RuntimeMessage, { role: "tool" }> => message.role === "tool",
      );
      const observedLead = (message: Extract<RuntimeMessage, { role: "tool" }>) =>
        message.toolName === name && !failedToolObservation(message) &&
        (structuredValue(message) as { lead?: { id?: unknown } } | null)?.lead?.id === leadId;
      const evidenceMessages = leadTool ? toolMessages.filter(observedLead) : toolMessages;
      const evidence = evidenceMessages.flatMap((message) =>
        toolEvidence(message, input.task.specialist.key),
      );
      const claims = evidenceMessages.filter((message) => !failedToolObservation(message)).flatMap((message) =>
        extractToolClaims({
          message,
          specialistKey: input.task.specialist.key,
          scope: input.task.scope,
        }),
      );
      const policy = policyObservationStatus({
        requirements,
        observations: toolMessages.filter(message => message.toolName === "crm_search_knowledge").map(message => ({
          failed: failedToolObservation(message), value: structuredValue(message),
        })),
        allowedSourceIds: childConfig.knowledgeSourceIds,
      });
      const missingMaterial = [
        ...(toolErrors || toolMessages.some(failedToolObservation)
          ? ["failed_tool_observations"] : []),
        ...(policy.state === "unavailable" ? ["published_knowledge_sources"] : []),
        ...(policy.state === "missing" ? ["required_policy_evidence"] : []),
        ...(toolCalls === 0 ? ["tool_observations"] : []),
        ...(leadTool && evidenceMessages.length === 0 ? ["selected_lead_evidence"] : []),
      ];
      const extractedAnswer = extractProductFinalAnswer(modelResult.result.text);
      if (!extractedAnswer.text.trim()) missingMaterial.push("specialist_summary");
      if (extractedAnswer.inspection.internalDraftCodes.length > 0 && !extractedAnswer.sanitized)
        missingMaterial.push("safe_specialist_summary");
      if (extractedAnswer.inspection.likelyTruncated)
        missingMaterial.push("complete_specialist_summary");
      const status = toolErrors > 0 || missingMaterial.length > 0 ? "partial" : "complete";
      let summary = extractedAnswer.text;
      if (status === "complete" && policy.verifiedEmpty.length) {
        summary = requirements.length === 1
          ? "已在授权资料核验指定词，正常检索无匹配，按任务要求将政策项及该项引用留空。"
          : `${summary}\n授权资料正常检索无匹配：${policy.verifiedEmpty.join("、")}。建议按任务边界说明缺口，勿为该项引用不存在的政策。`;
      }
      const { error: stateError } = await this.admin.from("ai_agent_run_states").upsert(
        {
          organization_id: this.root.organizationId,
          run_id: input.childRunId,
          messages: messages as never,
          observations: specialistObservationEnvelope(evidence, claims) as never,
        },
        { onConflict: "run_id" },
      );
      if (stateError) throw new Error("specialist_state_persist_failed");
      return {
        status,
        summary,
        evidence,
        claims,
        missingMaterial: [...new Set(missingMaterial)],
        toolCalls,
        usage: {
          inputTokens: modelResult.usage.inputTokens,
          outputTokens: modelResult.usage.outputTokens,
          costCents: modelResult.costCents,
          modelTurns: modelResult.events.filter((event) => event.type === "turn_end").length,
        },
      } satisfies Omit<AgentSpecialistResult, "childRunId" | "specialistKey">;
    } finally {
      await mcp?.cleanup();
    }
  }
}

export async function runWorkbenchCollaboration(input: {
  admin: Admin;
  deps: TurnDeps;
  plan: AgentCollaborationPlan;
  root: RootRunMetadata;
  agentConfig: PublishedAgentConfig;
  signal: AbortSignal;
  assertJobLease: () => Promise<void>;
}): Promise<AgentCollaborationOutcome> {
  const tasks = input.plan.specialists.map<AgentSpecialistTask>((specialist) => ({
    parentRunId: input.root.parentRunId,
    organizationId: input.root.organizationId,
    task: input.root.task,
    specialist,
    scope: {
      ...(input.root.scope.contactId ? { contactId: input.root.scope.contactId } : {}),
      ...(input.root.scope.leadId ? { leadId: input.root.scope.leadId } : {}),
      ...(input.root.scope.conversationId
        ? { conversationId: input.root.scope.conversationId }
        : {}),
      ...(input.root.scope.pipelineId ? { pipelineId: input.root.scope.pipelineId } : {}),
    },
  }));
  const runtime = new BoundedAgentCollaborationRuntime(
    new SupabaseCollaborationStore(input.admin, input.root),
    new PiWorkbenchSpecialistExecutor(input.admin, input.deps, input.root, input.agentConfig, input.assertJobLease),
  );
  const outcome = await runtime.runReadOnlySpecialists(input.plan, tasks, input.signal);
  return finishInitialCollaborationReview(getRequestPool(), input.root.organizationId,
    input.root.parentRunId, input.root.scope, outcome, input.root.agentId);
}
