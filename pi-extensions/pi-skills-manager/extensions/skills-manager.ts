/**
 * vstack Pi Skills Manager.
 *
 * A polished /skill manager view for browsing, previewing, inserting, creating,
 * editing, renaming, deleting, and enabling/disabling Pi skills.
 */

import { completeSimple, type ThinkingLevel, type UserMessage } from "@mariozechner/pi-ai";
import {
	DefaultPackageManager,
	getAgentDir,
	getMarkdownTheme,
	InteractiveMode,
	parseFrontmatter,
	SettingsManager,
	stripFrontmatter,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type PackageSource,
	type ResolvedResource,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import {
	Container,
	type Component,
	Editor,
	type Focusable,
	Input,
	Key,
	Markdown,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ID = "pi-skills-manager";
const INSTALL_SYMBOL = Symbol.for("vstack.pi-skills-manager.installed");
const STARTUP_PATCH_SYMBOL = Symbol.for("vstack.pi-skills-manager.startup-patch");
const STARTUP_HIDE_ENABLED_SYMBOL = Symbol.for("vstack.pi-skills-manager.hide-startup-skills");
const DEFAULT_POPUP_WIDTH: OverlaySize = "82%";
const DEFAULT_POPUP_MAX_HEIGHT: OverlaySize = "86%";
const DEFAULT_LIST_ROWS = 14;
const VSTACK_MODAL_LOCK_SYMBOL = Symbol.for("vstack.pi.modal-lock");
const ANSI_GREEN_FG = "\x1b[32m";
const ANSI_YELLOW_FG = "\x1b[33m";
const ANSI_FG_RESET = "\x1b[39m";

function ansiGreen(text: string): string { return `${ANSI_GREEN_FG}${text}${ANSI_FG_RESET}`; }
function ansiYellow(text: string): string { return `${ANSI_YELLOW_FG}${text}${ANSI_FG_RESET}`; }

const GENERATE_SKILL_SYSTEM_PROMPT = `You create production-ready Pi Agent skills.

Return only a complete SKILL.md file. Do not wrap it in fences. Do not add commentary.

Rules:
- Start with YAML frontmatter containing name and description.
- The frontmatter name must exactly match the provided skill_slug.
- The description is the trigger surface: state what the skill does and when Pi should use it.
- Include allowed-tools only if provided, as one space-delimited string.
- Keep the body concise, operational, and reusable.
- Prefer workflows, decision rules, output expectations, constraints, edge cases, and final checks.
- Do not add placeholders, TODOs, fake files, or ungrounded scripts/references.
- Use relative paths only if the user explicitly grounded extra files.
- Do not mention skill-authoring infrastructure, package managers, or this generation process.`;

type OverlaySize = number | `${number}%` | string;
type ExtensionInstallScope = "global" | "project";
type SkillScope = "user" | "project" | "temporary";
type SkillOrigin = "package" | "top-level";
type SkillLocation = "project" | "global";
type MessageTone = "dim" | "success" | "error";
type Mode = "browse" | "create" | "preview" | "edit" | "rename" | "delete-confirm" | "generating";

interface VstackModalLock {
	depth: number;
}
type CreateTextStepId = "name" | "description";
type CreateChoiceStepId = "location";
type CreateStepId = CreateTextStepId | CreateChoiceStepId;

interface SkillEntry {
	name: string;
	description: string;
	path: string;
	content: string;
	frontmatter?: Record<string, unknown>;
	scope: SkillScope;
	origin: SkillOrigin;
	source: string;
	baseDir?: string;
	enabled: boolean;
}

interface SkillRegistry {
	skills: SkillEntry[];
	allSkills: SkillEntry[];
	byName: Map<string, SkillEntry>;
}

interface SkillCreationAnswers {
	name: string;
	description: string;
	exampleRequests?: string;
	domainContext?: string;
	allowedTools: string[];
	location: SkillLocation;
}

interface SkillGenerationOptions {
	thinkingLevel?: ThinkingLevel | "off";
	signal?: AbortSignal;
}

interface ParsedSkillDocument {
	name: string;
	description: string;
	frontmatter: Record<string, unknown>;
	content: string;
	raw: string;
}

interface SettingsFile {
	path: string;
	json: Record<string, unknown>;
	exists: boolean;
}

interface CreateTextStep {
	id: CreateTextStepId;
	title: string;
	hint: string;
	kind: "text";
	optional: boolean;
}

interface CreateChoiceOption {
	value: SkillLocation;
	label: string;
	description: string;
}

interface CreateChoiceStep {
	id: CreateChoiceStepId;
	title: string;
	hint: string;
	kind: "choice";
	optional: boolean;
	options: CreateChoiceOption[];
}

type CreateStep = CreateTextStep | CreateChoiceStep;

interface SkillsManagerOptions {
	onCreate: (answers: SkillCreationAnswers, signal?: AbortSignal) => Promise<SkillEntry | null>;
	onDelete: (skill: SkillEntry) => Promise<boolean>;
	onToggle: (skill: SkillEntry, enabled: boolean) => Promise<void>;
	onRefresh: () => Promise<SkillRegistry>;
}

const EMPTY_REGISTRY: SkillRegistry = {
	skills: [],
	allSkills: [],
	byName: new Map(),
};

const LOCATION_OPTIONS: CreateChoiceOption[] = [
	{ value: "project", label: "Project", description: "Save in this project's .pi/skills directory." },
	{ value: "global", label: "Global", description: "Save in your user-level Pi skills directory." },
];

const CREATE_STEPS: CreateStep[] = [
	{ id: "name", title: "Name", hint: "Use lowercase letters, numbers, and hyphens, for example react-review.", optional: false, kind: "text" },
	{ id: "description", title: "Description", hint: "Describe what the skill does and when it should be used. Specific trigger language works best.", optional: false, kind: "text" },
	{ id: "location", title: "Visibility", hint: "Choose whether the skill is project-local or available in all Pi sessions.", optional: false, kind: "choice", options: LOCATION_OPTIONS },
];

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

function userPiDir(): string {
	return resolve(expandHome(process.env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent"));
}

function findProjectPiDir(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		const candidate = join(current, ".pi");
		if (existsSync(candidate)) return candidate;
		if (existsSync(join(current, ".git")) || existsSync(join(current, ".vstack-lock.json"))) return candidate;
		const parent = dirname(current);
		if (parent === current) return join(resolve(cwd), ".pi");
		current = parent;
	}
}

function projectSettingsPath(cwd: string): string {
	return join(findProjectPiDir(cwd), "settings.json");
}

function readJsonObject(path: string): SettingsFile {
	if (!existsSync(path)) return { path, json: {}, exists: false };
	const text = readFileSync(path, "utf8");
	if (!text.trim()) return { path, json: {}, exists: true };
	const parsed = JSON.parse(text);
	return { path, json: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}, exists: true };
}

function writeJsonFile(file: SettingsFile): void {
	mkdirSync(dirname(file.path), { recursive: true });
	writeFileSync(file.path, `${JSON.stringify(file.json, null, 2)}\n`, "utf8");
	file.exists = true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function getOrCreateRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
	const current = asRecord(parent[key]);
	if (current) return current;
	const created: Record<string, unknown> = {};
	parent[key] = created;
	return created;
}

function piSettingsFiles(cwd = process.cwd()): SettingsFile[] {
	return [readJsonObject(join(userPiDir(), "settings.json")), readJsonObject(projectSettingsPath(cwd))];
}

function packageConfigFromFile(file: SettingsFile): Record<string, unknown> | undefined {
	return asRecord(asRecord(asRecord(file.json.vstack)?.extensionManager)?.config)?.[PACKAGE_ID] as Record<string, unknown> | undefined;
}

function readVstackConfig(cwd = process.cwd()): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	for (const file of piSettingsFiles(cwd)) {
		const config = packageConfigFromFile(file);
		if (config && typeof config === "object" && !Array.isArray(config)) Object.assign(merged, config);
	}
	return merged;
}

function settingBoolean(key: string, fallback: boolean, cwd = process.cwd()): boolean {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "boolean" ? value : fallback;
}

function settingString(key: string, fallback: string, cwd = process.cwd()): string {
	const value = readVstackConfig(cwd)[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function settingNumber(key: string, fallback: number, cwd = process.cwd()): number {
	const value = readVstackConfig(cwd)[key];
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
}

function settingOverlaySize(key: string, fallback: OverlaySize, cwd = process.cwd()): OverlaySize {
	const value = readVstackConfig(cwd)[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const trimmed = value.trim();
		if (/^\d+$/.test(trimmed)) return Number(trimmed);
		return trimmed;
	}
	return fallback;
}

function writeScopeForConfigKey(cwd: string, key: string): ExtensionInstallScope {
	const [user, project] = piSettingsFiles(cwd);
	if (packageConfigFromFile(project)?.[key] !== undefined) return "project";
	if (packageConfigFromFile(user)?.[key] !== undefined) return "global";
	return detectExtensionInstallScope(cwd);
}

function updatePackageConfig(cwd: string, updates: Record<string, unknown>, scope?: ExtensionInstallScope): void {
	const firstKey = Object.keys(updates)[0] ?? "enabled";
	const targetScope = scope ?? writeScopeForConfigKey(cwd, firstKey);
	const path = targetScope === "global" ? join(userPiDir(), "settings.json") : projectSettingsPath(cwd);
	const file = readJsonObject(path);
	const vstack = getOrCreateRecord(file.json, "vstack");
	const extensionManager = getOrCreateRecord(vstack, "extensionManager");
	const config = getOrCreateRecord(extensionManager, "config");
	const packageConfig = getOrCreateRecord(config, PACKAGE_ID);
	Object.assign(packageConfig, updates);
	writeJsonFile(file);
}

function normalizeDir(path: string): string {
	const normalized = resolve(path);
	return normalized.endsWith(sep) ? normalized : normalized + sep;
}

function isWithin(path: string, parent: string): boolean {
	return normalizeDir(path).startsWith(normalizeDir(parent));
}

function detectExtensionInstallScope(cwd: string): ExtensionInstallScope {
	try {
		const extensionFile = fileURLToPath(import.meta.url);
		if (isWithin(extensionFile, findProjectPiDir(cwd))) return "project";
		if (isWithin(extensionFile, getAgentDir())) return "global";
	} catch {
		// Fall through to global for unusual loaders.
	}
	return "global";
}

function setStartupHideEnabled(enabled: boolean): void {
	(globalThis as unknown as Record<PropertyKey, unknown>)[STARTUP_HIDE_ENABLED_SYMBOL] = enabled;
}

function startupHideEnabled(): boolean {
	return (globalThis as unknown as Record<PropertyKey, unknown>)[STARTUP_HIDE_ENABLED_SYMBOL] === true;
}

function patchInteractiveModeStartupSkillsBlock(): void {
	const prototype = InteractiveMode.prototype as unknown as Record<PropertyKey, unknown> & { showLoadedResources?: (...args: unknown[]) => unknown };
	if (prototype[STARTUP_PATCH_SYMBOL]) return;
	const originalShowLoadedResources = prototype.showLoadedResources;
	if (typeof originalShowLoadedResources !== "function") return;

	prototype.showLoadedResources = function patchedShowLoadedResources(this: unknown, ...args: unknown[]) {
		if (!startupHideEnabled()) return originalShowLoadedResources.apply(this, args);
		const interactiveMode = this as {
			session?: { resourceLoader?: { getSkills?: () => { skills: unknown[]; diagnostics?: unknown[] } } };
		};
		const resourceLoader = interactiveMode.session?.resourceLoader;
		if (!resourceLoader || typeof resourceLoader.getSkills !== "function") return originalShowLoadedResources.apply(this, args);
		const originalGetSkills = resourceLoader.getSkills;
		resourceLoader.getSkills = () => ({ ...originalGetSkills.call(resourceLoader), skills: [] });
		try {
			return originalShowLoadedResources.apply(this, args);
		} finally {
			resourceLoader.getSkills = originalGetSkills;
		}
	};
	prototype[STARTUP_PATCH_SYMBOL] = true;
}

function compareSkills(a: SkillEntry, b: SkillEntry): number {
	const scopeRank = (scope: SkillScope) => scope === "project" ? 0 : scope === "user" ? 1 : 2;
	const rank = scopeRank(a.scope) - scopeRank(b.scope);
	if (rank !== 0) return rank;
	if (a.origin !== b.origin) return a.origin === "top-level" ? -1 : 1;
	return a.name.localeCompare(b.name);
}

function parseSkillFile(path: string): Pick<SkillEntry, "name" | "description" | "content" | "frontmatter"> | null {
	try {
		const raw = readFileSync(path, "utf8");
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(raw);
		const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
		const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
		if (!name || !description) return null;
		return {
			name,
			description,
			content: stripFrontmatter(raw).trim(),
			frontmatter: Object.fromEntries(Object.entries(frontmatter).filter(([, value]) => value !== undefined)),
		};
	} catch {
		return null;
	}
}

function toSkillEntry(resource: ResolvedResource): SkillEntry | null {
	const parsed = parseSkillFile(resource.path);
	if (!parsed) return null;
	return {
		name: parsed.name,
		description: parsed.description,
		content: parsed.content,
		frontmatter: parsed.frontmatter,
		path: resource.path,
		scope: resource.metadata.scope as SkillScope,
		origin: resource.metadata.origin as SkillOrigin,
		source: resource.metadata.source,
		baseDir: resource.metadata.baseDir,
		enabled: resource.enabled,
	};
}

function dedupeByPath(skills: SkillEntry[]): SkillEntry[] {
	const seen = new Set<string>();
	const out: SkillEntry[] = [];
	for (const skill of skills) {
		if (seen.has(skill.path)) continue;
		seen.add(skill.path);
		out.push(skill);
	}
	return out;
}

async function loadSkillRegistry(cwd: string): Promise<SkillRegistry> {
	const settingsManager = SettingsManager.create(cwd, getAgentDir());
	const packageManager = new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager });
	const resolved = await packageManager.resolve();
	const allSkills = dedupeByPath(resolved.skills.map(toSkillEntry).filter((entry): entry is SkillEntry => entry !== null)).sort(compareSkills);
	const byName = new Map<string, SkillEntry>();
	for (const skill of allSkills) {
		if (!skill.enabled) continue;
		if (!byName.has(skill.name)) byName.set(skill.name, skill);
	}
	const skills = Array.from(byName.values()).sort(compareSkills);
	return { skills, allSkills, byName: new Map(skills.map((skill) => [skill.name, skill])) };
}

function isDeletableSkill(skill: SkillEntry): boolean {
	return skill.origin === "top-level" && (skill.scope === "project" || skill.scope === "user");
}

function skillStorageTarget(skill: SkillEntry): string {
	return basename(skill.path).toLowerCase() === "skill.md" ? dirname(skill.path) : skill.path;
}

async function deleteSkill(ctx: ExtensionContext, skill: SkillEntry): Promise<boolean> {
	if (!isDeletableSkill(skill)) {
		ctx.ui.notify("Only your own project and global skills can be deleted", "warning");
		return false;
	}
	rmSync(skillStorageTarget(skill), { recursive: true, force: true });
	ctx.ui.notify(`Deleted skill: ${skill.name}`, "info");
	return true;
}

function updatePatterns(current: string[], pattern: string, enabled: boolean): string[] {
	const updated = current.filter((entry) => {
		const stripped = entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-") ? entry.slice(1) : entry;
		return stripped !== pattern;
	});
	updated.push(`${enabled ? "+" : "-"}${pattern}`);
	return updated;
}

function getTopLevelPattern(skill: SkillEntry, cwd: string): string {
	const baseDir = skill.scope === "project" ? findProjectPiDir(cwd) : getAgentDir();
	return relative(baseDir, skill.path);
}

function getPackagePattern(skill: SkillEntry): string {
	const baseDir = skill.baseDir ?? dirname(skill.path);
	return relative(baseDir, skill.path);
}

function hasPackageFilters(pkg: Exclude<PackageSource, string>): boolean {
	return pkg.extensions !== undefined || pkg.skills !== undefined || pkg.prompts !== undefined || pkg.themes !== undefined;
}

async function setSkillEnabled(cwd: string, skill: SkillEntry, enabled: boolean): Promise<void> {
	if (skill.scope === "temporary") throw new Error("Temporary skills cannot be toggled.");
	const settingsManager = SettingsManager.create(cwd, getAgentDir());

	if (skill.origin === "top-level") {
		const settings = skill.scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
		const updated = updatePatterns([...(settings.skills ?? [])], getTopLevelPattern(skill, cwd), enabled);
		if (skill.scope === "project") settingsManager.setProjectSkillPaths(updated);
		else settingsManager.setSkillPaths(updated);
		await settingsManager.flush();
		return;
	}

	const settings = skill.scope === "project" ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
	const packages = [...(settings.packages ?? [])];
	const packageIndex = packages.findIndex((pkg) => (typeof pkg === "string" ? pkg : pkg.source) === skill.source);
	if (packageIndex === -1) throw new Error("Could not find the package settings entry for this skill.");

	const packageEntry = packages[packageIndex];
	const packageConfig = typeof packageEntry === "string" ? { source: packageEntry } : { ...packageEntry };
	const updated = updatePatterns([...(packageConfig.skills ?? [])], getPackagePattern(skill), enabled);
	packageConfig.skills = updated.length > 0 ? updated : undefined;
	packages[packageIndex] = hasPackageFilters(packageConfig) ? packageConfig : packageConfig.source;
	if (skill.scope === "project") settingsManager.setProjectPackages(packages);
	else settingsManager.setPackages(packages);
	await settingsManager.flush();
}

function normalizeSkillName(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9-\s]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function getTargetDir(ctx: ExtensionContext, location: SkillLocation, skillName: string): string {
	return location === "global" ? join(getAgentDir(), "skills", skillName) : join(findProjectPiDir(ctx.cwd), "skills", skillName);
}

function formatScalar(value: unknown): string {
	if (typeof value === "string") {
		if (value.length === 0) return '""';
		if (/^[A-Za-z0-9_./@,+()[\]\- ]+$/.test(value) && !value.includes(": ") && !/^\s|\s$/.test(value)) return value;
		return JSON.stringify(value);
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null) return "null";
	return JSON.stringify(value);
}

function formatYamlValue(key: string, value: unknown, indent = ""): string[] {
	if (typeof value === "string" && value.includes("\n")) {
		return [`${indent}${key}: |`, ...value.split("\n").map((line) => `${indent}  ${line}`)];
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return [`${indent}${key}: []`];
		return [
			`${indent}${key}:`,
			...value.flatMap((item) => {
				if (item && typeof item === "object") {
					return [`${indent}  -`, ...Object.entries(item as Record<string, unknown>).flatMap(([nestedKey, nestedValue]) => formatYamlValue(nestedKey, nestedValue, `${indent}    `))];
				}
				return [`${indent}  - ${formatScalar(item)}`];
			}),
		];
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) return [`${indent}${key}: {}`];
		return [`${indent}${key}:`, ...entries.flatMap(([nestedKey, nestedValue]) => formatYamlValue(nestedKey, nestedValue, `${indent}  `))];
	}
	return [`${indent}${key}: ${formatScalar(value)}`];
}

