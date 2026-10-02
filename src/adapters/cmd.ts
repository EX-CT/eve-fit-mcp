// Command templates: "bin --dataset {dataset} serve-stdio" → argv, with {dataset} / {bin} substituted.

/** Minimal POSIX-ish word splitting (single/double quotes, backslash escapes). No globbing, no variables. */
export function splitWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let q: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (q) throw new Error(`unterminated quote in command: ${s}`);
  if (has || cur) out.push(cur);
  return out;
}

export function expandCommand(template: string, vars: Record<string, string | undefined>): string[] {
  const argv = splitWords(template).map((w) =>
    w.replace(/\{(\w+)\}/g, (m, k: string) => {
      const v = vars[k];
      if (v === undefined) throw new Error(`command template uses {${k}} but it is not configured: ${template}`);
      return v;
    }),
  );
  if (!argv.length) throw new Error("empty engine command");
  return argv;
}
