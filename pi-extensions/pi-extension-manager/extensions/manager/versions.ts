import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { npmCachePath } from "./paths.js";
import { NPM_CACHE_TTL_MS, type NpmCache, type SettingsFile, type SourceIndex, type SourceIndexEntry } from "./types.js";

let npmCheckInFlight = false;

export function loadSourceIndex(settingsFiles: SettingsFile[]): SourceIndex {
	const merged: SourceIndex = {};
	for (const file of settingsFiles) {
		const path = join(file.baseDir, ".vstack-source.json");
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (parsed && typeof parsed === "object") {
				for (const [name, entry] of Object.entries(parsed)) {
					if (entry && typeof entry === "object") merged[name] = entry as SourceIndexEntry;
				}
			}
		} catch {}
	}
	return merged;
}

export function loadNpmCache(): NpmCache {
	const path = npmCachePath();
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function saveNpmCache(cache: NpmCache): void {
	const path = npmCachePath();
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(cache, null, 2));
	} catch {}
}

export function parseSemver(v: string | undefined): number[] | undefined {
	if (!v) return undefined;
	const clean = v.replace(/^v/, "").split(/[-+]/)[0];
	const parts = clean.split(".").map((p) => Number.parseInt(p, 10));
	if (parts.some((n) => Number.isNaN(n))) return undefined;
	while (parts.length < 3) parts.push(0);
	return parts;
}

export function isNewer(latest: string | undefined, current: string | undefined): boolean {
	const a = parseSemver(latest);
	const b = parseSemver(current);
	if (!a || !b) return false;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		if (x > y) return true;
		if (x < y) return false;
	}
	return false;
}

export function localPackageDirName(packageName: string): string {
	return packageName.startsWith("@vanillagreen/") ? packageName.split("/").pop() || packageName : packageName;
}

export function readPackageVersionFromDir(dir: string | undefined): string | undefined {
	if (!dir) return undefined;
	const manifestPath = join(dir, "package.json");
	if (!existsSync(manifestPath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
		return typeof parsed?.version === "string" ? parsed.version : undefined;
	} catch {
		return undefined;
	}
}

export function readSourceRepoVersion(repoRoot: string, packageName: string, sourcePath?: string): string | undefined {
	return readPackageVersionFromDir(sourcePath) ?? readPackageVersionFromDir(join(repoRoot, "pi-extensions", localPackageDirName(packageName)));
}

function npmRoot(args: string[], cwd?: string): string | undefined {
	const result = spawnSync("npm", ["root", ...args], { encoding: "utf8", cwd });
	if (result.error || (result.status ?? 1) !== 0) return undefined;
	return (result.stdout ?? "").trim() || undefined;
}

function npmPackageDir(root: string, npmName: string): string {
	return join(root, ...npmName.split("/"));
}

export function npmInstalledVersion(npmName: string, cwd: string): string | undefined {
	const roots = [npmRoot(["-g"]), npmRoot([], cwd)].filter((root): root is string => Boolean(root));
	for (const root of roots) {
		const version = readPackageVersionFromDir(npmPackageDir(root, npmName));
		if (version) return version;
	}
	return undefined;
}

export function npmPackageNameFromSource(source: string): string | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const rest = source.slice("npm:".length);
	if (!rest) return undefined;
	const withoutTag = rest.startsWith("@")
		? rest.split("@").slice(0, 2).join("@")
		: rest.split("@")[0];
	return withoutTag || undefined;
}

function fetchNpmLatest(name: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		try {
			const https = require("node:https") as typeof import("node:https");
			const encoded = encodeURIComponent(name).replace(/%40/g, "@").replace(/%2F/g, "/");
			const req = https.request(
				{
					host: "registry.npmjs.org",
					path: `/${encoded}/latest`,
					headers: { accept: "application/json", "user-agent": "vstack-extension-manager" },
					timeout: 4000,
				},
				(res) => {
					if ((res.statusCode ?? 0) >= 400) {
						res.resume();
						resolve(undefined);
						return;
					}
					let body = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => { body += chunk; });
					res.on("end", () => {
						try {
							const parsed = JSON.parse(body);
							resolve(typeof parsed?.version === "string" ? parsed.version : undefined);
						} catch {
							resolve(undefined);
						}
					});
				},
			);
			req.on("error", () => resolve(undefined));
			req.on("timeout", () => { req.destroy(); resolve(undefined); });
			req.end();
		} catch {
			resolve(undefined);
		}
	});
}

export function kickNpmUpdateCheck(packages: { name: string; npmName: string }[], onUpdate: () => void): void {
	if (npmCheckInFlight || packages.length === 0) return;
	const cache = loadNpmCache();
	const now = Date.now();
	const stale = packages.filter((p) => {
		const entry = cache[p.npmName];
		return !entry || now - entry.checkedAt > NPM_CACHE_TTL_MS;
	});
	if (stale.length === 0) return;
	npmCheckInFlight = true;
	void (async () => {
		let changed = false;
		for (const p of stale) {
			const latest = await fetchNpmLatest(p.npmName);
			if (latest) {
				cache[p.npmName] = { version: latest, checkedAt: Date.now() };
				changed = true;
			}
		}
		if (changed) saveNpmCache(cache);
		npmCheckInFlight = false;
		try { onUpdate(); } catch {}
	})();
}
