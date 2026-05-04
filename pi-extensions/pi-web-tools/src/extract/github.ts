export type GitHubUrlKind = "repo" | "blob" | "tree" | "commit";

export interface ParsedGitHubUrl {
	kind: GitHubUrlKind;
	owner: string;
	repo: string;
	ref?: string;
	path?: string;
	apiUrl: string;
	rawUrl?: string;
}

export interface GitHubExtractOptions {
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	maxTreeEntries?: number;
}

function splitRefAndPath(parts: string[]): { ref?: string; path?: string } {
	if (parts.length === 0) return {};
	return { ref: parts[0], path: parts.slice(1).join("/") || undefined };
}

export function parseGitHubUrl(input: string): ParsedGitHubUrl | undefined {
	const url = new URL(input);
	if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return undefined;
	const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
	if (parts.length < 2) return undefined;
	const [owner, repo, marker, ...rest] = parts;
	const base = `https://api.github.com/repos/${owner}/${repo}`;
	if (!marker) return { kind: "repo", owner, repo, apiUrl: base };
	if (marker === "blob") {
		const { ref, path } = splitRefAndPath(rest);
		return { kind: "blob", owner, repo, ref, path, apiUrl: `${base}/contents/${path ?? ""}?ref=${encodeURIComponent(ref ?? "HEAD")}`, rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}` };
	}
	if (marker === "tree") {
		const { ref, path } = splitRefAndPath(rest);
		return { kind: "tree", owner, repo, ref, path, apiUrl: `${base}/contents/${path ?? ""}?ref=${encodeURIComponent(ref ?? "HEAD")}` };
	}
	if (marker === "commit") return { kind: "commit", owner, repo, ref: rest[0], apiUrl: `${base}/commits/${rest[0] ?? ""}` };
	return { kind: "repo", owner, repo, apiUrl: base };
}

async function jsonFetch(fetchImpl: typeof fetch, url: string, signal?: AbortSignal): Promise<any> {
	const response = await fetchImpl(url, { headers: { accept: "application/vnd.github+json" }, signal });
	if (!response.ok) throw new Error(`GitHub fetch failed (${response.status}) for ${url}`);
	return response.json();
}

export async function extractGitHubUrl(input: string, options: GitHubExtractOptions = {}) {
	const parsed = parseGitHubUrl(input);
	if (!parsed) return undefined;
	const fetchImpl = options.fetchImpl ?? fetch;
	if (parsed.kind === "blob" && parsed.rawUrl) {
		const response = await fetchImpl(parsed.rawUrl, { signal: options.signal });
		if (!response.ok) throw new Error(`GitHub raw fetch failed (${response.status}) for ${parsed.rawUrl}`);
		const content = await response.text();
		return { title: `${parsed.owner}/${parsed.repo}/${parsed.path ?? ""}`, content, metadata: { provider: "github", ...parsed, extraction: "raw" } };
	}
	const data = await jsonFetch(fetchImpl, parsed.apiUrl, options.signal);
	if (parsed.kind === "repo") {
		const readme = await fetchImpl(`https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/HEAD/README.md`, { signal: options.signal }).then((r) => r.ok ? r.text() : "").catch(() => "");
		const content = `# ${data.full_name ?? `${parsed.owner}/${parsed.repo}`}\n\n${data.description ?? ""}\n\n${readme}`.trim();
		return { title: data.full_name ?? `${parsed.owner}/${parsed.repo}`, content, metadata: { provider: "github", ...parsed, extraction: "repo", stars: data.stargazers_count, defaultBranch: data.default_branch } };
	}
	if (Array.isArray(data)) {
		const entries = data.slice(0, options.maxTreeEntries ?? 200).map((entry: any) => `- ${entry.type === "dir" ? "dir" : "file"}: ${entry.path ?? entry.name}`).join("\n");
		return { title: `${parsed.owner}/${parsed.repo}/${parsed.path ?? ""}`, content: entries, metadata: { provider: "github", ...parsed, extraction: "tree", entries: data.length } };
	}
	const content = JSON.stringify(data, null, 2);
	return { title: `${parsed.owner}/${parsed.repo}`, content, metadata: { provider: "github", ...parsed, extraction: parsed.kind } };
}
