export function normalizePath(path) {
  return String(path).replaceAll("\\", "/").replace(/^\.\//, "");
}

export function lineCount(content) {
  if (content == null || content === "") return 0;
  const text = String(content).replaceAll("\r\n", "\n");
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    const next = glob[i + 1];
    if (char === "*" && next === "*") {
      const after = glob[i + 2];
      if (after === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

export function pathMatchesAny(path, globs = []) {
  const normalized = normalizePath(path);
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}

function activeWaiver(
  path,
  rule,
  waivers = [],
  today = new Date().toISOString().slice(0, 10),
) {
  return (
    waivers.find((waiver) => {
      if (waiver.expires < today) return false;
      if (waiver.rule && waiver.rule !== rule) return false;
      return globToRegExp(waiver.path).test(normalizePath(path));
    }) ?? null
  );
}

function verdict({
  path,
  rule,
  message,
  measured,
  limit,
  remediation,
  waivers,
}) {
  const waiver = activeWaiver(path, rule, waivers);
  return {
    path: normalizePath(path),
    rule,
    status: waiver ? "waived" : "fail",
    message,
    measured,
    limit,
    remediation,
    waiver,
  };
}

export function addedLines(oldContent, newContent) {
  const oldCounts = new Map();
  for (const line of String(oldContent ?? "")
    .replaceAll("\r\n", "\n")
    .split("\n")) {
    oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  }
  const added = [];
  for (const line of String(newContent ?? "")
    .replaceAll("\r\n", "\n")
    .split("\n")) {
    const count = oldCounts.get(line) ?? 0;
    if (count > 0) oldCounts.set(line, count - 1);
    else added.push(line);
  }
  return added;
}

export function evaluateFileSizeRatchet({
  path,
  oldContent,
  newContent,
  rules,
}) {
  const normalized = normalizePath(path);
  if (
    newContent == null ||
    pathMatchesAny(normalized, rules.exempt_path_globs ?? [])
  )
    return [];
  const oldLines = lineCount(oldContent);
  const newLines = lineCount(newContent);
  const waivers = rules.waivers ?? [];
  if (oldContent == null && newLines > rules.new_file_line_cap) {
    return [
      verdict({
        path: normalized,
        rule: "file_size.new_file_line_cap",
        message: `new file has ${newLines} lines, above cap ${rules.new_file_line_cap}`,
        measured: newLines,
        limit: rules.new_file_line_cap,
        remediation:
          "Split the new source into smaller modules or add a visible temporary waiver.",
        waivers,
      }),
    ];
  }
  if (
    oldContent != null &&
    oldLines >= rules.no_growth_line_threshold &&
    newLines > oldLines
  ) {
    return [
      verdict({
        path: normalized,
        rule: "file_size.no_growth_over_threshold",
        message: `large file grew from ${oldLines} to ${newLines} lines`,
        measured: newLines - oldLines,
        limit: 0,
        remediation:
          "Extract new behavior into a smaller module; large files may shrink or stay flat only.",
        waivers,
      }),
    ];
  }
  return [];
}

export function evaluateGodFile({
  path,
  oldContent,
  newContent,
  rules,
  checkStaleHighPin = false,
}) {
  const normalized = normalizePath(path);
  const pin = (rules.pinned_files ?? []).find(
    (entry) => normalizePath(entry.path) === normalized,
  );
  if (!pin || newContent == null) return [];
  const waivers = rules.waivers ?? [];
  const results = [];
  const lines = lineCount(newContent);
  if (lines > pin.max_lines) {
    results.push(
      verdict({
        path: normalized,
        rule: "god_file.max_lines",
        message: `pinned god file has ${lines} lines, above pin ${pin.max_lines}`,
        measured: lines,
        limit: pin.max_lines,
        remediation:
          "Move new behavior into a focused module and keep this file flat or shrinking.",
        waivers,
      }),
    );
  }
  if (checkStaleHighPin && lines < pin.max_lines) {
    results.push(
      verdict({
        path: normalized,
        rule: "god_file.stale_high_pin",
        message: `pinned god file has ${lines} lines, below pin ${pin.max_lines}`,
        measured: lines,
        limit: pin.max_lines,
        remediation:
          "Run scripts/architecture/check-god-files.mjs --update-pins to normalize stale-high headroom downward.",
        waivers,
      }),
    );
  }
  for (const line of addedLines(oldContent, newContent)) {
    for (const pattern of pin.forbidden_new_patterns ?? []) {
      if (new RegExp(pattern.pattern).test(line)) {
        results.push(
          verdict({
            path: normalized,
            rule: `god_file.forbidden_new_pattern.${pattern.id}`,
            message: `added line matches forbidden pattern ${pattern.id}: ${line.trim()}`,
            measured: line.trim(),
            limit: pattern.pattern,
            remediation: pattern.remediation,
            waivers,
          }),
        );
      }
    }
  }
  return results;
}

export function unwaived(verdicts) {
  return verdicts.filter((item) => item.status !== "waived");
}
