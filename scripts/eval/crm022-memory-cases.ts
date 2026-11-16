export type Category = "preference" | "confirmed_fact" | "communication_context";
export type Arm = "none" | "sql10" | "mem0_10";

type FactInput = {
  key: string;
  category: Category;
  body: string;
};

type Mutation =
  | { kind: "revise"; key: string; currentBody: string }
  | { kind: "delete"; key: string };

export type Field = {
  key: string;
  description: string;
  expected: string | null;
  factKey: string | null;
  forbidden: string[];
};

export type MemoryContact = {
  key: string;
  facts: FactInput[]; // Oldest first. The runner assigns distinct, fixed timestamps.
  mutation?: Mutation;
};

export type MemoryTask = {
  id: string;
  contact: string;
  category: "simple" | "selection_old" | "selection_recent" | "limit50" | "revision" | "deletion";
  fields: Field[];
};

const fact = (key: string, category: Category, body: string): FactInput => ({ key, category, body });
const confirmed = (key: string, body: string) => fact(key, "confirmed_fact", body);
const preference = (key: string, body: string) => fact(key, "preference", body);
const communication = (key: string, body: string) => fact(key, "communication_context", body);
const field = (key: string, description: string, expected: string | null, factKey: string | null, forbidden: string[] = []): Field =>
  ({ key, description, expected, factKey, forbidden });

const selectionDecoys = [
  "样机入库区为桦木架。", "会议投影使用横屏。", "回执归档标签为银杏。", "备用演示卡颜色为紫色。",
  "安装说明放在玻璃柜。", "工作坊桌牌使用大号字。", "项目归档编号为霜桥二号。", "展示包命名使用短横线。",
  "样机巡检使用软布。", "需求记录模板版本是青石。", "报价草稿使用垂直排版。", "状态看板标题为云帆。",
  "访客登记标记为灰色。", "退件放到北侧收集台。", "演示账号备注为石榴。", "项目附件分类为参考。",
];

const boundarySubjects = [
  ["样品包封条", "样品包挂签", "样品包插页", "样品包标签", "样品包图标", "样品包尺寸码", "样品包附件"],
  ["会议室桌牌", "会议室席签", "会议室展板", "会议室时钟", "会议室白板", "会议室遥控器", "会议室备用线"],
  ["工作坊笔记", "工作坊签到条", "工作坊卡片", "工作坊计时器", "工作坊贴纸", "工作坊纸模", "工作坊夹板"],
  ["收货区指示牌", "收货区封套", "收货区置物格", "收货区备用袋", "收货区工位标记", "收货区插卡", "收货区清单"],
  ["资产表页头", "资产表状态栏", "资产表备注栏", "资产表灰度标记", "资产表归档目录", "资产表版本贴", "资产表角标"],
  ["产品样册索引", "产品样册封面", "产品样册边条", "产品样册腰封", "产品样册页脚", "产品样册标签", "产品样册装订号"],
  ["提交记录抬头", "提交记录命名码", "提交记录页码", "提交记录分类", "提交记录归档号", "提交记录附件夹", "提交记录备用夹"],
].flat();

export const memoryContacts: MemoryContact[] = [
  {
    key: "calibration",
    facts: [confirmed("sample", "样品登记编号为 CAL-小松-06。"), preference("cal-pref", "偏好的工作坊讲解形式是插图手册。")],
  },
  {
    key: "simple",
    facts: [confirmed("onboarding", "实施对接人代号为松溪-D7。"), confirmed("format", "首批导入文件格式为 TSV。"),
      communication("silence", "周末的内部留言暂不处理。")],
  },
  {
    key: "selection",
    facts: [communication("older", "客户偏好的后续沟通方式为站内留言，避开短信。确认的沟通窗口为周三 16:40。"),
      ...selectionDecoys.map((body, i) => confirmed(`decoy-${i + 1}`, body)),
      preference("recent", "客户确认的材料交付偏好为双面 PDF，便于后续沟通。")],
  },
  {
    key: "boundary",
    facts: [communication("rank51", "客户已确认第一次沟通需要使用语音会议代号 松岬-B51。"),
      preference("rank50", "客户已确认第二次沟通需要使用白板会议代号 桂石-B50。"),
      ...boundarySubjects.map((subject, i) => confirmed(`decoy-${i + 1}`, `${subject}的内部标记为 HN-${String(i + 1).padStart(2, "0")}。`))],
  },
  {
    key: "revision",
    facts: [confirmed("revision", "客户确认的试用环境实例代号为赤榆-R17。"),
      preference("rev-style", "偏好的改版材料顺序是先流程图、后表格。"),
      confirmed("rev-room", "内部核对室的登记色为浅灰。")],
    mutation: { kind: "revise", key: "revision", currentBody: "客户当前确认的试用环境实例代号为青砾-R29。" },
  },
  {
    key: "deleted",
    facts: [preference("deleted", "客户确认的后续材料转交代号为旧芦-D08。"),
      confirmed("active", "试用交接单的当前登记号为木棉-D36。"),
      communication("deleted-context", "只在内部工作台记录项目进度。")],
    mutation: { kind: "delete", key: "deleted" },
  },
];

export const calibrationTasks: MemoryTask[] = [
  { id: "CAL-M01", contact: "calibration", category: "simple", fields: [field("登记编号", "样品登记编号", "CAL-小松-06", "sample")] },
];

export const formalTasks: MemoryTask[] = [
  { id: "M01", contact: "simple", category: "simple", fields: [
    field("对接人代号", "实施对接人代号", "松溪-D7", "onboarding"),
    field("导入格式", "首批导入文件格式", "TSV", "format"),
  ] },
  { id: "M02", contact: "selection", category: "selection_old", fields: [
    field("沟通方式", "客户偏好的后续沟通方式，只写渠道名称", "站内留言", "older"),
    field("沟通窗口", "确认的下次沟通窗口，保留周几和时间", "周三 16:40", "older"),
  ] },
  { id: "M03", contact: "selection", category: "selection_recent", fields: [
    field("材料交付偏好", "客户最新确认的材料交付偏好", "双面 PDF", "recent"),
  ] },
  { id: "M04", contact: "boundary", category: "limit50", fields: [
    field("第二次会议代号", "第二次沟通的白板会议代号", "桂石-B50", "rank50"),
    field("第一次会议代号", "第一次沟通的语音会议代号", null, null, ["松岬-B51"]),
  ] },
  { id: "M05", contact: "revision", category: "revision", fields: [
    field("试用实例代号", "当前确认的试用环境实例代号", "青砾-R29", "revision", ["赤榆-R17"]),
  ] },
  { id: "M06", contact: "deleted", category: "deletion", fields: [
    field("材料转交代号", "目前仍确认有效的后续材料转交代号", null, null, ["旧芦-D08"]),
    field("交接单登记号", "试用交接单的当前登记号", "木棉-D36", "active"),
  ] },
];

const arms: Arm[] = ["none", "sql10", "mem0_10"];

export function orderedArms(taskIndex: number): Arm[] {
  // Cyclic order balances each arm at each position across the six formal tasks.
  return arms.map((_, offset) => arms[(taskIndex + offset) % arms.length]!);
}
