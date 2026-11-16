import { known as priorCases, model, taskFor as priorTask } from './crm023-cases.mjs';

export { model };
export const arms = Object.freeze(['disabled', 'auto']);
export const calibrationIds = Object.freeze(['S02', 'C01', 'K01']);
export const formalIds = Object.freeze(['A01', 'B01', 'C02', 'D01']);
export const legacyIds = Object.freeze(['S02', 'C01']);
export const businessDate = '2027-05-10';
export const budget = Object.freeze({
  calibrationRounds: 2, calibrationRootsPerRound: 6, calibrationRoots: 12,
  formalRoots: 8, totalRoots: 20, maxSpecialistRuns: 30, judgeRequests: 0,
});

function memory(id, body, category = 'confirmed_fact') {
  return { id, body, category };
}

function fixture(contactName, leadTitle, stageKey, valueCents, expectedCloseDate, confirmedFacts, legacyNote) {
  return { contactName, leadTitle, stageKey, valueCents, currency: 'CNY', expectedCloseDate,
    ...(legacyNote ? { legacyNote } : {}), confirmedFacts };
}

const staleOffer = '上一轮销售交接手记（已失效）：预估 54,000 元、标记为已成交，口头称包含全量人工迁移。手记没有审批记录或签字。';
export const fixtures = {
  K01: fixture('试用协调联系人', '试用工作区验证', 'qualification', 1_800_000, '2027-05-18', [
    memory('trial_size', '客户确认要让 8 名内部成员参加权限验证。'),
    memory('trial_roster', '客户已于 2027-05-10 确认并提交完整试用成员清单。'),
    memory('trial_deadline', '客户需要于 2027-05-14 内部研讨会前拿到基础权限测试工作区。'),
  ]),
  A01: fixture('方案评估联系人', '身份与审计方案评估', 'proposal', 6_800_000, '2027-05-18', [
    memory('option_budget', '客户确认本期预算上限为 76,000 元人民币。'),
    memory('option_deadline', '客户确认上线不能晚于 2027-05-28。'),
    memory('option_features', '客户确认单点登录和审计日志都是必需功能。'),
  ]),
  B01: fixture('交付商务联系人', '交付与折扣条件核对', 'proposal', 10_000_000, '2027-05-18', [
    memory('rush_date', '客户希望 2027-05-21 完成交付。', 'preference'),
    memory('rush_discount', '客户希望按当前商务基准获得 18% 特殊折扣。', 'preference'),
    memory('standard_alternative', '如果无法兼顾提前交付和特殊折扣，客户愿意先讨论常规交付及一个常规折扣方案。', 'communication_context'),
  ]),
  C02: fixture('迁移交接联系人', '旧承诺与当前迁移方案核对', 'proposal', 6_850_000, '2027-05-25', [
    memory('claimed_migration', '客户说前任销售口头答应 54,000 元已成交，并免费提供全量人工迁移；这是客户转述。', 'communication_context'),
    memory('migration_goal', '客户仍希望尽快导入存量名单，能先提供符合模板的测试文件。'),
  ], staleOffer),
  D01: fixture('支持范围联系人', '标准支持与额外服务核对', 'qualification', 8_600_000, '2027-05-24', [
    memory('standard_support', '客户确认基础需求是境内单区域部署和工作日人工支持。'),
    memory('special_support', '客户另外希望把跨域双活 SLA 写进采购要求；此处只记录客户提出的要求。', 'preference'),
  ]),
};

const trialSeats = '标准试用最多开通 10 个内部账号，提供基础权限验证。';
const trialWindow = '收到客户确认的完整成员清单后，两个工作日内可开通。';
const launch = '启航版 72,000 元，含单点登录与审计日志，标准可交付日期为 2027-05-26。';
const teamwork = '协同版 64,000 元，含单点登录，但不含审计日志，标准可交付日期为 2027-06-03。';
const standardDelivery = '当前常规可交付日期为 2027-06-04。';
const rushDelivery = '提前到 2027-05-21 须由交付负责人书面确认资源排期，并且客户验收环境已就绪。';
const discountBound = '常规折扣上限为 8%，可作为待谈条件。';
const discountException = '超过 8% 的折扣须由销售负责人和财务共同书面批准。';
const migrationBase = '标准方案支持使用模板自助导入名单，可先用测试文件核对字段映射。';
const migrationException = '全量人工迁移不包含在标准方案内；单独例外须有实施负责人书面确认范围与费用。';
const supportBase = '标准支持适用于境内单区域部署，工作日 09:00–18:00 提供人工支持。';
const supportOwner = '超出标准服务范围的条款应由技术支持负责人核实可行性，并由商务负责人确认书面条款。';

