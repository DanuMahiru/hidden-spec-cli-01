// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT), completed to cover
// every section of SPEC.md: the command line, the output and exit codes, safe paths, format detection, JSON edits and
// the all-or-nothing write, plus tiered (fuzzy) line matching (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), with move (R) output. Node 22, the standard library
// alone; run it as `node main.ts [options] [PATCH]`.
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
const trimEnd = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function safeOrFail(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  const firstLf = text.indexOf('\n');
  const br = firstLf >= 1 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = lines.length > 0 && lines[lines.length - 1] === '';
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, finalBr: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBr ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, old path -> new path, so the output can say R instead of D + A. */
  readonly moved = new Map<string, string>();
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
  /** Record a move: the old path goes away, the new path holds `text`. */
  move(oldPath: string, newPath: string, text: string): void {
    this.now.set(oldPath, null);
    this.now.set(newPath, text);
    this.moved.set(oldPath, newPath);
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

/* ------------------------------------------------------------------ */
/* Section 5: tiered line matching                                     */
/* ------------------------------------------------------------------ */

/** Whether two lines are equal at a tier: 0 exact, 1 trailing whitespace ignored, 2 both ends ignored. */
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEnd(a) === trimEnd(b);
  return trimBoth(a) === trimBoth(b);
}

/** Every start index where `old` occurs in `lines` at `tier` (overlapping occurrences count). */
function occurrences(lines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = 0; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (!tierEq(lines[i + j], old[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) with an occurrence at or after `from`, and its first one. */
function findFirst(lines: string[], old: string[], from: number, strict: boolean): { tier: number; start: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, old, t).filter((i) => i >= from);
    if (occ.length > 0) return { tier: t, start: occ[0] };
  }
  return null;
}

/** The first tier with an occurrence anywhere, and every occurrence at that tier. */
function findAll(lines: string[], old: string[], strict: boolean): { tier: number; starts: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, old, t);
    if (occ.length > 0) return { tier: t, starts: occ };
  }
  return null;
}

/** The occurrence at the found tier nearest to `target` (ties: the earlier one). */
function findNearest(lines: string[], old: string[], target: number, strict: boolean): { tier: number; start: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, old, t);
    if (occ.length === 0) continue;
    let best = occ[0]!;
    for (const s of occ) {
      if (Math.abs(s - target) < Math.abs(best - target)) best = s;
    }
    return { tier: t, start: best };
  }
  return null;
}

/**
 * The lines that replace a matched occurrence of `old` with `nw`.
 * `ctxOfN[j]` is the index into `old` of the context line that `nw[j]` is, or null when `nw[j]` is a new line:
 * a context line is written as the file's own matched line, never the patch's; at tier 2 every other new line is
 * re-indented from the patch's first old line to the file's first matched line.
 */