function buildFrontmatterBlock(skill: SkillEntry): string {
	const frontmatter = skill.frontmatter ?? { name: skill.name, description: skill.description };
	const lines = Object.entries(frontmatter).flatMap(([key, value]) => formatYamlValue(key, value));
	return ["---", ...lines, "---"].join("\n");
}

function buildSkillDocument(skill: SkillEntry): string {
	const frontmatter = buildFrontmatterBlock(skill);
	const content = skill.content.trim();
	return content ? `${frontmatter}\n\n${content}\n` : `${frontmatter}\n`;
}

function buildEditableSkillDocument(skill: SkillEntry, raw?: string): string {
	const source = raw ?? buildSkillDocument(skill);
	const parsed = parseFrontmatter<Record<string, unknown>>(source);
	const frontmatter = { ...parsed.frontmatter };
	delete frontmatter.name;
	const editableBlock = ["---", ...Object.entries(frontmatter).flatMap(([key, value]) => formatYamlValue(key, value)), "---"].join("\n");
	const content = stripFrontmatter(source).trim();
	return content ? `${editableBlock}\n\n${content}\n` : `${editableBlock}\n`;
}

function readSkillDocument(skill: SkillEntry): string {
	try {
		return readFileSync(skill.path, "utf8");
	} catch {
		return buildSkillDocument(skill);
	}
}

