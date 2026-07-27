export function parseCrabrunnerStaticSlotsJson(
  value: string | undefined,
): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("SYMPHONY_CRABRUNNER_STATIC_SLOTS_JSON must be valid JSON");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((slot) => typeof slot !== "string" || slot.trim() === "")
  ) {
    throw new Error(
      "SYMPHONY_CRABRUNNER_STATIC_SLOTS_JSON must be a non-empty JSON array of non-empty strings",
    );
  }
  return parsed.map((slot) => slot.trim());
}

export function crabrunnerStaticSlotsOption(value: string | undefined): {
  remoteStaticSlots?: string[];
} {
  const slots = parseCrabrunnerStaticSlotsJson(value);
  return slots === undefined ? {} : { remoteStaticSlots: slots };
}

export function appendCrabrunnerStaticSlotsArg(
  args: string[],
  slots: readonly string[] | null,
): void {
  if (slots !== null) args.push("--static-slots-json", JSON.stringify(slots));
}
