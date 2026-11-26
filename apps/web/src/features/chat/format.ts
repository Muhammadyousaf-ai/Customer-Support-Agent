export const formatMoney = (cents: number, currency = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export const titleCase = (s: string) => s.replace(/[_.-]+/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
export const docTitle = (file: string) => titleCase(file.replace(/\.md$/, ""));