function frontmatterToRaw(frontmatter: Record<string, unknown>, content: string): string {
	const block = ["---", ...Object.entries(frontmatter).flatMap(([key, value]) => formatYamlValue(key, value)), "---"].join("\n");
	return content.trim() ? `${block}\n\n${content.trim()}\n` : `${block}\n`;
}

function parseSkillDocument(raw: string, expectedName: string): ParsedSkillDocument {
	const parsed = parseFrontmatter<Record<string, unknown>>(raw);
	const name = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name.trim() : "";
	const description = typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description.trim() : "";
	if (!name || !description) throw new Error("Skill must include frontmatter fields 'name' and 'description'");
	if (name !== expectedName) throw new Error(`Frontmatter name must stay '${expectedName}'`);
	const frontmatter = Object.fromEntries(Object.entries(parsed.frontmatter).filter(([, value]) => value !== undefined));
	const content = stripFrontmatter(raw).trim();
	return { name, description, frontmatter, content, raw: frontmatterToRaw(frontmatter, content) };
}

function parseEditableSkillDocument(raw: string, expectedName: string): ParsedSkillDocument {
	const parsed = parseFrontmatter<Record<string, unknown>>(raw);
	if (typeof parsed.frontmatter.name === "string") throw new Error("Name is immutable here. Use Rename instead.");
	const frontmatter: Record<string, unknown> = {
		name: expectedName,
		...Object.fromEntries(Object.entries(parsed.frontmatter).filter(([, value]) => value !== undefined)),
	};
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!description) throw new Error("Skill must include frontmatter field 'description'");
	const content = stripFrontmatter(raw).trim();
	return { name: expectedName, description, frontmatter, content, raw: frontmatterToRaw(frontmatter, content) };
}

function toUpdatedSkill(skill: SkillEntry, parsed: ParsedSkillDocument): SkillEntry {
	return { ...skill, name: parsed.name, description: parsed.description, content: parsed.content, frontmatter: parsed.frontmatter };
}

function buildFallbackSkill(answers: SkillCreationAnswers): string {
	const frontmatter: Record<string, unknown> = { name: answers.name, description: answers.description };
	if (answers.allowedTools.length > 0) frontmatter["allowed-tools"] = answers.allowedTools.join(" ");
	const sections = [
		frontmatterToRaw(frontmatter, "").trim(),
		`# ${answers.name}`,
		"## Core workflow",
		"- Confirm the request matches the skill description and the user's current goal.",
		"- Inspect relevant inputs before acting; do not assume project-specific conventions without evidence.",
		"- Apply the most direct workflow for the task and keep outputs concrete.",
		"- Call out important edge cases, constraints, and verification steps before finishing.",
	];
	if (answers.exampleRequests?.trim()) sections.push("## Example requests", answers.exampleRequests.trim());
	if (answers.domainContext?.trim()) sections.push("## Domain context", answers.domainContext.trim());
	return `${sections.join("\n\n").trim()}\n`;
}

function getEffectiveReasoningLevel(ctx: ExtensionContext, thinkingLevel?: ThinkingLevel | "off"): ThinkingLevel | undefined {
	if (!ctx.model?.reasoning || !thinkingLevel || thinkingLevel === "off") return undefined;
	return thinkingLevel;
}

function isAbortError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const name = "name" in error ? String((error as { name?: unknown }).name) : "";
	const message = "message" in error ? String((error as { message?: unknown }).message) : "";
	return name === "AbortError" || message.toLowerCase().includes("aborted");
}

async function generateSkillDraft(ctx: ExtensionContext, answers: SkillCreationAnswers, options?: SkillGenerationOptions): Promise<string> {
	if (options?.signal?.aborted) throw new Error("Generation aborted");
	if (!settingBoolean("aiGenerationEnabled", true, ctx.cwd) || !ctx.model) return buildFallbackSkill(answers);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) return buildFallbackSkill(answers);

	const userMessage: UserMessage = {
		role: "user",
		content: [{
			type: "text",
			text: [
				"Create a Pi skill SKILL.md.",
				"",
				"Inputs:",
				`- skill_slug: ${answers.name}`,
				`- requested_description: ${answers.description}`,
				`- save_location: ${answers.location}`,
				answers.allowedTools.length > 0 ? `- allowed_tools: ${answers.allowedTools.join(" ")}` : "- allowed_tools: (none)",
				`- example_requests: ${answers.exampleRequests?.trim() || "(none)"}`,
				`- domain_context: ${answers.domainContext?.trim() || "(none)"}`,
				"",
				"Make the description specific enough for Pi's skill trigger list. Keep the body compact and execution-oriented.",
			].join("\n"),
		}],
		timestamp: Date.now(),
	};
	const reasoning = getEffectiveReasoningLevel(ctx, options?.thinkingLevel);
	const response = await completeSimple(
		ctx.model,
		{ systemPrompt: GENERATE_SKILL_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers, ...(reasoning ? { reasoning } : {}), ...(options?.signal ? { signal: options.signal } : {}) },
	);
	if (options?.signal?.aborted) throw new Error("Generation aborted");
	const generated = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n").trim();
	if (!generated) return buildFallbackSkill(answers);
	try {
		parseSkillDocument(generated, answers.name);
		return generated;
	} catch {
		return buildFallbackSkill(answers);
	}
}

async function saveCreatedSkill(ctx: ExtensionContext, answers: SkillCreationAnswers, draft: string): Promise<SkillEntry | null> {
	let parsed: ParsedSkillDocument;
	try {
		parsed = parseSkillDocument(draft, answers.name);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : "Invalid generated SKILL.md", "error");
		return null;
	}
	const targetDir = getTargetDir(ctx, answers.location, answers.name);
	const targetPath = join(targetDir, "SKILL.md");
	await mkdir(targetDir, { recursive: true });
	await writeFile(targetPath, parsed.raw, "utf8");
	ctx.ui.notify(`Created skill: ${targetPath}`, "info");
	return {
		name: parsed.name,
		description: parsed.description,
		path: targetPath,
		content: parsed.content,
		frontmatter: parsed.frontmatter,
		scope: answers.location === "global" ? "user" : "project",
		origin: "top-level",
		source: "auto",
		baseDir: targetDir,
		enabled: true,
	};
}

async function createSkillFromAnswers(ctx: ExtensionContext, answers: SkillCreationAnswers, options?: SkillGenerationOptions): Promise<SkillEntry | null> {
	const targetPath = join(getTargetDir(ctx, answers.location, answers.name), "SKILL.md");
	if (existsSync(targetPath)) {
		ctx.ui.notify(`Skill already exists: ${targetPath}`, "error");
		return null;
	}
	let draft: string;
	try {
		draft = await generateSkillDraft(ctx, answers, options);
	} catch (error) {
		if (isAbortError(error) || options?.signal?.aborted) return null;
		draft = buildFallbackSkill(answers);
	}
	if (options?.signal?.aborted) return null;
	return await saveCreatedSkill(ctx, answers, draft);
}

