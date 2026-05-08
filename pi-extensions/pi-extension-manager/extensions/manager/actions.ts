import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { removeAppendSystemBlockForUninstall, syncAppendSystemForPackage } from "./append-system.js";
import { stringifyError } from "./format.js";
import { normalizePackageEntry } from "./inventory.js";
import { asRecord, defaultWriteScope, findSettingsFile, updateManagerState, writeSettingsFile } from "./settings.js";
import { loadSourceIndex, npmPackageNameFromSource } from "./versions.js";
import {
	MANAGER_ID,
	type Inventory,
	type InventoryItem,
	type SettingsFile,
	type UninstallPlan,
	type UpdatePlan,
} from "./types.js";

export function planUninstall(item: InventoryItem, inventory: Inventory, ctx: ExtensionCommandContext | ExtensionContext): UninstallPlan | undefined {
	if (item.kind !== "package" || !item.packageName) return undefined;
	const sourceIndex = loadSourceIndex(inventory.settingsFiles);
	const scopeFlag = item.scope === "user" ? " --global" : "";
	if (sourceIndex[item.packageName]) {
		return {
			item,
			method: { kind: "vstack", packageName: item.packageName, scope: item.scope },
			command: `vstack remove ${item.packageName}${scopeFlag}`,
			description: "Installed via vstack — runs the vstack remove command (deletes the package directory, the settings.json entry, and the source-index entry).",
		};
	}
	const npmName = npmPackageNameFromSource(item.sourceName);
	if (npmName) {
		const gFlag = item.scope === "user" ? " -g" : "";
		return {
			item,
			method: { kind: "npm", npmName, scope: item.scope, cwd: ctx.cwd },
			command: `npm uninstall${gFlag} ${npmName}`,
			description: "Installed via npm — runs npm uninstall, then strips the npm: entry from Pi settings.json.",
		};
	}
	return {
		item,
		method: { kind: "orphan", packageName: item.packageName, scope: item.scope },
		command: `(strip ${item.sourceName} from ${item.scope} settings.json)`,
		description: "No vstack source-index entry and no npm: prefix — only the Pi settings.json entry will be removed.",
	};
}

function removePackageEntryFromSettings(item: InventoryItem, files: SettingsFile[]): boolean {
	const file = findSettingsFile(files, item.scope);
	if (!Array.isArray(file.json.packages)) return false;
	const before = file.json.packages.length;
	const next = file.json.packages.filter((entry) => {
		const normalized = normalizePackageEntry(entry, file.baseDir);
		if (!normalized) return true;
		if (normalized.resolved === item.sourcePath) return false;
		if (normalized.source === item.sourceName) return false;
		return true;
	});
	if (next.length === before) return false;
	if (next.length === 0) delete file.json.packages;
	else file.json.packages = next;
	writeSettingsFile(file);
	return true;
}

