/**
 * Pure, dependency-free conversion of a SQL tagged template into a
 * parameterized query: one text string with $1..$n placeholders plus the
 * list of bound parameters. Values are never interpolated into the text.
 */
export function toQuery(
  strings: readonly string[],
  values: readonly unknown[]
): { text: string; params: unknown[] } {
  if (strings.length !== values.length + 1) {
    throw new Error(
      `toQuery: template mismatch: strings.length (${strings.length}) must equal values.length + 1 (${values.length + 1})`
    );
  }

  let text = strings[0] ?? "";
  const params: unknown[] = [];

  for (let i = 0; i < values.length; i++) {
    params.push(values[i]);
    text += `$${i + 1}${strings[i + 1] ?? ""}`;
  }

  return { text, params };
}
