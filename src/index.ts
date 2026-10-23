#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFile, spawn, type ExecFileOptions } from "node:child_process";

import ignore from "ignore";
import writeFileAtomic from "write-file-atomic";

import { Command } from "commander";

const packageJson: { version: string; description: string } = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

type Person = { name: string; email: string };

type Processing = {
  newSha?: string;
  index: string;
  t0?: number;
  tX?: number;
  dt?: number;
  paths?: number;
  ignoredPaths?: number;
  allowedPaths?: number;
};

type Commit = {
  sha: string;
  author: Person;
  authorDate: string;
  committer: Person;
  committerDate: string;
  message: string;
  processing?: Processing;
};

// type: 3 = file, 1 = submodule, -1 = deleted
type FileEntry =
  | { type: 3; filemode: number; path: string; content: Buffer }
  | { type: 1 | -1; filemode: number; path: string; content: null };

type LogCommit = {
  date: string;
  sha: string;
  author: Person;
  committer: Person;
  message: string;
  processing?: Processing;
};

type LogData = {
  paths?: string[];
  ignoredPaths?: string[];
  allowedPaths?: string[];
  skippedPaths?: string[];
  commits: LogCommit[];
};

let DEBUG = false;

function execFileAsync(
  cmd: string,
  args: string[],
  options: ExecFileOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 100 * 1024 * 1024, ...options, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) return reject(Object.assign(err, { stderr }));
        resolve(stdout);
      },
    );
  });
}

async function git(
  repoPath: string,
  args: string[],
  options: ExecFileOptions = {},
) {
  if (DEBUG) console.log("git()", "-C", repoPath, ...args);
  return execFileAsync("git", ["-C", repoPath, ...args], options);
}

async function gitBuffer(repoPath: string, args: string[]): Promise<Buffer> {
  if (DEBUG) console.log("gitBuffer()", "-C", repoPath, ...args);
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", repoPath, ...args],
      { maxBuffer: 100 * 1024 * 1024, encoding: "buffer" },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      },
    );
  });
}

async function gitBatchObjects(
  repoPath: string,
  hashes: string[],
): Promise<{ hash: string; type: string; content: Buffer }[]> {
  if (hashes.length === 0) return [];
  if (DEBUG)
    console.log("gitBatchObjects()", "-C", repoPath, hashes.length, "objects");

  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repoPath, "cat-file", "--batch"]);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const error = new Error(
          `git cat-file --batch exited with code ${code}`,
        );
        reject(
          Object.assign(error, {
            stderr: Buffer.concat(stderrChunks).toString(),
          }),
        );
        return;
      }

      try {
        const output = Buffer.concat(stdoutChunks);
        const objects: { hash: string; type: string; content: Buffer }[] = [];
        let offset = 0;

        for (const expectedHash of hashes) {
          const headerEnd = output.indexOf(0x0a, offset);
          if (headerEnd === -1)
            throw new Error(`Missing batch header for ${expectedHash}`);

          const [hash, type, sizeText] = output
            .subarray(offset, headerEnd)
            .toString()
            .split(" ");
          const size = Number(sizeText);
          if (!hash || !type || !Number.isSafeInteger(size))
            throw new Error(`Invalid batch header for ${expectedHash}`);

          const contentStart = headerEnd + 1;
          const contentEnd = contentStart + size;
          if (contentEnd >= output.length || output[contentEnd] !== 0x0a)
            throw new Error(`Incomplete batch object for ${expectedHash}`);

          objects.push({
            hash,
            type,
            content: output.subarray(contentStart, contentEnd),
          });
          offset = contentEnd + 1;
        }

        resolve(objects);
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.end(`${hashes.join("\n")}\n`);
  });
}

async function openOrInitRepo(repoPath: string) {
  if (DEBUG) console.log("openOrInitRepo()", repoPath);
  if (!fs.existsSync(repoPath)) {
    if (DEBUG) console.log("openOrInitRepo() create repo", repoPath);
    await fs.promises.mkdir(repoPath, { recursive: true });
    await execFileAsync("git", ["init", repoPath]);
  } else {
    if (DEBUG) console.log("openOrInitRepo() open existing repo", repoPath);
  }
  if (DEBUG) console.log("openOrInitRepo()", repoPath, "done");
  return repoPath;
}