function buildNativeSkillCommand(skillName: string, args = ""): string {
	const trimmedArgs = args.trim();
	return `/skill:${skillName}${trimmedArgs ? ` ${trimmedArgs}` : ""}`;
}

function insertNativeSkillCommand(ctx: ExtensionContext, skill: SkillEntry): void {
	ctx.ui.pasteToEditor(`${buildNativeSkillCommand(skill.name)}\n`);
}

function scopeLabel(skill: SkillEntry): string {
	return skill.scope === "project" ? "project" : skill.scope === "user" ? "global" : "temporary";
}

function packageLabel(skill: SkillEntry): string | undefined {
	return skill.origin === "package" && skill.source ? skill.source : undefined;
}

function skillLocation(skill: SkillEntry): string {
	return skill.origin === "package" ? skill.source : skill.path;
}

function inlineLine(text: string): string {
	return text.replace(/[\r\n]+/g, " ").replace(/\t/g, " ");
}

function acquireVstackModalLock(): () => void {
	const host = globalThis as unknown as Record<PropertyKey, unknown>;
	const existing = host[VSTACK_MODAL_LOCK_SYMBOL] as VstackModalLock | undefined;
	const lock = existing && typeof existing.depth === "number" ? existing : { depth: 0 };
	host[VSTACK_MODAL_LOCK_SYMBOL] = lock;
	lock.depth += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		lock.depth = Math.max(0, lock.depth - 1);
	};
}

function padAnsi(text: string, width: number): string {
	const safeWidth = Math.max(0, width);
	const truncated = truncateToWidth(inlineLine(text), safeWidth, "");
	return `${truncated}${" ".repeat(Math.max(0, safeWidth - visibleWidth(truncated)))}`;
}

function toneText(theme: Theme, tone: MessageTone, text: string): string {
	if (tone === "error") return theme.fg("error", text);
	if (tone === "success") return theme.fg("success", text);
	return theme.fg("dim", text);
}

function skillEntityTitle(theme: Theme, label: string): string {
	return theme.fg("text", theme.bold(label));
}

function skillSectionTitle(theme: Theme, label: string): string {
	return theme.fg("muted", theme.bold(label));
}

function skillSelectedLine(theme: Theme, line: string, width: number): string {
	return theme.bg("selectedBg", padAnsi(line, width));
}

function skillKeyHints(theme: Theme, hints: Array<[key: string, description: string]>): string {
	return hints
		.map(([key, description]) => `${ansiYellow(key)} ${theme.fg("dim", description)}`)
		.join(theme.fg("dim", " • "));
}

function frameLine(theme: Theme, line: string, innerWidth: number): string {
	const clipped = truncateToWidth(inlineLine(line), innerWidth, theme.fg("dim", "..."));
	return `${theme.fg("borderAccent", "┃ ")}${padAnsi(clipped, innerWidth)}${theme.fg("borderAccent", " ┃")}`;
}

function fitFrameBody(theme: Theme, lines: string[], fixedInnerRows?: number): string[] {
	if (fixedInnerRows === undefined) return lines;
	const rowCount = Math.max(1, Math.floor(fixedInnerRows));
	if (lines.length > rowCount) {
		const hidden = lines.length - rowCount + 1;
		return [...lines.slice(0, Math.max(0, rowCount - 1)), theme.fg("dim", `↓ ${hidden} more line(s)`)].slice(0, rowCount);
	}
	if (lines.length < rowCount) return [...lines, ...Array.from({ length: rowCount - lines.length }, () => "")];
	return lines;
}

function renderFrame(theme: Theme, width: number, lines: string[], fixedInnerRows?: number, title = "", right = ""): string[] {
	const body = fitFrameBody(theme, lines, fixedInnerRows);
	if (width < 6) return body.map((line) => truncateToWidth(inlineLine(line), width, ""));
	const innerWidth = Math.max(1, width - 4);
	const top = () => {
		const contentWidth = innerWidth + 2;
		if (!title && !right) return theme.fg("borderAccent", `┏${"━".repeat(contentWidth)}┓`);
		const rightPlain = right ? ` ${right} ` : "";
		const titleBudget = Math.max(1, contentWidth - visibleWidth(rightPlain) - 1);
		const titlePlain = title ? ` ${truncateToWidth(title, Math.max(1, titleBudget - 2), "…")} ` : "";
		const fill = Math.max(1, contentWidth - visibleWidth(titlePlain) - visibleWidth(rightPlain));
		return `${theme.fg("borderAccent", "┏")}${titlePlain ? ansiGreen(titlePlain) : ""}${theme.fg("borderAccent", "━".repeat(fill))}${rightPlain ? theme.fg("dim", rightPlain) : ""}${theme.fg("borderAccent", "┓")}`;
	};
	return [
		top(),
		...body.map((line) => frameLine(theme, line, innerWidth)),
		theme.fg("borderAccent", `┗${"━".repeat(innerWidth + 2)}┛`),
	].map((line) => truncateToWidth(inlineLine(line), width, ""));
}

function centerLines(lines: string[], width: number): string[] {
	const renderedWidth = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
	const leftPad = Math.max(0, Math.floor((width - renderedWidth) / 2));
	return leftPad === 0 ? lines : lines.map((line) => `${" ".repeat(leftPad)}${line}`);
}

function renderCenteredDialog(theme: Theme, width: number, lines: string[], maxInnerWidth = 68): string[] {
	if (width < 8) return lines.map((line) => truncateToWidth(line, width, ""));
	const innerWidth = Math.max(1, Math.min(width - 4, maxInnerWidth));
	const framed = [
		theme.fg("borderAccent", `┏${"━".repeat(innerWidth + 2)}┓`),
		...lines.map((line) => frameLine(theme, line, innerWidth)),
		theme.fg("borderAccent", `┗${"━".repeat(innerWidth + 2)}┛`),
	];
	return centerLines(framed, width);
}

function getEditorTheme(theme: Theme) {
	return {
		borderColor: (text: string) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.bg("selectedBg", theme.fg("text", text)),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		},
	};
}

class SingleLineText implements Component {
	constructor(private readonly text: string, private readonly ellipsis = "...") {}
	render(width: number): string[] { return [truncateToWidth(inlineLine(this.text), width, this.ellipsis)]; }
	invalidate(): void {}
}

class ListLineText implements Component {
	constructor(private readonly text: string, private readonly selected: boolean, private readonly theme: Theme, private readonly ellipsis = "...") {}
	render(width: number): string[] {
		const line = truncateToWidth(inlineLine(this.text), width, this.ellipsis);
		return [this.selected ? skillSelectedLine(this.theme, line, width) : line];
	}
	invalidate(): void {}
}

class PrefixedEditor implements Component {
	constructor(private readonly editor: Editor, private readonly prefix = "> ") {}
	render(width: number): string[] {
		const rendered = this.editor.render(Math.max(1, width - this.prefix.length));
		const lines = rendered.length >= 2 ? rendered.slice(1, -1) : rendered;
		return lines.length === 0 ? [this.prefix] : lines.map((line, index) => `${index === 0 ? this.prefix : "  "}${line}`);
	}
	invalidate(): void { this.editor.invalidate(); }
}

class SearchInputLine implements Component {
	constructor(private readonly input: Input, private readonly theme: Theme, private readonly prefix = " ") {}
	render(width: number): string[] {
		const inputWidth = Math.max(1, width - visibleWidth(this.prefix));
		const line = truncateToWidth(`${this.prefix}${this.input.render(inputWidth)[0] ?? ""}`, width, "");
		return [this.theme.bg("toolPendingBg", padAnsi(line, width))];
	}
	invalidate(): void { this.input.invalidate(); }
}

