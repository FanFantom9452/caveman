#!/usr/bin/env node
// caveman — shared configuration resolver
//
// Resolution order for default mode:
//   1. CAVEMAN_DEFAULT_MODE environment variable
//   2. Repo-local config (checked-in, per-project default):
//      - <cwd>/.caveman/config.json
//      - <cwd>/.caveman.json
//      Walks up from process.cwd() to the nearest ancestor containing one of
//      these (stops at filesystem root). Lets a team pin a project's default
//      mode without polluting every contributor's user-level config or env.
//   3. User config file defaultMode field:
//      - $XDG_CONFIG_HOME/caveman/config.json (any platform, if set)
//      - ~/.config/caveman/config.json (macOS / Linux fallback)
//      - %APPDATA%\caveman\config.json (Windows fallback)
//   4. 'full'

const fs = require('fs');
const path = require('path');
const os = require('os');

const VALID_MODES = [
  'off', 'lite', 'full', 'ultra',
  'wenyan-lite', 'wenyan', 'wenyan-full', 'wenyan-ultra',
  'commit', 'review', 'compress'
];

function getConfigDir() {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'caveman');
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'caveman'
    );
  }
  return path.join(os.homedir(), '.config', 'caveman');
}

function getConfigPath() {
  return path.join(getConfigDir(), 'config.json');
}