function replacement(
  old: string[],
  nw: string[],
  ctxOfN: (number | null)[],
  fileLines: string[],
  start: number,
  tier: number,
): string[] {
  const f = leadingWs(fileLines[start] ?? '');
  const p = leadingWs(old[0] ?? '');
  const out: string[] = [];
  for (let j = 0; j < nw.length; j++) {
    const ci = ctxOfN[j];
    if (ci !== null && ci !== undefined) {
      out.push(fileLines[start + ci]!);
    } else if (tier === 2) {
      const line = nw[j]!;
      if (line !== '' && line.trim() !== '' && line.startsWith(p)) out.push(f + line.slice(p.length));
      else out.push(line);
    } else {
      out.push(nw[j]!);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                            */
/* ------------------------------------------------------------------ */

interface HunkLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}
interface Hunk {
  a: number;
  b: number;
  c: number;
  d: number;
  body: HunkLine[];
  /** A `\` line follows the hunk's last context or `+` line: the result has no final line break. */
  noEol: boolean;
}
interface Section {
  oldPath: string | null;
  newPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` header path: up to the first tab, spaces trimmed, /dev/null means no file, a/ or b/ stripped. */
function headerPath(raw: string): string | null {
  const p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Split a hunk body into its old lines, its new lines, and which new lines are context lines. */
function hunkON(h: Hunk): { old: string[]; nw: string[]; ctx: (number | null)[] } {
  const old: string[] = [];
  const nw: string[] = [];
  const ctx: (number | null)[] = [];
  for (const bl of h.body) {
    if (bl.kind === ' ') {
      ctx.push(old.length);
      old.push(bl.text);
      nw.push(bl.text);
    } else if (bl.kind === '-') {
      old.push(bl.text);
    } else if (bl.kind === '+') {
      ctx.push(null);
      nw.push(bl.text);
    }
  }
  return { old, nw, ctx };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const sections: Section[] = [];
  let sec: Section | null = null;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (sec === null) {
      if (l.startsWith('diff --git ')) {
        const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
        if (!m) throw new Exit2(`error: parse ${i + 1}`);
        sec = { oldPath: m[1], newPath: m[2], isNew: false, isDeleted: false, hunks: [] };
        sections.push(sec);
        i++;
        continue;
      }
      if (l.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
        sec = { oldPath: headerPath(l.slice(4)), newPath: headerPath(lines[i + 1]!.slice(4)), isNew: false, isDeleted: false, hunks: [] };
        sections.push(sec);
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!hm) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = {
        a: Number(hm[1]),
        b: hm[2] === undefined ? 1 : Number(hm[2]),
        c: Number(hm[3]),
        d: hm[4] === undefined ? 1 : Number(hm[4]),
        body: [],
        noEol: false,
      };
      sec.hunks.push(hunk);
      i++;
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) break;
        if (bl.startsWith('@@')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          if (bl === '') hunk.body.push({ kind: ' ', text: '' });
          else hunk.body.push({ kind: bl[0] as HunkLine['kind'], text: bl.slice(1) });
          i++;
        } else break;
      }
      while (hunk.body.length > 0) {
        const lastB = hunk.body[hunk.body.length - 1]!;
        if (lastB.kind === ' ' && lastB.text === '') hunk.body.pop();
        else break;
      }
      for (let k = hunk.body.length - 1; k >= 0; k--) {
        if (hunk.body[k]!.kind === ' ' || hunk.body[k]!.kind === '+') {
          hunk.noEol = k + 1 < hunk.body.length && hunk.body[k + 1]!.kind === '\\';
          break;
        }
      }
      continue;
    }
    if (sec.hunks.length === 0) {
      if (l.startsWith('diff --git ')) {
        sec = null;
        continue;
      }
      if (l.startsWith('--- ')) {
        if (i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
          sec.oldPath = headerPath(l.slice(4));
          sec.newPath = headerPath(lines[i + 1]!.slice(4));
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('+++ ')) {
        sec.newPath = headerPath(l.slice(4));
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        sec.oldPath = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.newPath = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.isNew = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.isDeleted = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('diff --git ') || (l.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ '))) {
      sec = null;
      continue;
    }
    i++;
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.oldPath;
    const newP = s.newPath;
    const isCreate = oldP === null || s.isNew;
    const isDelete = newP === null || s.isDeleted;
    if (isCreate && isDelete) continue;
    if (isCreate) {
      const target = newP!;
      const newLines: string[] = [];
      let lastPlus: Hunk | null = null;
      for (const h of s.hunks) {
        let hasPlus = false;
        for (const bl of h.body) {
          if (bl.kind === '+') {
            newLines.push(bl.text);
            hasPlus = true;
          }
        }
        if (hasPlus) lastPlus = h;
      }
      const finalBr = lastPlus === null ? true : !lastPlus.noEol;
      edits.push((tree) => {
        safeOrFail(target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        tree.now.set(target, joinFile(newLines, '\n', finalBr));
      });
      continue;
    }
    if (isDelete) {
      const target = oldP!;
      edits.push((tree) => {
        safeOrFail(target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
      });
      continue;
    }
    const oldPath = oldP!;
    const newPath = newP!;
    const isMove = oldPath !== newPath;
    edits.push((tree) => {
      safeOrFail(oldPath);
      if (isMove) safeOrFail(newPath);
      const cur = tree.get(oldPath);
      if (cur === null) throw new Fail('missing', oldPath);
      if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const st = splitFile(cur);
      let fileLines = [...st.lines];
      let finalBr = st.final;
      let d = 0;
      for (const h of s.hunks) {
        const { old, nw, ctx } = hunkON(h);
        if (old.length === 0) {
          const beforeLen = fileLines.length;
          const at = Math.min(h.a + d, beforeLen);
          fileLines.splice(at, 0, ...nw);
          if (at === beforeLen) finalBr = !h.noEol;
          d += nw.length;
        } else {
          const found = findNearest(fileLines, old, h.a - 1 + d, strict);
          if (found === null) throw new Fail('no-match', oldPath);
          const runsToEnd = found.start + old.length === fileLines.length;
          const rep = replacement(old, nw, ctx, fileLines, found.start, found.tier);
          fileLines.splice(found.start, old.length, ...rep);
          if (runsToEnd) finalBr = !h.noEol;
          d += nw.length - old.length;
        }
      }
      const text = joinFile(fileLines, st.br, finalBr);
      if (isMove) tree.move(oldPath, newPath, text);
      else tree.now.set(oldPath, text);
    });
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                    */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let lastPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let j = i; j < lines.length; j++) {
      if (trimEnd(lines[j]!) === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s === -1) break;
    let path: string | null = null;
    for (let j = s - 1; j >= i; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = lastPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (trimEnd(lines[j]!) === '=======') {
        eq = j;
        break;
      }
      if (trimEnd(lines[j]!) === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (trimEnd(lines[j]!) === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(((p, o, nw) => (tree: Tree) => {
      safeOrFail(p);
      if (o.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile(nw, '\n', true));
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const st = splitFile(cur);
      const found = findAll(st.lines, o, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.starts.length !== 1) throw new Fail('ambiguous', p);
      const start = found.starts[0]!;
      const repLines = replacement(o, nw, nw.map(() => null), st.lines, start, found.tier);
      const out = [...st.lines];
      out.splice(start, o.length, ...repLines);
      tree.now.set(p, joinFile(out, st.br, st.final));
    })(path, oldLines, newLines));
    lastPath = path;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                              */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  old: string[];
  nw: string[];
  ctx: (number | null)[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!blank(lines[i]!)) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last === -1 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    i++;
    const body: { text: string; line: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      body.push({ text: l, line: i + 1 });
      i++;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();

    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const b of body) {
        if (blank(b.text)) fileLines.push('');
        else if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
        else throw new Exit2(`error: parse ${b.line}`);
      }
      edits.push(((p, fl) => (tree: Tree) => {
        safeOrFail(p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile(fl, '\n', true));
      })(path, fileLines));
      continue;
    }
    if (kind === 'delete') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.line}`);
      edits.push(((p) => (tree: Tree) => {
        safeOrFail(p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      })(path));
      continue;
    }
    let moveTo: string | null = null;
    let b = 0;
    if (b < body.length && body[b]!.text.startsWith('*** Move to: ')) {
      moveTo = body[b]!.text.slice('*** Move to: '.length).trim();
      b++;
    }
    const chunks: V4aChunk[] = [];
    let current: V4aChunk | null = null;
    let chunkCount = 0;
    const closeChunk = (): void => {
      if (current !== null) {
        chunks.push(current);
        current = null;
        chunkCount++;
      }
    };
    while (b < body.length) {
      const bl = body[b]!;
      const t = bl.text;
      if (t.startsWith('@@')) {
        closeChunk();
        current = { anchor: t.slice(2).trim(), eof: false, old: [], nw: [], ctx: [] };
        if (current.anchor === '') current.anchor = null;
        b++;
        continue;
      }
      if (t.trim() === '*** End of File') {
        if (current === null) current = { anchor: null, eof: false, old: [], nw: [], ctx: [] };
        current.eof = true;
        closeChunk();
        b++;
        continue;
      }
      if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
        if (current === null) {
          if (chunkCount > 0) throw new Exit2(`error: parse ${bl.line}`);
          current = { anchor: null, eof: false, old: [], nw: [], ctx: [] };
        }
        if (t === '') {
          current.ctx.push(current.old.length);
          current.old.push('');
          current.nw.push('');
        } else if (t.startsWith(' ')) {
          current.ctx.push(current.old.length);
          current.old.push(t.slice(1));
          current.nw.push(t.slice(1));
        } else if (t.startsWith('-')) {
          current.old.push(t.slice(1));
        } else {
          current.ctx.push(null);
          current.nw.push(t.slice(1));
        }
        b++;
        continue;
      }
      throw new Exit2(`error: parse ${bl.line}`);
    }
    closeChunk();
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
    edits.push(((p, to, chs) => (tree: Tree) => {
      safeOrFail(p);
      if (to !== null) safeOrFail(to);
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
      const st = splitFile(cur);
      let fileLines = [...st.lines];
      let cursor = 0;
      for (const ch of chs) {
        if (ch.anchor !== null) {
          const m = findFirst(fileLines, [ch.anchor], cursor, strict);
          if (m === null) throw new Fail('no-match', p);
          cursor = m.start + 1;
        }
        if (ch.eof) {
          if (ch.old.length === 0) {
            fileLines.push(...ch.nw);
            cursor = fileLines.length;
          } else {
            let found: { tier: number; start: number } | null = null;
            const tiers = strict ? [0] : [0, 1, 2];
            for (const t of tiers) {
              const occ = occurrences(fileLines, ch.old, t).filter((x) => x >= cursor && x + ch.old.length === fileLines.length);
              if (occ.length > 0) {
                found = { tier: t, start: occ[0]! };
                break;
              }
            }
            if (found === null) throw new Fail('no-match', p);
            const repLines = replacement(ch.old, ch.nw, ch.ctx, fileLines, found.start, found.tier);
            fileLines.splice(found.start, ch.old.length, ...repLines);
            cursor = found.start + repLines.length;
          }
        } else if (ch.old.length === 0) {
          fileLines.splice(cursor, 0, ...ch.nw);
          cursor += ch.nw.length;
        } else {
          const m = findFirst(fileLines, ch.old, cursor, strict);
          if (m === null) throw new Fail('no-match', p);
          const repLines = replacement(ch.old, ch.nw, ch.ctx, fileLines, m.start, m.tier);
          fileLines.splice(m.start, ch.old.length, ...repLines);
          cursor = m.start + repLines.length;
        }
      }
      const text = joinFile(fileLines, st.br, st.final);
      if (to !== null) tree.move(p, to, text);
      else tree.now.set(p, text);
    })(path, moveTo, chunks));
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits                                               */
/* ------------------------------------------------------------------ */

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
      if (tree.get(p) !== null) throw new Fail('exists', p);
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

/* ------------------------------------------------------------------ */
/* Section 1, 2 and 10: the command line, the output, the write        */
/* ------------------------------------------------------------------ */

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoved = new Map(tree.moved);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moved.clear();
      for (const [k, v] of beforeMoved) tree.moved.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  // A move is an old path that is gone and a new path that is there, neither of which the tree started with that way.
  const movedFinal = new Map<string, string>();
  for (const [o, n] of tree.moved) {
    let dest = n;
    const seen = new Set<string>([o]);
    while (tree.moved.has(dest) && !seen.has(dest)) {
      seen.add(dest);
      dest = tree.moved.get(dest)!;
    }
    movedFinal.set(o, dest);
  }
  const destOf = new Map<string, string>();
  for (const [o, dest] of movedFinal) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(dest) === null && tree.get(dest) !== null) {
      destOf.set(dest, o);
    }
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null) {
      const dest = movedFinal.get(p);
      if (dest !== undefined && destOf.has(dest)) continue;
      rows.push({ key: p, line: `D ${p}` });
    } else if (was === null) {
      if (destOf.has(p)) continue;
      rows.push({ key: p, line: `A ${p}` });
    } else {
      rows.push({ key: p, line: `M ${p}` });
    }
  }
  for (const [dest, old] of destOf) rows.push({ key: dest, line: `R ${old} -> ${dest}` });
  rows.sort((a, b) => byteOrder(a.key, b.key));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