async function reWriteFilesInRepo(repoPath: string, files: FileEntry[]) {
  if (DEBUG) console.log("reWriteFilesInRepo()", files.length);

  // NOTE: we need to support rename case! if we rename from Index.js to index.js its equal to create Index.js and remove index.js
  //   And if your FS is ignore case you can create and delete the same file!
  for (const file of files) {
    if (file.type !== -1) continue;
    const filePath = path.join(repoPath, file.path);
    if (DEBUG) console.log("reWriteFilesInRepo() delete:", filePath);
    await fs.promises.rm(filePath, { force: true });
  }

  for (const file of files) {
    const filePath = path.join(repoPath, file.path);

    if (file.type === -1) {
      // delete file
      // NOTE: already processed
    } else if (file.type === 3) {
      // file Type
      const dirPath = path.dirname(filePath);
      const buffer = file.content;
      if (DEBUG)
        console.log(
          "reWriteFilesInRepo() write:",
          filePath,
          buffer.length,
          `mode:${file.filemode}`,
          JSON.stringify(buffer.toString().substring(0, 90)),
        );
      await fs.promises.mkdir(dirPath, { recursive: true });
      await writeFile(filePath, buffer, file.filemode);
    } else if (file.type === 1) {
      // submodule
      // NOTE: just skeep
      // TODO(pahaz): what we really should to do with submodules?
      console.log(`? git submodule: ${filePath} (skip)`);
    }
  }
  if (DEBUG) console.log("reWriteFilesInRepo() done");
}

async function getCommitHistory(repoPath: string): Promise<Commit[]> {
  if (!repoPath) return [];

  // Check if the repo has any commits
  try {
    await git(repoPath, ["rev-parse", "HEAD"]);
  } catch {
    return [];
  }

  // Get metadata via git log (one line per commit, fields separated by NUL)
  const output = await git(repoPath, [
    "log",
    "--reverse",
    "--format=%H%x00%aN%x00%aE%x00%aI%x00%cN%x00%cE%x00%cI",
  ]);
  const lines = output.trim().split("\n").filter(Boolean);

  const metadata = lines.map((line): Omit<Commit, "message"> => {
    const [
      sha,
      authorName,
      authorEmail,
      authorDate,
      committerName,
      committerEmail,
      committerDate,
    ] = line.split("\0");

    return {
      sha,
      author: { name: authorName, email: authorEmail },
      authorDate,
      committer: { name: committerName, email: committerEmail },
      committerDate,
    };
  });

  const rawCommits = await gitBatchObjects(
    repoPath,
    metadata.map(({ sha }) => sha),
  );

  return metadata.map((commit, index) => {
    const rawCommit = rawCommits[index]!;
    if (rawCommit.type !== "commit")
      throw new Error(`${commit.sha} is not a commit`);
    const blankLineIdx = rawCommit.content.indexOf("\n\n");
    const message = rawCommit.content.subarray(blankLineIdx + 2).toString();

    return {
      ...commit,
      message,
    };
  });
}

async function commitFiles(
  repoPath: string,
  commit: Commit,
  files: FileEntry[],
) {
  if (DEBUG) console.log("commitFiles()", files.length);

  // NOTE: we need to support rename case! if we rename from Index.js to index.js its equal to create Index.js and remove index.js
  //   And if your FS is ignore case you can create and delete the same file!
  for (const file of files) {
    if (file.type !== -1) continue;
    if (DEBUG) console.log(`commitFiles() rm --cached: ${file.path}`);
    try {
      await git(repoPath, ["rm", "--quiet", "--cached", file.path]);
    } catch (e) {
      // File might not be in the index
      if (DEBUG)
        console.log(
          `commitFiles() rm --cached failed (ok): ${(e as Error).message}`,
        );
    }
  }

  for (const file of files) {
    if (file.type === -1) {
      // delete file
      // NOTE: already processed
    } else if (file.type === 3) {
      // file Type
      if (DEBUG) console.log(`commitFiles() add: ${file.path}`);
      await git(repoPath, ["add", file.path]);
    } else if (file.type === 1) {
      // submodule
      // TODO(pahaz): what we really should to do with submodules?
      if (DEBUG) console.log(`commitFiles() ${file.path} (skip)`);
    }
  }

  // Write commit message to temp file to preserve exact content (including trailing newlines)
  // Use absolute path because git -C changes the working directory
  const msgFile = path.resolve(repoPath, ".git", "COMMIT_MSG_TMP");
  await fs.promises.writeFile(msgFile, commit.message);

  if (DEBUG) console.log("commitFiles() git commit");

  try {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: commit.author.name,
      GIT_AUTHOR_EMAIL: commit.author.email,
      GIT_AUTHOR_DATE: commit.authorDate,
      GIT_COMMITTER_NAME: commit.committer.name,
      GIT_COMMITTER_EMAIL: commit.committer.email,
      GIT_COMMITTER_DATE: commit.committerDate,
    };

    await git(
      repoPath,
      ["commit", "--allow-empty", "-F", msgFile, "--cleanup=verbatim"],
      { env },
    );
  } finally {
    await fs.promises.rm(msgFile, { force: true });
  }

  const newSha = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
  if (DEBUG) console.log("commitFiles() done", newSha);
  return newSha;
}

