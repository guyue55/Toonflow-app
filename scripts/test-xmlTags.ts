import { extractXmlTags } from "../src/utils/agent/xmlTags";

const cases: { name: string; text: string; tag: string; check: (r: any[]) => boolean; expect: string }[] = [
  { name: "T1 正常", text: "前置\n<storySkeleton>核心内容\n第二行</storySkeleton>\n结尾", tag: "storySkeleton", check: (r) => r.length === 1 && r[0].content === "核心内容\n第二行", expect: "1项含换行内容" },
  { name: "T2 无标签", text: "# 裸骨架\n\n故事骨架已保存。", tag: "storySkeleton", check: (r) => r.length === 0, expect: "[]" },
  { name: "T3 多scriptItem", text: `<scriptItem name="EP01">A</scriptItem><scriptItem name='EP02'>B</scriptItem>`, tag: "scriptItem", check: (r) => r.length === 2 && r[0].attrs.name === "EP01" && r[1].attrs.name === "EP02", expect: "EP01+EP02" },
  { name: "T4 多标签共存", text: "<adaptationStrategy>旧</adaptationStrategy><adaptationStrategy>新</adaptationStrategy>", tag: "adaptationStrategy", check: (r) => r.length === 2, expect: "2项" },
  { name: "T5 未闭合", text: "<storySkeleton>被截断", tag: "storySkeleton", check: (r) => r.length === 0, expect: "[]" },
  { name: "T6 裸字样", text: "提到 <storySkeleton> 字样，后面真的 <storySkeleton>真内容</storySkeleton>", tag: "storySkeleton", check: (r) => r.length === 1 && r[0].content === "真内容", expect: "真内容" },
  { name: "B4 自闭合", text: "<storySkeleton/>", tag: "storySkeleton", check: (r) => r.length === 0, expect: "[]" },
  { name: "B6 真嵌套取内层", text: `<scriptItem name="EP01">正文 <scriptItem name="示例">内层</scriptItem> 尾部</scriptItem>`, tag: "scriptItem", check: (r) => r.some((x) => x.content === "内层"), expect: "含内层" },
  { name: "B7 两个对", text: "<storySkeleton>A</storySkeleton> 中间 <storySkeleton>B</storySkeleton>", tag: "storySkeleton", check: (r) => r.length === 2 && r[0].content === "A" && r[1].content === "B", expect: "A+B" },
  { name: "B8 内容含闭标签字样", text: `<scriptItem name="EP01">内容含</scriptItem>字样</scriptItem>`, tag: "scriptItem", check: (r) => r.length >= 1 && r[0].content.includes("内容含"), expect: "宽松" },
  { name: "B9 属性含斜杠", text: `<scriptItem name="EP 1/2">内容</scriptItem>`, tag: "scriptItem", check: (r) => r.length === 1 && r[0].attrs.name === "EP 1/2", expect: "EP 1/2" },
  { name: "B10 大小写", text: "<StorySkeleton>x</StorySkeleton>", tag: "storySkeleton", check: (r) => r.length === 0, expect: "[]" },
  { name: "B11 属性含>", text: `<scriptItem name="A>B">内容B</scriptItem>`, tag: "scriptItem", check: (r) => r.length >= 1 && r.every((x) => x.content.includes("内容B")), expect: "宽松" },
  { name: "B12 混合真实场景", text: `思路说明。\n<scriptItem name="EP01：标题">第一集正文，含人物对话。</scriptItem>\n确认话术`, tag: "scriptItem", check: (r) => r.length === 1 && r[0].attrs.name === "EP01：标题" && r[0].content.includes("第一集"), expect: "EP01" },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  let r: any[];
  try {
    r = extractXmlTags(c.text, c.tag);
  } catch (e: any) {
    console.log(`❌ ${c.name}: 异常 ${e.message}`);
    fail++;
    continue;
  }
  const ok = c.check(r);
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${c.name}: ${JSON.stringify(r).slice(0, 120)}（期望 ${c.expect}）`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
