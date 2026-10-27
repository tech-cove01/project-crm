-- DashScope Qwen3.8 Flash officially supports Function Calling.
-- https://help.aliyun.com/zh/model-studio/qwen3-8-flash
-- Billing is region/tier-dependent; leave prices unset rather than fabricate them.
insert into public.ai_models
  (provider, model_id, display_name, description, context_window, supports_tools)
values
  ('dashscope', 'qwen3.8-flash', 'Qwen3.8 Flash',
   '阿里云百炼千问模型，支持工具调用。', 1000000, true)
on conflict (provider, model_id) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  context_window = excluded.context_window,
  supports_tools = excluded.supports_tools;
