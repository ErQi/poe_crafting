export function formatThreshold(threshold, threshold2) {
  if (threshold == null && threshold2 == null) return "";
  if (threshold == null) return String(threshold2);
  if (threshold2 == null) return String(threshold);
  return `${threshold}-${threshold2}`;
}

export function parseThreshold(text) {
  const raw = String(text || "").trim();
  if (!raw) return { threshold: null, threshold2: null };
  const parts = raw.split(/\s*(?:-|—|–|到|至)\s*/).filter((p) => p !== "");
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  if (parts.length >= 2) {
    const a = num(parts[0]);
    const b = num(parts[1]);
    if (a == null || b == null) return { threshold: null, threshold2: null };
    return { threshold: a, threshold2: b };
  }
  return { threshold: num(raw), threshold2: null };
}

export function emptyGroup(name = "规则组 1") {
  return {
    id: crypto.randomUUID(),
    name,
    combine: "all",
    enabled: true,
    min_matches: null,
    rules: [],
  };
}

export function emptyRule() {
  return {
    id: crypto.randomUUID(),
    pattern: "",
    operator: "",
    threshold: null,
    threshold2: null,
    enabled: true,
    note: "",
  };
}

export function cloneRuleset(rs) {
  return JSON.parse(JSON.stringify(rs || { group_combine: "all", groups: [emptyGroup()] }));
}
