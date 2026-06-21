export const AUTOGEN: { start: string; end: string };

export function replaceAutogenRegion(
  content: string,
  start: string,
  end: string,
  body: string,
): string;

export function helpBlock(helpText: string): string;
