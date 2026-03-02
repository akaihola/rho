import { execFile as execFileCb } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getProjectsDirs, getRhoHome } from "./config.ts";

const execFile = promisify(execFileCb);
const SESSION_CONTEXT_FILE = path.join(
	getRhoHome(),
	"git-context-sessions.json",
);
const MAX_PROJECTS = 500;

export interface SessionGitContext {
	sessionId: string;
	repoId: string;
	cwd: string;
	updatedAt: number;
}

interface SessionGitContextFile {
	version: 1;
	updatedAt: number;
	sessions: Record<string, SessionGitContext>;
}

function normalizeSessionId(raw: string): string {
	return typeof raw === "string" ? raw.trim() : "";
}

function normalizeRepoId(raw: string): string {
	const value = typeof raw === "string" ? raw.trim() : "";
	if (!value || value.includes("\0")) {
		return "";
	}
	// Absolute paths are accepted; security is enforced in resolveRepoFromId.
	if (path.isAbsolute(value)) {
		return path.normalize(value);
	}
	// Relative paths: normalise and reject traversal.
	const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
	if (
		normalized === "." ||
		normalized === ".." ||
		normalized.startsWith("../")
	) {
		return "";
	}
	return normalized;
}

async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		await execFile("git", ["rev-parse", "--git-dir"], {
			cwd,
			timeout: 2000,
			maxBuffer: 256 * 1024,
		});
		return true;
	} catch {
		return false;
	}
}

function emptyStore(): SessionGitContextFile {
	return { version: 1, updatedAt: 0, sessions: {} };
}

export async function readSessionGitContextFile(): Promise<SessionGitContextFile> {
	try {
		const raw = await readFile(SESSION_CONTEXT_FILE, "utf-8");
		const parsed = JSON.parse(raw) as SessionGitContextFile;
		if (!parsed || typeof parsed !== "object") {
			return emptyStore();
		}
		if (!parsed.sessions || typeof parsed.sessions !== "object") {
			return emptyStore();
		}
		return {
			version: 1,
			updatedAt:
				typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
			sessions: parsed.sessions,
		};
	} catch {
		return emptyStore();
	}
}

async function writeSessionGitContextFile(
	payload: SessionGitContextFile,
): Promise<void> {
	await mkdir(path.dirname(SESSION_CONTEXT_FILE), { recursive: true });
	await writeFile(SESSION_CONTEXT_FILE, JSON.stringify(payload), "utf-8");
}

export async function getSessionGitContext(
	sessionId: string,
): Promise<SessionGitContext | null> {
	const id = normalizeSessionId(sessionId);
	if (!id) {
		return null;
	}
	const store = await readSessionGitContextFile();
	const entry = store.sessions[id];
	if (
		!entry ||
		typeof entry.cwd !== "string" ||
		typeof entry.repoId !== "string"
	) {
		return null;
	}
	return {
		sessionId: id,
		repoId: entry.repoId,
		cwd: entry.cwd,
		updatedAt:
			typeof entry.updatedAt === "number" ? entry.updatedAt : store.updatedAt,
	};
}

export async function setSessionGitContext(
	sessionId: string,
	repoId: string,
): Promise<SessionGitContext> {
	const id = normalizeSessionId(sessionId);
	if (!id) {
		throw new Error("sessionId is required");
	}
	const resolved = resolveRepoFromId(repoId);
	if (!resolved) {
		throw new Error("Invalid repoId");
	}
	if (!(await isGitRepo(resolved.cwd))) {
		throw new Error("Repository is not a git repo");
	}

	const now = Date.now();
	const entry: SessionGitContext = {
		sessionId: id,
		repoId: resolved.repoId,
		cwd: resolved.cwd,
		updatedAt: now,
	};
	const store = await readSessionGitContextFile();
	store.updatedAt = now;
	store.sessions[id] = entry;
	await writeSessionGitContextFile(store);
	return entry;
}

export function resolveRepoFromId(
	repoId: string,
	projectsDirsRaw: string[] = getProjectsDirs(),
): { repoId: string; cwd: string } | null {
	const normalizedRepoId = normalizeRepoId(repoId);
	if (!normalizedRepoId) {
		return null;
	}

	// New format: absolute path — validate it lives inside one of the allowed dirs.
	if (path.isAbsolute(normalizedRepoId)) {
		for (const baseDir of projectsDirsRaw) {
			const rel = path.relative(path.resolve(baseDir), normalizedRepoId);
			if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
				return { repoId: normalizedRepoId, cwd: normalizedRepoId };
			}
		}
		return null;
	}

	// Legacy format: relative path — resolve against the first configured dir.
	const primaryDir = path.resolve(projectsDirsRaw[0] ?? "");
	if (!primaryDir) return null;
	const cwd = path.resolve(primaryDir, normalizedRepoId);
	const rel = path.relative(primaryDir, cwd);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
		return null;
	}
	return { repoId: normalizedRepoId, cwd };
}

/**
 * Scan `scanDir` for immediate-child git repos.
 * Uses absolute paths as IDs to work correctly across multiple base directories.
 */
async function collectGitProjects(
	scanDir: string,
	results: Array<{ id: string; name: string; cwd: string }>,
): Promise<void> {
	if (results.length >= MAX_PROJECTS) return;

	let entries: Awaited<ReturnType<typeof readdir>>;
	try {
		entries = await readdir(scanDir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (results.length >= MAX_PROJECTS) break;
		if (!entry.isDirectory()) continue;

		const childPath = path.join(scanDir, entry.name);
		if (await isGitRepo(childPath)) {
			results.push({
				id: childPath,
				name: path.basename(childPath),
				cwd: childPath,
			});
		}
	}
}

export async function listGitProjects(): Promise<
	Array<{ id: string; name: string; cwd: string }>
> {
	const projectsDirs = getProjectsDirs();
	const projects: Array<{ id: string; name: string; cwd: string }> = [];

	for (const baseDir of projectsDirs) {
		try {
			const info = await stat(baseDir);
			if (!info.isDirectory()) continue;
		} catch {
			continue;
		}
		await collectGitProjects(baseDir, projects);
		if (projects.length >= MAX_PROJECTS) break;
	}

	projects.sort((a, b) => a.name.localeCompare(b.name));
	return projects;
}