async function getDiffFiles(
  repoPath: string,
  hash: string,
): Promise<FileEntry[]> {
  if (DEBUG) console.log("getDiffFiles()", hash);

  const output = await git(repoPath, [
    "diff-tree",
    "-r",
    "--root",
    "--no-commit-id",
    "-z",
    hash,
  ]);
  if (!output) return [];

  const results: FileEntry[] = [];
  const parts = output.split("\0").filter(Boolean);

  for (let i = 0; i < parts.length; i += 2) {
    const header = parts[i];
    const filePath = parts[i + 1];
    if (!header || !filePath) continue;

    // header format: ":oldmode newmode oldhash newhash status"
    const match = header.match(
      /:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z]\d*)/,
    );
    if (!match) continue;

    const newMode = parseInt(match[2]!, 8);
    const status = match[5]![0]; // First char: A, D, M, T, etc.

    if (status === "A" || status === "M" || status === "T") {
      const isSubmodule = match[2] === "160000";
      if (isSubmodule) {
        results.push({
          filemode: newMode,
          type: 1,
          path: filePath,
          content: null,
        });
      } else {
        const content = await gitBuffer(repoPath, [
          "show",
          `${hash}:${filePath}`,
        ]);
        results.push({
          filemode: newMode,
          type: 3,
          path: filePath,
          content,
        });
      }
    } else if (status === "D") {
      results.push({
        filemode: 0,
        type: -1,
        path: filePath,
        content: null,
      });
    }
  }

  if (DEBUG) console.log("getDiffFiles()", hash, "done");
  return results;
}

async function getTreeFiles(
  repoPath: string,
  hash: string,
): Promise<FileEntry[]> {
  if (DEBUG) console.log("getTreeFiles()", hash);

  const output = await git(repoPath, ["ls-tree", "-r", "-z", hash]);
  if (!output) return [];

  const results: FileEntry[] = [];
  const entries = output.split("\0").filter(Boolean);

  for (const entry of entries) {
    // Format: "mode type hash\tpath"
    const match = entry.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/);
    if (!match) continue;

    const mode = parseInt(match[1]!, 8);
    const objType = match[2];
    const filePath = match[4]!;

    if (objType === "blob") {
      // Only include regular files (100644) and executables (100755), not symlinks (120000).
      // This matches nodegit's TreeEntry.isFile() which checks filemode, not type.
      const modeOctal = match[1];
      if (modeOctal !== "100644" && modeOctal !== "100755") continue;

      const content = await gitBuffer(repoPath, [
        "show",
        `${hash}:${filePath}`,
      ]);
      if (DEBUG) console.log("getTreeFiles() file =", filePath);
      results.push({
        filemode: mode,
        type: 3,
        path: filePath,
        content,
      });
    } else if (objType === "commit") {
      // submodule - skip by default (matching original behavior)
      if (DEBUG) console.log("getTreeFiles() submodule =", filePath);
    }
  }

  if (DEBUG) console.log("getTreeFiles()", hash, "done");
  return results;
}

