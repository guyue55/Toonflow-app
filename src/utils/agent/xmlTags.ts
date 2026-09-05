/**
 * XML 标签提取（纯函数，无依赖）。
 * 供服务端解析子 Agent 回复中的工作区标签使用。
 */

/** 解析开标签中的属性：支持 name="x" / name='x' / name=x 三种写法 */
function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/g;
  let am: RegExpExecArray | null;
  while ((am = attrRe.exec(attrStr)) !== null) {
    attrs[am[1]] = am[2] ?? am[3] ?? am[4] ?? "";
  }
  return attrs;
}

/**
 * 从文本中提取指定标签的内容（含属性），按出现顺序返回。
 *
 * 配对策略（LIFO 栈 + 显式游标）：
 * - 闭标签始终与最近的未匹配开标签配对；
 * - 正文里裸写标签字样（无对应闭标签）被弹出配对时，因内容残留同名开标签
 *   而丢弃，不污染真正的标签内容；
 * - 罕见的真实嵌套输出（skill 明令禁止）取最内层纯净配对；
 * - 未闭合的开标签（如输出被截断）被丢弃。
 *
 * 使用显式位置游标而非 regex.lastIndex 推进，避免 exec 返回 null 时
 * lastIndex 归零导致的重复匹配。
 */
export function extractXmlTags(text: string, tag: string): { attrs: Record<string, string>; content: string }[] {
  const results: { attrs: Record<string, string>; content: string }[] = [];
  const closeTag = `</${tag}>`;
  // 开标签：标签名后必须跟空白/斜杠/闭括号（排除 <tagX> 误匹配）；捕获属性段与自闭合斜杠
  const openRe = new RegExp(`<${tag}(?=[\\s/>])([^>]*?)(/?)>`, "g");
  const opens: { index: number; attrs: Record<string, string>; end: number }[] = [];

  // 1. 收集全部开标签位置（一次性，避免游标状态问题）
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(text)) !== null) {
    if (m[2] === "/") continue; // 自闭合，跳过
    opens.push({ index: m.index, attrs: parseAttrs(m[1] ?? ""), end: m.index + m[0].length });
  }

  // 2. 顺序扫描：闭标签与最近未配对开标签（LIFO）配对
  const stack: typeof opens = [];
  let cursor = 0;
  for (const open of opens) {
    // 开标签之间的闭标签先与栈内（前一组）开标签配对
    while (stack.length > 0) {
      const nextClose = text.indexOf(closeTag, cursor);
      if (nextClose === -1 || nextClose > open.index) break;
      const top = stack.pop()!;
      const content = text.slice(top.end, nextClose).trim();
      const hasStrayOpen = new RegExp(`<${tag}(?=[\\s/>])`).test(content);
      if (!hasStrayOpen) {
        results.push({ attrs: top.attrs, content });
      }
      cursor = nextClose + closeTag.length;
    }
    stack.push(open);
  }
  // 3. 收尾：剩余闭标签与栈内开标签配对；未配对的开标签（截断）丢弃
  while (stack.length > 0) {
    const nextClose = text.indexOf(closeTag, cursor);
    if (nextClose === -1) break;
    const top = stack.pop()!;
    const content = text.slice(top.end, nextClose).trim();
    const hasStrayOpen = new RegExp(`<${tag}(?=[\\s/>])`).test(content);
    if (!hasStrayOpen) {
      results.push({ attrs: top.attrs, content });
    }
    cursor = nextClose + closeTag.length;
  }
  return results;
}