class ScrollableSkillPreview implements Component {
	private scrollOffset = 0;
	private lastInnerWidth = 1;
	private lastContentLines: string[] = [];
	constructor(private skill: SkillEntry, private readonly theme: Theme, private readonly getTerminalRows: () => number) {}
	setSkill(skill: SkillEntry): void { this.skill = skill; this.scrollOffset = 0; this.lastContentLines = []; }
	invalidate(): void { this.lastContentLines = []; }
	private maxHeight(): number { return Math.max(10, Math.floor(this.getTerminalRows() * 0.78)); }
	private buildContentLines(innerWidth: number): string[] {
		const content = new Container();
		const status = this.skill.enabled ? this.theme.fg("success", "enabled") : this.theme.fg("warning", "disabled");
		const source = packageLabel(this.skill) ? `${packageLabel(this.skill)}` : this.skill.path;
		content.addChild(new Text(skillEntityTitle(this.theme, this.skill.name), 0, 0));
		content.addChild(new Text(`${this.theme.fg("muted", scopeLabel(this.skill))}${this.theme.fg("dim", " • ")}${this.theme.fg("muted", source)}${this.theme.fg("dim", " • ")}${status}`, 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(this.theme.fg("muted", this.theme.bold("Description")), 0, 0));
		content.addChild(new Text(this.skill.description, 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(this.theme.fg("muted", this.theme.bold("Metadata")), 0, 0));
		content.addChild(new Text(this.theme.fg("dim", buildFrontmatterBlock(this.skill)), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(this.theme.fg("muted", this.theme.bold("Content")), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Markdown(this.skill.content || this.theme.fg("dim", "(empty skill body)"), 0, 0, getMarkdownTheme()));
		const lines = content.render(innerWidth);
		this.lastInnerWidth = innerWidth;
		this.lastContentLines = lines;
		return lines;
	}
	private footer(innerWidth: number, visibleHeight: number, totalLines: number): string {
		const maxScroll = Math.max(0, totalLines - visibleHeight);
		const scroll = maxScroll > 0 ? this.theme.fg("dim", ` • ${this.scrollOffset + 1}-${Math.min(totalLines, this.scrollOffset + visibleHeight)}/${totalLines}`) : "";
		const hints: Array<[string, string]> = [["-/=", "page"]];
		if (this.skill.enabled) hints.push(["enter", "insert"]);
		hints.push(["ctrl+x", "enable/disable"]);
		if (isDeletableSkill(this.skill)) hints.push(["ctrl+e", "edit"], ["ctrl+r", "rename"], ["backspace", "delete"]);
		hints.push(["esc", "back"]);
		return truncateToWidth(`${skillKeyHints(this.theme, hints)}${scroll}`, innerWidth, this.theme.fg("dim", "..."));
	}
	render(width: number): string[] {
		if (width < 8) return [];
		const innerWidth = Math.max(1, width - 4);
		const visibleHeight = Math.max(1, this.maxHeight() - 3);
		const contentLines = this.buildContentLines(innerWidth);
		const maxScroll = Math.max(0, contentLines.length - visibleHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
		const visible = contentLines.slice(this.scrollOffset, this.scrollOffset + visibleHeight);
		return renderFrame(this.theme, width, [...visible, this.footer(innerWidth, visibleHeight, contentLines.length)]);
	}
	handleInput(data: string): void {
		const visibleHeight = Math.max(1, this.maxHeight() - 3);
		const total = this.lastContentLines.length || this.buildContentLines(this.lastInnerWidth).length;
		const maxScroll = Math.max(0, total - visibleHeight);
		if (matchesKey(data, Key.up)) this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		else if (matchesKey(data, Key.down)) this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
		else if (matchesKey(data, "-") || matchesKey(data, Key.pageUp)) this.scrollOffset = Math.max(0, this.scrollOffset - visibleHeight);
		else if (matchesKey(data, "=") || matchesKey(data, Key.pageDown)) this.scrollOffset = Math.min(maxScroll, this.scrollOffset + visibleHeight);
		else if (matchesKey(data, Key.home)) this.scrollOffset = 0;
		else if (matchesKey(data, Key.end)) this.scrollOffset = maxScroll;
	}
}

class SkillEditorView implements Component, Focusable {
	private readonly editor: Editor;
	private readonly initialText: string;
	private readonly proxyTui: TUI;
	private virtualRows = 24;
	private _focused = false;
	private message: { text: string; tone: MessageTone } | undefined;
	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.editor.focused = value; }
	constructor(
		private skill: SkillEntry,
		private readonly theme: Theme,
		private readonly realTui: TUI,
		initialText: string,
		private readonly onSave: (value: string) => void,
		private readonly onCancel: () => void,
	) {
		this.initialText = initialText;
		const self = this;
		this.proxyTui = { requestRender: () => realTui.requestRender(), get terminal() { return { ...realTui.terminal, rows: Math.max(1, self.virtualRows) }; } } as TUI;
		this.editor = new Editor(this.proxyTui, getEditorTheme(theme), { autocompleteMaxVisible: 6 });
		this.editor.setText(initialText);
	}
	setSkill(skill: SkillEntry): void { this.skill = skill; }
	setMessage(text: string, tone: MessageTone): void { this.message = { text, tone }; }
	isDirty(): boolean { return this.editor.getText() !== this.initialText; }
	invalidate(): void { this.editor.invalidate(); }
	private targetHeight(): number { return Math.max(10, Math.floor(this.realTui.terminal.rows * 0.78)); }
	private rowsForVisibleEditorLines(targetVisibleLines: number): number {
		let rows = 5;
		while (Math.max(5, Math.floor(rows * 0.3)) < targetVisibleLines && rows < 1000) rows += 1;
		return rows;
	}
	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		const lines: string[] = [
			skillEntityTitle(this.theme, `Edit ${this.skill.name}`),
			this.theme.fg("muted", skillLocation(this.skill)),
			this.theme.fg("dim", `Name is immutable here: ${this.skill.name}`),
		];
		if (this.message) lines.push("", toneText(this.theme, this.message.tone, this.message.text));
		const targetInnerLines = Math.max(1, this.targetHeight() - 2);
		const staticLineCount = lines.length + 3;
		const editorBlockLines = Math.max(7, targetInnerLines - staticLineCount);
		this.virtualRows = this.rowsForVisibleEditorLines(Math.max(5, editorBlockLines - 2));
		lines.push("", ...this.editor.render(innerWidth), "", truncateToWidth(skillKeyHints(this.theme, [["ctrl+s", "save"], ["esc", "back"]]), innerWidth, this.theme.fg("dim", "...")));
		while (lines.length < targetInnerLines) lines.splice(Math.max(0, lines.length - 1), 0, "");
		return renderFrame(this.theme, width, lines.slice(0, targetInnerLines));
	}
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) { this.onCancel(); return; }
		if (matchesKey(data, Key.ctrl("s"))) { this.onSave(this.editor.getText()); return; }
		if (this.message?.tone === "error") this.message = undefined;
		this.editor.handleInput(data);
	}
}

async function renameSkillEntry(ctx: ExtensionContext, skill: SkillEntry, entered: string): Promise<SkillEntry | null> {
	if (!isDeletableSkill(skill)) {
		ctx.ui.notify("Only your own project and global skills can be renamed", "warning");
		return null;
	}
	const normalizedName = normalizeSkillName(entered);
	if (!normalizedName) throw new Error("Name must contain letters, numbers, or hyphens");
	if (normalizedName === skill.name) {
		ctx.ui.notify("Skill name unchanged", "info");
		return skill;
	}
	const isDirectorySkill = basename(skill.path).toLowerCase() === "skill.md";
	const currentTarget = isDirectorySkill ? dirname(skill.path) : skill.path;
	const parentDir = dirname(currentTarget);
	const targetPath = isDirectorySkill ? join(parentDir, normalizedName, "SKILL.md") : join(parentDir, `${normalizedName}${extname(skill.path) || ".md"}`);
	const targetTarget = isDirectorySkill ? dirname(targetPath) : targetPath;
	if (existsSync(targetTarget) || existsSync(targetPath)) throw new Error(`Skill already exists: ${normalizedName}`);
	const parsed = parseSkillDocument(readFileSync(skill.path, "utf8"), skill.name);
	const renamedFrontmatter = { ...parsed.frontmatter, name: normalizedName };
	const updatedRaw = frontmatterToRaw(renamedFrontmatter, parsed.content);
	renameSync(currentTarget, targetTarget);
	writeFileSync(targetPath, updatedRaw, "utf8");
	const renamed: SkillEntry = { ...skill, name: normalizedName, path: targetPath, frontmatter: renamedFrontmatter, baseDir: isDirectorySkill ? dirname(targetPath) : dirname(targetPath) };
	ctx.ui.notify(`Renamed skill: ${skill.name} → ${normalizedName}`, "info");
	return renamed;
}

class SkillsManagerDialog implements Focusable {
	private mode: Mode = "browse";
	private _focused = false;
	private registry: SkillRegistry;
	private filteredSkills: SkillEntry[] = [];
	private selectedIndex: number;
	private browseQuery: string;
	private readonly browseInput = new Input();
	private readonly descriptionEditor: Editor;
	private readonly renameInput = new Input();
	private createStepIndex = 0;
	private createValues: Record<CreateTextStepId, string> = { name: "", description: "" };
	private createLocation: SkillLocation;
	private submittedDescriptionValue: string | undefined;
	private createError: string | undefined;
	private previewSkillPath: string | undefined;
	private preview: ScrollableSkillPreview | undefined;
	private editorView: SkillEditorView | undefined;
	private renameError: string | undefined;
	private deleteSkillPath: string | undefined;
	private deleteReturnMode: "browse" | "preview" = "browse";
	private generationAbortController: AbortController | undefined;
	private generationRunId = 0;
	private readonly listRows: number;

	constructor(
		private readonly ctx: ExtensionContext,
		registry: SkillRegistry,
		private readonly theme: Theme,
		private readonly tui: TUI,
		private readonly done: (skill: SkillEntry | null) => void,
		private readonly options: SkillsManagerOptions,
		private readonly requestRender: () => void,
		initialSelectedIndex = 0,
		initialQuery = "",
	) {
		this.registry = registry;
		this.selectedIndex = Math.max(0, initialSelectedIndex);
		this.browseQuery = initialQuery;
		this.browseInput.setValue(initialQuery);
		this.createLocation = settingString("defaultCreateLocation", "project", ctx.cwd) === "global" ? "global" : "project";
		this.listRows = Math.max(6, Math.floor(settingNumber("listRows", DEFAULT_LIST_ROWS, ctx.cwd)));
		this.descriptionEditor = new Editor(tui, { borderColor: (text: string) => " ".repeat(text.length), selectList: getEditorTheme(theme).selectList });
		this.descriptionEditor.onSubmit = (text: string) => { this.submittedDescriptionValue = text; void this.advanceCreate(); };
		this.renameInput.onSubmit = (value) => { void this.submitRename(value); };
		this.refreshBrowseList();
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.syncFocus(); }
	invalidate(): void { this.browseInput.invalidate(); this.descriptionEditor.invalidate(); this.renameInput.invalidate(); this.preview?.invalidate(); this.editorView?.invalidate(); }

