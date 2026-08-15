// Session-scoped mode flags.
//
// The mode used to live in one file per machine, $CLAUDE_CONFIG_DIR/.caveman-active.
// #691 stopped SessionStart from clobbering a mid-session switch by branching on
// `source`, but the file itself is still shared: two windows cannot hold two
// different modes, and a switch in one is a switch in all of them.
//
// These cover the session-keyed layout that replaces it, and the fallback that
// keeps every caller without a session id behaving exactly as it did.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const hooks = path.join(here, '..', 'src', 'hooks');

const SID_A = '11111111-2222-3333-4444-555555555555';
const SID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caveman-session-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  return path.join(dir, 'config');
}

function run(script, payload, claudeDir, env = {}) {
  return spawnSync(process.execPath, [path.join(hooks, script)], {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeDir,
      CAVEMAN_DEFAULT_MODE: 'full',
      ...env,
    },
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
}

const scoped = (dir, sid, name = 'caveman') => path.join(dir, 'modes', sid, name);
const legacy = (dir, name = '.caveman-active') => path.join(dir, name);
const read = p => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null);

test('SessionStart writes under the session, not globally', () => {
  const dir = makeDir();
  const r = run('caveman-activate.js', { session_id: SID_A, source: 'startup' }, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(scoped(dir, SID_A)), 'full');
  assert.equal(fs.existsSync(legacy(dir)), false, 'the global flag must not be written when the session is known');
});

test('a second session does not disturb the first', () => {
  const dir = makeDir();
  run('caveman-activate.js', { session_id: SID_A, source: 'startup' }, dir, { CAVEMAN_DEFAULT_MODE: 'ultra' });
  run('caveman-activate.js', { session_id: SID_B, source: 'startup' }, dir, { CAVEMAN_DEFAULT_MODE: 'lite' });
  assert.equal(read(scoped(dir, SID_A)), 'ultra');
  assert.equal(read(scoped(dir, SID_B)), 'lite');
});

test('a mode switch stays in the window it was typed in', () => {
  const dir = makeDir();
  run('caveman-activate.js', { session_id: SID_A, source: 'startup' }, dir);
  run('caveman-activate.js', { session_id: SID_B, source: 'startup' }, dir);

  const r = run('caveman-mode-tracker.js', { session_id: SID_A, prompt: '/caveman ultra' }, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(scoped(dir, SID_A)), 'ultra');
  assert.equal(read(scoped(dir, SID_B)), 'full', 'the other window keeps the mode it was on');
});

test('/caveman off clears only this session', () => {
  const dir = makeDir();
  run('caveman-activate.js', { session_id: SID_A, source: 'startup' }, dir);
  run('caveman-activate.js', { session_id: SID_B, source: 'startup' }, dir);

  run('caveman-mode-tracker.js', { session_id: SID_A, prompt: '/caveman off' }, dir);
  assert.equal(fs.existsSync(scoped(dir, SID_A)), false);
  assert.equal(read(scoped(dir, SID_B)), 'full', 'and leaves other sessions running');
});

// #691, now narrower: resume/clear/compact restore what THIS window was set to,
// where before they restored whatever another window last left in the shared file.
test('resume preserves this session own mid-session switch', () => {
  const dir = makeDir();
  run('caveman-activate.js', { session_id: SID_A, source: 'startup' }, dir);
  run('caveman-mode-tracker.js', { session_id: SID_A, prompt: '/caveman ultra' }, dir);
  run('caveman-activate.js', { session_id: SID_B, source: 'startup' }, dir, { CAVEMAN_DEFAULT_MODE: 'lite' });

  const r = run('caveman-activate.js', { session_id: SID_A, source: 'resume' }, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(scoped(dir, SID_A)), 'ultra', 'resume must not adopt another session mode');
});