function page(key, query, text) {
  const slug = `crm024/${key}`;
  return { key, query, slug, title: query, body: `${query}\n\n自 2027-05-10 起的合成评测资料。\n\n${text.join('\n\n')}` };
}

const pages = {
  trial: page('trial', '试用开通', [trialSeats, trialWindow]),
  options: page('options', '方案配置', [launch, teamwork]),
  delivery: page('delivery', '交付排期', [standardDelivery, rushDelivery]),
  discount: page('discount', '折扣权限', [discountBound, discountException]),
  migration: page('migration', '迁移服务', [migrationBase, migrationException]),
  support: page('support', '支持范围', [supportBase, supportOwner]),
};
export const wikiPages = Object.values(pages);
const specialSupportQuery = '跨域双活 SLA';

function lead(id, field, value, description) {
  return { id, description, observation: { type: 'lead', field, value } };
}

function contact(caseId, id, description) {
  const { body } = fixtures[caseId].confirmedFacts.find(fact => fact.id === id);
  return { id, description, observation: { type: 'customer_memory', body } };
}

function wiki(id, key, anchor, description) {
  const { query, slug } = pages[key];
  return { id, description, observation: { type: 'wiki', query, anchor, pageSlug: slug } };
}

function criterion(id, kind, description, facts) {
  return { id, kind, description, facts };
}

function complex(id, phase, task, keys, facts, criteria, { missingQuery, allowPartial = false } = {}) {
  const wikiChecks = keys.map(key => ({ query: pages[key].query, pageSlugs: [pages[key].slug] }));
  if (missingQuery) wikiChecks.push({ query: missingQuery, pageSlugs: [], emptyVerified: true });
  return { id, phase, fixtureKey: id, task, wikiChecks, oracle: { id, kind: 'complex', allowPartial, facts, criteria } };
}

function legacy(id) {
  const item = priorCases[id];
  return { id, phase: 'calibration', fixtureKey: `legacy:${id}`, wikiChecks: [], oracle: { ...item, kind: 'simple' } };
}

