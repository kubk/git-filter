#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ignore = require("ignore");
const writeFileAtomic = require("write-file-atomic");

const { Command } = require("commander");
const packageJson = require(path.join(__dirname, "../package.json"));

let DEBUG = false;

function execFileAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 100 * 1024 * 1024, ...options },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          return reject(err);
        }
        resolve(stdout);
      },
    );
  });
}

async function git(repoPath, args, options = {}) {
  if (DEBUG) console.log("git()", "-C", repoPath, ...args);
  return execFileAsync("git", ["-C", repoPath, ...args], options);
}

async function gitBuffer(repoPath, args) {
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

async function openOrInitRepo(repoPath) {
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

async function reWriteFilesInRepo(repoPath, files) {
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
    } else {
      console.log(`? WTF ? type=${file.type} path=${file.path} (skip)`);
    }
  }
  if (DEBUG) console.log("reWriteFilesInRepo() done");
}

async function getCommitHistory(repoPath) {
  if (!repoPath) return [];

  // Check if the repo has any commits
  try {
    await git(repoPath, ["rev-parse", "HEAD"]);
  } catch (e) {
    return [];
  }

  // Get metadata via git log (one line per commit, fields separated by NUL)
  const output = await git(repoPath, [
    "log",
    "--reverse",
    "--format=%H%x00%aN%x00%aE%x00%aI%x00%cN%x00%cE%x00%cI",
  ]);
  const lines = output.trim().split("\n").filter(Boolean);

  const commits = [];
  for (const line of lines) {
    const [
      sha,
      authorName,
      authorEmail,
      authorDate,
      committerName,
      committerEmail,
      committerDate,
    ] = line.split("\0");

    // Get exact raw message via cat-file (preserves trailing newlines exactly)
    const raw = await git(repoPath, ["cat-file", "commit", sha]);
    const blankLineIdx = raw.indexOf("\n\n");
    const message = raw.substring(blankLineIdx + 2);

    commits.push({
      sha,
      author: { name: authorName, email: authorEmail },
      authorDate,
      committer: { name: committerName, email: committerEmail },
      committerDate,
      message,
    });
  }

  return commits;
}

async function commitFiles(repoPath, commit, files) {
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
        console.log(`commitFiles() rm --cached failed (ok): ${e.message}`);
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
    } else {
      if (DEBUG)
        console.log(`commitFiles() type=${file.type} path=${file.path} (skip)`);
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
    await fs.promises.unlink(msgFile).catch(() => {});
  }

  const newSha = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
  if (DEBUG) console.log("commitFiles() done", newSha);
  return newSha;
}

