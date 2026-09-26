/** Splits "---\n<yaml>\n---\n<body>" into its parts. Files without front matter return frontMatter null. */
export function splitFrontMatter(text: string): { frontMatter: string | null; body: string } {
  const normalized = text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { frontMatter: null, body: normalized };
  return { frontMatter: match[1] ?? "", body: normalized.slice(match[0].length) };
}

/** The first "# " heading, if any. */
export function firstHeading(body: string): string | null {
  const match = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body);
  return match?.[1]?.trim() ?? null;
}

/** Level-two sections ("## Heading") with their text, in order. */
export function markdownSections(body: string): { heading: string; text: string }[] {
  const sections: { heading: string; text: string }[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  let fence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(\u0060\u0060\u0060|~~~)/.test(line)) fence = !fence;
    const heading = fence ? null : /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (heading && !line.startsWith("###")) {
      if (current) sections.push({ heading: current.heading, text: current.lines.join("\n").trim() });
      current = { heading: heading[1]?.trim() ?? "", lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, text: current.lines.join("\n").trim() });
  return sections;
}
