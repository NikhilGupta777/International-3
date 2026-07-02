import test from "node:test";
import assert from "node:assert/strict";
import { formatTavilySearchNotes } from "./tavily-search";

test("formatTavilySearchNotes preserves source titles, urls, and snippets", () => {
  const notes = formatTavilySearchNotes({
    answer: "Short answer",
    results: [
      { title: "Delhi update", url: "https://example.com/a", content: "Snippet A" },
      { title: "Border report", url: "https://example.com/b", content: "Snippet B" },
    ],
  });

  assert.match(notes, /Short answer/);
  assert.match(notes, /Delhi update/);
  assert.match(notes, /https:\/\/example\.com\/a/);
  assert.match(notes, /Snippet B/);
});
