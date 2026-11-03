// Grouping for the usage tables. JSX-free so it can be tested on its own.

// Direct model calls, and traffic recorded before combos were tracked.
const NO_COMBO = "No combo";

function getGroupKey(item, keyField) {
  switch (keyField) {
    case "rawModel": return item.rawModel || "Unknown Model";
    case "accountName": return item.accountName || `Account ${item.connectionId?.slice(0, 8)}...` || "Unknown Account";
    case "keyName": return item.apiKeyMasked ? `${item.keyName} (${item.apiKeyMasked})` : item.keyName || "Unknown Key";
    case "endpoint": return item.endpoint || "Unknown Endpoint";
    case "combo": return item.combo || NO_COMBO;
    default: return item[keyField] || "Unknown";
  }
}

export function groupDataByKey(data, keyField) {
  if (!Array.isArray(data)) return [];
  const groups = {};
  data.forEach((item) => {
    const gk = getGroupKey(item, keyField);
    if (!groups[gk]) {
      groups[gk] = {
        groupKey: gk,
        summary: { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0, inputCost: 0, cachedCost: 0, outputCost: 0, lastUsed: null, pending: 0 },
        items: [],
      };
    }
    const s = groups[gk].summary;
    s.requests += item.requests || 0;
    s.promptTokens += item.promptTokens || 0;
    s.completionTokens += item.completionTokens || 0;
    s.cachedTokens += item.cachedTokens || 0;
    s.totalTokens += item.totalTokens || 0;
    s.cost += item.cost || 0;
    s.inputCost += item.inputCost || 0;
    s.cachedCost += item.cachedCost || 0;
    s.outputCost += item.outputCost || 0;
    s.pending += item.pending || 0;
    if (item.lastUsed && (!s.lastUsed || new Date(item.lastUsed) > new Date(s.lastUsed))) {
      s.lastUsed = item.lastUsed;
    }
    groups[gk].items.push(item);
  });
  return Object.values(groups);
}

/**
 * API key groups with one more level: key → combo → the models that answered.
 * UsageTable renders `subgroups` in place of `items` when present.
 */
export function groupApiKeysByCombo(data) {
  return groupDataByKey(data, "keyName").map((group) => ({
    ...group,
    subgroups: groupDataByKey(group.items, "combo"),
  }));
}
