import { cached } from "./cache";
import { fetchText } from "./text-fetch";

export interface ParsedRule {
  type: string;
  value: string;
  flag?: string;
}

const RULE_TYPES = new Set([
  "DOMAIN",
  "DOMAIN-SUFFIX",
  "DOMAIN-KEYWORD",
  "DOMAIN-REGEX",
  "GEOSITE",
  "IP-CIDR",
  "IP-CIDR6",
  "IP-SUFFIX",
  "IP-ASN",
  "GEOIP",
  "SRC-GEOIP",
  "SRC-IP-CIDR",
  "SRC-PORT",
  "DST-PORT",
  "PROCESS-NAME",
  "PROCESS-PATH",
  "PROCESS-NAME-REGEX",
  "RULE-SET",
  "NETWORK",
  "MATCH",
]);

/**
 * 规则文件里可能出现、但 mihomo / sing-box 都不支持的规则类型。
 * URL-REGEX 是 Surge / Quantumult X 专有语法，写进 mihomo 配置会导致整份配置加载失败。
 */
const UNSUPPORTED_RULE_TYPES = new Set(["URL-REGEX"]);

export function isRuleType(name: string): boolean {
  return RULE_TYPES.has(name.toUpperCase());
}

export function isUnsupportedRuleType(name: string): boolean {
  return UNSUPPORTED_RULE_TYPES.has(name.toUpperCase());
}

export interface ParseRuleListResult {
  rules: ParsedRule[];
  skipped: number;
  /** 被跳过的规则类型，如 ["URL-REGEX"]，用于给出可读的警告 */
  skippedTypes: string[];
}

function normalizeLine(line: string): string {
  return line.replace(/^\s*-\s*/, "").replace(/^["']|["']$/g, "").trim();
}

export function parseRuleList(text: string): ParseRuleListResult {
  const rules: ParsedRule[] = [];
  const skippedTypes = new Set<string>();
  let skipped = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalizeLine(rawLine);
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    if (/^payload\s*:/i.test(line)) continue;

    if (line.includes(",")) {
      const parts = line.split(",").map((p) => p.trim());
      const type = parts[0].toUpperCase();
      if (RULE_TYPES.has(type) && parts.length >= 2 && parts[1]) {
        const rule: ParsedRule = { type, value: parts[1] };
        const third = parts[2];
        if (third && /^no-resolve$/i.test(third)) rule.flag = "no-resolve";
        rules.push(rule);
        continue;
      }
      skipped++;
      if (type) skippedTypes.add(type);
      continue;
    }

    if (line.startsWith("+.")) {
      rules.push({ type: "DOMAIN-SUFFIX", value: line.slice(2) });
      continue;
    }
    if (line.startsWith("*.")) {
      rules.push({ type: "DOMAIN-SUFFIX", value: line.slice(2) });
      continue;
    }
    if (line.startsWith(".")) {
      rules.push({ type: "DOMAIN-SUFFIX", value: line.slice(1) });
      continue;
    }
    if (/^[a-z0-9.-]+$/i.test(line)) {
      rules.push({ type: "DOMAIN", value: line });
      continue;
    }

    skipped++;
  }

  return { rules, skipped, skippedTypes: [...skippedTypes] };
}

export function toClashRule(rule: ParsedRule, policy: string): string {
  // MATCH 没有匹配值，写成 MATCH,<policy> 才是合法格式
  if (rule.type === "MATCH") return `MATCH,${policy}`;
  const base = `${rule.type},${rule.value},${policy}`;
  return rule.flag ? `${base},${rule.flag}` : base;
}

export interface RuleListResult {
  rules: ParsedRule[];
  skipped: number;
  skippedTypes: string[];
  url: string;
  bytes: number;
}

export async function fetchRuleList(
  url: string,
  allowLocal: boolean,
  ttlMs = 10 * 60_000,
): Promise<RuleListResult> {
  return cached(`rules:${url}`, ttlMs, async () => {
    const file = await fetchText(url, { allowLocal, accept: "*/*", timeoutMs: 20_000 });
    const parsed = parseRuleList(file.text);
    return {
      rules: parsed.rules,
      skipped: parsed.skipped,
      skippedTypes: parsed.skippedTypes,
      url: file.url,
      bytes: file.bytes,
    };
  });
}