// The one-shot modes stash the displaced prose mode; that stash is per session too,
// or /caveman-commit in one window would restore into another.
test('the one-shot restore stash is per session', () => {
  const dir = makeDir();
  run('caveman-activate.js', { session_id: SID_A, source: 'startup' }, dir, { CAVEMAN_DEFAULT_MODE: 'ultra' });
  run('caveman-mode-tracker.js', { session_id: SID_A, prompt: '/caveman-commit' }, dir);
  assert.equal(read(scoped(dir, SID_A)), 'commit');
  assert.equal(read(scoped(dir, SID_A, 'caveman.prev')), 'ultra');
  assert.equal(fs.existsSync(legacy(dir, '.caveman-active.prev')), false);

  run('caveman-mode-tracker.js', { session_id: SID_A, prompt: 'now do the next thing' }, dir);
  assert.equal(read(scoped(dir, SID_A)), 'ultra', 'the next ordinary prompt restores the prose mode');
});

test('no session id falls back to the global flag', () => {
  const dir = makeDir();
  const r = run('caveman-activate.js', { source: 'startup' }, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(legacy(dir)), 'full', 'compatibility path must behave as before');
});

test('transcript_path stands in for a missing session_id', () => {
  const dir = makeDir();
  const r = run('caveman-activate.js', {
    source: 'startup',
    transcript_path: path.join(dir, 'projects', 'x', SID_B + '.jsonl'),
  }, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(scoped(dir, SID_B)), 'full');
  assert.equal(fs.existsSync(legacy(dir)), false);
});

test('a forged session id cannot build a path', () => {
  for (const evil of ['../../escape', 'a/b', 'short', '..', '']) {
    const dir = makeDir();
    const r = run('caveman-activate.js', { session_id: evil, source: 'startup' }, dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(legacy(dir)), 'full', `${JSON.stringify(evil)} must fall back, not become a path`);
    assert.equal(fs.existsSync(path.join(dir, '..', 'escape')), false);
  }
});

// Otherwise a statusline that finds no session flag falls back to the global one
// and lights a badge for a window that has caveman switched off.
test('a stale global flag is cleared once a session owns one', () => {
  const dir = makeDir();
  fs.writeFileSync(legacy(dir), 'lite');
  fs.writeFileSync(legacy(dir, '.caveman-active.prev'), 'full');
  const r = run('caveman-activate.js', { session_id: SID_A, source: 'startup' }, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(scoped(dir, SID_A)), 'full');
  assert.equal(fs.existsSync(legacy(dir)), false);
  assert.equal(fs.existsSync(legacy(dir, '.caveman-active.prev')), false);
});

// The transition log is one flat timeline shared by every window, but the mode it
// records no longer is. Rows have to name their session or stats, walking the
// timeline for one, would attribute another window's switches to its messages.
test('transition-log rows name the session that wrote them', () => {
  const dir = makeDir();
  run('caveman-activate.js', { session_id: SID_A, source: 'startup' }, dir, { CAVEMAN_DEFAULT_MODE: 'ultra' });
  run('caveman-activate.js', { session_id: SID_B, source: 'startup' }, dir, { CAVEMAN_DEFAULT_MODE: 'lite' });
  run('caveman-mode-tracker.js', { session_id: SID_B, prompt: '/caveman off' }, dir);

  const rows = fs.readFileSync(path.join(dir, '.caveman-mode-log.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(rows.length >= 3, 'each transition is logged');
  assert.ok(rows.every(r => typeof r.session === 'string'), 'every row carries its session');
  assert.deepEqual(rows.filter(r => r.session === SID_A).map(r => r.mode), ['ultra']);
  assert.deepEqual(rows.filter(r => r.session === SID_B).map(r => r.mode), ['lite', null]);
});

test('session directories older than a week are swept, the live one is not', () => {
  const dir = makeDir();
  run('caveman-activate.js', { session_id: SID_B, source: 'startup' }, dir);

  const stale = 'ffffffff-0000-0000-0000-000000000000';
  fs.mkdirSync(path.dirname(scoped(dir, stale)), { recursive: true });
  fs.writeFileSync(scoped(dir, stale), 'full');
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.dirname(scoped(dir, stale)), longAgo, longAgo);

  const r = run('caveman-activate.js', { session_id: SID_A, source: 'startup' }, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.dirname(scoped(dir, stale))), false, 'a month-old session directory must go');
  assert.equal(read(scoped(dir, SID_A)), 'full', 'the session doing the sweeping must survive it');
  assert.equal(read(scoped(dir, SID_B)), 'full', 'and so must every recently touched one');
});