async function writeFile(path: string, buffer: Buffer, permission: number) {
  const isDirectory = (permission & 0o170000) == 0o040000;
  const isNormalFile = (permission & 0o170000) == 0o100644;
  const isExecutable = (permission & 0o170000) == 0o100755;
  const isSymlink = (permission & 0o170000) == 0o120000;
  if (DEBUG)
    console.log(
      "writeFile()",
      path,
      (permission & 0o170000).toString(2).substring(0, 4),
      (permission | 0o170000).toString(2).substring(4),
      isDirectory,
      isNormalFile,
      isExecutable,
      isSymlink,
    );
  if (isSymlink) {
    await fs.promises.symlink(buffer.toString(), path);
  } else {
    await writeFileAtomic(path, buffer, { mode: permission });
  }
}

function prepareLogData(commits: Commit[]) {
  const result: LogCommit[] = [];
  for (const {
    authorDate,
    sha,
    author,
    committer,
    message,
    processing,
  } of commits) {
    if (!processing) break;
    result.push({
      date: authorDate,
      sha,
      author: {
        name: author.name,
        email: author.email,
      },
      committer: {
        name: committer.name,
        email: committer.email,
      },
      message: message.substring(0, 200),
      processing,
    });
  }

  return result;
}

async function writeLogData(
  logFilePath: string,
  commits: Commit[],
  filePaths: Set<string>,
  ignoredPaths: Set<string>,
  allowedPaths: Set<string>,
  skippedPaths: Set<string>,
) {
  const processedCommits = prepareLogData(commits);
  const data = JSON.stringify(
    {
      paths: [...filePaths],
      ignoredPaths: [...ignoredPaths],
      allowedPaths: [...allowedPaths],
      skippedPaths: [...skippedPaths],
      commits: processedCommits,
    },
    null,
    2,
  );
  await writeFileAtomic(logFilePath, data);
}

async function readLogData(logFilePath: string): Promise<LogData> {
  try {
    const data = JSON.parse(await fs.promises.readFile(logFilePath, "utf8"));
    if (!data.commits || !Array.isArray(data.commits)) data.commits = [];
    return data;
  } catch {
    return { commits: [] };
  }
}

async function checkout(repoPath: string, hash: string) {
  await git(repoPath, ["checkout", "--force", "--quiet", hash]);
}

async function stash(repoPath: string) {
  // Check if repo has any commits (stash requires at least one)
  try {
    await git(repoPath, ["rev-parse", "HEAD"]);
  } catch {
    return;
  }

  try {
    await git(repoPath, ["stash", "--quiet"]);
  } catch (e) {
    // Nothing to stash or other non-fatal error
    if (DEBUG) console.log("stash():", (e as Error).message);
  }
}

async function readOptions(config: string) {
  const options = JSON.parse(fs.readFileSync(config, "utf8"));
  const debug = !!options.debug || false;
  const dontShowTiming = !!options.dontShowTiming || false;
  const targetRepoPath: string = options.targetRepoPath || "ignore.target";
  const sourceRepoPath: string = options.sourceRepoPath || ".";
  const targetRemote: string | null = options.targetRemote || null;
  const targetBranch: string = options.targetBranch || "main";
  const logFilePath: string =
    options.logFilePath || targetRepoPath + ".log.json";
  const forceReCreateRepo: boolean = options.forceReCreateRepo || false;
  const syncAllFilesOnLastFollowCommit: boolean =
    options.syncAllFilesOnLastFollowCommit || false;
  if (options.followByLogFile && options.followByNumberOfCommits)
    exit(
      "ERROR: can't use followByLogFile=true and followByNumberOfCommits=true simultaneously. Choose one or use forceReCreateRepo=true",
      8,
    );
  if (
    !forceReCreateRepo &&
    typeof options.followByLogFile !== "undefined" &&
    typeof options.followByNumberOfCommits !== "undefined" &&
    !options.followByLogFile &&
    !options.followByNumberOfCommits
  )
    exit(
      "ERROR: can't use followByLogFile=false and followByNumberOfCommits=false simultaneously. Choose one or use forceReCreateRepo=true",
      8,
    );
  const followByNumberOfCommits: boolean = forceReCreateRepo
    ? false
    : options.followByLogFile
      ? false
      : options.followByNumberOfCommits || false;
  const followByLogFile: boolean = forceReCreateRepo
    ? false
    : options.followByLogFile || !followByNumberOfCommits;
  const allowedPaths: string[] = options.allowedPaths || ["*"];
  const ignoredPaths: string[] = options.ignoredPaths || [];
  const commitDescriptionAppend: string =
    typeof options.commitDescriptionAppend === "string"
      ? options.commitDescriptionAppend
      : `This commit was filtered by https://github.com/kubk/git-filter\nSome files were excluded, so this commit may appear empty or incomplete.`;
  return {
    debug,
    dontShowTiming,
    forceReCreateRepo,
    followByLogFile,
    followByNumberOfCommits,
    syncAllFilesOnLastFollowCommit,
    targetRepoPath,
    sourceRepoPath,
    targetRemote,
    targetBranch,
    logFilePath,
    allowedPaths,
    ignoredPaths,
    commitDescriptionAppend,
  };
}

