import u from "@/utils";
import { extractXmlTags } from "./xmlTags";

/**
 * 服务端工作区数据兜底落库模块
 *
 * 背景：工作区（故事骨架/改编策略/剧本）此前完全依赖前端解析消息流中的
 * XML 标签后回调 HTTP 接口保存。一旦模型输出丢失 XML 格式（或前端断开），
 * 生成内容就会静默丢失——Agent 明明回复"已保存"，数据却没有入库。
 *
 * 本模块在服务端提供同样的解析与落库能力，作为前端的并行/兜底通道：
 * 1. 从子 Agent 的完整回复文本中解析 XML 标签；
 * 2. 解析成功 → 合并写入 o_agentWorkData（不覆盖前端已保存的其他字段）；
 * 3. 标签缺失 → 返回空 patch，由调用方决定是否触发格式补写重试。
 */

/** 合并保存 scriptAgent 工作区数据（只覆盖出现的新字段，保留其他字段） */
export async function mergeScriptPlanData(
  projectId: number,
  patch: { storySkeleton?: string; adaptationStrategy?: string; script?: { name: string; content: string }[] },
): Promise<void> {
  const row = await u.db("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first();
  let data: Record<string, any> = {};
  if (row?.data) {
    try {
      data = JSON.parse(row.data);
    } catch {
      data = {};
    }
  }

  if (patch.storySkeleton !== undefined) data.storySkeleton = patch.storySkeleton;
  if (patch.adaptationStrategy !== undefined) data.adaptationStrategy = patch.adaptationStrategy;

  if (Array.isArray(patch.script) && patch.script.length > 0) {
    const scriptMap = new Map<string, { name: string; content: string }>();
    for (const s of patch.script) {
      if (s && s.name) scriptMap.set(s.name, s);
    }
    for (const s of scriptMap.values()) {
      const rows = await u.db("o_script").where({ projectId, name: s.name }).select("id").orderBy("id", "asc");
      if (rows.length > 0) {
        await u.db("o_script").where({ id: rows[0].id }).update({ content: s.content });
      } else {
        await u.db("o_script").insert({ projectId, name: s.name, content: s.content, createTime: Date.now() });
      }
    }
  }

  const payload = JSON.stringify(data);
  if (row) {
    await u.db("o_agentWorkData").where({ id: row.id }).update({ data: payload, updateTime: Date.now() });
  } else {
    await u.db("o_agentWorkData").insert({ projectId, key: "scriptAgent", data: payload, createTime: Date.now(), updateTime: Date.now() });
  }
}

/**
 * 服务端解析子 Agent 完整回复并落库 scriptAgent 工作区。
 * 返回本次解析到的各字段内容（供调用方判断是否需要格式补写重试）。
 */
export async function persistScriptPlanDataFromResponse(
  projectId: number,
  fullResponse: string,
): Promise<{ storySkeleton?: string; adaptationStrategy?: string; script?: { name: string; content: string }[] }> {
  const skeletons = extractXmlTags(fullResponse, "storySkeleton");
  const strategies = extractXmlTags(fullResponse, "adaptationStrategy");
  const scripts = extractXmlTags(fullResponse, "scriptItem");

  const patch: { storySkeleton?: string; adaptationStrategy?: string; script?: { name: string; content: string }[] } = {};
  const skeleton = skeletons.length ? skeletons[skeletons.length - 1].content : undefined;
  const strategy = strategies.length ? strategies[strategies.length - 1].content : undefined;
  const scriptItems = scripts
    .map((s) => ({ name: s.attrs.name ?? "", content: s.content }))
    .filter((s) => s.name && s.content);

  if (skeleton) patch.storySkeleton = skeleton;
  if (strategy) patch.adaptationStrategy = strategy;
  if (scriptItems.length) patch.script = scriptItems;

  if (patch.storySkeleton !== undefined || patch.adaptationStrategy !== undefined || patch.script !== undefined) {
    await mergeScriptPlanData(projectId, patch);
  }
  return patch;
}

/**
 * 合并保存 productionAgent 工作区的纯文本字段（scriptPlan/storyboardTable）。
 * 只覆盖出现的字段，assets/storyboard 等复杂结构交由前端原有链路，不越权。
 */
export async function mergeProductionTextFields(
  projectId: number,
  episodesId: number,
  patch: { script?: string; scriptPlan?: string; storyboardTable?: string },
): Promise<void> {
  const row = await u
    .db("o_agentWorkData")
    .where({ projectId: String(projectId), episodesId: String(episodesId), key: "productionAgent" })
    .first();
  let data: Record<string, any> = {};
  if (row?.data) {
    try {
      data = JSON.parse(row.data);
    } catch {
      data = {};
    }
  }
  if (patch.script !== undefined) data.script = patch.script;
  if (patch.scriptPlan !== undefined) data.scriptPlan = patch.scriptPlan;
  if (patch.storyboardTable !== undefined) data.storyboardTable = patch.storyboardTable;

  const payload = JSON.stringify(data);
  if (row) {
    await u.db("o_agentWorkData").where({ id: row.id }).update({ data: payload, updateTime: Date.now() });
  } else {
    await u.db("o_agentWorkData").insert({
      projectId,
      episodesId,
      key: "productionAgent",
      data: payload,
      createTime: Date.now(),
      updateTime: Date.now(),
    });
  }
}

/**
 * 服务端解析 productionAgent 子 Agent 回复中的纯文本工作区字段并落库。
 * 返回解析到的字段（空对象表示无可落库内容）。
 */
export async function persistProductionTextFromResponse(
  projectId: number,
  episodesId: number,
  fullResponse: string,
): Promise<{ scriptPlan?: string; storyboardTable?: string }> {
  const plans = extractXmlTags(fullResponse, "scriptPlan");
  const tables = extractXmlTags(fullResponse, "storyboardTable");

  const patch: { scriptPlan?: string; storyboardTable?: string } = {};
  if (plans.length) patch.scriptPlan = plans[plans.length - 1].content;
  if (tables.length) patch.storyboardTable = tables[tables.length - 1].content;

  if (patch.scriptPlan !== undefined || patch.storyboardTable !== undefined) {
    await mergeProductionTextFields(projectId, episodesId, patch);
  }
  return patch;
}