// Walk up from `start` looking for a repo-local caveman config. Returns the
// absolute path of the first match, or null. Stops at the filesystem root.
// Candidates per dir (first wins): .caveman/config.json, .caveman.json.
//
// Bounded to 64 levels to defend against symlink cycles on pathological mounts.
function findRepoConfigPath(start) {
  try {
    let dir = path.resolve(start || process.cwd());
    const candidates = ['.caveman/config.json', '.caveman.json'];
    for (let i = 0; i < 64; i++) {
      for (const rel of candidates) {
        const p = path.join(dir, rel);
        try {
          const st = fs.lstatSync(p);
          // Refuse symlinks — symmetric with safeWriteFlag/readFlag policy.
          if (st.isSymbolicLink() || !st.isFile()) continue;
          return p;
        } catch (e) {
          // not present, try next candidate
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch (e) {
    // Defensive: any cwd / fs failure → no repo config
  }
  return null;
}

function readModeFromConfigFile(configPath) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    if (config && config.defaultMode &&
        VALID_MODES.includes(String(config.defaultMode).toLowerCase())) {
      return String(config.defaultMode).toLowerCase();
    }
  } catch (e) {
    // Missing / unreadable / invalid JSON → caller falls through
  }
  return null;
}

// startDir overrides the cwd the repo-config walk starts from (default
// process.cwd(), same as findRepoConfigPath's own fallback) — lets a caller
// resolve the mode for a directory other than its own process cwd (#634:
// the UserPromptSubmit hook's stdin carries the session's cwd, which can
// differ from the hook process's cwd). Every other resolution step is
// cwd-independent, so only the repo-config walk takes it.
function getDefaultMode(startDir) {
  // 1. Environment variable (highest priority)
  const envMode = process.env.CAVEMAN_DEFAULT_MODE;
  if (envMode && VALID_MODES.includes(envMode.toLowerCase())) {
    return envMode.toLowerCase();
  }

  // 2. Repo-local config (checked-in, per-project default)
  const repoConfigPath = findRepoConfigPath(startDir);
  if (repoConfigPath) {
    const repoMode = readModeFromConfigFile(repoConfigPath);
    if (repoMode) return repoMode;
  }

  // 3. User config file
  const userMode = readModeFromConfigFile(getConfigPath());
  if (userMode) return userMode;

  // 4. Default
  return 'full';
}

// Symlink-safe flag file write.
// Uses O_NOFOLLOW where available, writes atomically via temp + rename with
// 0600 permissions. Protects against local attackers replacing the predictable
// flag path (~/.claude/.caveman-active) with a symlink to clobber other files.
//
// When the parent directory is itself a symlink (legitimate pattern: ~/.claude
// symlinked to another drive or shared config dir), resolves through to the
// real path and verifies ownership on Unix (uid match). This allows e.g.
//   ln -s /opt/shared-claude-config ~/.claude
// while still refusing attacker-planted symlinks pointing to dirs owned by
// another user.
//
// On Windows, uid checks are unavailable — falls back to verifying the resolved
// path lives under the user's home directory.
//
// The flag file itself must never be a symlink (that's the actual clobber vector).
//
// Set CAVEMAN_DEBUG=1 to emit stderr diagnostics when flag writes are refused.
//
// ---------------------------------------------------------------------------
// Session scoping.
//
// The mode used to live in one file per machine, $CLAUDE_CONFIG_DIR/.caveman-active,
// which meant a switch in one window followed the user into every other one, and a
// new window reset all of them to the configured default. #691 fixed half of that
// by only resetting on a real `startup`, but the file is still shared: two windows
// cannot hold two different modes.
//
// Flags now live at $CLAUDE_CONFIG_DIR/modes/<session_id>/caveman. The bare name is
// deliberate — a statusline that lists that directory gets the badge label for free,
// and `caveman.prev` is excluded from such a listing by its dot.
//
// Everything falls back to the old paths when no session id is available (opencode,
// a manual run, a harness that sends no payload), so those keep working unchanged.
const MODES_DIR = 'modes';
const SESSION_FILES = { mode: 'caveman', prev: 'caveman.prev' };
const LEGACY_FILES = { mode: '.caveman-active', prev: '.caveman-active.prev' };

// A session id becomes a path component, so it is validated rather than trusted for
// having come from the harness.
function validSessionId(id) {
  return (typeof id === 'string' && /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/.test(id)) ? id : null;
}

// session_id is on every hook payload. transcript_path is named after the session,
// so it stands in for any caller that has the one but not the other.
function sessionIdFrom(data) {
  if (!data) return null;
  const direct = validSessionId(data.session_id);
  if (direct) return direct;
  if (typeof data.transcript_path === 'string' && data.transcript_path) {
    return validSessionId(path.basename(data.transcript_path).replace(/\.jsonl$/i, ''));
  }
  return null;
}

function flagPathFor(claudeDir, sessionId, kind = 'mode') {
  const sid = validSessionId(sessionId);
  return sid
    ? path.join(claudeDir, MODES_DIR, sid, SESSION_FILES[kind])
    : path.join(claudeDir, LEGACY_FILES[kind]);
}

// Once a session owns its flag the global one is stale, and a statusline that finds
// no session flag falls back to exactly that file — so leaving it behind keeps a
// badge lit for a window that has since turned caveman off.
function clearLegacyFlags(claudeDir) {
  for (const name of Object.values(LEGACY_FILES)) {
    try { fs.unlinkSync(path.join(claudeDir, name)); } catch (e) { /* best-effort */ }
  }
}

// One directory per session accumulates forever otherwise. Swept on session start;
// the live session is never a candidate, having just been written.
function pruneSessions(claudeDir, currentSessionId, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const root = path.join(claudeDir, MODES_DIR);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === currentSessionId) continue;
    const dir = path.join(root, entry.name);
    try {
      if (fs.statSync(dir).mtimeMs >= cutoff) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) { /* best-effort */ }
  }
}
// ---------------------------------------------------------------------------