export function runUninstall(plan: UninstallPlan, inventory: Inventory): { ok: boolean; message: string } {
	if (plan.method.kind === "vstack") {
		const args = ["remove", plan.method.packageName];
		if (plan.method.scope === "user") args.push("--global");
		const result = spawnSync("vstack", args, { encoding: "utf8" });
		if (result.error) return { ok: false, message: `Failed to launch vstack: ${stringifyError(result.error)}` };
		if ((result.status ?? 1) !== 0) {
			const stderr = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `exit ${result.status}`;
			return { ok: false, message: `vstack remove failed: ${stderr}` };
		}
		// `vstack remove` already handled APPEND_SYSTEM.md, so no extra cleanup here.
		return { ok: true, message: `Removed via vstack: ${plan.item.displayName}.` };
	}
	if (plan.method.kind === "npm") {
		const args = ["uninstall"];
		if (plan.method.scope === "user") args.push("-g");
		args.push(plan.method.npmName);
		const result = spawnSync("npm", args, { encoding: "utf8", cwd: plan.method.cwd });
		if (result.error) return { ok: false, message: `Failed to launch npm: ${stringifyError(result.error)}` };
		if ((result.status ?? 1) !== 0) {
			const stderr = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `exit ${result.status}`;
			return { ok: false, message: `npm uninstall failed: ${stderr}` };
		}
		const stripped = removePackageEntryFromSettings(plan.item, inventory.settingsFiles);
		// Backstop: npm's preuninstall script should have removed the block,
		// but call removeAppendSystemBlockForUninstall too — idempotent if the
		// preuninstall already won the race.
		removeAppendSystemBlockForUninstall(plan.item);
		return { ok: true, message: `npm uninstall ${plan.method.npmName} succeeded${stripped ? "; removed Pi settings entry." : " (no settings entry to remove)."}` };
	}
	const stripped = removePackageEntryFromSettings(plan.item, inventory.settingsFiles);
	// Orphan branch: settings.json strip is the only underlying cleanup, so
	// remove any APPEND_SYSTEM.md block keyed by this package name as well.
	removeAppendSystemBlockForUninstall(plan.item);
	return stripped
		? { ok: true, message: `Removed ${plan.item.sourceName} from ${plan.item.scope} settings.json.` }
		: { ok: false, message: `Could not find a matching entry for ${plan.item.sourceName} in ${plan.item.scope} settings.json.` };
}

export function planUpdate(item: InventoryItem, ctx: ExtensionCommandContext | ExtensionContext): UpdatePlan | undefined {
	if (item.kind !== "package" || !item.packageName || !item.updateAvailable) return undefined;
	if (item.updateSource === "vstack" && item.sourceRepo) {
		const scopeFlag = item.scope === "user" ? " --global" : "";
		return {
			item,
			method: { kind: "vstack", packageName: item.packageName, sourceRepo: item.sourceRepo, scope: item.scope },
			command: `vstack add ${item.sourceRepo}${scopeFlag} --pi-extension ${item.packageName} --harness pi -y`,
			description: "Installed via vstack — copies the selected package from its tracked source repo into the same Pi scope.",
		};
	}
	if (item.updateSource === "npm" && item.npmName) {
		return {
			item,
			method: { kind: "npm", npmName: item.npmName, scope: item.scope, cwd: ctx.cwd },
			command: `npm install -g ${item.npmName}@latest`,
			description: "Installed via npm — installs the latest published package version, then Pi can load it after /reload or restart.",
		};
	}
	return undefined;
}

export function runUpdate(plan: UpdatePlan): { ok: boolean; message: string } {
	if (plan.method.kind === "vstack") {
		const args = ["add", plan.method.sourceRepo];
		if (plan.method.scope === "user") args.push("--global");
		args.push("--pi-extension", plan.method.packageName, "--harness", "pi", "-y");
		const result = spawnSync("vstack", args, { encoding: "utf8" });
		if (result.error) return { ok: false, message: `Failed to launch vstack: ${stringifyError(result.error)}` };
		if ((result.status ?? 1) !== 0) {
			const stderr = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `exit ${result.status}`;
			return { ok: false, message: `vstack update failed: ${stderr}` };
		}
		return { ok: true, message: `Updated via vstack: ${plan.item.displayName}.` };
	}
	const result = spawnSync("npm", ["install", "-g", `${plan.method.npmName}@latest`], { encoding: "utf8", cwd: plan.method.cwd });
	if (result.error) return { ok: false, message: `Failed to launch npm: ${stringifyError(result.error)}` };
	if ((result.status ?? 1) !== 0) {
		const stderr = (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `exit ${result.status}`;
		return { ok: false, message: `npm update failed: ${stderr}` };
	}
	return { ok: true, message: `Updated via npm: ${plan.method.npmName}.` };
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

export function toggleItem(_pi: ExtensionAPI, ctx: ExtensionCommandContext | ExtensionContext, inventory: Inventory, item: InventoryItem): void {
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

	if (item.kind === "package" && item.packageName) {
		const changed = setPackageFiltered(item, inventory.settingsFiles, willDisable);
		syncAppendSystemForPackage(item, willDisable);
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
