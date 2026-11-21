import { parseDocument } from "yaml";
import type { ClashGroup } from "../convert";
import type { ClashProxy } from "../links";
import { HttpError } from "../text-fetch";

export function buildClashConfig(
  templateText: string,
  nodes: ClashProxy[],
  groups: ClashGroup[],
  rules: string[],
): string {
  const doc = parseDocument(templateText);
  if (doc.errors.length > 0) {
    throw new HttpError(502, `基础模板不是合法 YAML：${doc.errors[0].message}`);
  }

  doc.set("proxies", nodes);
  doc.set("proxy-groups", groups);
  doc.set("rules", rules);
  if (!doc.has("mode")) doc.set("mode", "rule");

  return doc.toString({ lineWidth: 0 });
}