// Silent-fails on any filesystem error — the flag is best-effort.
function safeWriteFlag(flagPath, content) {
  const debug = process.env.CAVEMAN_DEBUG === '1';
  try {
    const flagDir = path.dirname(flagPath);
    fs.mkdirSync(flagDir, { recursive: true });

    // When the parent directory is a symlink, resolve it and verify ownership.
    // This allows legitimate symlinked ~/.claude dirs while still refusing
    // attacker-planted symlinks pointing at dirs owned by another user.
    let realFlagDir;
    try {
      const lstat = fs.lstatSync(flagDir);
      if (lstat.isSymbolicLink()) {
        realFlagDir = fs.realpathSync(flagDir);
        const realStat = fs.statSync(realFlagDir);
        if (!realStat.isDirectory()) {
          if (debug) process.stderr.write(`[caveman] safeWriteFlag: symlink target ${realFlagDir} is not a directory\n`);
          return;
        }
        if (typeof process.getuid === 'function') {
          if (realStat.uid !== process.getuid()) {
            if (debug) process.stderr.write(`[caveman] safeWriteFlag: symlink target ${realFlagDir} owned by uid ${realStat.uid}, not current user ${process.getuid()}\n`);
            return;
          }
        } else {
          const home = os.homedir();
          const normalizedReal = path.resolve(realFlagDir);
          const normalizedHome = path.resolve(home);
          if (!normalizedReal.toLowerCase().startsWith(normalizedHome.toLowerCase() + path.sep) &&
              normalizedReal.toLowerCase() !== normalizedHome.toLowerCase()) {
            if (debug) process.stderr.write(`[caveman] safeWriteFlag: symlink target ${normalizedReal} is outside home directory ${normalizedHome}\n`);
            return;
          }
        }
      } else {
        realFlagDir = flagDir;
      }
    } catch (e) {
      return;
    }

    // The flag file itself must never be a symlink (that's the actual clobber vector).
    const realFlagPath = path.join(realFlagDir, path.basename(flagPath));
    try {
      if (fs.lstatSync(realFlagPath).isSymbolicLink()) return;
    } catch (e) {
      if (e.code !== 'ENOENT') return;
    }

    // tempPath is hoisted above the try so the finally below can always find
    // it. On Windows, renameSync onto an existing target throws EPERM/EBUSY/
    // EACCES/EEXIST when another process (statusline read, a concurrent
    // session's hook) holds the file open without FILE_SHARE_DELETE —
    // without the retry + guaranteed cleanup here, every such miss left an
    // orphaned .caveman-active.<pid>.<ts> file behind (#511/#578/#657).
    let tempPath;
    try {
      tempPath = path.join(realFlagDir, `.caveman-active.${process.pid}.${Date.now()}`);
      const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW;
      let fd;
      try {
        fd = fs.openSync(tempPath, flags, 0o600);
        fs.writeSync(fd, String(content));
        try { fs.fchmodSync(fd, 0o600); } catch (e) { /* best-effort on Windows */ }
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }

      // Retry brief lock contention a few times. A missed write is harmless
      // (concurrent writers publish the same mode value); a leaked temp file
      // is not, so the finally below always sweeps it regardless of outcome.
      let renamed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          fs.renameSync(tempPath, realFlagPath);
          renamed = true;
          break;
        } catch (e) {
          const transient = e.code === 'EPERM' || e.code === 'EBUSY' ||
                             e.code === 'EACCES' || e.code === 'EEXIST';
          if (!transient) throw e;
        }
      }
      if (!renamed && debug) {
        process.stderr.write('[caveman] safeWriteFlag: rename contended after 3 attempts; flag not updated this write\n');
      }
    } finally {
      if (tempPath) {
        try {
          fs.unlinkSync(tempPath);
        } catch (error) {
          if (debug && error.code !== 'ENOENT') {
            process.stderr.write(`[caveman] safeWriteFlag: failed to remove temp flag ${tempPath}: ${error.message}\n`);
          }
        }
      }
    }
  } catch (e) {
    // Silent fail — flag is best-effort
  }
}

// Symlink-safe, size-capped, whitelist-validated flag file read.
// Symmetric with safeWriteFlag: refuses symlinks at the target, caps the read,
// and rejects anything that isn't a known mode. Returns null on any anomaly.
//
// Without this, a local attacker with write access to ~/.claude/ could replace
// the flag with a symlink to ~/.ssh/id_rsa (or any user-readable secret). Every
// reader — statusline, per-turn reinforcement — would slurp that content and
// either echo it to the terminal or inject it into model context.
//
// MAX_FLAG_BYTES is a hard cap. The longest legitimate value is "wenyan-ultra"
// (12 bytes); 64 leaves slack without enabling exfil.
const MAX_FLAG_BYTES = 64;

function readFlag(flagPath) {
  try {
    let st;
    try {
      st = fs.lstatSync(flagPath);
    } catch (e) {
      return null;
    }
    if (st.isSymbolicLink() || !st.isFile()) return null;
    if (st.size > MAX_FLAG_BYTES) return null;

    const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    const flags = fs.constants.O_RDONLY | O_NOFOLLOW;
    let fd;
    let out;
    try {
      fd = fs.openSync(flagPath, flags);
      const buf = Buffer.alloc(MAX_FLAG_BYTES);
      const n = fs.readSync(fd, buf, 0, MAX_FLAG_BYTES, 0);
      out = buf.slice(0, n).toString('utf8');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }

    const raw = out.trim().toLowerCase();
    if (!VALID_MODES.includes(raw)) return null;
    return raw;
  } catch (e) {
    return null;
  }
}

