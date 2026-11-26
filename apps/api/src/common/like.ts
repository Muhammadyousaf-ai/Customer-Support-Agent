/** `%text%` for ILIKE with the user's own `%`, `_` and `\` matched literally (Postgres' default LIKE escape is `\`). */
export const containsPattern = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;
