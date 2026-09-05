/**
 * 集成测试：工作区数据落库链路（不依赖 AI 模型）
 *
 * 验证：
 * 1. persistScriptPlanDataFromResponse 正常XML解析落库 + 合并语义
 * 2. 无XML（本次事故场景）返回空patch，不落库
 * 3. setPlanData 行不存在时自动插入（此前会静默失败）
 * 4. production 纯文本字段落库
 *
 * 用法：npx tsx scripts/test-planData-persist.ts
 * 注意：不 import startServe（app.ts 导入即自动监听），仅直接调用落库函数验证
 */
import u from "../src/utils";
import { persistScriptPlanDataFromResponse, persistProductionTextFromResponse } from "../src/utils/agent/planData";

async function main() {
  // 测试专用项目ID（记忆清理必须用精确匹配 IN 列表，禁止范围删除——
  // 真实项目ID是13位时间戳(≈1.79万亿)远大于 999000001，范围删除会误删真实数据）
  const testProjectIds = [999000001, 999000002];
  const testProjectId = testProjectIds[0];
  let passed = 0;
  let failed = 0;

  async function cleanup() {
    await u.db("o_agentWorkData").whereIn("projectId", testProjectIds).del();
    await u.db("o_script").whereIn("projectId", testProjectIds).del();
  }
  await cleanup();

  // ── T1: 正常XML解析落库 ──
  {
    const resp = "思路说明...\n<storySkeleton># 骨架标题\n核心内容A</storySkeleton>\n确认话术";
    const patch = await persistScriptPlanDataFromResponse(testProjectId, resp);
    const row = await u.db("o_agentWorkData").where({ projectId: testProjectId, key: "scriptAgent" }).first();
    const data = row?.data ? JSON.parse(row.data) : null;
    const ok = patch.storySkeleton === "# 骨架标题\n核心内容A" && data?.storySkeleton === "# 骨架标题\n核心内容A";
    ok ? passed++ : failed++;
    console.log(`[T1 正常XML解析落库] ${ok ? "✅" : "❌"} patch=${JSON.stringify(patch)}`);
  }

  // ── T2: 合并语义（写入策略时不覆盖已有骨架）──
  {
    await persistScriptPlanDataFromResponse(testProjectId, "<adaptationStrategy>策略内容B</adaptationStrategy>");
    const row = await u.db("o_agentWorkData").where({ projectId: testProjectId, key: "scriptAgent" }).first();
    const data = JSON.parse(row!.data!);
    const ok = data.storySkeleton === "# 骨架标题\n核心内容A" && data.adaptationStrategy === "策略内容B";
    ok ? passed++ : failed++;
    console.log(`[T2 合并语义不覆盖] ${ok ? "✅" : "❌"} storySkeleton保留=${data.storySkeleton?.slice(0, 10)}... adaptationStrategy=${data.adaptationStrategy}`);
  }

  // ── T3: 事故场景——无XML标签 → 空patch不落库 ──
  {
    const before = await u.db("o_agentWorkData").where({ projectId: testProjectId, key: "scriptAgent" }).first();
    const patch = await persistScriptPlanDataFromResponse(testProjectId, "# 裸markdown骨架\n内容...\n\n故事骨架已保存，请在右侧工作台查看。");
    const after = await u.db("o_agentWorkData").where({ projectId: testProjectId, key: "scriptAgent" }).first();
    const ok = Object.keys(patch).length === 0 && JSON.parse(after!.data!).adaptationStrategy === "策略内容B";
    ok ? passed++ : failed++;
    console.log(`[T3 无XML返回空patch] ${ok ? "✅" : "❌"} patch=${JSON.stringify(patch)}`);
  }

  // ── T4: setPlanData 行不存在时自动插入（需启动服务+token，见 T4b 说明）──
  // 直接调用 mergeScriptPlanData 等价验证插入路径（路由内部即调用此逻辑）
  {
    await u.db("o_agentWorkData").where("projectId", testProjectIds[1]).del();
    await persistScriptPlanDataFromResponse(testProjectIds[1], "<storySkeleton>函数插入的骨架</storySkeleton>");
    const row = await u.db("o_agentWorkData").where({ projectId: testProjectIds[1], key: "scriptAgent" }).first();
    const ok = !!row?.data && JSON.parse(row.data).storySkeleton === "函数插入的骨架";
    ok ? passed++ : failed++;
    console.log(`[T4 自动插入缺失行] ${ok ? "✅" : "❌"} row=${row ? "已插入" : "未插入"}`);
    await u.db("o_agentWorkData").where("projectId", testProjectIds[1]).del();
  }

  // ── T5: scriptItem 落库到 o_script ──
  {
    const patch = await persistScriptPlanDataFromResponse(
      testProjectId,
      '<scriptItem name="EP01">第一集内容</scriptItem><scriptItem name="EP02">第二集内容</scriptItem>',
    );
    const scripts = await u.db("o_script").where({ projectId: testProjectId }).orderBy("name");
    const ok =
      patch.script?.length === 2 &&
      scripts.length === 2 &&
      scripts[0].name === "EP01" &&
      scripts[0].content === "第一集内容";
    ok ? passed++ : failed++;
    console.log(`[T5 scriptItem落库] ${ok ? "✅" : "❌"} scripts=${JSON.stringify(scripts.map((s: any) => s.name))}`);
  }

  // ── T6: production 纯文本字段落库 ──
  {
    await persistProductionTextFromResponse(testProjectId, 7, "<scriptPlan>拍摄计划内容</scriptPlan>");
    let row = await u
      .db("o_agentWorkData")
      .where({ projectId: String(testProjectId), episodesId: String(7), key: "productionAgent" })
      .first();
    let ok = !!row?.data && JSON.parse(row.data).scriptPlan === "拍摄计划内容";
    ok ? passed++ : failed++;
    console.log(`[T6 production文本落库-新行] ${ok ? "✅" : "❌"}`);

    await persistProductionTextFromResponse(testProjectId, 7, "<storyboardTable>分镜表内容</storyboardTable>");
    row = await u
      .db("o_agentWorkData")
      .where({ projectId: String(testProjectId), episodesId: String(7), key: "productionAgent" })
      .first();
    const data = JSON.parse(row!.data!);
    ok = data.scriptPlan === "拍摄计划内容" && data.storyboardTable === "分镜表内容";
    ok ? passed++ : failed++;
    console.log(`[T6 production文本落库-合并] ${ok ? "✅" : "❌"}`);
  }

  await cleanup();
  console.log(`\n[TEST] 结果: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("[TEST] 执行出错:", e);
  process.exit(1);
});