	private syncFocus(): void {
		this.browseInput.focused = this._focused && (this.mode === "browse" || (this.mode === "create" && this.currentCreateStep.id === "name"));
		this.descriptionEditor.focused = this._focused && this.mode === "create" && this.currentCreateStep.id === "description";
		this.renameInput.focused = this._focused && this.mode === "rename";
		if (this.editorView) this.editorView.focused = this._focused && this.mode === "edit";
	}

	private searchableText(skill: SkillEntry): string {
		return [skill.name, skill.description, scopeLabel(skill), skill.origin, skill.source, skill.path, skill.baseDir ?? ""].join(" ").toLowerCase();
	}

	private filterSkills(query: string): SkillEntry[] {
		const trimmed = query.trim().toLowerCase();
		if (!trimmed) return this.registry.allSkills;
		const tokens = trimmed.split(/\s+/).filter(Boolean);
		return this.registry.allSkills.filter((skill) => tokens.every((token) => this.searchableText(skill).includes(token)));
	}

	private orderBrowseSkills(skills: SkillEntry[]): SkillEntry[] {
		const own = skills.filter((skill) => isDeletableSkill(skill));
		const library = skills.filter((skill) => !isDeletableSkill(skill));
		return [...own, ...library];
	}

	private refreshBrowseList(preferredPath?: string): void {
		const currentPath = preferredPath ?? this.getSelectedSkill()?.path;
		this.filteredSkills = this.orderBrowseSkills(this.filterSkills(this.browseQuery));
		if (currentPath) {
			const nextIndex = this.filteredSkills.findIndex((skill) => skill.path === currentPath);
			if (nextIndex >= 0) { this.selectedIndex = nextIndex + 1; return; }
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredSkills.length));
	}

	private getSelectedSkill(): SkillEntry | undefined { return this.selectedIndex === 0 ? undefined : this.filteredSkills[this.selectedIndex - 1]; }
	private getCurrentSkill(): SkillEntry | undefined { return this.previewSkillPath ? this.registry.allSkills.find((skill) => skill.path === this.previewSkillPath) : undefined; }
	private get currentCreateStep(): CreateStep { return CREATE_STEPS[this.createStepIndex]!; }

	private enterCreateMode(): void { this.mode = "create"; this.createStepIndex = 0; this.createError = undefined; this.syncCreateInput(); this.syncFocus(); this.requestRender(); }
	private exitToBrowse(preferredPath?: string): void {
		this.mode = "browse"; this.createError = undefined; this.renameError = undefined; this.previewSkillPath = undefined; this.preview = undefined; this.editorView = undefined; this.deleteSkillPath = undefined;
		this.browseInput.setValue(this.browseQuery); this.refreshBrowseList(preferredPath); this.syncFocus(); this.requestRender();
	}
	private openPreview(skill: SkillEntry): void { this.previewSkillPath = skill.path; this.preview = new ScrollableSkillPreview(skill, this.theme, () => this.tui.terminal.rows); this.mode = "preview"; this.syncFocus(); this.requestRender(); }
	private openDeleteConfirm(skill: SkillEntry, returnMode: "browse" | "preview"): void { this.deleteSkillPath = skill.path; this.deleteReturnMode = returnMode; this.mode = "delete-confirm"; this.syncFocus(); this.requestRender(); }
	private openEditor(): void {
		const skill = this.getCurrentSkill();
		if (!skill || !isDeletableSkill(skill)) return;
		this.editorView = new SkillEditorView(skill, this.theme, this.tui, buildEditableSkillDocument(skill, readSkillDocument(skill)), (value) => { void this.saveEditedSkill(value); }, () => this.closeEditorMaybeConfirm());
		this.mode = "edit"; this.syncFocus(); this.requestRender();
	}
	private closeEditor(): void { this.editorView = undefined; this.mode = "preview"; this.syncFocus(); this.requestRender(); }
	private closeEditorMaybeConfirm(): void { this.closeEditor(); }
	private openRenameDialog(): void {
		const skill = this.getCurrentSkill();
		if (!skill || !isDeletableSkill(skill)) return;
		this.renameError = undefined; this.renameInput.setValue(skill.name); this.mode = "rename"; this.syncFocus(); this.requestRender();
	}
	private closeRenameDialog(): void { this.renameError = undefined; this.mode = "preview"; this.syncFocus(); this.requestRender(); }

	private syncCreateInput(): void {
		const step = this.currentCreateStep;
		if (step.id === "name") this.browseInput.setValue(this.createValues.name);
		if (step.id === "description") { this.submittedDescriptionValue = undefined; this.descriptionEditor.setText(this.createValues.description); }
	}
	private persistCreateInput(): void {
		const step = this.currentCreateStep;
		if (step.id === "name") this.createValues.name = this.browseInput.getValue();
		else if (step.id === "description") {
			this.createValues.description = this.submittedDescriptionValue !== undefined ? this.submittedDescriptionValue : this.descriptionEditor.getText();
			this.submittedDescriptionValue = undefined;
		}
	}
	private validateCreateStep(): boolean {
		this.persistCreateInput();
		const step = this.currentCreateStep;
		if (step.kind === "text" && !step.optional) {
			const value = this.createValues[step.id].trim();
			if (!value) { this.createError = `${step.title} is required.`; return false; }
			if (step.id === "name" && !normalizeSkillName(value)) { this.createError = "Name must contain letters, numbers, or hyphens."; return false; }
		}
		this.createError = undefined;
		return true;
	}
	private goToPreviousCreateStep(): void { this.persistCreateInput(); if (this.createStepIndex > 0) { this.createError = undefined; this.createStepIndex -= 1; this.syncCreateInput(); this.syncFocus(); } }
	private async advanceCreate(): Promise<void> { if (!this.validateCreateStep()) return; if (this.createStepIndex >= CREATE_STEPS.length - 1) await this.submitCreate(); else { this.createStepIndex += 1; this.syncCreateInput(); this.syncFocus(); } this.requestRender(); }
	private async submitCreate(): Promise<void> {
		const name = normalizeSkillName(this.createValues.name);
		if (!name) { this.createStepIndex = 0; this.syncCreateInput(); this.createError = "Name is required."; return; }
		if (!this.createValues.description.trim()) { this.createStepIndex = 1; this.syncCreateInput(); this.createError = "Description is required."; return; }
		this.mode = "generating";
		const runId = ++this.generationRunId;
		const abortController = new AbortController();
		this.generationAbortController = abortController;
		this.syncFocus(); this.requestRender();
		const created = await this.options.onCreate({ name, description: this.createValues.description.trim(), allowedTools: [], location: this.createLocation }, abortController.signal);
		if (this.generationRunId !== runId) return;
		this.generationAbortController = undefined;
		if (abortController.signal.aborted || !created) { this.mode = "create"; this.syncFocus(); this.requestRender(); return; }
		await this.refreshRegistry(created.path);
		this.openPreview(this.registry.allSkills.find((skill) => skill.path === created.path) ?? created);
	}
	private async refreshRegistry(preferredPath?: string): Promise<void> {
		this.registry = await this.options.onRefresh();
		this.refreshBrowseList(preferredPath);
		if (this.previewSkillPath) {
			const current = this.registry.allSkills.find((skill) => skill.path === this.previewSkillPath);
			if (!current) { this.exitToBrowse(preferredPath); return; }
			this.preview?.setSkill(current); this.editorView?.setSkill(current);
		}
	}
	private async toggleSkill(skill: SkillEntry): Promise<void> {
		const nextEnabled = !skill.enabled;
		try {
			await this.options.onToggle(skill, nextEnabled);
			await this.refreshRegistry(skill.path);
			this.ctx.ui.notify(`${nextEnabled ? "Enabled" : "Disabled"} ${skill.name}. Run /reload to fully apply the change.`, "info");
		} catch (error) {
			this.ctx.ui.notify(error instanceof Error ? error.message : "Failed to update skill visibility", "error");
		}
		this.requestRender();
	}
	private async confirmDelete(): Promise<void> {
		const skill = this.deleteSkillPath ? this.registry.allSkills.find((entry) => entry.path === this.deleteSkillPath) : undefined;
		if (!skill) { this.exitToBrowse(); return; }
		const deleted = await this.options.onDelete(skill);
		if (!deleted) { this.mode = this.deleteReturnMode === "preview" ? "preview" : "browse"; this.syncFocus(); this.requestRender(); return; }
		this.deleteSkillPath = undefined; this.previewSkillPath = undefined; this.preview = undefined;
		await this.refreshRegistry();
		this.exitToBrowse();
	}
	private async submitRename(value: string): Promise<void> {
		const skill = this.getCurrentSkill();
		if (!skill) { this.exitToBrowse(); return; }
		try {
			const renamed = await renameSkillEntry(this.ctx, skill, value);
			if (!renamed) { this.closeRenameDialog(); return; }
			this.previewSkillPath = renamed.path;
			await this.refreshRegistry(renamed.path);
			this.closeRenameDialog();
		} catch (error) {
			this.renameError = error instanceof Error ? error.message : "Failed to rename skill";
			this.requestRender();
		}
	}
	private async saveEditedSkill(raw: string): Promise<void> {
		const skill = this.getCurrentSkill();
		if (!skill) { this.exitToBrowse(); return; }
		try {
			const parsed = parseEditableSkillDocument(raw, skill.name);
			writeFileSync(skill.path, parsed.raw, "utf8");
			await this.refreshRegistry(skill.path);
			this.preview?.setSkill(this.registry.allSkills.find((entry) => entry.path === skill.path) ?? toUpdatedSkill(skill, parsed));
			this.ctx.ui.notify(`Updated skill: ${skill.name}`, "info");
			this.closeEditor();
		} catch (error) {
			this.editorView?.setMessage(error instanceof Error ? error.message : "Failed to save skill", "error");
			this.requestRender();
		}
	}