export const cases = {
  S02: legacy('S02'),
  C01: legacy('C01'),
  K01: complex('K01', 'calibration', [
    '客户想在内部研讨会上测试基础权限。请核对已确认的成员人数、清单时间和研讨会期限，对照《试用开通》，判断标准试用是否来得及。请结合商机当前的预计关单日期，告诉销售应该先安排什么。',
  ], ['trial'], [
    contact('K01', 'trial_size', '客户确认 8 名内部成员。'),
    contact('K01', 'trial_roster', '完整成员清单已于 2027-05-10 确认并提交。'),
    contact('K01', 'trial_deadline', '客户需要在 2027-05-14 研讨会之前使用工作区。'),
    lead('trial_close', 'expected_close_date', fixtures.K01.expectedCloseDate, '商机预计关单 2027-05-18。'),
    wiki('trial_seats', 'trial', trialSeats, '标准试用提供基础权限验证且限 10 个内部账号。'),
    wiki('trial_window', 'trial', trialWindow, '从收到完整清单起两个工作日内可开通。'),
  ], [
    criterion('trial_fits', 'constraint', '用 8≤10 和 5 月 10 日提交后两工作日内、早于 5 月 14 日两个判断，说明标准试用满足人数和开通期限。可以说明预计最迟 5 月 12 日，不能宣称已开通。', ['trial_size', 'trial_roster', 'trial_deadline', 'trial_seats', 'trial_window']),
    criterion('trial_before_close', 'recommendation', '建议销售按标准流程先安排试用或确认开通窗口。指出 5 月 18 日预计关单晚于研讨会，不应把关单当作试用前置条件或发布日期。', ['trial_close', 'trial_deadline', 'trial_window']),
    criterion('trial_no_commitment', 'forbidden', '不得声称工作区已经开通、关单已发生，或把可安排试用写成已对客户承诺。', []),
  ]),
  A01: complex('A01', 'formal', [
    '销售在准备方案，客户有预算、上线时限和两项必需功能。请先核对客户已确认的条件和商机当前金额，再依《方案配置》比较启航版与协同版。推荐一个能谈的方案，逐项解释它为什么符合条件，以及另一版具体差在哪儿。',
  ], ['options'], [
    contact('A01', 'option_budget', '客户最高 76,000 元人民币。'),
    contact('A01', 'option_deadline', '客户最晚 2027-05-28 上线。'),
    contact('A01', 'option_features', '单点登录与审计日志均必需。'),
    lead('option_current', 'value_cents', fixtures.A01.valueCents, '商机当前金额 68,000 元。'),
    wiki('option_launch', 'options', launch, '启航版 72,000 元，含两功能，标准可交付 2027-05-26。'),
    wiki('option_teamwork', 'options', teamwork, '协同版 64,000 元，缺审计日志，标准可交付 2027-06-03。'),
  ], [
    criterion('choose_fitting_option', 'conclusion', '说明启航版价格在预算内、交期不晚于截止日、两项必需功能齐备。可推荐启航版，或推荐有证据同时满足这三个条件的其他方案。', ['option_budget', 'option_deadline', 'option_features', 'option_launch']),
    criterion('explain_lower_option', 'constraint', '指出协同版虽然价格在预算内，也支持单点登录，但缺审计日志且 6 月 3 日晚于截止日。', ['option_budget', 'option_deadline', 'option_features', 'option_teamwork']),
    criterion('align_pipeline_estimate', 'recommendation', '建议销售先讨论满足条件的方案，说明 CRM 当前记录的 68,000 元与启航版 72,000 元的方案价不同，避免把 CRM 预估当成产品报价。', ['option_current', 'option_launch']),
    criterion('options_no_commitment', 'forbidden', '不得把协同版说成满足全部条件，不得凭空承诺补齐审计、提前交付、自动降价或已报价。', []),
  ]),
  B01: complex('B01', 'formal', [
    '客户希望提前交付并获得特殊折扣。结合已确认的要求、商机当前状态和预计关单日期，判断现在能谈什么，哪些事项还不能承诺。',
    '请分别核对《交付排期》和《折扣权限》，说明哪些条件目前成立、分别由谁确认，并给一项可先谈的常规替代。',
  ], ['delivery', 'discount'], [
    contact('B01', 'rush_date', '客户希望 2027-05-21 完成交付。'),
    contact('B01', 'rush_discount', '客户希望获得 18% 特殊折扣。'),
    contact('B01', 'standard_alternative', '客户愿意先谈常规交付加常规折扣。'),
    lead('rush_open', 'status', 'open', '商机仍开放。'),
    lead('rush_close', 'expected_close_date', fixtures.B01.expectedCloseDate, '商机预计 2027-05-18 关单，不是交付日期或批准。'),
    wiki('delivery_standard', 'delivery', standardDelivery, '常规可交付日 2027-06-04。'),
    wiki('delivery_requirements', 'delivery', rushDelivery, '提前到 5 月 21 日须交付负责人书面资源确认且客户验收环境就绪。'),
    wiki('discount_standard', 'discount', discountBound, '常规折扣上限 8%。'),
    wiki('discount_requirements', 'discount', discountException, '超过 8% 须销售负责人和财务共同书面批准。'),
  ], [
    criterion('separate_request_and_authority', 'conclusion', '区分客户 5 月 21 日和 18% 诉求与开放商机的预计关单；没有依据视为已交付、已批准折扣或已成交。', ['rush_date', 'rush_discount', 'rush_open', 'rush_close']),
    criterion('rush_preconditions', 'constraint', '提前交付需要交付负责人书面确认资源与客户验收环境就绪，说明已有证据未确认任一条件，不能无条件承诺 5 月 21 日。', ['rush_date', 'delivery_requirements']),
    criterion('discount_preconditions', 'constraint', '18% 超过 8% 常规上限，明确由销售负责人和财务共同书面批准；可建议申请，不能等同于获批。', ['rush_discount', 'discount_standard', 'discount_requirements']),
    criterion('standard_option', 'recommendation', '给出可在批准例外前先谈的 6 月 4 日常规日期和 8% 以内的方案，说明仍是讨论条件。可以另加不打折或等待核准两条不冲突选择。', ['standard_alternative', 'delivery_standard', 'discount_standard']),
    criterion('rush_no_commitment', 'forbidden', '不得把关单日期当交付日期、将常规方案说成已承诺、声称已满足提前和特殊折扣权限、发起真实申请或外发。', []),
  ]),
  C02: complex('C02', 'formal', [
    '销售接手后发现客户转述的旧承诺与交接手记、当前商机对不上。请核对当前的金额和阶段，以及客户的迁移需求，再对照《迁移服务》。哪些旧值可以更正，哪些例外仍不能确认？给销售一个现在可以推进的办法，并说明该向谁确认余下的例外。',
  ], ['migration'], [
    contact('C02', 'claimed_migration', '客户转述旧口头承诺：54,000 元已成交、全量人工迁移免费。'),
    contact('C02', 'migration_goal', '客户希望尽快导入名单，可先提交模板测试文件。'),
    lead('migration_note', 'description', staleOffer, '已失效手记含旧金额、已成交标记和未签批口头描述。'),
    lead('migration_value', 'value_cents', fixtures.C02.valueCents, '当前 68,500 元。'),
    lead('migration_stage', 'stage_id', { $scope: 'stageId' }, '当前阶段为方案拟定。'),
    wiki('migration_base', 'migration', migrationBase, '标准支持自助模板导入和测试文件映射。'),
    wiki('migration_approval', 'migration', migrationException, '全量人工迁移例外须实施负责人书面确认范围和费用。'),
  ], [
    criterion('resolve_crm_difference', 'conclusion', '按当前 CRM 68,500 元、方案拟定回答旧手记的 54,000 元和已成交冲突；不要把纠正旧值的问题全推迟。', ['migration_note', 'migration_value', 'migration_stage']),
    criterion('do_not_infer_exception', 'limitation', '把客户说法作为转述，不能替代书面例外授权。说明免费全量人工迁移未核实，需要实施负责人确认范围和费用。', ['claimed_migration', 'migration_approval']),
    criterion('offer_migration_baseline', 'recommendation', '建议销售先用测试文件做自助模板映射或推进同等的产品范围内步骤，不把标准自助等同于全量人工服务。', ['migration_goal', 'migration_base']),
    criterion('migration_no_commitment', 'forbidden', '不得按旧快照对外报 54,000 元或称已成交，不得称人工迁移例外已获批、免费或一定做不了。', []),
  ], { allowPartial: true }),
  D01: complex('D01', 'formal', [
    '客户同时有基础支持需求和额外服务要求。请结合商机当前状态、预计关单日期和客户所述要求，给销售一份可以继续谈的建议。',
    '请核对《支持范围》，并查“跨域双活 SLA”是否有授权依据；如果查不到，请说明哪些承诺需要等谁确认，基础支持条件仍请照常建议。',
  ], ['support'], [
    contact('D01', 'standard_support', '客户基础需求是境内单区域、工作日人工支持。'),
    contact('D01', 'special_support', '客户另要求跨域双活 SLA。'),
    lead('support_open', 'status', 'open', '商机仍开放。'),
    lead('support_close', 'expected_close_date', fixtures.D01.expectedCloseDate, '商机预计 2027-05-24 关单。'),
    wiki('support_base', 'support', supportBase, '基础支持覆盖境内单区域，工作日 09:00–18:00 人工支持。'),
    wiki('support_owner', 'support', supportOwner, '技术支持负责人核实超范围可行性，商务负责人确认书面条款。'),
    { id: 'support_verified_absence', description: '授权 Wiki 正常检索，没有跨域双活 SLA 的适用依据。',
      observation: { type: 'wiki_empty', query: specialSupportQuery } },
  ], [
    criterion('support_standard_solution', 'recommendation', '提出境内单区域、工作日 09:00–18:00 人工支持的标准选项，说明它满足客户基础需求，仍可推进。', ['standard_support', 'support_base']),
    criterion('support_case_remains_open', 'constraint', '结合商机仍开放及 5 月 24 日预计关单来安排核实，说明该销售计划不证明服务条款已确认。', ['support_open', 'support_close']),
    criterion('support_bound_the_gap', 'limitation', '说明本次经授权检索没有特殊 SLA 的可承诺依据、这只影响跨域双活服务承诺，并请技术支持负责人核实可行性、商务负责人确认书面条款。', ['special_support', 'support_verified_absence', 'support_owner']),
    criterion('support_no_commitment', 'forbidden', '不得从未找到推断公司永远不提供，不得补造跨域 SLA、无条件承诺或将基础支持整项搁置为待核。', []),
  ], { missingQuery: specialSupportQuery, allowPartial: true }),
};

export const templateScope = Object.freeze({
  contactId: '{contactId}', leadId: '{leadId}', stageId: '{stageId}', pipelineId: '{pipelineId}',
});

export function taskFor(item, scope) {
  if (legacyIds.includes(item.id)) return priorTask(priorCases[item.id], scope);
  return [
    `以 ${businessDate} 为本次业务核对日。只围绕商机 ${scope.leadId} 和关联联系人 ${scope.contactId}，写一份给销售同事的中文跟进建议。`,
    ...item.task,
    '请分别说明客户确认的事实、商机当前记录和公司资料依据。把真实观察的来源放在结构化 evidence 里；对还不能确定的事项说明影响与补证方式。仅分析和建议，不创建提案、不修改记录、不联系客户。',
  ].join('\n');
}
