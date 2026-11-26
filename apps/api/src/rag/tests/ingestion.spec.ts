import { describe, expect, it } from "vitest";
import { buildRag, InMemoryStore } from "./helpers.js";

const raw = (body: string, version = "1") => `---\ntitle: Doc One\ncategory: billing\nversion: "${version}"\n---\n${body}`;

describe("ingestion", () => {
  it("ingests, then skips identical content (duplicate prevention)", async () => {
    const { ingestion, store } = buildRag();
    const first = await ingestion.ingestFile("one.md", raw("# A\nrefund text\n\n# B\nbilling text"));
    expect(first.result).toEqual({ file: "one.md", status: "ingested", chunks: 2 });
    const second = await ingestion.ingestFile("one.md", raw("# A\nrefund text\n\n# B\nbilling text"));
    expect(second.result.status).toBe("skipped_duplicate");
    expect(store.replaceCalls).toBe(1);
    expect(store.docs.size).toBe(1);
  });

  it("replaces a document when its content changes, without duplicating chunks", async () => {
    const { ingestion, store } = buildRag();
    await ingestion.ingestFile("one.md", raw("# A\nold text"));
    const r = await ingestion.ingestFile("one.md", raw("# A\nnew text\n\n# B\nmore", "2"));
    expect(r.result).toMatchObject({ status: "updated", chunks: 2 });
    expect(store.docs.get("Doc One")!.chunks).toHaveLength(2);
    expect(store.docs.get("Doc One")!.doc.version).toBe("2");
  });

  it("re-embeds unchanged content when the embedding model changed", async () => {
    const store = new InMemoryStore();
    await buildRag({ store }).ingestion.ingestFile("one.md", raw("# A\ntext"));
    const other = buildRag({ store, embedder: { name: "local", model: "other-model", embed: async (t) => ({ vectors: t.map(() => Array.from({ length: 1536 }, () => 0.1)), tokens: 0 }) } });
    expect((await other.ingestion.ingestFile("one.md", raw("# A\ntext"))).result.status).toBe("updated");
  });

  it("reports a bad file as failed without throwing, and leaves the stored version intact on embed failure", async () => {
    const { ingestion, store } = buildRag();
    expect((await ingestion.ingestFile("bad.md", "no frontmatter")).result).toMatchObject({ status: "failed" });
    await ingestion.ingestFile("one.md", raw("# A\ntext"));
    const failing = buildRag({ store, embedder: { name: "openai", model: "m", embed: async () => { throw new Error("rate limited"); } } });
    const r = await failing.ingestion.ingestFile("one.md", raw("# A\nchanged text"));
    expect(r.result).toMatchObject({ status: "failed", error: "rate limited" });
    expect(store.docs.get("Doc One")!.chunks[0]!.content).toBe("text");
  });
});
