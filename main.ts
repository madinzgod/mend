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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, in the patch's order, for the `R` lines of section 2. */
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

// ---------------------------------------------------------------------------
// Sections 5 to 8, written for this entry: matching lines at three tiers, and
// the unified, SEARCH/REPLACE and V4A readers. A file is worked on as its list
// of lines plus its own line break and whether it ended with one (section 3).

interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    fin = true;
    parts.pop();
  }
  return { lines: parts, br, final: fin };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

const rtrimWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWs(a) === rtrimWs(b);
  return trimWs(a) === trimWs(b);
}

/** Occurrences of o in lines at the first tier that has one, at or after `from`; an end-of-file match must also end at the last line. */
function findOcc(lines: string[], o: string[], strict: boolean, from = 0, eofOnly = false): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i += 1) {
      if (eofOnly && i + o.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j += 1) {
        if (!tierEq(lines[i + j]!, o[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first line at or after `from` equal to the anchor, at the first tier that has one (section 8). */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (tierEq(lines[i]!, anchor, tier)) return i;
    }
  }
  return -1;
}

interface BodyLine {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  bs: boolean;
  oi: number;
}

/** The old and new line lists of one hunk or chunk body; sections 6 and 8 share the body alphabet. */
function bodyLists(raw: string[]): { entries: BodyLine[]; o: BodyLine[]; n: BodyLine[]; lastNbs: boolean } {
  const entries: BodyLine[] = [];
  for (const l of raw) {
    if (l.startsWith('\\')) {
      const prev = entries[entries.length - 1];
      if (prev !== undefined) prev.bs = true;
    } else if (l === '' || l.startsWith(' ')) entries.push({ kind: 'ctx', text: l.slice(1), bs: false, oi: -1 });
    else if (l.startsWith('-')) entries.push({ kind: 'del', text: l.slice(1), bs: false, oi: -1 });
    else entries.push({ kind: 'add', text: l.slice(1), bs: false, oi: -1 });
  }
  const o: BodyLine[] = [];
  const n: BodyLine[] = [];
  for (const e of entries) {
    if (e.kind !== 'add') {
      e.oi = o.length;
      o.push(e);
    }
    if (e.kind !== 'del') n.push(e);
  }
  const lastN = n[n.length - 1];
  return { entries, o, n, lastNbs: lastN !== undefined && lastN.bs };
}

/** The lines n writes at a match: a context line is the file's own matched line, and at tier 2 every other line is re-indented (section 5). */
function buildWritten(fileLines: string[], pos: number, o: BodyLine[], n: BodyLine[], tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(fileLines[pos]!);
    p = leadWs(o[0]!.text);
  }
  return n.map((e) => {
    if (e.kind === 'ctx') return fileLines[pos + e.oi]!;
    if (tier !== 2 || e.text.trim() === '') return e.text;
    return e.text.startsWith(p) ? f + e.text.slice(p.length) : e.text;
  });
}

function checkSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

// --- Section 6: unified diffs ----------------------------------------------

interface UHunk {
  a: number;
  entries: BodyLine[];
  o: BodyLine[];
  n: BodyLine[];
  lastNbs: boolean;
}

interface USection {
  gitOld?: string;
  gitNew?: string;
  oldP?: string;
  newP?: string;
  renOld?: string;
  renNew?: string;
  create: boolean;
  del: boolean;
  hunks: UHunk[];
}

function headerPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p !== '/dev/null' && (p.startsWith('a/') || p.startsWith('b/'))) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^a\/(.+) b\/(.+)$/.exec(l.slice('diff --git '.length));
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: USection = { gitOld: m[1]!, gitNew: m[2]!, create: false, del: false, hunks: [] };
      sections.push(sec);
      i = unifiedRest(lines, i + 1, sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: USection = { oldP: headerPath(l), newP: headerPath(lines[i + 1]!), create: false, del: false, hunks: [] };
      sections.push(sec);
      i = unifiedRest(lines, i + 2, sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else i += 1;
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

/** One section's header and hunks, from just after its first line; returns the index of the first line after the section. */
function unifiedRest(lines: string[], i: number, sec: USection): number {
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@') || l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        sec.oldP = headerPath(l);
        sec.newP = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('rename from ')) sec.renOld = l.slice('rename from '.length);
    else if (l.startsWith('rename to ')) sec.renNew = l.slice('rename to '.length);
    else if (l.startsWith('new file mode')) sec.create = true;
    else if (l.startsWith('deleted file mode')) sec.del = true;
    i += 1;
  }
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (!l.startsWith('@@')) {
      i += 1;
      continue;
    }
    const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:\s.*)?$/.exec(l);
    if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
    const a = parseInt(hm[1]!, 10);
    i += 1;
    const body: string[] = [];
    while (i < lines.length) {
      const bl = lines[i]!;
      if (bl.startsWith('diff --git ')) break;
      if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
        body.push(bl);
        i += 1;
      } else break;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    const { entries, o, n, lastNbs } = bodyLists(body);
    sec.hunks.push({ a, entries, o, n, lastNbs });
  }
  return i;
}