	render(width: number): string[] {
		if (this.mode === "preview") return this.preview?.render(width) ?? [];
		if (this.mode === "edit") return this.editorView?.render(width) ?? [];
		if (this.mode === "rename") return this.renderRenameDialog(width);
		if (this.mode === "delete-confirm") return this.renderDeleteDialog(width);
		if (this.mode === "generating") return this.renderGeneratingDialog(width);
		return this.mode === "create" ? this.renderCreate(width) : this.renderBrowse(width);
	}

	private renderBrowse(width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		const root = new Container();
		const enabledCount = this.registry.allSkills.filter((skill) => skill.enabled).length;
		const totalCount = this.registry.allSkills.length;
		root.addChild(new SearchInputLine(this.browseInput, this.theme));
		root.addChild(new Spacer(1));
		const list = new Container();
		const entries: Array<{ kind: "create" } | { kind: "header"; label: string } | { kind: "skill"; skill: SkillEntry }> = [{ kind: "create" }];
		const own = this.filteredSkills.filter((skill) => isDeletableSkill(skill));
		const library = this.filteredSkills.filter((skill) => !isDeletableSkill(skill));
		if (own.length > 0) entries.push({ kind: "header", label: "Your Skills" }, ...own.map((skill) => ({ kind: "skill" as const, skill })));
		if (library.length > 0) entries.push({ kind: "header", label: "Library Skills" }, ...library.map((skill) => ({ kind: "skill" as const, skill })));
		let selectedDisplayIndex = 0;
		let selectableIndex = 0;
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i]!;
			if (entry.kind === "create" || entry.kind === "skill") {
				if (selectableIndex === this.selectedIndex) { selectedDisplayIndex = i; break; }
				selectableIndex += 1;
			}
		}
		const startIndex = Math.max(0, Math.min(selectedDisplayIndex - Math.floor(this.listRows / 2), Math.max(0, entries.length - this.listRows)));
		const endIndex = Math.min(startIndex + this.listRows, entries.length);
		selectableIndex = 0;
		const ellipsis = this.theme.fg("dim", "...");
		for (let i = 0; i < endIndex; i++) {
			const entry = entries[i]!;
			const isSelectable = entry.kind === "create" || entry.kind === "skill";
			const isSelected = isSelectable && selectableIndex === this.selectedIndex;
			if (i >= startIndex) {
				if (entry.kind === "header") {
					list.addChild(new Spacer(1));
					list.addChild(new SingleLineText(skillSectionTitle(this.theme, entry.label), ellipsis));
				} else if (entry.kind === "create") {
					const prefix = " ";
					const label = "Create new skill";
					list.addChild(new ListLineText(`${prefix}${label}${this.theme.fg("dim", " — generate and save a new skill")}`, isSelected, this.theme, ellipsis));
				} else {
					const skill = entry.skill;
					const prefix = " ";
					const name = skill.enabled ? skill.name : this.theme.fg("muted", skill.name);
					const status = skill.enabled ? "" : this.theme.fg("warning", " [disabled]");
					const scope = this.theme.fg("muted", ` [${scopeLabel(skill)}]`);
					const source = packageLabel(skill) ? this.theme.fg("muted", ` [${packageLabel(skill)}]`) : "";
					const description = this.theme.fg("dim", ` — ${skill.description}`);
					list.addChild(new ListLineText(`${prefix}${name}${status}${scope}${source}${description}`, isSelected, this.theme, ellipsis));
				}
			}
			if (isSelectable) selectableIndex += 1;
		}
		if (entries.length === 1 && this.filteredSkills.length === 0) list.addChild(new Text(this.theme.fg("dim", "No skills match your search."), 1, 0));
		root.addChild(list);
		root.addChild(new Spacer(1));
		const selected = this.getSelectedSkill();
		const actions: Array<[string, string]> = [["-/=", "page"]];
		if (!selected) actions.push(["enter", "create"], ["esc", "close"]);
		else { if (selected.enabled) actions.push(["enter", "insert"]); actions.push(["tab", "preview"], ["ctrl+x", "enable/disable"]); if (!this.browseQuery && isDeletableSkill(selected)) actions.push(["backspace", "delete"]); actions.push(["esc", "close"]); }
		root.addChild(new Text(skillKeyHints(this.theme, actions), 1, 0));
		return renderFrame(this.theme, width, root.render(innerWidth), undefined, "Skills Manager", `${enabledCount}/${totalCount} enabled`);
	}

	private renderCreate(width: number): string[] {
		const innerWidth = Math.max(1, width - 4);
		const step = this.currentCreateStep;
		const root = new Container();
		root.addChild(new Text(skillEntityTitle(this.theme, `${step.title} (${this.createStepIndex + 1}/${CREATE_STEPS.length})`), 1, 0));
		root.addChild(new Spacer(1));
		if (step.id === "name") { root.addChild(this.browseInput); root.addChild(new Spacer(1)); root.addChild(new Text(this.theme.fg("dim", step.hint), 1, 0)); }
		else if (step.id === "description") { root.addChild(new PrefixedEditor(this.descriptionEditor)); root.addChild(new Spacer(1)); root.addChild(new Text(this.theme.fg("dim", step.hint), 1, 0)); }
		else {
			for (const option of step.options) {
				const selected = option.value === this.createLocation;
				root.addChild(new ListLineText(` ${option.label}${this.theme.fg(selected ? "text" : "dim", ` — ${option.description}`)}`, selected, this.theme));
			}
			root.addChild(new Spacer(1)); root.addChild(new Text(this.theme.fg("dim", step.hint), 1, 0));
		}
		if (this.createError) { root.addChild(new Spacer(1)); root.addChild(new Text(this.theme.fg("error", this.createError), 1, 0)); }
		root.addChild(new Spacer(1));
		const footer = step.id === "description"
			? skillKeyHints(this.theme, [["enter", "next"], ["ctrl+j", "newline"], ["alt+←", "back"], ["alt+→", "next"], ["esc", "cancel"]])
			: step.id === "location"
				? skillKeyHints(this.theme, [["enter", "create"], ["alt+←", "back"], ["esc", "cancel"]])
				: skillKeyHints(this.theme, [["enter", "next"], ["alt+←", "back"], ["alt+→", "next"], ["esc", "cancel"]]);
		root.addChild(new Text(footer, 1, 0));
		return renderFrame(this.theme, width, root.render(innerWidth));
	}
	private renderRenameDialog(width: number): string[] {
		const lines = [skillEntityTitle(this.theme, "Rename skill"), "", this.theme.fg("dim", "Enter new skill name (lowercase letters, numbers, hyphens)"), "", ...this.renameInput.render(Math.max(1, Math.min(width - 4, 64)))];
		if (this.renameError) lines.push("", toneText(this.theme, "error", this.renameError));
		lines.push("", skillKeyHints(this.theme, [["enter", "save"], ["esc", "cancel"]]));
		return renderCenteredDialog(this.theme, width, lines);
	}
	private renderDeleteDialog(width: number): string[] {
		const skill = this.deleteSkillPath ? this.registry.allSkills.find((entry) => entry.path === this.deleteSkillPath) : undefined;
		const innerWidth = Math.max(1, Math.min(width - 4, 64));
		const message = skill ? `Delete ${skill.name}? This removes ${skillStorageTarget(skill)} and cannot be undone.` : "Delete this skill?";
		return renderCenteredDialog(this.theme, width, [skillEntityTitle(this.theme, "Delete skill"), "", ...wrapTextWithAnsi(message, innerWidth), "", skillKeyHints(this.theme, [["enter", "delete"], ["esc", "cancel"]])]);
	}
	private renderGeneratingDialog(width: number): string[] {
		const modelLabel = this.ctx.model?.id ?? "fallback template";
		return renderCenteredDialog(this.theme, width, [skillEntityTitle(this.theme, "Generating skill"), "", this.theme.fg("dim", `Using ${modelLabel} to draft SKILL.md.`), this.theme.fg("dim", "The preview opens when generation finishes."), "", skillKeyHints(this.theme, [["esc", "cancel"]])]);
	}

	handleInput(data: string): void {
		if (this.mode === "generating") { if (matchesKey(data, Key.escape)) { this.generationAbortController?.abort(); this.generationAbortController = undefined; this.generationRunId += 1; this.mode = "create"; this.syncFocus(); this.requestRender(); } return; }
		if (this.mode === "rename") { if (matchesKey(data, Key.escape)) { this.closeRenameDialog(); return; } if (this.renameError) this.renameError = undefined; this.renameInput.handleInput(data); return; }
		if (this.mode === "delete-confirm") { if (matchesKey(data, Key.escape)) { this.mode = this.deleteReturnMode === "preview" ? "preview" : "browse"; this.syncFocus(); return; } if (matchesKey(data, Key.enter)) void this.confirmDelete(); return; }
		if (this.mode === "edit") { this.editorView?.handleInput(data); return; }
		if (this.mode === "preview") {
			const skill = this.getCurrentSkill();
			if (!skill) { this.exitToBrowse(); return; }
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.tab)) { this.exitToBrowse(skill.path); return; }
			if (matchesKey(data, Key.enter)) { if (!skill.enabled) this.ctx.ui.notify("Enable this skill first with ctrl+x", "info"); else this.done(skill); return; }
			if (matchesKey(data, Key.ctrl("x"))) { void this.toggleSkill(skill); return; }
			if (isDeletableSkill(skill) && matchesKey(data, Key.ctrl("e"))) { this.openEditor(); return; }
			if (isDeletableSkill(skill) && matchesKey(data, Key.ctrl("r"))) { this.openRenameDialog(); return; }
			if (isDeletableSkill(skill) && (matchesKey(data, Key.backspace) || matchesKey(data, "delete"))) { this.openDeleteConfirm(skill, "preview"); return; }
			this.preview?.handleInput(data); return;
		}
		if (this.mode === "create") { this.handleCreateInput(data); return; }
		this.handleBrowseInput(data);
	}
	private handleBrowseInput(data: string): void {
		if (matchesKey(data, Key.up)) { this.selectedIndex = this.selectedIndex === 0 ? this.filteredSkills.length : this.selectedIndex - 1; return; }
		if (matchesKey(data, Key.down)) { this.selectedIndex = this.selectedIndex === this.filteredSkills.length ? 0 : this.selectedIndex + 1; return; }
		if (matchesKey(data, "-") || matchesKey(data, Key.pageUp)) { this.selectedIndex = Math.max(0, this.selectedIndex - this.listRows); return; }
		if (matchesKey(data, "=") || matchesKey(data, Key.pageDown)) { this.selectedIndex = Math.min(this.filteredSkills.length, this.selectedIndex + this.listRows); return; }
		if (matchesKey(data, Key.enter)) { if (this.selectedIndex === 0) { this.enterCreateMode(); return; } const skill = this.getSelectedSkill(); if (!skill) return; if (!skill.enabled) this.ctx.ui.notify("Enable this skill first with ctrl+x", "info"); else this.done(skill); return; }
		if (matchesKey(data, Key.tab)) { const skill = this.getSelectedSkill(); if (skill) this.openPreview(skill); return; }
		if (matchesKey(data, Key.ctrl("x"))) { const skill = this.getSelectedSkill(); if (skill) void this.toggleSkill(skill); return; }
		if (matchesKey(data, Key.backspace) && !this.browseInput.getValue()) { const skill = this.getSelectedSkill(); if (skill && isDeletableSkill(skill)) this.openDeleteConfirm(skill, "browse"); return; }
		if (matchesKey(data, Key.escape)) { if (this.browseInput.getValue()) { this.browseQuery = ""; this.browseInput.setValue(""); this.refreshBrowseList(); } else this.done(null); return; }
		this.browseInput.handleInput(data); this.browseQuery = this.browseInput.getValue(); this.refreshBrowseList();
	}
	private handleCreateInput(data: string): void {
		if (matchesKey(data, Key.escape)) { this.exitToBrowse(); return; }
		if (matchesKey(data, Key.alt("left"))) { this.goToPreviousCreateStep(); return; }
		if (matchesKey(data, Key.alt("right"))) { void this.advanceCreate(); return; }
		if (matchesKey(data, Key.enter) && this.currentCreateStep.id !== "description") { void this.advanceCreate(); return; }
		this.createError = undefined;
		const step = this.currentCreateStep;
		if (step.id === "name") { this.browseInput.handleInput(data); this.createValues.name = this.browseInput.getValue(); return; }
		if (step.id === "location") { if (matchesKey(data, Key.up)) this.createLocation = this.createLocation === "project" ? "global" : "project"; else if (matchesKey(data, Key.down)) this.createLocation = this.createLocation === "project" ? "global" : "project"; return; }
		this.descriptionEditor.handleInput(data); if (!matchesKey(data, Key.enter)) this.createValues.description = this.descriptionEditor.getText();
	}
}

