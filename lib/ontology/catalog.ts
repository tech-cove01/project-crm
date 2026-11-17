// Adapted from Ontology Lite's catalog, contract, and snapshot approach.
// Copyright (c) 2026 Rafael Melgaço. MIT, see the repository LICENSE.
import { createHash } from "node:crypto";
import {
  COMPLETED_APPOINTMENT_TYPE,
  ONTOLOGY_MAX_ROWS,
  ONTOLOGY_MAX_WINDOW_DAYS,
  OPEN_LEAD_STATUS,
  type OntologyTemplate,
} from "./contract";

export type { OntologyTemplate } from "./contract";

const V1 = "1.0.0";
const V1_DIGEST = "5102aecfbd6ac810320cf12bd648db9e78b82d37238df0247851acd199fdbb9f";
export type OntologyDefinitionId = OntologyTemplate | "high_potential" | "effective_follow_up";
export type OntologyDefinitionStatus = "reviewed" | "disabled" | "undefined";
export type OntologyCatalogReference = { version: string; digest: string };

type NamedConcept = { id: string; label: string; aliases: readonly string[] };
type Entity = NamedConcept & { table: string; fields: readonly string[] };
type Relation = NamedConcept & { from: string; to: string; fields: readonly string[]; rule: string };
type Definition = NamedConcept & {
  id: OntologyDefinitionId;
  version: string;
  status: OntologyDefinitionStatus;
  rule: string;
  fields: readonly string[];
  dependencies: readonly OntologyDefinitionId[];
  template: OntologyTemplate | null;
  questions: readonly string[];
  missing: readonly string[];
  source: string;
};
export type OntologyDefinitionReference = Pick<Definition, "id" | "label" | "version" | "status" | "rule"> & {
  digest: string;
  fields: string[];
};
export type OntologyConcept = Pick<NamedConcept, "id" | "label"> & { kind: "entity" | "relation" | "definition" };

type Catalog = {
  version: string;
  entities: readonly Entity[];
  relations: readonly Relation[];
  definitions: readonly Definition[];
  limits: { rows: number; windowDays: number };
};
export type OntologyCatalog = Readonly<Catalog> & { reference: OntologyCatalogReference };

const source = "supabase/baseline.sql";
const openLeadFields = [
  "crm_leads.id", "crm_leads.organization_id", "crm_leads.status", "crm_leads.pipeline_id", "crm_leads.stage_id",
  "crm_pipelines.is_archived",
];
const completedAppointmentFields = [
  "crm_leads.id", "crm_leads.organization_id", "crm_lead_activities.id", "crm_lead_activities.organization_id",
  "crm_lead_activities.lead_id", "crm_lead_activities.type", "crm_lead_activities.performed_at",
];