function applyUnified(model: FileModel, hunks: UHunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      if (h.n.length > 0) {
        const at = Math.max(0, Math.min(h.a + d, model.lines.length));
        const atEnd = at === model.lines.length;
        model.lines.splice(at, 0, ...h.n.map((e) => e.text));
        if (atEnd) model.final = !h.lastNbs;
      }
    } else {
      const found = findOcc(model.lines, h.o.map((e) => e.text), strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.positions[0]!;
      let best = Math.abs(pos - target);
      for (const p of found.positions) {
        const dd = Math.abs(p - target);
        if (dd < best) {
          best = dd;
          pos = p;
        }
      }
      const written = buildWritten(model.lines, pos, h.o, h.n, found.tier);
      const toEnd = pos + h.o.length === model.lines.length;
      model.lines.splice(pos, h.o.length, ...written);
      if (toEnd) model.final = !h.lastNbs;
    }
    d += h.n.length - h.o.length;
  }
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  const oldRaw = sec.oldP ?? sec.renOld ?? sec.gitOld!;
  const newRaw = sec.newP ?? sec.renNew ?? sec.gitNew!;
  const isCreate = sec.create || oldRaw === '/dev/null';
  const isDelete = sec.del || newRaw === '/dev/null';
  return (tree) => {
    if (isCreate) {
      if (oldRaw !== '/dev/null') checkSafe(oldRaw);
      checkSafe(newRaw);
      if (tree.get(newRaw) !== null) throw new Fail('exists', newRaw);
      const out: string[] = [];
      let lastAddBs = false;
      for (const h of sec.hunks) {
        for (const e of h.entries) {
          if (e.kind === 'add') {
            out.push(e.text);
            lastAddBs = e.bs;
          }
        }
      }
      tree.now.set(newRaw, out.length === 0 ? '' : out.join('\n') + (lastAddBs ? '' : '\n'));
      return;
    }
    if (isDelete) {
      checkSafe(oldRaw);
      if (tree.get(oldRaw) === null) throw new Fail('missing', oldRaw);
      tree.now.set(oldRaw, null);
      return;
    }
    if (oldRaw !== newRaw) {
      checkSafe(oldRaw);
      checkSafe(newRaw);
      const before = tree.get(oldRaw);
      if (before === null) throw new Fail('missing', oldRaw);
      if (tree.get(newRaw) !== null) throw new Fail('exists', newRaw);
      const model = splitFile(before);
      applyUnified(model, sec.hunks, strict, oldRaw);
      tree.now.set(newRaw, joinFile(model));
      tree.now.set(oldRaw, null);
      tree.moves.push([oldRaw, newRaw]);
      return;
    }
    checkSafe(oldRaw);
    const before = tree.get(oldRaw);
    if (before === null) throw new Fail('missing', oldRaw);
    const model = splitFile(before);
    applyUnified(model, sec.hunks, strict, oldRaw);
    tree.now.set(oldRaw, joinFile(model));
  };
}

// --- Section 7: SEARCH/REPLACE blocks ---------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let from = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j >= from; j -= 1) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchAt + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchAt + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchAt + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    from = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    checkSafe(path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = splitFile(before);
    const found = findOcc(model.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const o: BodyLine[] = oldLines.map((t) => ({ kind: 'del', text: t, bs: false, oi: -1 }));
    const n: BodyLine[] = newLines.map((t) => ({ kind: 'add', text: t, bs: false, oi: -1 }));
    const written = buildWritten(model.lines, pos, o, n, found.tier);
    model.lines.splice(pos, oldLines.length, ...written);
    tree.now.set(path, joinFile(model));
  };
}

