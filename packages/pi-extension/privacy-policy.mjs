import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export class PrivacyError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new PrivacyError(code); };
const clean = (value, max = 4096) => typeof value === 'string' && value.length > 0
  && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const missing = error => ['ENOENT', 'ENOTDIR'].includes(error?.code);
const fresh = () => ({ schema_version: '1', paths: [], models: [], sessions: [] });
const within = (path, root) => {
  const rest = relative(root, path);
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};
const sessionKey = id => {
  if (!clean(id)) fail('PRIVACY_SESSION_UNAVAILABLE');
  return createHash('sha256').update(id).digest('hex');
};

function pathName(input, cwd) {
  if (!clean(input) || !clean(cwd)) fail('PRIVACY_PATH_INVALID');
  let value = input.trim().replace(/^@(?=\S)/, '');
  const quote = { '"': '"', "'": "'", '`': '`', '“': '”', '‘': '’' };
  if (quote[value[0]] && value.endsWith(quote[value[0]])) value = value.slice(1, -1);
  value = value.replace(/^@(?=\S)/, '').replace(/\\([ "'`\\])/g, '$1');
  if (!value) fail('PRIVACY_PATH_INVALID');
  if (value.startsWith('file:')) {
    try { value = fileURLToPath(value); } catch { fail('PRIVACY_PATH_INVALID'); }
  }
  if (value === '~') value = homedir();
  else if (value.startsWith('~/')) value = resolve(homedir(), value.slice(2));
  return resolve(cwd, value);
}

// Mirror Pi 1.2.0 tool resolution, which intentionally does not trim whitespace,
// remove quotes or interpret shell escapes. Text/command parsing uses pathName instead.
function toolName(input, toolInput = false) {
  let value = input;
  if (toolInput) {
    value = value.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
    if (value.startsWith('@')) value = value.slice(1);
  }
  if (process.platform === 'win32' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) {
    const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(value);
    if (drive) value = `${drive[1].toUpperCase()}:\\${(drive[2] ?? '').replaceAll('/', '\\')}`;
  }
  if (value === '~') return homedir();
  if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\'))) return join(homedir(), value.slice(2));
  if (value.startsWith('file://')) {
    try { return fileURLToPath(value); } catch { fail('PRIVACY_PATH_INVALID'); }
  }
  return value;
}
export function toolPaths(input, cwd = process.cwd(), read = false) {
  if (!clean(input) || !clean(cwd) || typeof read !== 'boolean') fail('PRIVACY_PATH_INVALID');
  const base = toolName(cwd), normalized = resolve(base, toolName(input, true));
  // Include the complete literal input as a conservative check, even where Pi will
  // normalize it. In particular " name " and '"name"' can be distinct real files.
  const paths = new Set([resolve(base, input), normalized]);
  if (read) {
    const nfd = normalized.normalize('NFD');
    paths.add(normalized.replace(/ (AM|PM)\./gi, '\u202F$1.'));
    paths.add(nfd);
    paths.add(normalized.replace(/'/g, '\u2019'));
    paths.add(nfd.replace(/'/g, '\u2019'));
  }
  return [...paths];
}

// Resolve existing ancestors as well: a not-yet-created child may still be inside a symlinked folder.
function canonical(path) {
  let part = path;
  const tail = [];
  while (true) {
    try { return resolve(realpathSync(part), ...tail.reverse()); }
    catch (error) {
      if (!missing(error)) fail('PRIVACY_PATH_UNAVAILABLE');
      const parent = dirname(part);
      if (parent === part) fail('PRIVACY_PATH_UNAVAILABLE');
      tail.push(basename(part)); part = parent;
    }
  }
}
function info(path) {
  try { return statSync(path, { bigint: true }); }
  catch (error) { if (missing(error)) return null; fail('PRIVACY_PATH_UNAVAILABLE'); }
}
function preparePaths(data) {
  return data.paths.map(rule => ({ ...rule,
    roots: new Set([rule.path, rule.realPath, canonical(rule.path)]) }));
}
function pathMatches(rules, input, cwd, recursive = false) {
  // Keep the literal spelling too: tools do not trim or unquote path arguments.
  const paths = new Set([pathName(input, cwd), resolve(cwd, input)]);
  for (const path of paths) {
    const realPath = canonical(path), st = info(path);
    // Finding every hard-link name would require an unbounded filesystem walk. With a
    // directory rule active, conservatively protect any multiply-linked regular file.
    if (st?.isFile() && st.nlink > 1n && rules.some(rule => rule.kind === 'directory')) return true;
    for (const rule of rules) {
      if (rule.kind === 'file' && st && String(st.dev) === rule.dev && String(st.ino) === rule.ino) return true;
      for (const root of rule.roots) {
        if ([path, realPath].some(p => p === root || (rule.kind === 'directory' && within(p, root))
          || (recursive && within(root, p)))) return true;
      }
    }
  }
  return false;
}
function endpoint(value) {
  if (!clean(value)) fail('PRIVACY_MODEL_INVALID');
  let url;
  try { url = new URL(value); } catch { fail('PRIVACY_MODEL_INVALID'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail('PRIVACY_MODEL_INVALID');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href;
}
function modelRecord(model, kind) {
  if (!['local', 'trusted'].includes(kind) || !model || !clean(model.provider, 200)
    || !clean(model.id, 500) || !clean(model.api, 200)) fail('PRIVACY_MODEL_INVALID');
  const baseUrl = endpoint(model.baseUrl);
  const host = new URL(baseUrl).hostname;
  if (kind === 'local' && !['127.0.0.1', '[::1]', 'localhost'].includes(host)) fail('PRIVACY_NOT_LOOPBACK');
  return { provider: model.provider, id: model.id, api: model.api, baseUrl, kind };
}
const sameBinding = (a, b) => a.provider === b.provider && a.id === b.id
  && a.api === b.api && a.baseUrl === b.baseUrl;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function valid(data) {
  if (!exactKeys(data, ['schema_version', 'paths', 'models', 'sessions']) || data.schema_version !== '1'
    || !Array.isArray(data.paths) || data.paths.length > 1024 || !Array.isArray(data.models) || data.models.length > 1024
    || !Array.isArray(data.sessions) || data.sessions.length > 32768) return false;
  if (data.paths.some(p => !exactKeys(p, ['path', 'realPath', 'kind', 'dev', 'ino'])
    || !clean(p.path) || !isAbsolute(p.path) || !clean(p.realPath) || !isAbsolute(p.realPath)
    || resolve(p.path) !== p.path || resolve(p.realPath) !== p.realPath
    || !['file', 'directory'].includes(p.kind) || typeof p.dev !== 'string' || !/^\d+$/.test(p.dev)
    || typeof p.ino !== 'string' || !/^\d+$/.test(p.ino))) return false;
  if (new Set(data.paths.map(p => p.path)).size !== data.paths.length) return false;
  try {
    if (data.models.some(m => !exactKeys(m, ['provider', 'id', 'api', 'baseUrl', 'kind'])
      || !sameBinding(m, modelRecord(m, m.kind)))) return false;
  } catch { return false; }
  if (new Set(data.models.map(m => JSON.stringify([m.provider, m.id, m.api, m.baseUrl]))).size !== data.models.length) return false;
  return data.sessions.every(s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s))
    && new Set(data.sessions).size === data.sessions.length;
}

export class PrivacyPolicy {
  constructor(file) {
    if (!clean(file)) fail('PRIVACY_FILE_INVALID');
    this.file = resolve(file);
  }
  read() {
    try { lstatSync(this.file + '.lock'); fail('PRIVACY_FILE_BUSY'); }
    catch (error) { if (error.code !== 'ENOENT') throw error instanceof PrivacyError ? error : new PrivacyError('PRIVACY_FILE_INVALID'); }
    return this.load();
  }
  load() {
    let data;
    try {
      const st = lstatSync(this.file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 8_000_000) fail('PRIVACY_FILE_INVALID');
      data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return fresh();
      fail('PRIVACY_FILE_INVALID');
    }
    if (!valid(data)) fail('PRIVACY_FILE_INVALID');
    return data;
  }
  update(change) {
    const lock = this.file + '.lock';
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd, output;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      try { fd = openSync(lock, 'wx', 0o600); }
      catch (error) { fail(error.code === 'EEXIST' ? 'PRIVACY_FILE_BUSY' : 'PRIVACY_SAVE_FAILED'); }
      const data = this.load();
      if (change(data) === false) return data;
      if (!valid(data)) fail('PRIVACY_LIMIT_REACHED');
      output = openSync(temporary, 'wx', 0o600);
      writeFileSync(output, JSON.stringify(data, null, 2) + '\n');
      fsyncSync(output); closeSync(output); output = undefined;
      renameSync(temporary, this.file);
      return data;
    } catch (error) {
      if (error instanceof PrivacyError) throw error;
      fail('PRIVACY_SAVE_FAILED');
    } finally {
      if (output !== undefined) closeSync(output);
      try { unlinkSync(temporary); } catch {}
      if (fd !== undefined) { closeSync(fd); try { unlinkSync(lock); } catch {} }
    }
  }
  addPath(input, cwd = process.cwd()) {
    const path = pathName(input, cwd), st = info(path);
    if (!st || (!st.isFile() && !st.isDirectory())) fail('PRIVACY_PATH_NOT_FOUND');
    const record = { path, realPath: canonical(path), kind: st.isDirectory() ? 'directory' : 'file',
      dev: String(st.dev), ino: String(st.ino) };
    return this.update(data => {
      const old = data.paths.findIndex(p => p.path === path);
      if (old < 0) data.paths.push(record); else data.paths[old] = record;
    });
  }
  removePath(input, cwd = process.cwd()) {
    const path = pathName(input, cwd);
    // Only the exact registered path is removed, so overlapping rules remain explicit.
    return this.update(data => { data.paths = data.paths.filter(p => p.path !== path); });
  }
  allowModel(model, kind = 'trusted') {
    const record = modelRecord(model, kind);
    return this.update(data => {
      data.models = data.models.filter(m => m.provider !== record.provider || m.id !== record.id);
      data.models.push(record);
    });
  }
  revokeModel(providerAndId) {
    if (!clean(providerAndId, 702)) fail('PRIVACY_MODEL_INVALID');
    return this.update(data => { data.models = data.models.filter(m => `${m.provider}/${m.id}` !== providerAndId); });
  }
  hasRules() { return this.read().paths.length > 0; }
  allowed(model) {
    const data = this.read();
    let binding;
    try { binding = modelRecord(model, 'trusted'); } catch { return false; }
    return data.models.some(m => sameBinding(m, binding));
  }
  matchesPath(input, cwd = process.cwd(), { recursive = false } = {}) {
    const data = this.read();
    if (!data.paths.length) return false;
    return pathMatches(preparePaths(data), input, cwd, recursive);
  }
  matchesText(text, cwd = process.cwd()) {
    const data = this.read();
    if (!data.paths.length) return false;
    if (typeof text !== 'string' || text.length > 8_000_000) fail('PRIVACY_TEXT_INVALID');
    // One policy snapshot and one resolution of every rule per text, not per word.
    const rules = preparePaths(data);
    if (pathMatches(rules, cwd, cwd)) return true;
    const candidates = new Set();
    for (const match of text.matchAll(/["'`“‘]([^"'`”’\n]+)["'`”’]/g)) candidates.add(match[1]);
    for (const match of text.matchAll(/(?:\\.|[^\s"'`<>()[\]{}，。！？、；：])+/g)) {
      const word = match[0];
      if (word.includes('/') || /^[~@]/.test(word) || /\.[\p{L}\p{N}_-]+(?::\d+(?::\d+)?)?$/u.test(word)) candidates.add(word);
    }
    // Exact registered spellings also cover unquoted names containing spaces.
    for (const rule of data.paths) {
      for (const name of [rule.path, rule.realPath, basename(rule.path)]) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const boundary = rule.kind === 'directory' ? '(?=$|[\\s/"\'`<>()[\\]{}，。！？、；：,;:!?])'
          : '(?=$|[\\s"\'`<>()[\\]{}，。！？、；：,;:!?])';
        if (new RegExp(`(?:^|[\\s/@"'\x60<>()\\[\\]{}，。！？、；：])${escaped}${boundary}`, 'u').test(text)) return true;
      }
    }
    for (let value of candidates) {
      value = value.replace(/[.,;!?]+$/, '').replace(/:\d+(?::\d+)?$/, '');
      if (!value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) continue;
      // HTTP links are not local file references. file: URIs remain eligible.
      if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !value.startsWith('file://')) continue;
      try { if (pathMatches(rules, value, cwd)) return true; }
      catch (error) { if (error.code !== 'PRIVACY_PATH_INVALID') throw error; }
    }
    return false;
  }
  markSession(id) {
    const key = sessionKey(id);
    return this.update(data => { if (data.sessions.includes(key)) return false; data.sessions.push(key); });
  }
  isMarked(id) { return this.read().sessions.includes(sessionKey(id)); }
}
