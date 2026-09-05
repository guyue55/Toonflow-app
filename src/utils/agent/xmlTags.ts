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
 * 采用栈式配对处理嵌套：闭标签总是与最近的未匹配开标签配对，
 * 因此正文中裸写标签字样不会污染真正的标签内容。
 */
export function extractXmlTags(text: string, tag: string): { attrs: Record<string, string>; content: string }[] {
  const results: { attrs: Record<string, string>; content: string }[] = [];
  const tokenRe = new RegExp(`<(/?)${tag}(\\s[^>]*)?>`, "g");
  // 栈元素：开标签的属性与内容起点
  const stack: { attrs: Record<string, string>; start: number }[] = [];

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const isClose = m[1] === "/";
    if (!isClose) {
      stack.push({ attrs: parseAttrs(m[2] ?? ""), start: m.index + m[0].length });
    } else {
      const open = stack.pop();
      if (open) {
        const content = text.slice(open.start, m.index).trim();
        // 嵌套内容（内部还有未配对的开标签）不可靠，跳过；只接受纯净配对
        const hasNested = new RegExp(`<${tag}(\\s[^>]*)?>`).test(content);
        if (!hasNested) {
          results.push({ attrs: open.attrs, content });
        }
      }
    }
  }
  return results;
}