// --- Section 8: V4A patches --------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: BodyLine[];
  n: BodyLine[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionAt = (idx: number): 'add' | 'del' | 'upd' | null => {
    const l = lines[idx]!;
    if (l.startsWith('*** Add File:')) return 'add';
    if (l.startsWith('*** Delete File:')) return 'del';
    if (l.startsWith('*** Update File:')) return 'upd';
    return null;
  };
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const kind = sectionAt(i);
    if (kind === null) {
      if (blank(lines[i]!)) {
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headAt = i + 1;
    const prefix = kind === 'add' ? '*** Add File:' : kind === 'del' ? '*** Delete File:' : '*** Update File:';
    const path = lines[i]!.slice(prefix.length).trim();
    i += 1;
    const body: { at: number; raw: string }[] = [];
    while (i < last && sectionAt(i) === null) {
      body.push({ at: i + 1, raw: lines[i]! });
      i += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.raw)) body.pop();
    if (kind === 'add') {
      const content: string[] = [];
      for (const b of body) {
        if (b.raw === '') content.push('');
        else if (b.raw.startsWith('+')) content.push(b.raw.slice(1));
        else throw new Exit2(`error: parse ${b.at}`);
      }
      edits.push((tree) => {
        checkSafe(path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
      });
    } else if (kind === 'del') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.at}`);
      edits.push((tree) => {
        checkSafe(path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      edits.push(v4aUpdateEdit(path, body, headAt, strict));
    }
  }
  return edits;
}

function v4aUpdateEdit(path: string, body: { at: number; raw: string }[], headAt: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; raw: string[] } | null = null;
  let firstLine = true;
  const close = (): void => {
    if (cur !== null) {
      const { o, n } = bodyLists(cur.raw);
      chunks.push({ anchor: cur.anchor, eof: cur.eof, o, n });
      cur = null;
    }
  };
  for (const b of body) {
    const l = b.raw;
    if (firstLine && l.startsWith('*** Move to:')) {
      moveTo = l.slice('*** Move to:'.length).trim();
      firstLine = false;
      continue;
    }
    firstLine = false;
    if (l.startsWith('@@')) {
      close();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, raw: [] };
    } else if (l.trim() === '*** End of File') {
      if (cur === null) cur = { anchor: null, eof: true, raw: [] };
      else cur.eof = true;
      close();
    } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${b.at}`);
        cur = { anchor: null, eof: false, raw: [] };
      }
      cur.raw.push(l);
    } else throw new Exit2(`error: parse ${b.at}`);
  }
  close();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headAt}`);
  return (tree) => {
    checkSafe(path);
    if (moveTo !== null) checkSafe(moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(model.lines, ch.anchor, strict, cursor);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        model.lines.splice(at, 0, ...ch.n.map((e) => e.text));
        cursor = at + ch.n.length;
      } else {
        const found = findOcc(model.lines, ch.o.map((e) => e.text), strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.positions[0]!;
        const written = buildWritten(model.lines, pos, ch.o, ch.n, found.tier);
        model.lines.splice(pos, ch.o.length, ...written);
        cursor = pos + written.length;
      }
    }
    const text = joinFile(model);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else tree.now.set(path, text);
  };
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
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? parseUnified(lines, strict)
      : kind === 'search-replace' ? parseSearchReplace(lines, strict)
      : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { p: string; was: string | null; now: string | null }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.push({ p, was, now });
  }
  // A move whose old path is gone and whose new path is new prints as one R line, sorted by the new path (section 2).
  const byPath = new Map(changed.map((c) => [c.p, c]));
  const used = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    const o = byPath.get(oldP);
    const n = byPath.get(newP);
    if (o !== undefined && n !== undefined && o.was !== null && o.now === null && n.was === null && n.now !== null && !used.has(oldP) && !used.has(newP)) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      used.add(oldP);
      used.add(newP);
    }
  }
  for (const c of changed) {
    if (used.has(c.p)) continue;
    rows.push({ key: c.p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${c.p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const c of changed) {
      if (c.now === null) rmSync(c.p, { force: true });
      else {
        mkdirSync(dirname(c.p), { recursive: true });
        writeFileSync(c.p, c.now);
      }
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
