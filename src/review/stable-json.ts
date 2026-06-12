export function stableJsonStringify(value: unknown): string {
  return stableJsonStringifyValue(value, new WeakSet<object>());
}

function stableJsonStringifyValue(
  value: unknown,
  seen: WeakSet<object>,
): string {
  if (value === undefined) {
    return "undefined:";
  }
  if (value === null) {
    return "null:";
  }

  switch (typeof value) {
    case "boolean":
      return `boolean:${value ? "true" : "false"}`;
    case "number":
      return `number:${normalizeNumber(value)}`;
    case "string":
      return `string:${JSON.stringify(value)}`;
    case "bigint":
      return `bigint:${value.toString()}`;
    case "function":
    case "symbol":
      throw new Error(`Cannot stable-stringify ${typeof value} values.`);
    case "object":
      break;
  }

  if (seen.has(value)) {
    throw new Error("Cannot stable-stringify circular object values.");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `array:[${value
        .map((item) => stableJsonStringifyValue(item, seen))
        .join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJsonStringifyValue(record[key], seen)}`,
      );
    return `object:{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function normalizeNumber(value: number): string {
  if (Number.isNaN(value)) {
    return "NaN";
  }
  if (Object.is(value, -0)) {
    return "-0";
  }
  return String(value);
}