function exit(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

async function main(config: string) {
  const options = await readOptions(config);
  if (options.debug) DEBUG = true;

  const time0 = Date.now();
  const ig = ignore().add(options.ignoredPaths);
  const al = ignore().add(options.allowedPaths);

  const existingLogState = await readLogData(options.logFilePath);
  const isTargetRepoExists = fs.existsSync(options.targetRepoPath);

  let isFollowByLogFileFeatureEnabled =
    options.followByLogFile && !options.forceReCreateRepo;

  let isFollowByNumberOfCommits =
    options.followByNumberOfCommits && !options.forceReCreateRepo;

  if (options.forceReCreateRepo) {
    if (isTargetRepoExists) {
      console.log("Remove existing repo:", options.targetRepoPath);
      await fs.promises.rm(options.targetRepoPath, {
        recursive: true,
        force: true,
      });
    }
  } else {
    if (isFollowByLogFileFeatureEnabled && isFollowByNumberOfCommits)
      exit(
        "ERROR: Config error! The behavior will be non-deterministic. You want to follow by log file and follow by number of commits! Choose one or use `forceReCreateRepo`",
        5,
      );

    // forceReCreateRepo = false
    if (isTargetRepoExists) {
      // We have some existing repo! with commits! Cases:
      //  1) follow by log
      //  2) follow by number of commits
      //  3) unpredictable to add new commits is such case!

      if (isFollowByLogFileFeatureEnabled) {
        if (existingLogState.commits.length === 0)
          exit(
            "ERROR: Your target repo already exits but your log file does not have commits! The behavior will be non-deterministic. Remove existing target repo or use `forceReCreateRepo` or change the `logFilePath`",
            7,
          );
      } else if (isFollowByNumberOfCommits) {
        // pass
      } else {
        exit(
          "ERROR: Target repository already exists and you disable `followByLogFile` and `followByNumberOfCommits` features! The behavior will be non-deterministic. You can use `forceReCreateRepo` or remove existing target repo",
          5,
        );
      }
    } else {
      // We doesn't have a target repo! Cases:
      //  1) first running with follow by log
      //  2) first running with number of commits
      //  3) running without following and without force!

      if (isFollowByLogFileFeatureEnabled) {
        if (existingLogState.commits.length === 0) {
          // we don't have commits inside the log and we don't have an existing repo! no need to follow!
          isFollowByLogFileFeatureEnabled = false;
        } else {
          exit(
            "ERROR: Target repository does not exists but you already have an enable `followByLogFile` feature with existing log file commits! The behavior will be non-deterministic. You can use `forceReCreateRepo` or remove the existing log file",
            7,
          );
        }
      } else if (isFollowByNumberOfCommits) {
        // it's ok! no repo no number of commits! no need to follow!
        isFollowByNumberOfCommits = false;
      } else {
        // pass
      }
    }
  }

  const targetRepoPath = await openOrInitRepo(options.targetRepoPath);
  await stash(targetRepoPath);

  const commits = await getCommitHistory(options.sourceRepoPath);
  const targetCommits = await getCommitHistory(targetRepoPath);

  if (isFollowByLogFileFeatureEnabled) {
    if (existingLogState.commits.length === 0) {
      isFollowByLogFileFeatureEnabled = false;
    } else {
      console.log(
        "Follow target repo state by log file:",
        existingLogState.commits.length,
        "commits",
      );
    }
  }
  if (isFollowByNumberOfCommits) {
    if (targetCommits.length === 0) {
      isFollowByNumberOfCommits = false;
    } else {
      console.log(
        "Follow target repo state by number of commits:",
        targetCommits.length,
        "commits",
      );
    }
  }

  let commitIndex = 0;
  const commitLength = commits.length;

  let time1 = Date.now();
  let time2 = Date.now();
  let pathsLength = 0;
  let ignoredPathsLength = 0;
  let allowedPathsLength = 0;
  let isFollowByOk = true;
  let lastFollowCommit: string | null = null;
  let lastTargetCommit: string | null = null;
  let syncTreeCommitIndex = -1;
  const filePaths =
    (isFollowByLogFileFeatureEnabled || isFollowByNumberOfCommits) &&
    existingLogState.paths
      ? new Set(existingLogState.paths)
      : new Set<string>();
  const ignoredPaths =
    (isFollowByLogFileFeatureEnabled || isFollowByNumberOfCommits) &&
    existingLogState.ignoredPaths
      ? new Set(existingLogState.ignoredPaths)
      : new Set<string>();
  const allowedPaths =
    (isFollowByLogFileFeatureEnabled || isFollowByNumberOfCommits) &&
    existingLogState.allowedPaths
      ? new Set(existingLogState.allowedPaths)
      : new Set<string>();
  const skippedPaths =
    (isFollowByLogFileFeatureEnabled || isFollowByNumberOfCommits) &&
    existingLogState.skippedPaths
      ? new Set(existingLogState.skippedPaths)
      : new Set<string>();

  if (isFollowByLogFileFeatureEnabled) {
    const targetCommitShas = new Set(targetCommits.map(({ sha }) => sha));
    let followedCommitCount = 0;

    while (
      followedCommitCount < commits.length &&
      followedCommitCount < existingLogState.commits.length
    ) {
      const commit = commits[followedCommitCount]!;
      const existingCommit = existingLogState.commits[followedCommitCount];
      const newSha = existingCommit?.processing?.newSha;
      if (
        commit.sha !== existingCommit?.sha ||
        !newSha ||
        !targetCommitShas.has(newSha)
      )
        break;

      commit.processing = existingCommit.processing;
      lastFollowCommit = newSha;
      lastTargetCommit = newSha;
      followedCommitCount++;
    }

    if (!lastFollowCommit)
      exit(
        "ERROR: Does not find any log commit! Try to use `forceReCreateRepo` mode or remove wrong log file!",
        2,
      );

    commitIndex = followedCommitCount;
    if (commitIndex < commits.length) {
      isFollowByOk = false;
      await checkout(targetRepoPath, lastFollowCommit);
      if (options.syncAllFilesOnLastFollowCommit)
        syncTreeCommitIndex = commitIndex + 1;
      console.log(
        `Follow log stopped! last commit ${commitIndex + 1}/${commitLength} ${lastFollowCommit}`,
      );
    }
  }

  for (const commit of commits.slice(commitIndex)) {
    console.log(
      `Processing: ${++commitIndex}/${commitLength}`,
      commit.sha,
      options.dontShowTiming
        ? ""
        : `~${Math.round((time2 - time0) / commitIndex)}ms; ${time2 - time1}ms`,
    );

    if (isFollowByOk && isFollowByNumberOfCommits) {
      const targetCommit = targetCommits[commitIndex - 1];
      if (targetCommit) {
        const existingLogCommit = existingLogState.commits[commitIndex - 1];
        if (existingLogCommit && existingLogCommit.processing) {
          commit.processing = existingLogCommit.processing;
          if (commit.processing.newSha !== targetCommit.sha)
            console.warn(
              `WARN: log file commit sha ${commit.processing.newSha} != target commit sha ${targetCommit.sha}`,
            );
        } else {
          commit.processing = {
            index: `${commitIndex}/${commitLength}`,
          };
        }
        commit.processing.newSha = targetCommit.sha;
        lastFollowCommit = targetCommit.sha;
        lastTargetCommit = targetCommit.sha;
        continue;
      } else {
        isFollowByOk = false;
        if (!lastFollowCommit)
          exit(
            "ERROR: Does not find any log commit! Try to use `forceReCreateRepo` mode or remove target repo!",
            2,
          );
        await checkout(targetRepoPath, lastFollowCommit);
        if (options.syncAllFilesOnLastFollowCommit)
          syncTreeCommitIndex = commitIndex;
        console.log(
          `Follow log stopped! last commit ${commitIndex}/${commitLength} ${lastFollowCommit}`,
        );
      }
    }

    pathsLength = 0;
    ignoredPathsLength = 0;
    allowedPathsLength = 0;
    const files = (
      commitIndex === syncTreeCommitIndex
        ? await getTreeFiles(options.sourceRepoPath, commit.sha)
        : await getDiffFiles(options.sourceRepoPath, commit.sha)
    ).filter(({ path }) => {
      let isOk = true;
      pathsLength++;
      filePaths.add(path);
      if (ig.ignores(path)) {
        if (isOk) isOk = false;
        ignoredPathsLength++;
        ignoredPaths.add(path);
      }
      if (al.ignores(path)) {
        allowedPathsLength++;
        allowedPaths.add(path);
      } else {
        if (isOk) {
          skippedPaths.add(path);
          isOk = false;
        }
      }
      return isOk;
    });

    if (commitIndex === syncTreeCommitIndex && lastFollowCommit) {
      // want to `git rm` all existing files if the config.json was changed!
      const targetFiles = await getTreeFiles(targetRepoPath, lastFollowCommit);
      const sourcePaths = new Set(files.map((x) => x.path));
      targetFiles.forEach((targetFile) => {
        if (!sourcePaths.has(targetFile.path)) {
          files.push({
            filemode: 0,
            type: -1,
            path: targetFile.path,
            content: null,
          });
        }
      });
    }

    if (options.commitDescriptionAppend) {
      // Insert before git trailers (Co-Authored-By, Signed-off-by, etc.)
      // so GitHub still recognizes them
      const lines = commit.message.trimEnd().split("\n");
      let trailerStart = lines.length;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (/^[A-Za-z-]+: .+/.test(lines[i]!)) {
          trailerStart = i;
        } else {
          break;
        }
      }
      const body = lines.slice(0, trailerStart).join("\n").trimEnd();
      const trailers = lines.slice(trailerStart).join("\n");
      commit.message = trailers
        ? body +
          "\n\n" +
          options.commitDescriptionAppend +
          "\n\n" +
          trailers +
          "\n"
        : body + "\n\n" + options.commitDescriptionAppend + "\n";
    }

    await reWriteFilesInRepo(options.targetRepoPath, files);
    const newSha = await commitFiles(targetRepoPath, commit, files);
    lastTargetCommit = newSha;

    time1 = time2;
    time2 = Date.now();
    commit.processing = {
      newSha,
      index: `${commitIndex}/${commitLength}`,
      t0: time0,
      tX: time2,
      dt: time2 - time1,
      paths: pathsLength,
      ignoredPaths: ignoredPathsLength,
      allowedPaths: allowedPathsLength,
    };

    if (commitIndex % 50 === 0) {
      await writeLogData(
        options.logFilePath,
        commits,
        filePaths,
        ignoredPaths,
        allowedPaths,
        skippedPaths,
      );
      console.log(`Saved export state: ${commitIndex}/${commitLength}`);
    }
  }

  await writeLogData(
    options.logFilePath,
    commits,
    filePaths,
    ignoredPaths,
    allowedPaths,
    skippedPaths,
  );
  if (lastTargetCommit) {
    await checkout(targetRepoPath, lastTargetCommit);
    console.log(`Checkout: ${lastTargetCommit}`);
  }
  if (options.targetRemote) {
    // Force, because changing allowed or ignored paths rewrites the history
    await git(targetRepoPath, [
      "push",
      "--force",
      "--quiet",
      options.targetRemote,
      `HEAD:refs/heads/${options.targetBranch}`,
    ]);
    console.log(`Push: ${options.targetRemote} ${options.targetBranch}`);
  }
  if (
    isFollowByOk &&
    (isFollowByLogFileFeatureEnabled || isFollowByNumberOfCommits)
  )
    console.log(
      "Follow log stopped! last commit",
      commitIndex,
      lastFollowCommit,
    );
  console.log(
    options.dontShowTiming
      ? "Finish"
      : `Finish: total=${Date.now() - time0}ms;`,
  );
}

const program = new Command();
program
  .version(packageJson.version)
  .argument("<config-path>", "json config path")
  .description(packageJson.description)
  .action(main)
  .parseAsync(process.argv);
