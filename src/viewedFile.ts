import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ViewedEntry {
  /** sha256 hex of the file's patch when it was marked. */
  hash: string;
  /** ISO timestamp of the mark; entries expire after VIEWED_TTL_MS. */
  at: string;
}

export type RepoFiles = Record<string, ViewedEntry>;

export interface ViewedFileDocument {
  version: 1;
  repos: Record<string, { files: RepoFiles }>;
}

export const VIEWED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Resolve the state file path: $XDG_STATE_HOME/hunk/viewed.json, %LOCALAPPDATA% on Windows, else ~/.local/state. */
export function resolveViewedFilePath(
  env: NodeJS.ProcessEnv,
  platform: string,
  homeDir: string,
): string {
  if (env.XDG_STATE_HOME) {
    return join(env.XDG_STATE_HOME, "hunk", "viewed.json");
  }
  if (platform === "win32" && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, "hunk", "viewed.json");
  }
  return join(homeDir, ".local", "state", "hunk", "viewed.json");
}

/** Parse the state file, or return an empty document when it is missing or unusable. */
function readDocument(filePath: string, log: (message: string) => void): ViewedFileDocument {
  const empty: ViewedFileDocument = { version: 1, repos: {} };
  if (!existsSync(filePath)) {
    return empty;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<ViewedFileDocument>;
    if (parsed.version !== 1 || typeof parsed.repos !== "object" || parsed.repos === null) {
      log(`hunk-viewed: ignoring ${filePath}: unsupported format`);
      return empty;
    }
    return { version: 1, repos: parsed.repos };
  } catch (error) {
    log(`hunk-viewed: ignoring ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return empty;
  }
}

/** Read the viewed marks stored for one repo. */
export function readRepoFiles(
  filePath: string,
  repoKey: string,
  log: (message: string) => void,
): RepoFiles {
  return readDocument(filePath, log).repos[repoKey]?.files ?? {};
}

/** Drop entries older than VIEWED_TTL_MS. */
function pruneExpired(files: RepoFiles, now: Date): RepoFiles {
  const cutoff = now.getTime() - VIEWED_TTL_MS;
  const kept: RepoFiles = {};
  for (const [path, entry] of Object.entries(files)) {
    if (Date.parse(entry.at) >= cutoff) {
      kept[path] = entry;
    }
  }
  return kept;
}

/**
 * Replace one repo's marks in the state file and write it atomically.
 *
 * Rereads the file first so sessions in other repos keep their marks. Every
 * repo's expired entries are pruned on the way through, and a repo left with
 * no entries is removed.
 */
export function writeRepoFiles(filePath: string, repoKey: string, files: RepoFiles, now: Date): void {
  const document = readDocument(filePath, () => {});
  const repos: ViewedFileDocument["repos"] = {};
  for (const [key, record] of Object.entries(document.repos)) {
    if (key === repoKey) continue;
    const kept = pruneExpired(record.files, now);
    if (Object.keys(kept).length > 0) repos[key] = { files: kept };
  }
  const own = pruneExpired(files, now);
  if (Object.keys(own).length > 0) repos[repoKey] = { files: own };

  mkdirSync(dirname(filePath), { recursive: true });
  const staged = `${filePath}.${process.pid}.tmp`;
  writeFileSync(staged, `${JSON.stringify({ version: 1, repos }, null, 2)}\n`, { mode: 0o600 });
  try {
    renameSync(staged, filePath);
  } catch (error) {
    // Windows refuses to rename over an open target; fall back to a plain overwrite.
    if (process.platform === "win32" && existsSync(filePath)) {
      rmSync(filePath, { force: true });
      renameSync(staged, filePath);
      return;
    }
    rmSync(staged, { force: true });
    throw error;
  }
}