const catalogV1: Catalog = {
  version: V1,
  limits: { rows: ONTOLOGY_MAX_ROWS, windowDays: ONTOLOGY_MAX_WINDOW_DAYS },
  entities: [
    { id: "opportunity", label: "商机", aliases: ["商机", "opportunity", "opportunities", "oportunidade", "oportunidades"],
      table: "crm_leads", fields: ["id", "organization_id", "status", "contact_id", "pipeline_id", "stage_id"] },
    { id: "activity", label: "商机活动", aliases: ["活动", "约见", "会面", "appointment", "appointments", "atividade"],
      table: "crm_lead_activities", fields: ["id", "organization_id", "lead_id", "type", "performed_at"] },
  ],
  relations: [
    { id: "activity_opportunity", label: "商机与活动", aliases: ["商机活动", "已完成约见", "completed appointments"],
      from: "activity", to: "opportunity", fields: ["crm_lead_activities.lead_id", "crm_leads.id"],
      rule: "同组织的活动通过 lead_id 归属一笔商机。活动归属不授予对象读权限。" },
  ],
  definitions: [
    {
      id: "open_leads", label: "开放商机", version: V1, status: "reviewed", template: "open_leads",
      aliases: ["开放商机", "开放的商机", "未关闭商机", "尚未关闭的商机", "进行中的商机", "open leads", "open opportunities", "oportunidades abertas"],
      rule: `授权且未归档的销售管道内，crm_leads.status = '${OPEN_LEAD_STATUS}' 的商机。状态表示当前记录，不能用它推断历史状态。`,
      fields: openLeadFields, dependencies: [], missing: [], source,
      questions: ["商机哪些是开放的", "哪些商机仍然开放", "哪些商机处于开放状态", "哪些商机处于进行中", "哪些是开放商机",
        "有哪些开放商机", "哪些商机是开放的", "有哪些未关闭的商机",
        "有哪些商机还没关闭", "商机哪些还没关闭", "which opportunities are open", "which leads are open",
        "quais oportunidades estão abertas", "liste as oportunidades abertas"],
    },
    {
      id: "completed_appointments", label: "已完成约见", version: V1, status: "reviewed", template: "completed_appointments",
      aliases: ["已完成约见", "已完成的约见", "已完成会面", "已完成的会面", "已经完成的约见", "完成了的约见", "completed appointments"],
      rule: `所选商机的活动 type = '${COMPLETED_APPOINTMENT_TYPE}'，按 performed_at 查询含起点、不含终点的 UTC 窗口。排期、取消和未到场均不计。`,
      fields: completedAppointmentFields, dependencies: [], missing: [], source: "lib/leads/activity-vocabulary.ts",
      questions: ["哪些约见已经完成", "哪些约见已完成", "有无已完成约见记录", "是否有已完成约见记录",
        "有没有已完成约见记录", "which appointments were completed"],
    },
    {
      id: "open_leads_without_completed_appointments", label: "无已完成约见记录的开放商机",
      version: V1, status: "reviewed", template: "open_leads_without_completed_appointments",
      aliases: ["无已完成约见记录的开放商机", "没有已完成约见记录的开放商机", "缺少已完成约见记录的开放商机",
        "open opportunities without completed appointment records"],
      rule: "授权范围内的开放商机，其中在给定 UTC 窗口内查不到已完成约见活动。这只说明当前 CRM 无记录。",
      fields: [...openLeadFields, ...completedAppointmentFields.filter(field => !openLeadFields.includes(field))],
      dependencies: ["open_leads", "completed_appointments"], missing: [], source,
      questions: ["没有已完成约见的开放商机", "无已完成约见的开放商机", "没有约见完成记录的开放商机",
        "哪些开放商机没有已完成约见记录", "哪些开放商机在 CRM 没有已完成约见记录"],
    },
    {
      id: "high_potential", label: "高潜商机", version: V1, status: "undefined", template: null,
      aliases: ["高潜", "高潜商机", "高潜力", "潜力较高", "high potential", "high-potential", "alto potencial"],
      rule: "尚未审核高潜商机的业务定义。", fields: [], dependencies: [], source: "docs/STATUS.md", questions: [],
      missing: ["请明确高潜判定依据，包括使用的信号、阈值和覆盖范围。"],
    },
    {
      id: "effective_follow_up", label: "有效跟进", version: V1, status: "undefined", template: null,
      aliases: ["有效跟进", "跟进不足", "缺乏跟进", "跟进不够", "跟进不到位", "跟进滞后", "未跟进", "没有跟进", "valid follow-up", "effective follow-up", "insufficient follow-up"],
      rule: "尚未审核有效跟进的判定规则。约见记录缺失无法证明没有跟进。", fields: [], dependencies: [],
      source: "docs/STATUS.md", questions: [],
      missing: ["请明确有效跟进的渠道、方向、送达或回应要求、执行角色和判断时间窗。"],
    },
  ],
};

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJSON(value)).digest("hex");
}

export function definitionReference(definition: Definition): OntologyDefinitionReference {
  const { id, label, version, status, rule, fields } = definition;
  return { id, label, version, status, rule, digest: digest(definition), fields: [...fields] };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function publishedSnapshot(catalog: Catalog, expectedDigest: string): OntologyCatalog {
  const actualDigest = digest(catalog);
  if (actualDigest !== expectedDigest) throw new Error("ontology_catalog_snapshot_mismatch");
  return freeze({ ...catalog, reference: { version: catalog.version, digest: actualDigest } });
}

// Keep each published entry when the active definition set changes.
const publishedCatalogs = new Map<string, OntologyCatalog>([[V1, publishedSnapshot(catalogV1, V1_DIGEST)]]);

export function getOntologyCatalog(version: string = V1): OntologyCatalog {
  const catalog = publishedCatalogs.get(version);
  if (!catalog) throw new Error("ontology_catalog_version_not_found");
  return catalog;
}

export function resolveOntologyCatalog(reference: OntologyCatalogReference): OntologyCatalog {
  const catalog = getOntologyCatalog(reference.version);
  if (catalog.reference.digest !== reference.digest) throw new Error("ontology_catalog_digest_mismatch");
  return catalog;
}