async function getDiffFiles(repoPath, hash) {
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

  const results = [];
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

    const newMode = parseInt(match[2], 8);
    const status = match[5][0]; // First char: A, D, M, T, etc.

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

async function getTreeFiles(repoPath, hash) {
  if (DEBUG) console.log("getTreeFiles()", hash);

  const output = await git(repoPath, ["ls-tree", "-r", "-z", hash]);
  if (!output) return [];

  const results = [];
  const entries = output.split("\0").filter(Boolean);

  for (const entry of entries) {
    // Format: "mode type hash\tpath"
    const match = entry.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/);
    if (!match) continue;

    const mode = parseInt(match[1], 8);
    const objType = match[2];
    const filePath = match[4];

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

async function writeFile(path, buffer, permission) {
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

function prepareLogData(commits) {
  const result = [];
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
  logFilePath,
  commits,
  filePaths,
  ignoredPaths,
  allowedPaths,
  skippedPaths,
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

async function readLogData(logFilePath) {
  try {
    const data = JSON.parse(await fs.promises.readFile(logFilePath));
    if (!data.commits || !Array.isArray(data.commits)) data.commits = [];
    return data;
  } catch (e) {
    return { commits: [] };
  }
}

async function hasCommit(repoPath, hash) {
  try {
    const type = (await git(repoPath, ["cat-file", "-t", hash])).trim();
    return type === "commit";
  } catch (e) {
    return false;
  }
}

async function checkout(repoPath, hash) {
  await git(repoPath, ["checkout", "--force", "--quiet", hash]);
}

async function stash(repoPath) {
  // Check if repo has any commits (stash requires at least one)
  try {
    await git(repoPath, ["rev-parse", "HEAD"]);
  } catch (e) {
    return;
  }

  try {
    await git(repoPath, ["stash", "--quiet"]);
  } catch (e) {
    // Nothing to stash or other non-fatal error
    if (DEBUG) console.log("stash():", e.message);
  }
}

async function readOptions(config, args) {
  const data = fs.readFileSync(config);
  const options = JSON.parse(data);
  const debug = !!options.debug || false;
  const dontShowTiming = !!options.dontShowTiming || false;
  const targetRepoPath = options.targetRepoPath || "ignore.target";
  const sourceRepoPath = options.sourceRepoPath || ".";
  const logFilePath = options.logFilePath || targetRepoPath + ".log.json";
  const forceReCreateRepo = options.forceReCreateRepo || false;
  const syncAllFilesOnLastFollowCommit =
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
  const followByNumberOfCommits = forceReCreateRepo
    ? false
    : options.followByLogFile
      ? false
      : options.followByNumberOfCommits || false;
  const followByLogFile = forceReCreateRepo
    ? false
    : options.followByLogFile || !followByNumberOfCommits;
  const allowedPaths = options.allowedPaths || ["*"];
  const ignoredPaths = options.ignoredPaths || [];
  const commitDescriptionPrepend =
    typeof options.commitDescriptionPrepend === "string"
      ? options.commitDescriptionPrepend
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
    logFilePath,
    allowedPaths,
    ignoredPaths,
    commitDescriptionPrepend,
  };
}

function exit(message, code = 1) {
  console.error(message);
  process.exit(code);
}

async function main(config, args) {
  const options = await readOptions(config, args);
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
  let lastFollowCommit = null;
  let lastTargetCommit = null;
  let syncTreeCommitIndex = -1;
  const filePaths =
    (isFollowByLogFileFeatureEnabled || isFollowByNumberOfCommits) &&
    existingLogState.paths
      ? new Set(existingLogState.paths)
      : new Set();
  const ignoredPaths =
    (isFollowByLogFileFeatureEnabled || isFollowByNumberOfCommits) &&
    existingLogState.ignoredPaths
      ? new Set(existingLogState.ignoredPaths)
      : new Set();
  const allowedPaths =
    (isFollowByLogFileFeatureEnabled || isFollowByNumberOfCommits) &&
    existingLogState.allowedPaths
      ? new Set(existingLogState.allowedPaths)
      : new Set();
  const skippedPaths =
    (isFollowByLogFileFeatureEnabled || isFollowByNumberOfCommits) &&
    existingLogState.skippedPaths
      ? new Set(existingLogState.skippedPaths)
      : new Set();
  for (const commit of commits) {
    console.log(
      `Processing: ${++commitIndex}/${commitLength}`,
      commit.sha,
      options.dontShowTiming
        ? ""
        : `~${Math.round((time2 - time0) / commitIndex)}ms; ${time2 - time1}ms`,
    );

    if (isFollowByOk && isFollowByLogFileFeatureEnabled) {
      const existingCommit = existingLogState.commits[commitIndex - 1];
      if (existingCommit && existingCommit.processing) {
        const sha = existingCommit.sha;
        const newSha = existingCommit.processing.newSha;
        const hasTargetCommit = await hasCommit(targetRepoPath, newSha);
        const hasSourceCommit = await hasCommit(options.sourceRepoPath, sha);
        if (hasTargetCommit && hasSourceCommit) {
          lastFollowCommit = newSha;
          lastTargetCommit = newSha;
          // we also need to update commit.processing data
          commit.processing = existingCommit.processing;
          continue;
        } else {
          isFollowByOk = false;
          if (!lastFollowCommit)
            exit(
              "ERROR: Does not find any log commit! Try to use `forceReCreateRepo` mode or remove wrong log file!",
              2,
            );
          await checkout(targetRepoPath, lastFollowCommit);
          if (options.syncAllFilesOnLastFollowCommit)
            syncTreeCommitIndex = commitIndex;
          console.log(
            `Follow log stopped! last commit ${commitIndex}/${commitLength} ${lastFollowCommit}`,
          );
        }
      } else {
        isFollowByOk = false;
        if (!lastFollowCommit)
          exit(
            "ERROR: Does not find any log commit! Try to use `forceReCreateRepo` mode or remove wrong log file!",
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

    if (options.commitDescriptionPrepend) {
      commit.message = options.commitDescriptionPrepend + "\n\n" + commit.message;
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
