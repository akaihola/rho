import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

export type KnownFileCategory = "core" | "brain" | "config";

export interface KnownFile {
	id: string;
	name: string;
	category: KnownFileCategory;
	path: string;
	isDirectory?: boolean;
}

export function getRhoHome(): string {
	return process.env.RHO_HOME ?? path.join(os.homedir(), ".rho");
}

function resolveOneProjectDir(value: unknown, home: string): string {
	if (typeof value !== "string" || !value.trim()) return "";
	const v = value.trim();
	if (v === "~") return home;
	if (v.startsWith("~/")) return path.resolve(home, v.slice(2));
	return path.resolve(v);
}

function resolveProjectsDirs(raw: unknown): string[] {
	const home = process.env.HOME ?? os.homedir();
	const fallback = [path.join(getRhoHome(), "projects")];
	if (Array.isArray(raw)) {
		const dirs = raw.map((v) => resolveOneProjectDir(v, home)).filter(Boolean);
		return dirs.length > 0 ? dirs : fallback;
	}
	const single = resolveOneProjectDir(raw, home);
	return single ? [single] : fallback;
}

export function getProjectsDirs(): string[] {
	const initPath = path.join(getRhoHome(), "init.toml");
	try {
		const raw = parseToml(readFileSync(initPath, "utf-8")) as Record<
			string,
			unknown
		>;
		// projects_dirs (array) takes precedence; falls back to projects_dir (string)
		const rawDirs = raw.projects_dirs ?? raw.projects_dir;
		return resolveProjectsDirs(rawDirs);
	} catch {
		return resolveProjectsDirs(undefined);
	}
}

/** Backward-compat: returns the first configured projects dir. */
export function getProjectsDir(): string {
	return getProjectsDirs()[0];
}

export function getRecursiveDiscovery(): boolean {
	const initPath = path.join(getRhoHome(), "init.toml");
	try {
		const raw = parseToml(readFileSync(initPath, "utf-8")) as Record<
			string,
			unknown
		>;
		const settings = (raw?.settings as Record<string, unknown>) ?? {};
		const web = (settings?.web as Record<string, unknown>) ?? {};
		return web.recursive_discovery === true;
	} catch {
		return false;
	}
}

export function getKnownFiles(): KnownFile[] {
	const rhoHome = getRhoHome();
	const brainDir = path.join(rhoHome, "brain");
	const vaultDb = path.join(brainDir, "vault.db");
	const vaultDir = path.join(brainDir, "vault");

	const files: KnownFile[] = [
		{
			id: "brain-jsonl",
			name: "brain.jsonl",
			category: "brain",
			path: path.join(brainDir, "brain.jsonl"),
		},
		{
			id: "init-toml",
			name: "init.toml",
			category: "config",
			path: path.join(rhoHome, "init.toml"),
		},
	];

	if (existsSync(vaultDir) && !existsSync(vaultDb)) {
		files.push({
			id: "vault-dir",
			name: "vault",
			category: "brain",
			path: vaultDir,
			isDirectory: true,
		});
	} else {
		files.push({
			id: "vault-db",
			name: "vault.db",
			category: "brain",
			path: vaultDb,
		});
	}

	return files;
}

export function findKnownFileByPath(candidatePath: string): KnownFile | null {
	const normalized = path.resolve(candidatePath);
	const files = getKnownFiles();

	for (const file of files) {
		if (path.resolve(file.path) === normalized) {
			return file;
		}
	}

	return null;
}

export interface AuthConfig {
	enabled: boolean;
	tokenHashes: string[];
	sessionTtlSeconds: number;
}

// ── RPC Reliability Config ──────────────────────────────

const DEFAULT_ORPHAN_GRACE_MS = 60_000;
const DEFAULT_ORPHAN_ABORT_DELAY_MS = 5_000;
// Minimum values: grace must be at least 1 s; abort-delay may be 0 (immediate).
const MIN_ORPHAN_GRACE_MS = 1_000;
const MIN_ORPHAN_ABORT_DELAY_MS = 0;

export interface RpcReliabilityConfig {
	/** How long (ms) to wait for a subscriber to re-attach before triggering orphan abort. */
	orphanGraceMs: number;
	/** How long (ms) after orphan abort before the session is fully stopped. */
	orphanAbortDelayMs: number;
}

/**
 * Parse a raw TOML value as a millisecond duration.
 * Non-numeric, NaN, or Infinite values fall back to `fallback`.
 * Valid numbers are clamped to `[minValue, ∞)` and floored.
 */
function parseOrphanMs(
	raw: unknown,
	minValue: number,
	fallback: number,
): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) {
		return fallback;
	}
	return Math.max(minValue, Math.floor(raw));
}

/**
 * Read orphan-timing config from `[settings.web]` in init.toml.
 * Pass `initPath` to override the default `~/.rho/init.toml` (useful in tests).
 * Falls back to safe defaults on any parse error.
 */
export function getRpcReliabilityConfig(
	initPath?: string,
): RpcReliabilityConfig {
	const resolvedPath = initPath ?? path.join(getRhoHome(), "init.toml");
	try {
		const raw = parseToml(readFileSync(resolvedPath, "utf-8")) as Record<
			string,
			unknown
		>;
		const settings = (raw?.settings as Record<string, unknown>) ?? {};
		const web = (settings?.web as Record<string, unknown>) ?? {};
		return {
			orphanGraceMs: parseOrphanMs(
				web.rpc_orphan_grace_ms,
				MIN_ORPHAN_GRACE_MS,
				DEFAULT_ORPHAN_GRACE_MS,
			),
			orphanAbortDelayMs: parseOrphanMs(
				web.rpc_orphan_abort_delay_ms,
				MIN_ORPHAN_ABORT_DELAY_MS,
				DEFAULT_ORPHAN_ABORT_DELAY_MS,
			),
		};
	} catch {
		return {
			orphanGraceMs: DEFAULT_ORPHAN_GRACE_MS,
			orphanAbortDelayMs: DEFAULT_ORPHAN_ABORT_DELAY_MS,
		};
	}
}

export function getAuthConfig(): AuthConfig {
	const initPath = path.join(getRhoHome(), "init.toml");
	try {
		const raw = parseToml(readFileSync(initPath, "utf-8")) as Record<
			string,
			unknown
		>;
		const settings = (raw?.settings as Record<string, unknown>) || {};
		const web = (settings?.web as Record<string, unknown>) || {};

		const tokenHashes = Array.isArray(web.auth_token_hashes)
			? web.auth_token_hashes.filter((h): h is string => typeof h === "string")
			: [];

		if (
			typeof web.auth_token_hash === "string" &&
			!tokenHashes.includes(web.auth_token_hash)
		) {
			tokenHashes.push(web.auth_token_hash);
		}

		let sessionTtlSeconds = 900;
		if (
			typeof web.auth_session_ttl_seconds === "number" &&
			web.auth_session_ttl_seconds > 0
		) {
			sessionTtlSeconds = web.auth_session_ttl_seconds;
		}

		return {
			enabled: web.auth_enabled === true,
			tokenHashes,
			sessionTtlSeconds,
		};
	} catch {
		return { enabled: false, tokenHashes: [], sessionTtlSeconds: 900 };
	}
}