async function showSkillsManager(ctx: ExtensionContext, registry: SkillRegistry, options: SkillsManagerOptions): Promise<SkillEntry | null> {
	const releaseModalLock = acquireVstackModalLock();
	try {
		return await ctx.ui.custom<SkillEntry | null>((tui, theme, _kb, done) => {
			const dialog = new SkillsManagerDialog(ctx, registry, theme, tui, done, options, () => tui.requestRender());
			return {
				get focused() { return dialog.focused; },
				set focused(value: boolean) { dialog.focused = value; },
				render(width: number) { return dialog.render(width); },
				invalidate() { dialog.invalidate(); },
				handleInput(data: string) { dialog.handleInput(data); tui.requestRender(); },
			};
		}, {
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: settingOverlaySize("popupWidth", DEFAULT_POPUP_WIDTH, ctx.cwd),
				maxHeight: settingOverlaySize("popupMaxHeight", DEFAULT_POPUP_MAX_HEIGHT, ctx.cwd),
			},
		});
	} finally {
		releaseModalLock();
	}
}

export default function skillsManager(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;

	patchInteractiveModeStartupSkillsBlock();
	setStartupHideEnabled(settingBoolean("enabled", true) && settingBoolean("hideStartupSkillsBlock", true));

	let registry: SkillRegistry = EMPTY_REGISTRY;
	const enabledAtLoad = settingBoolean("enabled", true);

	if (!enabledAtLoad) {
		const enableRecovery = async (ctx: ExtensionCommandContext) => {
			updatePackageConfig(ctx.cwd, { enabled: true });
			ctx.ui.notify("Skills Manager enabled. Reloading...", "info");
			await ctx.reload();
		};
		pi.registerCommand("skill", {
			description: "Skills manager recovery command.",
			handler: async (args, ctx) => {
				if (args.trim().toLowerCase() !== "enable") {
					ctx.ui.notify("Skills Manager is disabled. Run /skill:enable, then /reload.", "warning");
					return;
				}
				await enableRecovery(ctx);
			},
		});
		pi.registerCommand("skill:enable", {
			description: "Re-enable the skills manager",
			handler: async (_args, ctx) => enableRecovery(ctx),
		});
		return;
	}

	async function refreshRegistry(cwd: string): Promise<SkillRegistry> {
		registry = await loadSkillRegistry(cwd);
		return registry;
	}

	async function prepareSession(ctx: ExtensionContext): Promise<boolean> {
		setStartupHideEnabled(settingBoolean("enabled", true, ctx.cwd) && settingBoolean("hideStartupSkillsBlock", true, ctx.cwd));
		try {
			await refreshRegistry(ctx.cwd);
		} catch (error) {
			registry = EMPTY_REGISTRY;
			console.error("pi-skills-manager: failed to load skills registry", error);
		}
		return false;
	}

	pi.registerCommand("skill", {
		description: "Pi skills manager view. Native skills remain /skill:name.",
		handler: async (args, ctx) => {
			const rawArgs = args.trim();
			const trimmed = rawArgs.toLowerCase();
			if (trimmed === "enable") {
				updatePackageConfig(ctx.cwd, { enabled: true });
				ctx.ui.notify("Skills Manager already enabled.", "info");
				return;
			}
			if (trimmed === "disable") {
				updatePackageConfig(ctx.cwd, { enabled: false });
				ctx.ui.notify("Skills Manager disabled. Run /reload to unload commands/hooks.", "info");
				return;
			}
			if (rawArgs) {
				ctx.ui.notify("Use /skill:name for native skill invocation, or /skill with no arguments for the manager.", "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("/skill manager requires interactive mode", "warning");
				return;
			}
			try {
				await refreshRegistry(ctx.cwd);
			} catch (error) {
				console.error("pi-skills-manager: failed to refresh skills registry", error);
				ctx.ui.notify("Failed to load skills list", "error");
				return;
			}
			const selection = await showSkillsManager(ctx, registry, {
				onCreate: async (answers, signal) => await createSkillFromAnswers(ctx, answers, { thinkingLevel: pi.getThinkingLevel(), signal }),
				onDelete: async (skill) => await deleteSkill(ctx, skill),
				onToggle: async (skill, enabled) => await setSkillEnabled(ctx.cwd, skill, enabled),
				onRefresh: async () => await refreshRegistry(ctx.cwd),
			});
			if (selection) insertNativeSkillCommand(ctx, selection);
		},
	});

	pi.on("session_start", async (_event, ctx) => { await prepareSession(ctx); });
}
