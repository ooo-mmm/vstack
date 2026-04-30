/**
 * vstack Pi extension manager.
 *
 * Provides a Pi-styled settings shell with an Extensions tab. Pi does not yet
 * expose a public API for third-party extensions to inject native built-in
 * /settings tabs, so this extension registers /extensions plus a best-effort
 * /settings wrapper when extension command priority allows it.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-extension-manager.installed");
const MANAGER_ID = "pi-extension-manager";
const SETTINGS_EVENT = "vstack:extension-settings-changed";
const DEFAULT_WIDTH = 118;
const DEFAULT_MAX_HEIGHT = "90%";
const LEFT_MIN_WIDTH = 34;
const LEFT_MAX_WIDTH = 48;
const LIST_ROWS = 18;
const SETTINGS_ROWS = 10;

type Scope = "user" | "project" | "temporary" | "builtin" | "unknown";
type ExtensionState = "active" | "disabled" | "shadowed" | "broken";
type ApplyMode = "live" | "reload" | "session" | "restart";
type SettingType = "boolean" | "enum" | "string" | "number" | "secret" | "path";
type TopTab = "General" | "Extensions" | "Audit";
type Pane = "list" | "settings";

interface SettingsSchema {
	key: string;
	label?: string;
	description?: string;
	type: SettingType;
	default?: unknown;
	enumValues?: string[];
	secret?: boolean;
	category?: string;
	apply?: ApplyMode;
	requiresReload?: boolean;
	validation?: Record<string, unknown>;
}

interface PackageManifest {
	name?: string;
	version?: string;
	description?: string;
	keywords?: string[];
	pi?: {
		extensions?: string[];
		skills?: string[];
		prompts?: string[];
		themes?: string[];
	};
	bin?: string | Record<string, string>;
	vstack?: {
		extensionManager?: {
			displayName?: string;
			settings?: SettingsSchema[];
			resources?: ResourceMetadata[];
		};
	};
}

interface ResourceMetadata {
	kind: string;
	name: string;
	description?: string;
	trigger?: string;
	path?: string;
}

interface SettingsFile {
	scope: Scope;
	baseDir: string;
	path: string;
	json: Record<string, unknown>;
	exists: boolean;
}

interface ManagerState {
	disabledItems: string[];
	disabledProviders: string[];
	config: Record<string, Record<string, unknown>>;
}

interface ConfigValue {
	value: unknown;
	scope: Scope | "default";
	explicit: boolean;
}

interface InventoryItem {
	id: string;
	displayName: string;
	kind: string;
	state: ExtensionState;
	stateReason: string;
	description: string;
	provider: string;
	scope: Scope;
	sourcePath: string;
	sourceName: string;
	packageName?: string;
	packageDir?: string;
	entrypoint?: string;
	trigger?: string;
	shadowedBy?: string;
	settingsSchema?: SettingsSchema[];
	brokenError?: string;
	metadata?: Record<string, unknown>;
}

interface Inventory {
	items: InventoryItem[];
	packages: InventoryItem[];
	settingsFiles: SettingsFile[];
	managerState: ManagerState;
	auditLines: string[];
}

interface ManagerActionEdit {
	type: "edit-setting";
	itemId: string;
	settingKey: string;
}

interface ManagerActionSet {
	type: "set-setting";
	itemId: string;
	settingKey: string;
	value: unknown;
}

interface ManagerActionToggleItem {
	type: "toggle-item";
	itemId: string;
}

interface ManagerActionToggleProvider {
	type: "toggle-provider";
	provider: string;
}

type ManagerAction = ManagerActionEdit | ManagerActionSet | ManagerActionToggleItem | ManagerActionToggleProvider | { type: "close" } | undefined;

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

function readJsonObject(path: string): { json: Record<string, unknown>; exists: boolean; error?: string } {
	if (!existsSync(path)) return { json: {}, exists: false };
	try {
		const text = readFileSync(path, "utf8");
		if (!text.trim()) return { json: {}, exists: true };
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { json: {}, exists: true, error: "settings root is not an object" };
		return { json: parsed as Record<string, unknown>, exists: true };
	} catch (error) {
		return { json: {}, exists: true, error: stringifyError(error) };
	}
}

function loadSettingsFiles(ctx: ExtensionContext): SettingsFile[] {
	const projectBase = findProjectPiDir(ctx.cwd);
	const userBase = userPiDir();
	const user = readJsonObject(join(userBase, "settings.json"));
	const project = readJsonObject(join(projectBase, "settings.json"));
	return [
		{ scope: "user", baseDir: userBase, path: join(userBase, "settings.json"), json: user.json, exists: user.exists },
		{ scope: "project", baseDir: projectBase, path: join(projectBase, "settings.json"), json: project.json, exists: project.exists },
	];
}

function writeSettingsFile(file: SettingsFile): void {
	mkdirSync(dirname(file.path), { recursive: true });
	writeFileSync(file.path, `${JSON.stringify(file.json, null, 2)}\n`, "utf8");
	file.exists = true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function getOrCreateRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
	const current = asRecord(parent[key]);
	if (current) return current;
	const created: Record<string, unknown> = {};
	parent[key] = created;
	return created;
}

function managerStateFrom(json: Record<string, unknown>): ManagerState {
	const vstack = asRecord(json.vstack) ?? {};
	const manager = asRecord(vstack.extensionManager) ?? {};
	const config = asRecord(manager.config) ?? {};
	const normalizedConfig: Record<string, Record<string, unknown>> = {};
	for (const [id, value] of Object.entries(config)) {
		const record = asRecord(value);
		if (record) normalizedConfig[id] = { ...record };
	}
	return {
		disabledItems: Array.isArray(manager.disabledItems) ? manager.disabledItems.filter((v): v is string => typeof v === "string") : [],
		disabledProviders: Array.isArray(manager.disabledProviders)
			? manager.disabledProviders.filter((v): v is string => typeof v === "string")
			: [],
		config: normalizedConfig,
	};
}

function mergedManagerState(files: SettingsFile[]): ManagerState {
	const user = managerStateFrom(files.find((f) => f.scope === "user")?.json ?? {});
	const project = managerStateFrom(files.find((f) => f.scope === "project")?.json ?? {});
	return {
		disabledItems: [...new Set([...user.disabledItems, ...project.disabledItems])],
		disabledProviders: [...new Set([...user.disabledProviders, ...project.disabledProviders])],
		config: deepMergeConfig(user.config, project.config),
	};
}

function deepMergeConfig(
	base: Record<string, Record<string, unknown>>,
	override: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
	const out: Record<string, Record<string, unknown>> = {};
	for (const [id, values] of Object.entries(base)) out[id] = { ...values };
	for (const [id, values] of Object.entries(override)) out[id] = { ...(out[id] ?? {}), ...values };
	return out;
}

function updateManagerState(file: SettingsFile, updater: (state: ManagerState) => void): void {
	const vstack = getOrCreateRecord(file.json, "vstack");
	const manager = getOrCreateRecord(vstack, "extensionManager");
	const current = managerStateFrom(file.json);
	updater(current);
	manager.disabledItems = current.disabledItems;
	manager.disabledProviders = current.disabledProviders;
	manager.config = current.config;
	writeSettingsFile(file);
}

function findSettingsFile(files: SettingsFile[], scope: Scope): SettingsFile {
	return files.find((file) => file.scope === scope) ?? files[0]!;
}

function defaultWriteScope(item: InventoryItem | undefined, files: SettingsFile[], managerState: ManagerState): Scope {
	if (item?.scope === "project" || item?.scope === "user") return item.scope;
	const configured = managerState.config[MANAGER_ID]?.defaultSaveScope;
	if (configured === "user") return "user";
	if (configured === "project") return "project";
	return files.some((file) => file.scope === "project" && file.exists) ? "project" : "user";
}

function readPackageManifest(dir: string): { manifest?: PackageManifest; error?: string } {
	try {
		const path = join(dir, "package.json");
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return { manifest: parsed as PackageManifest };
	} catch (error) {
		return { error: stringifyError(error) };
	}
}

function normalizePackageEntry(entry: unknown, baseDir: string): { source: string; resolved: string; disabledByFilter: boolean } | undefined {
	if (typeof entry === "string") {
		return { source: entry, resolved: resolveSource(entry, baseDir), disabledByFilter: false };
	}
	const record = asRecord(entry);
	if (!record || typeof record.source !== "string") return undefined;
	const extensionsFilter = record.extensions;
	const allDisabled = Array.isArray(extensionsFilter) && extensionsFilter.length === 0;
	return { source: record.source, resolved: resolveSource(record.source, baseDir), disabledByFilter: allDisabled };
}

function resolveSource(source: string, baseDir: string): string {
	const expanded = expandHome(source);
	if (expanded.startsWith("npm:") || expanded.startsWith("git:") || expanded.startsWith("http://") || expanded.startsWith("https://")) {
		return expanded;
	}
	return resolve(baseDir, expanded);
}

function binNames(bin: PackageManifest["bin"]): string[] {
	if (!bin) return [];
	if (typeof bin === "string") return [bin];
	return Object.keys(bin);
}

function packageDisplayName(manifest: PackageManifest, fallback: string): string {
	return manifest.vstack?.extensionManager?.displayName || manifest.name || fallback;
}

function settingSchema(manifest: PackageManifest): SettingsSchema[] {
	const schema = manifest.vstack?.extensionManager?.settings;
	return Array.isArray(schema) ? schema.filter(isSettingSchema) : [];
}

function isSettingSchema(value: unknown): value is SettingsSchema {
	const record = asRecord(value);
	return Boolean(record && typeof record.key === "string" && isSettingType(record.type));
}

function isSettingType(value: unknown): value is SettingType {
	return value === "boolean" || value === "enum" || value === "string" || value === "number" || value === "secret" || value === "path";
}

function collectConfiguredExtensions(file: SettingsFile): InventoryItem[] {
	const entries = Array.isArray(file.json.extensions) ? file.json.extensions : [];
	const items: InventoryItem[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string" || entry.startsWith("!")) continue;
		const resolved = resolveSource(entry, file.baseDir);
		items.push(makeResourceItem(`extension-setting:${file.scope}:${entry}`, entry, "extension setting", file.scope, resolved, `${file.scope}:extensions`, entry, "Configured in settings.json extensions[]"));
	}
	return items;
}

function collectAutoExtensions(baseDir: string, scope: Scope): InventoryItem[] {
	const roots = [join(baseDir, "extensions")];
	const items: InventoryItem[] = [];
	for (const root of roots) {
		if (!existsSync(root)) continue;
		for (const entry of safeReadDir(root)) {
			const full = join(root, entry);
			try {
				const stat = statSync(full);
				if (stat.isFile() && /\.[cm]?[jt]s$/.test(entry)) {
					items.push(makeResourceItem(`extension:${scope}:${full}`, entry, "extension module", scope, full, `${scope}:extensions`, full));
				} else if (stat.isDirectory()) {
					const index = ["index.ts", "index.js", "index.mts", "index.mjs"].map((name) => join(full, name)).find((p) => existsSync(p));
					if (index) items.push(makeResourceItem(`extension:${scope}:${index}`, entry, "extension module", scope, index, `${scope}:extensions`, root));
				}
			} catch {
				// ignore transient filesystem errors in inventory scan
			}
		}
	}
	return items;
}

function safeReadDir(path: string): string[] {
	try {
		return readdirSync(path).sort();
	} catch {
		return [];
	}
}

function makeResourceItem(
	id: string,
	displayName: string,
	kind: string,
	scope: Scope,
	sourcePath: string,
	provider: string,
	sourceName: string,
	description = "",
	trigger?: string,
): InventoryItem {
	return {
		description,
		displayName,
		id,
		kind,
		provider,
		scope,
		sourceName,
		sourcePath,
		state: "active",
		stateReason: "loaded or discoverable",
		trigger,
	};
}

function buildInventory(pi: ExtensionAPI, ctx: ExtensionContext): Inventory {
	const settingsFiles = loadSettingsFiles(ctx);
	const managerState = mergedManagerState(settingsFiles);
	const items: InventoryItem[] = [];
	const auditLines: string[] = [];
	const seenPackages = new Map<string, InventoryItem>();

	// Project scope wins over user scope, mirroring Pi settings override behavior.
	for (const file of [...settingsFiles].sort((a, b) => (a.scope === "project" ? -1 : b.scope === "project" ? 1 : 0))) {
		const packages = Array.isArray(file.json.packages) ? file.json.packages : [];
		for (const rawEntry of packages) {
			const normalized = normalizePackageEntry(rawEntry, file.baseDir);
			if (!normalized) continue;
			const fallbackName = normalized.source.split("/").filter(Boolean).pop() ?? normalized.source;
			let manifest: PackageManifest | undefined;
			let brokenError: string | undefined;
			if (existsSync(normalized.resolved) && statSync(normalized.resolved).isDirectory()) {
				const read = readPackageManifest(normalized.resolved);
				manifest = read.manifest;
				brokenError = read.error;
			} else if (normalized.resolved.startsWith("npm:") || normalized.resolved.startsWith("git:") || normalized.resolved.startsWith("http")) {
				manifest = { name: fallbackName, description: "External package source" };
			} else {
				brokenError = `package source not found: ${normalized.resolved}`;
			}

			const packageName = manifest?.name ?? fallbackName;
			const pkgId = `package:${packageName}`;
			const packageItem: InventoryItem = {
				brokenError,
				description: manifest?.description ?? "Pi package",
				displayName: packageDisplayName(manifest ?? {}, packageName),
				id: pkgId,
				kind: "package",
				packageDir: normalized.resolved,
				packageName,
				provider: `${file.scope}:packages`,
				scope: file.scope,
				settingsSchema: manifest ? settingSchema(manifest) : [],
				sourceName: normalized.source,
				sourcePath: normalized.resolved,
				state: brokenError ? "broken" : normalized.disabledByFilter ? "disabled" : "active",
				stateReason: brokenError ?? (normalized.disabledByFilter ? "package entry filters extensions: []" : "package listed in settings.json"),
			};

			const existing = seenPackages.get(packageName);
			if (existing && existing.scope === "project" && packageItem.scope === "user") {
				packageItem.state = "shadowed";
				packageItem.stateReason = `shadowed by project package ${existing.sourcePath}`;
				packageItem.shadowedBy = existing.id;
			} else if (!existing) {
				seenPackages.set(packageName, packageItem);
			}
			items.push(packageItem);

			if (manifest) {
				auditLines.push(formatPackageAudit(packageItem, manifest));
				for (const extPath of manifest.pi?.extensions ?? []) {
					const fullPath = resolve(normalized.resolved, extPath);
					items.push({
						description: `Entrypoint from ${packageName}`,
						displayName: extPath,
						entrypoint: extPath,
						id: `extension:${packageName}:${extPath}`,
						kind: "extension module",
						packageDir: normalized.resolved,
						packageName,
						provider: `${file.scope}:packages`,
						scope: file.scope,
						sourceName: packageName,
						sourcePath: fullPath,
						state: packageItem.state,
						stateReason: packageItem.state === "active" ? "declared in package pi.extensions" : packageItem.stateReason,
					});
				}
				for (const binName of binNames(manifest.bin)) {
					items.push(makeResourceItem(`bin:${packageName}:${binName}`, binName, "bin", file.scope, normalized.resolved, `${file.scope}:packages`, packageName, `CLI bin from ${packageName}`));
				}
				for (const resource of manifest.vstack?.extensionManager?.resources ?? []) {
					items.push(makeResourceItem(`resource:${packageName}:${resource.kind}:${resource.name}`, resource.name, resource.kind, file.scope, resolve(normalized.resolved, resource.path ?? "."), `${file.scope}:packages`, packageName, resource.description ?? "", resource.trigger));
				}
			}
		}
		items.push(...collectConfiguredExtensions(file));
		items.push(...collectAutoExtensions(file.baseDir, file.scope));
	}

	for (const command of safeCommands(pi)) {
		const sourceInfo = command.sourceInfo ?? {};
		const scope = normalizeScope(sourceInfo.scope);
		items.push({
			description: command.description ?? "Slash command",
			displayName: `/${command.name}`,
			id: `command:${command.name}`,
			kind: command.source === "skill" ? "skill command" : command.source === "prompt" ? "prompt command" : "slash command",
			provider: sourceInfo.source ?? command.source ?? "commands",
			scope,
			sourceName: sourceInfo.source ?? command.source ?? "commands",
			sourcePath: sourceInfo.path ?? "<runtime>",
			state: "active",
			stateReason: "registered in current runtime",
			trigger: `/${command.name}`,
		});
	}

	const activeTools = new Set(safeActiveTools(pi));
	const showBuiltins = managerState.config[MANAGER_ID]?.showBuiltinTools === true;
	for (const tool of safeTools(pi)) {
		const sourceInfo = tool.sourceInfo ?? {};
		if (!showBuiltins && sourceInfo.source === "builtin") continue;
		items.push({
			description: tool.description ?? "Tool",
			displayName: tool.name,
			id: `tool:${tool.name}`,
			kind: "tool",
			provider: sourceInfo.source ?? "tools",
			scope: normalizeScope(sourceInfo.scope),
			sourceName: sourceInfo.source ?? "tools",
			sourcePath: sourceInfo.path ?? "<runtime>",
			state: activeTools.has(tool.name) ? "active" : "disabled",
			stateReason: activeTools.has(tool.name) ? "active tool" : "not present in active tool set",
			trigger: tool.name,
		});
	}

	applyDisableState(items, managerState);
	items.sort((a, b) => `${a.kind}:${a.displayName}`.localeCompare(`${b.kind}:${b.displayName}`));
	return { auditLines, items, managerState, packages: items.filter((item) => item.kind === "package"), settingsFiles };
}

function formatPackageAudit(item: InventoryItem, manifest: PackageManifest): string {
	const extensions = manifest.pi?.extensions?.join(", ") || "none";
	const settings = settingSchema(manifest);
	const settingText = settings.length === 0 ? "no declared settings schema" : settings.map((s) => `${s.key}:${s.type}:${s.apply ?? (s.requiresReload ? "reload" : "live")}`).join(", ");
	return `${manifest.name ?? item.displayName}\n  source: ${item.sourcePath}\n  entrypoints: ${extensions}\n  settings: ${settingText}`;
}

function applyDisableState(items: InventoryItem[], managerState: ManagerState): void {
	const disabledItems = new Set(managerState.disabledItems);
	const disabledProviders = new Set(managerState.disabledProviders);
	for (const item of items) {
		if (item.state === "shadowed" || item.state === "broken") continue;
		if (disabledProviders.has(item.provider)) {
			item.state = "disabled";
			item.stateReason = `provider disabled: ${item.provider}`;
		}
		if (disabledItems.has(item.id)) {
			item.state = "disabled";
			item.stateReason = "explicitly disabled in vstack extension manager";
		}
	}
}

function normalizeScope(value: unknown): Scope {
	return value === "user" || value === "project" || value === "temporary" || value === "builtin" ? value : "unknown";
}

function safeCommands(pi: ExtensionAPI): any[] {
	try {
		return pi.getCommands?.() ?? [];
	} catch {
		return [];
	}
}

function safeTools(pi: ExtensionAPI): any[] {
	try {
		return pi.getAllTools?.() ?? [];
	} catch {
		return [];
	}
}

function safeActiveTools(pi: ExtensionAPI): string[] {
	try {
		return pi.getActiveTools?.() ?? [];
	} catch {
		return [];
	}
}

function getConfigValue(inventory: Inventory, extensionId: string, schema: SettingsSchema): ConfigValue {
	const project = managerStateFrom(inventory.settingsFiles.find((file) => file.scope === "project")?.json ?? {});
	const user = managerStateFrom(inventory.settingsFiles.find((file) => file.scope === "user")?.json ?? {});
	if (Object.prototype.hasOwnProperty.call(project.config[extensionId] ?? {}, schema.key)) {
		return { explicit: true, scope: "project", value: project.config[extensionId]![schema.key] };
	}
	if (Object.prototype.hasOwnProperty.call(user.config[extensionId] ?? {}, schema.key)) {
		return { explicit: true, scope: "user", value: user.config[extensionId]![schema.key] };
	}
	return { explicit: false, scope: "default", value: schema.default };
}

function setConfigValue(inventory: Inventory, item: InventoryItem, schema: SettingsSchema, value: unknown): void {
	const scope = defaultWriteScope(item, inventory.settingsFiles, inventory.managerState);
	const file = findSettingsFile(inventory.settingsFiles, scope);
	const extensionId = item.packageName ?? item.displayName;
	updateManagerState(file, (state) => {
		state.config[extensionId] = { ...(state.config[extensionId] ?? {}), [schema.key]: value };
	});
}

function parseSettingInput(schema: SettingsSchema, input: string): unknown {
	switch (schema.type) {
		case "boolean": {
			const lower = input.trim().toLowerCase();
			if (["true", "yes", "on", "1", "enabled"].includes(lower)) return true;
			if (["false", "no", "off", "0", "disabled"].includes(lower)) return false;
			throw new Error("Expected boolean: true/false, on/off, yes/no");
		}
		case "number": {
			const parsed = Number(input.trim());
			if (!Number.isFinite(parsed)) throw new Error("Expected a number");
			return parsed;
		}
		case "enum": {
			const value = input.trim();
			if (schema.enumValues?.length && !schema.enumValues.includes(value)) {
				throw new Error(`Expected one of: ${schema.enumValues.join(", ")}`);
			}
			return value;
		}
		case "secret":
		case "path":
		case "string":
			return input;
	}
}

function nextSettingValue(schema: SettingsSchema, current: unknown): unknown {
	if (schema.type === "boolean") return !(current === true);
	if (schema.type === "enum" && schema.enumValues?.length) {
		const idx = schema.enumValues.indexOf(String(current ?? schema.default ?? ""));
		return schema.enumValues[(idx + 1 + schema.enumValues.length) % schema.enumValues.length];
	}
	return current;
}

function formatSettingValue(schema: SettingsSchema, value: unknown): string {
	if (schema.secret) return value == null || value === "" ? "(unset)" : "••••••";
	if (value === undefined) return "(unset)";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function selectedPackageForSetting(item: InventoryItem): string | undefined {
	return item.packageName ?? (item.kind === "package" ? item.displayName : undefined);
}

function filteredItems(items: InventoryItem[], ui: ManagerUiState): InventoryItem[] {
	const query = ui.search.trim().toLowerCase();
	return items.filter((item) => {
		if (query) {
			const hay = [item.displayName, item.kind, item.provider, item.description, item.sourcePath, item.stateReason].join("\n").toLowerCase();
			if (!hay.includes(query)) return false;
		}
		if (ui.kindFilter !== "all" && item.kind !== ui.kindFilter) return false;
		if (ui.providerFilter !== "all" && item.provider !== ui.providerFilter) return false;
		if (ui.stateFilter !== "all" && item.state !== ui.stateFilter) return false;
		if (ui.scopeFilter !== "all" && item.scope !== ui.scopeFilter) return false;
		return true;
	});
}

interface ManagerUiState {
	topTab: TopTab;
	pane: Pane;
	search: string;
	selected: number;
	settingSelected: number;
	scroll: number;
	settingScroll: number;
	kindFilter: string;
	providerFilter: string;
	stateFilter: string;
	scopeFilter: string;
}

function makeInitialUiState(initialTab: TopTab): ManagerUiState {
	return {
		kindFilter: "all",
		pane: "list",
		providerFilter: "all",
		scopeFilter: "all",
		search: "",
		selected: 0,
		settingScroll: 0,
		settingSelected: 0,
		stateFilter: "all",
		topTab: initialTab,
		scroll: 0,
	};
}

async function openManager(pi: ExtensionAPI, ctx: ExtensionCommandContext | ExtensionContext, initialTab: TopTab = "Extensions"): Promise<void> {
	let ui = makeInitialUiState(initialTab);
	while (true) {
		const inventory = buildInventory(pi, ctx as ExtensionContext);
		const action = await ctx.ui.custom<ManagerAction>(
			(tui, theme, _keybindings, done) => createManagerComponent(pi, inventory, ui, theme, () => tui.requestRender(), done),
			{ overlay: true, overlayOptions: { anchor: "center", maxHeight: DEFAULT_MAX_HEIGHT, width: DEFAULT_WIDTH } },
		);

		if (!action || action.type === "close") return;
		if (action.type === "edit-setting") {
			const item = inventory.items.find((candidate) => candidate.id === action.itemId);
			const schema = item?.settingsSchema?.find((candidate) => candidate.key === action.settingKey);
			if (!item || !schema) continue;
			const extensionId = selectedPackageForSetting(item) ?? item.displayName;
			const current = getConfigValue(inventory, extensionId, schema).value;
			const prompt = `${schema.label ?? schema.key} (${schema.type}${schema.enumValues?.length ? `: ${schema.enumValues.join("|")}` : ""})`;
			const input = await ctx.ui.input(prompt, formatSettingValue({ ...schema, secret: false }, current));
			if (input === undefined) continue;
			try {
				const value = parseSettingInput(schema, input);
				setConfigValue(inventory, item, schema, value);
				pi.events.emit(SETTINGS_EVENT, { extensionId, key: schema.key, value });
				ctx.ui.notify(applyMessage(schema), schema.apply === "restart" || schema.requiresReload ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(stringifyError(error), "error");
			}
			continue;
		}
		if (action.type === "set-setting") {
			const item = inventory.items.find((candidate) => candidate.id === action.itemId);
			const schema = item?.settingsSchema?.find((candidate) => candidate.key === action.settingKey);
			if (!item || !schema) continue;
			setConfigValue(inventory, item, schema, action.value);
			pi.events.emit(SETTINGS_EVENT, { extensionId: selectedPackageForSetting(item) ?? item.displayName, key: schema.key, value: action.value });
			ctx.ui.notify(applyMessage(schema), schema.apply === "restart" || schema.requiresReload ? "warning" : "info");
			continue;
		}
		if (action.type === "toggle-item") {
			const item = inventory.items.find((candidate) => candidate.id === action.itemId);
			if (item) toggleItem(pi, ctx, inventory, item);
			continue;
		}
		if (action.type === "toggle-provider") {
			toggleProvider(pi, ctx, inventory, action.provider);
			continue;
		}
	}
}

function applyMessage(schema: SettingsSchema): string {
	const apply = schema.apply ?? (schema.requiresReload ? "reload" : "live");
	if (apply === "live") return "Setting saved and available to extensions immediately.";
	if (apply === "reload") return "Setting saved. Run /reload for extensions that read it at load time.";
	if (apply === "session") return "Setting saved. Start/resume a session to fully apply it.";
	return "Setting saved. Restart Pi to fully apply it.";
}

function toggleItem(pi: ExtensionAPI, ctx: ExtensionCommandContext | ExtensionContext, inventory: Inventory, item: InventoryItem): void {
	if ((item.id === `package:${MANAGER_ID}` || item.packageName === MANAGER_ID) && item.state !== "disabled") {
		ctx.ui.notify("Refusing to disable pi-extension-manager from inside itself. Edit settings.json manually if needed.", "warning");
		return;
	}
	const scope = defaultWriteScope(item, inventory.settingsFiles, inventory.managerState);
	const file = findSettingsFile(inventory.settingsFiles, scope);
	const disabled = new Set(inventory.managerState.disabledItems);
	const currentlyDisabled = item.state === "disabled" || disabled.has(item.id);
	const willDisable = !currentlyDisabled;
	if (willDisable) disabled.add(item.id);
	else disabled.delete(item.id);
	updateManagerState(file, (state) => {
		state.disabledItems = [...disabled].sort();
	});

	if (item.kind === "tool") {
		const active = new Set(safeActiveTools(pi));
		if (willDisable) active.delete(item.displayName);
		else active.add(item.displayName);
		pi.setActiveTools?.([...active]);
		ctx.ui.notify(`${item.displayName} ${willDisable ? "disabled" : "enabled"} live.`, "info");
		return;
	}

	if (item.kind === "package" && item.packageName) {
		const changed = setPackageFiltered(item, inventory.settingsFiles, willDisable);
		ctx.ui.notify(changed ? "Package setting updated. Run /reload or restart Pi to apply module loading changes." : "Item toggle saved. Reload may be required.", "warning");
		return;
	}

	if (item.kind === "extension module" && item.packageName && item.entrypoint) {
		const changed = setPackageExtensionFiltered(item, inventory.settingsFiles, willDisable);
		ctx.ui.notify(changed ? "Extension module filter updated. Run /reload or restart Pi to apply." : "Module toggle saved. Reload may be required.", "warning");
		return;
	}

	ctx.ui.notify("Item toggle saved. Pi cannot unload this resource type live; /reload or restart may be required.", "warning");
}

function setPackageFiltered(item: InventoryItem, files: SettingsFile[], disabled: boolean): boolean {
	const file = findSettingsFile(files, item.scope);
	const packages = Array.isArray(file.json.packages) ? file.json.packages : [];
	let changed = false;
	const next = packages.map((entry) => {
		const normalized = normalizePackageEntry(entry, file.baseDir);
		if (!normalized || normalized.resolved !== item.sourcePath) return entry;
		changed = true;
		const record = asRecord(entry);
		if (disabled) {
			return record ? { ...record, extensions: [] } : { source: normalized.source, extensions: [] };
		}
		if (record) {
			const restored = { ...record };
			if (Array.isArray(restored.extensions) && restored.extensions.length === 0) delete restored.extensions;
			return Object.keys(restored).length === 1 && restored.source === normalized.source ? normalized.source : restored;
		}
		return normalized.source;
	});
	if (changed) {
		file.json.packages = next;
		writeSettingsFile(file);
	}
	return changed;
}

function setPackageExtensionFiltered(item: InventoryItem, files: SettingsFile[], disabled: boolean): boolean {
	if (!item.packageDir || !item.entrypoint) return false;
	const file = findSettingsFile(files, item.scope);
	const packages = Array.isArray(file.json.packages) ? file.json.packages : [];
	const exclude = `-${item.entrypoint}`;
	let changed = false;
	const next = packages.map((entry) => {
		const normalized = normalizePackageEntry(entry, file.baseDir);
		if (!normalized || normalized.resolved !== item.packageDir) return entry;
		changed = true;
		const record = asRecord(entry);
		const filters = Array.isArray(record?.extensions) ? record!.extensions.filter((value): value is string => typeof value === "string") : [];
		const withoutThis = filters.filter((value) => value !== exclude && value !== `!${item.entrypoint}`);
		if (disabled) {
			const extensions = withoutThis.includes(exclude) ? withoutThis : [...withoutThis, exclude];
			return record ? { ...record, extensions } : { source: normalized.source, extensions };
		}
		if (record) {
			const restored = { ...record };
			if (withoutThis.length > 0) restored.extensions = withoutThis;
			else delete restored.extensions;
			return Object.keys(restored).length === 1 && restored.source === normalized.source ? normalized.source : restored;
		}
		return normalized.source;
	});
	if (changed) {
		file.json.packages = next;
		writeSettingsFile(file);
	}
	return changed;
}

function toggleProvider(pi: ExtensionAPI, ctx: ExtensionCommandContext | ExtensionContext, inventory: Inventory, provider: string): void {
	const file = findSettingsFile(inventory.settingsFiles, "project");
	const disabled = new Set(inventory.managerState.disabledProviders);
	if (disabled.has(provider)) disabled.delete(provider);
	else disabled.add(provider);
	updateManagerState(file, (state) => {
		state.disabledProviders = [...disabled].sort();
	});
	const active = new Set(safeActiveTools(pi));
	const itemDisabled = new Set(inventory.managerState.disabledItems);
	for (const tool of inventory.items.filter((item) => item.kind === "tool" && item.provider === provider)) {
		if (disabled.has(provider)) active.delete(tool.displayName);
		else if (!itemDisabled.has(tool.id)) active.add(tool.displayName);
	}
	pi.setActiveTools?.([...active]);
	ctx.ui.notify(`Provider ${provider} ${disabled.has(provider) ? "disabled" : "enabled"}. Package/module resources require /reload.`, "warning");
}

function createManagerComponent(
	pi: ExtensionAPI,
	inventory: Inventory,
	ui: ManagerUiState,
	theme: Theme,
	requestRender: () => void,
	done: (value: ManagerAction) => void,
) {
	const topTabs: TopTab[] = ["General", "Extensions", "Audit"];
	const providers = ["all", ...new Set(inventory.items.map((item) => item.provider))].sort();
	const kinds = ["all", ...new Set(inventory.items.map((item) => item.kind))].sort();
	const states = ["all", "active", "disabled", "shadowed", "broken"];
	const scopes = ["all", "project", "user", "temporary", "builtin", "unknown"];

	function clamp(): void {
		if (ui.topTab !== "Extensions") return;
		const list = filteredItems(inventory.items, ui);
		ui.selected = Math.max(0, Math.min(ui.selected, Math.max(0, list.length - 1)));
		ui.scroll = Math.max(0, Math.min(ui.scroll, Math.max(0, list.length - LIST_ROWS)));
		if (ui.selected < ui.scroll) ui.scroll = ui.selected;
		if (ui.selected >= ui.scroll + LIST_ROWS) ui.scroll = ui.selected - LIST_ROWS + 1;
		const selected = list[ui.selected];
		const settingCount = selected?.settingsSchema?.length ?? 0;
		ui.settingSelected = Math.max(0, Math.min(ui.settingSelected, Math.max(0, settingCount - 1)));
		if (ui.settingSelected < ui.settingScroll) ui.settingScroll = ui.settingSelected;
		if (ui.settingSelected >= ui.settingScroll + SETTINGS_ROWS) ui.settingScroll = ui.settingSelected - SETTINGS_ROWS + 1;
	}

	function cycle<T extends string>(values: T[], current: string, delta: number): T {
		const idx = Math.max(0, values.indexOf(current as T));
		return values[(idx + delta + values.length) % values.length]!;
	}

	function handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return done({ type: "close" });
		if (matchesKey(data, "tab")) {
			ui.topTab = cycle(topTabs, ui.topTab, 1);
			requestRender();
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			ui.topTab = cycle(topTabs, ui.topTab, -1);
			requestRender();
			return;
		}
		if (ui.topTab !== "Extensions") return;
		const list = filteredItems(inventory.items, ui);
		const selected = list[ui.selected];
		const settings = selected?.settingsSchema ?? [];
		if (matchesKey(data, "left")) {
			ui.pane = "list";
			requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			ui.pane = "settings";
			requestRender();
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			if (ui.pane === "settings") ui.settingSelected -= 1;
			else ui.selected -= 1;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			if (ui.pane === "settings") ui.settingSelected += 1;
			else ui.selected += 1;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "pageup")) {
			ui.selected -= LIST_ROWS;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "pagedown")) {
			ui.selected += LIST_ROWS;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "backspace")) {
			ui.search = ui.search.slice(0, -1);
			ui.selected = 0;
			clamp();
			requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			ui.search = "";
			ui.selected = 0;
			clamp();
			requestRender();
			return;
		}
		if (data === "f") {
			ui.kindFilter = cycle(kinds, ui.kindFilter, 1);
			ui.selected = 0;
			clamp();
			requestRender();
			return;
		}
		if (data === "p") {
			ui.providerFilter = cycle(providers, ui.providerFilter, 1);
			ui.selected = 0;
			clamp();
			requestRender();
			return;
		}
		if (data === "s") {
			ui.stateFilter = cycle(states, ui.stateFilter, 1);
			ui.selected = 0;
			clamp();
			requestRender();
			return;
		}
		if (data === "S") {
			ui.scopeFilter = cycle(scopes, ui.scopeFilter, 1);
			ui.selected = 0;
			clamp();
			requestRender();
			return;
		}
		if (data === "P" && selected) return done({ type: "toggle-provider", provider: selected.provider });
		if ((matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") && selected) {
			if (ui.pane === "settings" && settings.length > 0) {
				const schema = settings[ui.settingSelected];
				if (!schema) return;
				const extensionId = selectedPackageForSetting(selected) ?? selected.displayName;
				const current = getConfigValue(inventory, extensionId, schema).value;
				if (schema.type === "boolean" || schema.type === "enum") {
					return done({ type: "set-setting", itemId: selected.id, settingKey: schema.key, value: nextSettingValue(schema, current) });
				}
				return done({ type: "edit-setting", itemId: selected.id, settingKey: schema.key });
			}
			return done({ type: "toggle-item", itemId: selected.id });
		}
		if (data === "e" && selected && settings.length > 0) {
			const schema = settings[ui.settingSelected];
			if (schema) return done({ type: "edit-setting", itemId: selected.id, settingKey: schema.key });
		}
		if (data.length === 1 && data >= " " && data !== "\x7f") {
			ui.search += data;
			ui.selected = 0;
			clamp();
			requestRender();
		}
	}

	function render(width: number): string[] {
		clamp();
		const safeWidth = Math.max(60, width);
		const bodyWidth = safeWidth - 4;
		let lines: string[] = [];
		lines.push(renderTabBar(topTabs, ui.topTab, bodyWidth, theme));
		lines.push(theme.fg("dim", "tab switch tabs · ↑↓ navigate · enter/space toggle or edit · esc close"));
		lines.push("");
		if (ui.topTab === "General") lines.push(...renderGeneral(inventory, bodyWidth, theme));
		if (ui.topTab === "Audit") lines.push(...renderAudit(inventory, bodyWidth, theme));
		if (ui.topTab === "Extensions") lines.push(...renderExtensions(inventory, ui, bodyWidth, theme));
		return frame(lines, safeWidth, theme);
	}

	return { handleInput, invalidate() {}, render };
}

function renderTabBar(tabs: TopTab[], active: TopTab, width: number, theme: Theme): string {
	const parts = tabs.map((tab) => (tab === active ? theme.bg("selectedBg", ` ${theme.bold(tab)} `) : theme.fg("muted", ` ${tab} `)));
	return truncateToWidth(parts.join(" "), width, "");
}

function renderGeneral(inventory: Inventory, width: number, theme: Theme): string[] {
	const counts = countBy(inventory.items, (item) => item.state);
	const kinds = countBy(inventory.items, (item) => item.kind);
	const lines = [
		theme.fg("accent", theme.bold("vstack Pi Settings")),
		"",
		`Inventory: ${inventory.items.length} items · ${counts.active ?? 0} active · ${counts.disabled ?? 0} disabled · ${counts.shadowed ?? 0} shadowed · ${counts.broken ?? 0} broken`,
		`Kinds: ${Object.entries(kinds).map(([k, v]) => `${k}=${v}`).join(", ")}`,
		"",
		theme.fg("accent", "Settings files"),
	];
	for (const file of inventory.settingsFiles) {
		lines.push(`${file.scope}: ${file.path}${file.exists ? "" : " (not created yet)"}`);
	}
	lines.push("", theme.fg("warning", "Runtime note"));
	lines.push("Pi currently has no public API for injecting native /settings tabs or unloading extension modules live.");
	lines.push("This manager provides the integrated settings shell here and applies tool toggles live; package/module toggles apply after /reload or restart.");
	return lines.map((line) => truncateToWidth(line, width, ""));
}

function renderAudit(inventory: Inventory, width: number, theme: Theme): string[] {
	const lines = [theme.fg("accent", theme.bold("Local package settings audit")), ""];
	if (inventory.auditLines.length === 0) lines.push("No package manifests found in current Pi settings.");
	for (const block of inventory.auditLines) {
		const [head, ...rest] = block.split("\n");
		lines.push(theme.fg("accent", head ?? "package"));
		for (const line of rest) lines.push(theme.fg("dim", line));
		lines.push("");
	}
	return lines.flatMap((line) => wrapLine(line, width));
}

function renderExtensions(inventory: Inventory, ui: ManagerUiState, width: number, theme: Theme): string[] {
	const list = filteredItems(inventory.items, ui);
	const selected = list[ui.selected];
	const leftWidth = Math.max(LEFT_MIN_WIDTH, Math.min(LEFT_MAX_WIDTH, Math.floor(width * 0.38)));
	const rightWidth = Math.max(20, width - leftWidth - 3);
	const left = renderList(list, ui, leftWidth, theme);
	const right = renderInspector(inventory, selected, ui, rightWidth, theme);
	const rows = Math.max(left.length, right.length);
	const lines = [
		truncateToWidth(
			`${theme.fg("accent", "Search")}: ${ui.search || theme.fg("dim", "type to filter")}  ${theme.fg("accent", "kind")}:${ui.kindFilter} ${theme.fg("accent", "provider")}:${ui.providerFilter} ${theme.fg("accent", "state")}:${ui.stateFilter} ${theme.fg("accent", "scope")}:${ui.scopeFilter}`,
			width,
			"",
		),
		theme.fg("dim", "f kind · p provider · s state · S scope · P toggle provider · ←/→ pane · e edit text setting"),
		"",
	];
	for (let i = 0; i < rows; i += 1) {
		lines.push(`${pad(left[i] ?? "", leftWidth)} ${theme.fg("dim", "│")} ${truncateToWidth(right[i] ?? "", rightWidth, "")}`);
	}
	return lines;
}

function renderList(items: InventoryItem[], ui: ManagerUiState, width: number, theme: Theme): string[] {
	const lines = [`${theme.fg(ui.pane === "list" ? "accent" : "muted", theme.bold("Extensions"))} ${theme.fg("dim", `(${items.length})`)}`, ""];
	if (items.length === 0) {
		lines.push(theme.fg("dim", "No matching items."));
		return lines;
	}
	if (ui.scroll > 0) lines.push(theme.fg("dim", `↑ ${ui.scroll} more`));
	for (const [visibleIndex, item] of items.slice(ui.scroll, ui.scroll + LIST_ROWS).entries()) {
		const index = ui.scroll + visibleIndex;
		const marker = index === ui.selected ? theme.fg("accent", "›") : theme.fg("dim", " ");
		const stateIcon = item.state === "active" ? theme.fg("success", "●") : item.state === "disabled" ? theme.fg("warning", "○") : item.state === "shadowed" ? theme.fg("dim", "◌") : theme.fg("error", "×");
		const text = `${marker} ${stateIcon} ${item.displayName}`;
		lines.push(truncateToWidth(text, width, "…"));
		lines.push(truncateToWidth(`    ${theme.fg("dim", `${item.kind} · ${item.scope} · ${item.provider}`)}`, width, "…"));
	}
	const hidden = Math.max(0, items.length - (ui.scroll + LIST_ROWS));
	if (hidden > 0) lines.push(theme.fg("dim", `↓ ${hidden} more`));
	return lines;
}

function renderInspector(inventory: Inventory, item: InventoryItem | undefined, ui: ManagerUiState, width: number, theme: Theme): string[] {
	if (!item) return [theme.fg("dim", "Select an item to inspect it.")];
	const lines = [
		`${theme.fg("accent", theme.bold(item.displayName))} ${theme.fg(stateColor(item.state), item.state)}`,
		item.description || theme.fg("dim", "No description."),
		"",
		`${theme.fg("muted", "Kind")}: ${item.kind}`,
		`${theme.fg("muted", "Provider")}: ${item.provider}`,
		`${theme.fg("muted", "Scope")}: ${item.scope}`,
		`${theme.fg("muted", "Source")}: ${item.sourcePath}`,
		`${theme.fg("muted", "State")}: ${item.stateReason}`,
	];
	if (item.trigger) lines.push(`${theme.fg("muted", "Trigger")}: ${item.trigger}`);
	if (item.shadowedBy) lines.push(`${theme.fg("muted", "Shadowed by")}: ${item.shadowedBy}`);
	if (item.brokenError) lines.push(`${theme.fg("error", "Error")}: ${item.brokenError}`);
	lines.push("", `${theme.fg(ui.pane === "settings" ? "accent" : "muted", theme.bold("Settings"))}`);
	const schemas = item.settingsSchema ?? [];
	if (schemas.length === 0) {
		lines.push(theme.fg("dim", "No declared settings schema for this item."));
		return lines.flatMap((line) => wrapLine(line, width));
	}
	const extensionId = selectedPackageForSetting(item) ?? item.displayName;
	if (ui.settingScroll > 0) lines.push(theme.fg("dim", `↑ ${ui.settingScroll} earlier setting(s)`));
	for (const [visibleIndex, schema] of schemas.slice(ui.settingScroll, ui.settingScroll + SETTINGS_ROWS).entries()) {
		const index = ui.settingScroll + visibleIndex;
		const config = getConfigValue(inventory, extensionId, schema);
		const marker = index === ui.settingSelected ? theme.fg("accent", "›") : " ";
		const apply = schema.apply ?? (schema.requiresReload ? "reload" : "live");
		const value = formatSettingValue(schema, config.value);
		const scope = config.explicit ? config.scope : "default";
		lines.push(`${marker} ${schema.label ?? schema.key}: ${theme.fg("accent", value)} ${theme.fg("dim", `(${schema.type}, ${scope}, ${apply})`)}`);
		if (schema.description) lines.push(`  ${theme.fg("dim", schema.description)}`);
	}
	const hidden = Math.max(0, schemas.length - (ui.settingScroll + SETTINGS_ROWS));
	if (hidden > 0) lines.push(theme.fg("dim", `↓ ${hidden} more setting(s)`));
	return lines.flatMap((line) => wrapLine(line, width));
}

function stateColor(state: ExtensionState): string {
	if (state === "active") return "success";
	if (state === "disabled") return "warning";
	if (state === "broken") return "error";
	return "dim";
}

function frame(lines: string[], width: number, theme: Theme): string[] {
	const inner = Math.max(1, width - 2);
	const border = (s: string) => theme.fg("borderAccent", s);
	const out = [`${border("╭")}${border("─".repeat(inner))}${border("╮")}`];
	for (const line of lines) out.push(`${border("│")}${pad(line, inner)}${border("│")}`);
	out.push(`${border("╰")}${border("─".repeat(inner))}${border("╯")}`);
	return out.map((line) => truncateToWidth(line, width, ""));
}

function pad(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function wrapLine(line: string, width: number): string[] {
	return [truncateToWidth(line, width, "…")];
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
	return out;
}

function stringifyError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

export default function extensionManager(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;

	const projectPiDir = findProjectPiDir(process.cwd());
	const loadConfig = mergedManagerState([
		{ baseDir: userPiDir(), exists: existsSync(join(userPiDir(), "settings.json")), json: readJsonObject(join(userPiDir(), "settings.json")).json, path: join(userPiDir(), "settings.json"), scope: "user" },
		{ baseDir: projectPiDir, exists: existsSync(join(projectPiDir, "settings.json")), json: readJsonObject(join(projectPiDir, "settings.json")).json, path: join(projectPiDir, "settings.json"), scope: "project" },
	]);

	if (loadConfig.config[MANAGER_ID]?.enabled === false) {
		pi.registerCommand("extensions", {
			description: "Extension manager is disabled. Use /extensions enable to re-enable it.",
			handler: async (args, ctx) => {
				if (args.trim().toLowerCase() !== "enable") {
					ctx.ui.notify("Extension manager UI is disabled. Run /extensions enable, then /reload, to restore it.", "warning");
					return;
				}
				const files = loadSettingsFiles(ctx as ExtensionContext);
				const scope = defaultWriteScope(undefined, files, mergedManagerState(files));
				const file = findSettingsFile(files, scope);
				updateManagerState(file, (state) => {
					state.config[MANAGER_ID] = { ...(state.config[MANAGER_ID] ?? {}), enabled: true };
				});
				ctx.ui.notify("Extension manager enabled. Run /reload to restore the full UI.", "info");
			},
		});
		return;
	}

	pi.registerCommand("extensions", {
		description: "Browse, toggle, inspect, and configure Pi extension-like resources.",
		handler: async (_args, ctx) => openManager(pi, ctx, "Extensions"),
	});

	pi.registerCommand("settings-extensions", {
		description: "Open the vstack settings shell directly on the Extensions tab.",
		handler: async (_args, ctx) => openManager(pi, ctx, "Extensions"),
	});

	// Best-effort /settings integration. Pi's public extension API has no native
	// settings-tab registration yet. If extension commands are checked before the
	// built-in /settings handler in the active Pi version, this gives users the
	// requested /settings extensions entrypoint. If not, /extensions remains the
	// stable shortcut. The wrapper can be disabled from manager settings.
	if (loadConfig.config[MANAGER_ID]?.allowSettingsCommandShadow !== false) {
		pi.registerCommand("settings", {
			description: "vstack settings shell; use /settings extensions to jump to extension management.",
			handler: async (args, ctx) => {
				const initial = args.trim().toLowerCase().startsWith("extensions") ? "Extensions" : "General";
				await openManager(pi, ctx, initial as TopTab);
			},
		});
	}

	pi.on("session_start", (_event, ctx) => {
		const inventory = buildInventory(pi, ctx);
		const disabledTools = new Set(
			inventory.items.filter((item) => item.kind === "tool" && item.state === "disabled").map((item) => item.displayName),
		);
		if (disabledTools.size > 0) {
			const active = safeActiveTools(pi).filter((tool) => !disabledTools.has(tool));
			pi.setActiveTools?.(active);
		}
	});
}