// Symlink-safe append. Same parent-dir + symlink-target rules as safeWriteFlag,
// but opens with O_APPEND so concurrent writers from different sessions don't
// clobber each other. Used for the lifetime stats log
// ($CLAUDE_CONFIG_DIR/.caveman-history.jsonl).
//
// Silent-fails on any filesystem error.
function appendFlag(filePath, line) {
  const debug = process.env.CAVEMAN_DEBUG === '1';
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    let realDir;
    try {
      const lstat = fs.lstatSync(dir);
      if (lstat.isSymbolicLink()) {
        realDir = fs.realpathSync(dir);
        const realStat = fs.statSync(realDir);
        if (!realStat.isDirectory()) return;
        if (typeof process.getuid === 'function') {
          if (realStat.uid !== process.getuid()) {
            if (debug) process.stderr.write(`[caveman] appendFlag: symlink target ${realDir} owned by uid ${realStat.uid}\n`);
            return;
          }
        } else {
          const home = os.homedir();
          const normalized = path.resolve(realDir).toLowerCase();
          const normalizedHome = path.resolve(home).toLowerCase();
          if (!normalized.startsWith(normalizedHome + path.sep) && normalized !== normalizedHome) return;
        }
      } else {
        realDir = dir;
      }
    } catch (e) {
      return;
    }

    const realPath = path.join(realDir, path.basename(filePath));
    try {
      if (fs.lstatSync(realPath).isSymbolicLink()) return;
    } catch (e) {
      if (e.code !== 'ENOENT') return;
    }

    const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | O_NOFOLLOW;
    let fd;
    try {
      fd = fs.openSync(realPath, flags, 0o600);
      fs.writeSync(fd, String(line).replace(/\n$/, '') + '\n');
      try { fs.fchmodSync(fd, 0o600); } catch (e) { /* best-effort on Windows */ }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  } catch (e) {
    // Silent fail — history is best-effort
  }
}

// Mode-transition log (#601). Whenever the active-mode flag actually changes,
// append {ts, mode, prev} to $CLAUDE_CONFIG_DIR/.caveman-mode-log.jsonl so
// caveman-stats can attribute output tokens to the mode that was active when
// each message was generated, instead of whatever mode the flag holds at
// stats time. mode/prev are a VALID_MODES string or null (null = caveman off).
// prev lets stats attribute messages that predate the first logged transition
// of a session. No-op when the mode is unchanged; best-effort like all flag IO.
const MODE_LOG_BASENAME = '.caveman-mode-log.jsonl';

function recordModeChange(claudeDir, newMode, sessionId) {
  try {
    // Against this session's flag, not the global one: comparing to another
    // window's mode would log transitions that never happened here and skip the
    // ones that did.
    const current = readFlag(flagPathFor(claudeDir, sessionId));
    const next = newMode || null;
    if ((current || null) === next) return;
    // Stamped with the session, because the log is one flat timeline shared by
    // every window while the mode it records is not. Without this, stats walking
    // the timeline for one session would attribute another window's switches to
    // its messages. Rows written before scoping carry no session and are read as
    // applying to whatever was running at the time.
    appendFlag(
      path.join(claudeDir, MODE_LOG_BASENAME),
      JSON.stringify({ ts: Date.now(), mode: next, prev: current || null, session: validSessionId(sessionId) })
    );
  } catch (e) {
    // Silent fail — the log is best-effort
  }
}

// Symlink-safe history read. Returns lines (untrimmed) or empty array on any
// anomaly. Caller is responsible for parsing JSON. Does NOT enforce a size cap
// the way readFlag does — history is expected to grow with use.
function readHistory(filePath) {
  try {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) return [];
    const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    const flags = fs.constants.O_RDONLY | O_NOFOLLOW;
    let fd;
    let raw;
    try {
      fd = fs.openSync(filePath, flags);
      raw = fs.readFileSync(fd, 'utf8');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return raw.split('\n').filter(line => line.trim());
  } catch (e) {
    return [];
  }
}

module.exports = { getDefaultMode, getConfigDir, getConfigPath, findRepoConfigPath, VALID_MODES, safeWriteFlag, readFlag, appendFlag, readHistory, recordModeChange, MODE_LOG_BASENAME, clearLegacyFlags, flagPathFor, pruneSessions, sessionIdFrom, validSessionId };
