export type TavilySearchResult = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
};

export type TavilySearchResponse = {
  answer?: string;
  results?: TavilySearchResult[];
};

export function isTavilyConfigured(): boolean {
  return Boolean((process.env.TAVILY_API_KEY ?? "").trim());
}

export async function searchWithTavily(params: {
  query: string;
  maxResults?: number;
}): Promise<{ notes: string; sources: Array<{ title: string; url: string }> }> {
  const apiKey = (process.env.TAVILY_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("Tavily search is not configured. Add TAVILY_API_KEY.");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: params.query,
      search_depth: "basic",
      topic: "news",
      max_results: params.maxResults ?? 5,
      include_answer: true,
      include_raw_content: false,
    }),
  });
  const data = await res.json().catch(() => ({})) as TavilySearchResponse & { error?: string };
  if (!res.ok) {
    throw new Error(data?.error || `Tavily search failed (${res.status})`);
  }
  const results = Array.isArray(data.results) ? data.results : [];
  return {
    notes: formatTavilySearchNotes(data),
    sources: results
      .map((item) => ({ title: clean(item.title) || clean(item.url), url: clean(item.url) }))
      .filter((item) => item.title && item.url)
      .slice(0, params.maxResults ?? 5),
  };
}

export function formatTavilySearchNotes(data: TavilySearchResponse): string {
  const lines: string[] = [];
  const answer = clean(data.answer);
  if (answer) {
    lines.push(`Tavily answer: ${answer}`);
  }
  const results = Array.isArray(data.results) ? data.results : [];
  results.slice(0, 8).forEach((item, index) => {
    const title = clean(item.title) || "Untitled source";
    const url = clean(item.url);
    const content = clean(item.content);
    lines.push(`${index + 1}. ${title}${url ? ` (${url})` : ""}${content ? `\n   ${content}` : ""}`);
  });
  return lines.join("\n");
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
