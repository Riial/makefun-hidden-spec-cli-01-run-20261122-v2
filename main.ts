// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------- section 5: matching lines ----------

type Tier = 0 | 1 | 2;

function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function stripSides(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}
function lineEqAt(a: string, b: string, tier: Tier): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripSides(a) === stripSides(b);
}

/** Positions i in `file` where `old` occurs at `tier`, at or after `from`. Overlaps count. */
function occurrencesAt(file: string[], old: string[], tier: Tier, from: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = Math.max(0, from); i + old.length <= file.length; i += 1) {
    let ok = true;
    for (let k = 0; k < old.length; k += 1) {
      if (!lineEqAt(file[i + k]!, old[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiersToTry(strict: boolean): Tier[] {
  return strict ? [0] : [0, 1, 2];
}

/** A file's lines under its own line break, and whether it ends with one. */
interface FileView {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileView {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(v: FileView): string {
  if (v.lines.length === 0) return '';
  return v.lines.join(v.br) + (v.final ? v.br : '');
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Render N against the file's matched lines. At tier 2 the non-context lines are re-indented. */
function renderNew(nLines: NewLine[], matched: string[], tier: Tier, oldFirst: string): string[] {
  if (tier !== 2) return nLines.map((n) => (n.ctx ? matched[n.oIdx]! : n.text));
  const f = matched.length === 0 ? '' : leadingWs(matched[0]!);
  const p = leadingWs(oldFirst);
  return nLines.map((n) => {
    if (n.ctx) return matched[n.oIdx]!;
    const t = n.text;
    if (t === '' || t.trim() === '') return t;
    return t.startsWith(p) ? f + t.slice(p.length) : t;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful single-edit moves, as (old, new) pairs, in patch order. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** True when the path exists in the tree as earlier edits left it: a file in `now`, or anything on disk. */
  exists(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }
}

/** Fail with `exists` naming the first parent segment of `p` that is a file in the tree state. */
function checkParents(tree: Tree, p: string): void {
  const segs = p.split('/');
  let cur = '';
  for (let k = 0; k < segs.length - 1; k += 1) {
    cur = cur === '' ? segs[k]! : `${cur}/${segs[k]!}`;
    if (tree.get(cur) !== null) throw new Fail('exists', cur);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.exists(p)) throw new Fail('exists', p);
      checkParents(tree, p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- section 6: unified diffs ----------

interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNewline: boolean;
  /** The hunk has a `+` line, and a `\` line follows its last one. */
  hasPlus: boolean;
  plusBs: boolean;
}

interface UniSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  hasPair: boolean;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  createMode: boolean;
  deleteMode: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, surrounding spaces removed, a/b stripped, /dev/null as null. */
function headerPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.trim();
  const p = t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
  return p === '/dev/null' ? null : p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Read one hunk starting at lines[i] (a `@@` line). Returns the hunk and the index after its body. */
function readHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  const body: string[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: string[] = [];
  const n: NewLine[] = [];
  let prevKind: string | null = null;
  let hasPlus = false;
  for (let k = 0; k < body.length; k += 1) {
    const b = body[k]!;
    if (b === '' || b[0] === ' ') {
      const text = b === '' ? '' : b.slice(1);
      o.push(text);
      n.push({ text, ctx: true, oIdx: o.length - 1 });
      prevKind = 'ctx';
    } else if (b[0] === '-') {
      o.push(b.slice(1));
      prevKind = 'old';
    } else if (b[0] === '+') {
      n.push({ text: b.slice(1), ctx: false, oIdx: -1 });
      hasPlus = true;
      prevKind = 'new';
    } else {
      if (prevKind === null || prevKind === 'bs') throw new Exit2(`error: parse ${i + 2 + k}`);
      prevKind = 'bs';
    }
  }
  let noNewline = false;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const b = body[k]!;
    if (b === '' || b[0] === ' ' || b[0] === '+') {
      noNewline = k + 1 < body.length && body[k + 1]![0] === '\\';
      break;
    }
  }
  let plusBs = false;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const b = body[k]!;
    if (b[0] === '+') {
      plusBs = k + 1 < body.length && body[k + 1]![0] === '\\';
      break;
    }
  }
  return { hunk: { a, o, n, noNewline, hasPlus, plusBs }, next: j };
}

/** Consume a section's header lines from i; returns the index of the first line that is not one. */
function readUniHeader(lines: string[], i: number, s: UniSection): number {
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('@@')) return i;
    if (l.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (s.hasPair) return i;
        s.pairOld = headerPath(l.slice(4));
        s.pairNew = headerPath(next.slice(4));
        s.hasPair = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('+++ ')) {
      s.pairNew = headerPath(l.slice(4));
      i += 1;
      continue;
    }
    if (l.startsWith('rename from ')) {
      s.renameFrom = l.slice(12).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      s.renameTo = l.slice(10).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      s.createMode = true;
      i += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      s.deleteMode = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return i;
}

/** Apply a section's hunks in order to a file's text; fails with no-match on the first bad hunk. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const v = splitFile(text);
  const lines = v.lines;
  let final = v.final;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const runsToEnd = at === lines.length;
      lines.splice(at, 0, ...h.n.map((n) => n.text));
      if (runsToEnd) final = !h.noNewline;
      d += h.n.length;
      continue;
    }
    let found: { tier: Tier; positions: number[] } | null = null;
    for (const t of tiersToTry(strict)) {
      const pos = occurrencesAt(lines, h.o, t, 0);
      if (pos.length > 0) {
        found = { tier: t, positions: pos };
        break;
      }
    }
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const written = renderNew(h.n, lines.slice(best, best + h.o.length), found.tier, h.o[0]!);
    const runsToEnd = best + h.o.length === lines.length;
    lines.splice(best, h.o.length, ...written);
    if (runsToEnd) final = !h.noNewline;
    d += h.n.length - h.o.length;
  }
  return joinFile({ br: v.br, lines, final });
}

function unifiedSectionEdit(s: UniSection, strict: boolean): Edit {
  const oldPath = s.pairOld !== undefined ? s.pairOld : s.renameFrom !== undefined ? s.renameFrom : s.diffOld !== undefined ? s.diffOld : null;
  const newPath = s.pairNew !== undefined ? s.pairNew : s.renameTo !== undefined ? s.renameTo : s.diffNew !== undefined ? s.diffNew : null;
  const create = s.createMode || oldPath === null;
  const remove = !create && (s.deleteMode || newPath === null);
  if (create) {
    return (tree) => {
      const p = newPath;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.exists(p)) throw new Fail('exists', p);
      checkParents(tree, p);
      const out: string[] = [];
      let noFinal = false;
      for (const h of s.hunks) {
        for (const n of h.n) if (!n.ctx) out.push(n.text);
        if (h.hasPlus) noFinal = h.plusBs;
      }
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (noFinal ? '' : '\n'));
    };
  }
  if (remove) {
    return (tree) => {
      const p = oldPath;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (oldPath !== newPath) {
    return (tree) => {
      const oldP = oldPath!;
      const newP = newPath!;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.exists(newP)) throw new Fail('exists', newP);
      checkParents(tree, newP);
      tree.now.set(newP, applyHunks(before, s.hunks, strict, oldP));
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
    };
  }
  return (tree) => {
    const p = oldPath!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, s.hunks, strict, p));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  const blankSection = (): UniSection => {
    const s: UniSection = {
      pairOld: undefined,
      pairNew: undefined,
      hasPair: false,
      renameFrom: undefined,
      renameTo: undefined,
      diffOld: undefined,
      diffNew: undefined,
      createMode: false,
      deleteMode: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  let cur: UniSection | null = null;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = blankSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      i = readUniHeader(lines, i + 1, cur);
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = blankSection();
      cur.pairOld = headerPath(l.slice(4));
      cur.pairNew = headerPath(lines[i + 1]!.slice(4));
      cur.hasPair = true;
      i = readUniHeader(lines, i + 2, cur);
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur.deleteMode || cur.pairNew === null) {
        // A deletion section's hunks are not read, but a malformed @@ line is still a parse error (SPEC section 6).
        if (HUNK_RE.exec(l) === null) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
        continue;
      }
      const h = readHunk(lines, i);
      cur.hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.exists(path)) throw new Fail('exists', path);
      checkParents(tree, path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const v = splitFile(before);
    let found: { tier: Tier; positions: number[] } | null = null;
    for (const t of tiersToTry(strict)) {
      const pos = occurrencesAt(v.lines, oldLines, t, 0);
      if (pos.length > 0) {
        found = { tier: t, positions: pos };
        break;
      }
    }
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const at = found.positions[0]!;
    const nLines: NewLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const written = renderNew(nLines, v.lines.slice(at, at + oldLines.length), found.tier, oldLines[0]!);
    const out = v.lines.slice();
    out.splice(at, oldLines.length, ...written);
    tree.now.set(path, joinFile({ br: v.br, lines: out, final: v.final }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = 0;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevReplace; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchIdx + 1}`);
      if (eq < 0 && t === '=======') {
        eq = j;
        continue;
      }
      if (t === '>>>>>>> REPLACE') {
        if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevReplace = rep + 1;
    prevPath = path;
    i = rep;
  }
  return edits;
}

// ---------- section 8: V4A patches ----------

interface V4aChunk {
  anchor: string | null;
  o: string[];
  n: NewLine[];
  eof: boolean;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.exists(moveTo)) throw new Fail('exists', moveTo);
    if (moveTo !== null) checkParents(tree, moveTo);
    const v = splitFile(before);
    const lines = v.lines;
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        let foundAt = -1;
        for (const t of tiersToTry(strict)) {
          for (let i = cursor; i < lines.length; i += 1) {
            if (lineEqAt(lines[i]!, c.anchor, t)) {
              foundAt = i;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      if (c.o.length === 0) {
        const at = c.eof ? lines.length : cursor;
        const ins = c.n.map((n) => n.text);
        lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      let found: { tier: Tier; pos: number } | null = null;
      for (const t of tiersToTry(strict)) {
        const occ = occurrencesAt(lines, c.o, t, cursor);
        if (c.eof) {
          const endPos = lines.length - c.o.length;
          if (endPos >= cursor && occ.includes(endPos)) {
            found = { tier: t, pos: endPos };
            break;
          }
        } else if (occ.length > 0) {
          found = { tier: t, pos: occ[0]! };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const written = renderNew(c.n, lines.slice(found.pos, found.pos + c.o.length), found.tier, c.o[0]!);
      lines.splice(found.pos, c.o.length, ...written);
      cursor = found.pos + written.length;
    }
    const out = joinFile({ br: v.br, lines, final: v.final });
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aSectionEdit(kind: string, path: string, raw: string[], bodyStart: number, headerLine: number, strict: boolean): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (let k = 0; k < raw.length; k += 1) {
      const l = raw[k]!;
      if (l === '') {
        fileLines.push('');
        continue;
      }
      if (l[0] === '+') {
        fileLines.push(l.slice(1));
        continue;
      }
      throw new Exit2(`error: parse ${bodyStart + k + 1}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.exists(path)) throw new Fail('exists', path);
      checkParents(tree, path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    for (let k = 0; k < raw.length; k += 1) {
      if (!blank(raw[k]!)) throw new Exit2(`error: parse ${bodyStart + k + 1}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let idx = 0;
  let moveTo: string | null = null;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to:')) {
    moveTo = raw[0]!.slice(12).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  for (let k = idx; k < raw.length; k += 1) {
    const l = raw[k]!;
    const lineNo = bodyStart + k + 1;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, o: [], n: [], eof: false };
      chunks.push(cur);
      continue;
    }
    if (l.trimEnd() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length === 0) {
          cur = { anchor: null, o: [], n: [], eof: false };
          chunks.push(cur);
        } else {
          throw new Exit2(`error: parse ${lineNo}`);
        }
      }
      if (l === '' || l[0] === ' ') {
        const text = l === '' ? '' : l.slice(1);
        cur.o.push(text);
        cur.n.push({ text, ctx: true, oIdx: cur.o.length - 1 });
      } else if (l[0] === '-') {
        cur.o.push(l.slice(1));
      } else {
        cur.n.push({ text: l.slice(1), ctx: false, oIdx: -1 });
      }
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return v4aUpdateEdit(path, moveTo, chunks, strict);
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:')) {
      const kind = l.startsWith('*** Add File:') ? 'add' : l.startsWith('*** Delete File:') ? 'delete' : 'update';
      const path = l.slice(kind === 'add' ? 13 : 16).trim();
      const start = i + 1;
      let j = start;
      while (j < last) {
        const m = lines[j]!;
        if (m.startsWith('*** Add File:') || m.startsWith('*** Delete File:') || m.startsWith('*** Update File:')) break;
        j += 1;
      }
      const raw = lines.slice(start, j);
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      edits.push(v4aSectionEdit(kind, path, raw, start, i + 1, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (covered.has(oldP) || covered.has(newP)) continue;
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of changed) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    // Defensive: a filesystem error while writing (e.g. a parent segment
    // is a file created by an earlier edit in this patch) must never
    // crash the program. Report a defined failure instead. SPEC defines
    // no error code for this shape; `exists` is used because something
    // in the way exists and blocks the write.
    let failedPath = '';
    try {
      for (const p of changed) {
        const was = tree.original(p);
        const now = tree.now.get(p)!;
        if (was === now) continue;
        failedPath = p;
        if (now === null) rmSync(p, { force: true });
        else {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, now);
        }
      }
    } catch {
      return { code: 1, out: [`error: exists ${failedPath}`, `failed: 1 of ${edits.length} edits`] };
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
