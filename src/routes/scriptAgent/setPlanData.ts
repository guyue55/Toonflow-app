import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    agentType: z.enum(["scriptAgent"]),
    data: z.object({
      storySkeleton: z.string(),
      adaptationStrategy: z.string(),
    }),
  }),
  async (req, res) => {
    const { projectId, agentType, data } = req.body;
    // 行不存在时 update 会静默无效（返回 200 但没写入），先补行再更新
    const existing = await u.db("o_agentWorkData").where({ projectId: projectId, key: agentType }).first();
    if (!existing) {
      await u.db("o_agentWorkData").insert({
        projectId: projectId,
        key: agentType,
        data: JSON.stringify(data),
        createTime: Date.now(),
        updateTime: Date.now(),
      });
    } else {
      // 防覆盖保护：前端页面在后台仍会自动保存其内存态，若其内存态为空
      // （如模型丢XML格式导致前端从未收到内容），会反复把空值写回，
      // 清掉服务端已兜底保存/恢复的数据。因此空字符串不覆盖已有非空值。
      const current: Record<string, any> = (() => {
        try {
          return JSON.parse(existing.data ?? "{}");
        } catch {
          return {};
        }
      })();
      const safeData = { ...data };
      for (const k of ["storySkeleton", "adaptationStrategy"]) {
        if (typeof safeData[k] === "string" && safeData[k].trim() === "" && typeof current[k] === "string" && current[k].trim() !== "") {
          safeData[k] = current[k];
        }
      }
      await u.db("o_agentWorkData").where({ id: existing.id }).update({
        data: JSON.stringify(safeData),
        updateTime: Date.now(),
      });
      // 下发实际保存的数据（含保护结果），前端可据此校正本地状态
      res.status(200).send(success({ data: safeData }));
      return;
    }

    const rawScript = data?.script;
    if (Array.isArray(rawScript) && rawScript.length > 0) {
      // 对 payload 中可能存在的重名 script 做去重（保留最新一项）
      const scriptMap = new Map<string, any>();
      for (const s of rawScript) {
        if (s && s.name) {
          scriptMap.set(s.name, s);
        }
      }
      const uniqueScripts = Array.from(scriptMap.values());

      for (const s of uniqueScripts) {
        const rows = await u.db("o_script").where({ projectId, name: s.name }).select("id").orderBy("id", "asc");
        if (rows.length > 0) {
          const mainId = rows[0].id;
          await u.db("o_script").where({ id: mainId }).update({
            content: s.content,
          });

          // 如果存在历史重复多余的同名记录，清理多余记录并迁移关联资产
          if (rows.length > 1) {
            const extraIds = rows.slice(1).map((r) => r.id);
            const mainAssets = await u.db("o_scriptAssets").where("scriptId", mainId).select("assetId");
            const existingAssetIds = new Set(mainAssets.map((a: any) => a.assetId));

            const dupAssets = await u.db("o_scriptAssets").whereIn("scriptId", extraIds).select("assetId");
            for (const da of dupAssets) {
              if (!existingAssetIds.has(da.assetId)) {
                await u.db("o_scriptAssets").insert({ scriptId: mainId, assetId: da.assetId });
                existingAssetIds.add(da.assetId);
              }
            }
            await u.db("o_scriptAssets").whereIn("scriptId", extraIds).delete();
            await u.db("o_script").whereIn("id", extraIds).delete();
          }
        } else {
          await u.db("o_script").insert({
            projectId,
            name: s.name,
            content: s.content,
            createTime: Date.now(),
          });
        }
      }
    }

    res.status(200).send(success());
  },
);
