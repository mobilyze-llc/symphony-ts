export function containsAsciiIdentifierBoundedLiteral(
  text: string,
  literal: string,
): boolean {
  let fromIndex = 0;
  while (fromIndex <= text.length - literal.length) {
    const index = text.indexOf(literal, fromIndex);
    if (index === -1) return false;
    const before = index === 0 ? "" : text[index - 1];
    const after = text[index + literal.length] ?? "";
    if (!isAsciiWordCharacter(before) && !isAsciiWordCharacter(after)) {
      return true;
    }
    fromIndex = index + 1;
  }
  return false;
}

export function* wordBoundedLiteralIndices(
  content: string,
  literal: string,
): Generator<number> {
  let fromIndex = 0;
  while (fromIndex <= content.length - literal.length) {
    const index = content.indexOf(literal, fromIndex);
    if (index === -1) return;
    if (
      isWordBoundary(content, index) &&
      isWordBoundary(content, index + literal.length)
    ) {
      yield index;
      fromIndex = index + Math.max(literal.length, 1);
    } else {
      fromIndex = index + 1;
    }
  }
}

function isWordBoundary(content: string, index: number): boolean {
  return (
    isAsciiWordCharacter(content[index - 1]) !==
    isAsciiWordCharacter(content[index])
  );
}

function isAsciiWordCharacter(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  const code = value.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122)
  );
}
