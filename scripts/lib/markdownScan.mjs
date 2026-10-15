/**
 * markdownScan.mjs — a fence-aware CommonMark scanner and the GitHub heading slugger.
 *
 * WHY THIS EXISTS. The documentation checks need three facts about a Markdown file: where its
 * headings are (and the ids GitHub gives them), which links and raw HTML it contains, and which
 * text sits inside code. A line-by-line regex reads all three wrong as soon as a fenced block
 * holds a `#` comment or a `](…)` sample: the old printable builder said so in its own docstring
 * and simply assumed it never happened. This module follows the CommonMark block rules that
 * decide those facts:
 *
 *   - fenced code opens with 3+ backticks or tildes indented 0–3 spaces (relative to the list
 *     item that holds it), and closes only on the same character, at least as long, with nothing
 *     after it; a fence still open at the end of the file is reported, not silently closed;
 *   - a line indented 4+ spaces outside a paragraph is indented code, never a heading;
 *   - blockquote markers and list-item content indentation are containers: a fence inside them
 *     ends when the container does;
 *   - ATX (`#`) and setext (`===` / `---` under a paragraph) headings, with closing `#` runs
 *     stripped; a `---` under a table or a reference definition is a thematic break;
 *   - HTML blocks (CommonMark types 1–7), inside which nothing is a heading;
 *   - inline: code spans (a run of N backticks closed by exactly N), backslash escapes, raw HTML
 *     tags and comments, autolinks, inline / reference / image links, GFM bare URLs.
 *
 * It is not a renderer. It reports what the checks need and nothing more. Every pattern here is
 * anchored or index-scanned and has no nested quantifier (CodeQL security-extended), and tags are
 * found by scanning, never by a regex replacement.
 *
 * The slugger is GitHub's (github-slugger, the same algorithm GitHub uses for `user-content-` ids):
 * lower-case the heading's rendered text, delete every character that is not a letter, mark,
 * decimal digit, letter number (Ⅻ), connector punctuation, zero-width joiner or non-joiner, space
 * or hyphen, turn each space into a hyphen, and suffix repeats `-1`, `-2`, … in document order.
 * Other numbers go: GitHub gives "Fit quality (R²)" the id `fit-quality-r` and "CO₂ ½" `co-`.
 * scripts/build-docs-docx.py carries the Python copy.
 */

const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const isAsciiPunct = (c) => c !== undefined && c !== '' && ASCII_PUNCT.includes(c);
const UNICODE_PUNCT = /^[\p{P}\p{S}]$/u;
const UNICODE_SPACE = /^\s$/u;
const isWs = (c) => c === undefined || c === '' || UNICODE_SPACE.test(c);
const isPunct = (c) => c !== undefined && c !== '' && UNICODE_PUNCT.test(c);
const isAsciiLetter = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
const isAsciiDigit = (c) => c >= '0' && c <= '9';
const isAsciiAlnum = (c) => isAsciiLetter(c) || isAsciiDigit(c);

/* ─────────────────────────────── slugger ─────────────────────────────── */

/**
 * Characters GitHub deletes from a heading's text before it becomes an id: all but letters, marks,
 * decimal digits, letter numbers, connector punctuation, ZWNJ (U+200C), ZWJ (U+200D), hyphen and
 * space. Superscripts, subscripts and fractions (other numbers) are deleted, as GitHub does.
 */
const SLUG_REMOVE = /[^\p{L}\p{M}\p{Nd}\p{Nl}\p{Pc}\u200C\u200D\- ]/gu;

/** GitHub's base slug for a heading's rendered text (no duplicate suffix). */
export function githubSlug(text) {
  return String(text).toLowerCase().replace(SLUG_REMOVE, '').replaceAll(' ', '-');
}

/**
 * A per-document slugger: the first heading with a given base slug gets it unchanged, the next
 * `-1`, then `-2`, and a suffixed form never collides with a slug already handed out
 * (github-slugger's loop).
 */
export function createSlugger() {
  const occurrences = new Map();
  return (text) => {
    const base = githubSlug(text);
    let result = base;
    while (occurrences.has(result)) {
      const n = occurrences.get(base) + 1;
      occurrences.set(base, n);
      result = `${base}-${n}`;
    }
    occurrences.set(result, 0);
    return result;
  };
}

/* ─────────────────────────────── entities ─────────────────────────────── */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', bull: '•', middot: '·', times: '×', divide: '÷',
  deg: '°', plusmn: '±', micro: 'µ', para: '¶', sect: '§', larr: '←',
  rarr: '→', uarr: '↑', darr: '↓', harr: '↔', le: '≤', ge: '≥',
  ne: '≠', asymp: '≈', minus: '−', eacute: 'é', egrave: 'è', aacute: 'á',
  iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü', ouml: 'ö',
  auml: 'ä', ccedil: 'ç', shy: '­', zwj: '‍', zwnj: '‌',
};

/** Decode HTML entities by index scanning (named ones from a small table, numeric ones all). */
export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf('&', i);
    if (amp < 0) { out += s.slice(i); break; }
    out += s.slice(i, amp);
    const semi = s.indexOf(';', amp + 1);
    if (semi < 0 || semi - amp > 33) { out += '&'; i = amp + 1; continue; }
    const body = s.slice(amp + 1, semi);
    let decoded = null;
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const hex = body.slice(2);
      if (hex.length >= 1 && hex.length <= 6 && /^[0-9A-Fa-f]+$/.test(hex)) decoded = codePoint(parseInt(hex, 16));
    } else if (body.startsWith('#')) {
      const dec = body.slice(1);
      if (dec.length >= 1 && dec.length <= 7 && /^[0-9]+$/.test(dec)) decoded = codePoint(parseInt(dec, 10));
    } else if (Object.hasOwn(NAMED_ENTITIES, body)) {
      decoded = NAMED_ENTITIES[body];
    }
    if (decoded === null) { out += '&'; i = amp + 1; continue; }
    out += decoded;
    i = semi + 1;
  }
  return out;
}

function codePoint(n) {
  if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '�';
  return String.fromCodePoint(n);
}

/** Process backslash escapes (ASCII punctuation only, as CommonMark does). */
export function unescapeMarkdown(s) {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && isAsciiPunct(s[i + 1])) { out += s[i + 1]; i++; continue; }
    out += s[i];
  }
  return out;
}

/* ─────────────────────────────── inline: tags and autolinks ─────────────────────────────── */

const TAG_NAME_CHAR = (c) => isAsciiAlnum(c) || c === '-';
const ATTR_START = (c) => isAsciiLetter(c) || c === '_' || c === ':';
const ATTR_CHAR = (c) => isAsciiAlnum(c) || c === '_' || c === '.' || c === ':' || c === '-';
const HTML_WS = (c) => c === ' ' || c === '\t' || c === '\n';

/**
 * Try to read a raw HTML construct starting at `s[i] === '<'` (CommonMark §6.6).
 * Returns `{ end, tag, close, comment }` or null. `tag` is lower-case; a comment is tag `!--`.
 */
export function readHtmlTag(s, i) {
  if (s[i] !== '<') return null;
  const c1 = s[i + 1];
  if (c1 === '!' && s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return { end: i + 5, tag: '!--', close: false, comment: true };
    if (s.startsWith('<!--->', i)) return { end: i + 6, tag: '!--', close: false, comment: true };
    const close = s.indexOf('-->', i + 4);
    return close < 0 ? null : { end: close + 3, tag: '!--', close: false, comment: true };
  }
  if (c1 === '!' && s.startsWith('<![CDATA[', i)) {
    const close = s.indexOf(']]>', i + 9);
    return close < 0 ? null : { end: close + 3, tag: '![cdata[', close: false, comment: false };
  }
  if (c1 === '!' && isAsciiLetter(s[i + 2])) {
    const close = s.indexOf('>', i + 2);
    return close < 0 ? null : { end: close + 1, tag: '!' + s.slice(i + 2, close).split(/\s/, 1)[0].toLowerCase(), close: false, comment: false };
  }
  if (c1 === '?') {
    const close = s.indexOf('?>', i + 2);
    return close < 0 ? null : { end: close + 2, tag: '?', close: false, comment: false };
  }
  let j = i + 1;
  let close = false;
  if (s[j] === '/') { close = true; j++; }
  if (!isAsciiLetter(s[j])) return null;
  const nameStart = j;
  while (j < s.length && TAG_NAME_CHAR(s[j])) j++;
  const tag = s.slice(nameStart, j).toLowerCase();
  if (close) {
    while (HTML_WS(s[j])) j++;
    return s[j] === '>' ? { end: j + 1, tag, close: true, comment: false } : null;
  }
  // attributes: whitespace+ name (ws* = ws* value)?
  for (;;) {
    const wsStart = j;
    while (HTML_WS(s[j])) j++;
    if (s[j] === '>') return { end: j + 1, tag, close: false, comment: false };
    if (s[j] === '/' && s[j + 1] === '>') return { end: j + 2, tag, close: false, comment: false };
    if (j === wsStart || !ATTR_START(s[j])) return null;
    while (j < s.length && ATTR_CHAR(s[j])) j++;
    let k = j;
    while (HTML_WS(s[k])) k++;
    if (s[k] !== '=') continue;
    k++;
    while (HTML_WS(s[k])) k++;
    const q = s[k];
    if (q === '"' || q === "'") {
      const endQ = s.indexOf(q, k + 1);
      if (endQ < 0) return null;
      j = endQ + 1;
    } else {
      const vStart = k;
      while (k < s.length && !' \t\n"\'=<>`'.includes(s[k])) k++;
      if (k === vStart) return null;
      j = k;
    }
  }
}

/** Try to read an autolink `<scheme:…>` or `<user@host>` at `s[i] === '<'`. */
export function readAutolink(s, i) {
  if (s[i] !== '<') return null;
  const close = s.indexOf('>', i + 1);
  if (close < 0) return null;
  const body = s.slice(i + 1, close);
  if (body.length === 0) return null;
  for (const ch of body) {
    if (ch === ' ' || ch === '<' || ch.charCodeAt(0) <= 0x20) return null;
  }
  const colon = body.indexOf(':');
  if (colon >= 2 && colon <= 32 && isAsciiLetter(body[0])) {
    let ok = true;
    for (let k = 1; k < colon; k++) {
      const c = body[k];
      if (!(isAsciiAlnum(c) || c === '+' || c === '.' || c === '-')) { ok = false; break; }
    }
    if (ok) return { end: close + 1, url: body, email: false };
  }
  const at = body.indexOf('@');
  if (at > 0 && at < body.length - 1 && body.indexOf('@', at + 1) < 0 && !body.includes('\\')) {
    return { end: close + 1, url: `mailto:${body}`, email: true };
  }
  return null;
}

/* ─────────────────────────────── inline: tokenizer ─────────────────────────────── */

/** Stands in for masked constructs: a private-use character no document text contains. */
const MASK = '\ue000';

/**
 * Pass 1 over one inline chunk: code spans, escapes, autolinks and raw HTML, in CommonMark
 * precedence (leftmost wins; backslash escapes do not apply inside code). Returns the tokens and
 * a same-length copy of the text with those constructs masked so bracket matching cannot see
 * into them.
 */
function tokenizeInline(text) {
  const tokens = [];
  let masked = '';
  let i = 0;
  let textStart = 0;
  const flushText = (end) => {
    if (end > textStart) {
      tokens.push({ type: 'text', start: textStart, end });
      masked += text.slice(textStart, end);
    }
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && isAsciiPunct(text[i + 1])) {
      flushText(i);
      tokens.push({ type: 'escape', start: i, end: i + 2, ch: text[i + 1] });
      masked += MASK + MASK;
      i += 2;
      textStart = i;
      continue;
    }
    if (c === '`') {
      let n = 0;
      while (text[i + n] === '`') n++;
      // find a closing run of exactly n backticks
      let j = i + n;
      let closeAt = -1;
      while (j < text.length) {
        const k = text.indexOf('`', j);
        if (k < 0) break;
        let m = 0;
        while (text[k + m] === '`') m++;
        if (m === n) { closeAt = k; break; }
        j = k + m;
      }
      if (closeAt < 0) { i += n; continue; }
      flushText(i);
      let content = text.slice(i + n, closeAt).replaceAll('\n', ' ');
      if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      tokens.push({ type: 'code', start: i, end: closeAt + n, content });
      masked += MASK.repeat(closeAt + n - i);
      i = closeAt + n;
      textStart = i;
      continue;
    }
    if (c === '<') {
      const auto = readAutolink(text, i);
      if (auto) {
        flushText(i);
        tokens.push({ type: 'autolink', start: i, end: auto.end, url: auto.url });
        masked += MASK.repeat(auto.end - i);
        i = auto.end;
        textStart = i;
        continue;
      }
      const tag = readHtmlTag(text, i);
      if (tag) {
        flushText(i);
        tokens.push({ type: 'html', start: i, end: tag.end, tag: tag.tag, close: tag.close, comment: tag.comment, raw: text.slice(i, tag.end) });
        masked += MASK.repeat(tag.end - i);
        i = tag.end;
        textStart = i;
        continue;
      }
    }
    i++;
  }
  flushText(text.length);
  return { tokens, masked };
}

/** Normalise a link label for matching definitions (case-fold, collapse whitespace). */
export function normalizeLabel(label) {
  return label.trim().split(/\s+/).join(' ').toLowerCase();
}

/**
 * Read an inline link destination and optional title starting just after `(` at text[i]. Read
 * from the raw text: the destination is parsed before anything after it, so `<b c.md>` here is
 * a destination, not an HTML tag. Returns `{ dest, end }` (end = index after `)`) or null.
 */
function readInlineDest(text, i) {
  const ws = (c) => c === ' ' || c === '\t' || c === '\n';
  let j = i;
  while (j < text.length && ws(text[j])) j++;
  let dest = '';
  if (text[j] === '<') {
    let k = j + 1;
    while (k < text.length && text[k] !== '>') {
      if (text[k] === '\n' || text[k] === '<') return null;
      if (text[k] === '\\' && isAsciiPunct(text[k + 1])) k++;
      k++;
    }
    if (text[k] !== '>') return null;
    dest = text.slice(j + 1, k);
    j = k + 1;
  } else {
    let depth = 0;
    const start = j;
    while (j < text.length) {
      const c = text[j];
      if (c === '\\' && isAsciiPunct(text[j + 1])) { j += 2; continue; }
      if (ws(c) || c.charCodeAt(0) < 0x20) break;
      if (c === '(') depth++;
      if (c === ')') { if (depth === 0) break; depth--; }
      j++;
    }
    if (depth !== 0) return null;
    dest = text.slice(start, j);
  }
  while (j < text.length && ws(text[j])) j++;
  const q = text[j];
  if (q === '"' || q === "'" || q === '(') {
    const closer = q === '(' ? ')' : q;
    let k = j + 1;
    while (k < text.length && text[k] !== closer) {
      if (text[k] === '\\' && isAsciiPunct(text[k + 1])) k++;
      k++;
    }
    if (k >= text.length) return null;
    j = k + 1;
    while (j < text.length && ws(text[j])) j++;
  }
  if (text[j] !== ')') return null;
  return { dest: decodeEntities(unescapeMarkdown(dest)), end: j + 1 };
}

/** Find the `]` matching the `[` at masked[open] (nesting-aware), or -1. */
function matchBracket(masked, open) {
  let depth = 0;
  for (let j = open; j < masked.length; j++) {
    const c = masked[j];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/**
 * Pass 2: links and images, from the masked text. Each result is
 * `{ start, end, textStart, textEnd, image, kind, dest, label }`.
 */
function findLinks(text, masked, definitions, from = 0, to = masked.length) {
  const links = [];
  let i = from;
  // an image inside a link's text ([![alt](src)](href)) is still an image
  const pushWithImages = (link) => {
    links.push(link);
    for (const inner of findLinks(text, masked, definitions, link.textStart, link.textEnd)) {
      if (inner.image) links.push(inner);
    }
  };
  while (i < to) {
    const open = masked.indexOf('[', i);
    if (open < 0 || open >= to) break;
    const image = open > 0 && masked[open - 1] === '!';
    const close = matchBracket(masked, open);
    if (close < 0 || close >= to) { i = open + 1; continue; }
    const start = image ? open - 1 : open;
    const label = text.slice(open + 1, close);
    if (masked[close + 1] === '(') {
      const d = readInlineDest(text, close + 2);
      if (d && d.end <= to) {
        pushWithImages({ start, end: d.end, textStart: open + 1, textEnd: close, image, kind: 'inline', dest: d.dest, label });
        i = d.end;
        continue;
      }
    }
    if (masked[close + 1] === '[') {
      const refClose = masked.indexOf(']', close + 2);
      if (refClose > 0 && refClose < to) {
        const refLabel = text.slice(close + 2, refClose);
        const key = normalizeLabel(refLabel === '' ? label : refLabel);
        if (definitions.has(key)) {
          pushWithImages({ start, end: refClose + 1, textStart: open + 1, textEnd: close, image, kind: 'reference', dest: definitions.get(key), label });
          i = refClose + 1;
          continue;
        }
      }
    }
    const key = normalizeLabel(label);
    if (key !== '' && definitions.has(key) && close < to) {
      pushWithImages({ start, end: close + 1, textStart: open + 1, textEnd: close, image, kind: 'reference', dest: definitions.get(key), label });
      i = close + 1;
      continue;
    }
    i = open + 1;
  }
  return links;
}

const BARE_TRAIL = '?!.,:*_~\'"';

/** Pass 3: GFM extended autolinks (bare `https://…`, `http://…`, `www.…`) outside links and code. */
function findBareUrls(text, masked) {
  const out = [];
  let i = 0;
  while (i < masked.length) {
    const h = masked.indexOf('http', i);
    const w = masked.indexOf('www.', i);
    let at = -1;
    if (h >= 0 && (w < 0 || h <= w)) at = h; else at = w;
    if (at < 0) break;
    const prev = masked[at - 1];
    const okPrev = at === 0 || prev === ' ' || prev === '\t' || prev === '\n' || prev === '*' || prev === '_' || prev === '~' || prev === '(';
    const isScheme = masked.startsWith('https://', at) || masked.startsWith('http://', at);
    const isWww = masked.startsWith('www.', at);
    if (!okPrev || !(isScheme || isWww)) { i = at + 1; continue; }
    let j = at;
    while (j < masked.length && masked[j] !== ' ' && masked[j] !== '\t' && masked[j] !== '\n' && masked[j] !== '<' && masked[j] !== MASK) j++;
    let end = j;
    for (;;) {
      const c = text[end - 1];
      if (BARE_TRAIL.includes(c)) { end--; continue; }
      if (c === ')') {
        const seg = text.slice(at, end);
        let opens = 0; let closes = 0;
        for (const ch of seg) { if (ch === '(') opens++; else if (ch === ')') closes++; }
        if (closes > opens) { end--; continue; }
      }
      break;
    }
    const url = text.slice(at, end);
    if (url.length > (isWww ? 4 : 8)) out.push({ start: at, end, url: isWww ? `http://${url}` : url });
    i = Math.max(j, at + 1);
  }
  return out;
}

/** Strip paired emphasis / strikethrough delimiter runs (`*`, `_`, `~`) by CommonMark flanking. */
function stripEmphasis(s) {
  const runs = [];
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '*' || c === '_' || c === '~') {
      let n = 0;
      while (s[i + n] === c) n++;
      const prev = s[i - 1];
      const next = s[i + n];
      const left = !isWs(next) && (!isPunct(next) || isWs(prev) || isPunct(prev));
      const right = !isWs(prev) && (!isPunct(prev) || isWs(next) || isPunct(next));
      let canOpen = left;
      let canClose = right;
      if (c === '_') {
        canOpen = left && (!right || isPunct(prev));
        canClose = right && (!left || isPunct(next));
      }
      runs.push({ c, i, n, canOpen, canClose, remove: 0 });
      i += n;
    } else {
      i++;
    }
  }
  const stack = [];
  for (const r of runs) {
    if (r.canClose) {
      for (let k = stack.length - 1; k >= 0; k--) {
        const o = stack[k];
        if (o.c !== r.c) continue;
        const used = Math.min(o.n - o.remove, r.n - r.remove);
        if (used <= 0) continue;
        o.remove += used;
        r.remove += used;
        stack.length = k;
        break;
      }
    }
    if (r.canOpen && r.remove < r.n) stack.push(r);
  }
  let out = '';
  let last = 0;
  for (const r of runs) {
    if (r.remove === 0) continue;
    out += s.slice(last, r.i) + r.c.repeat(r.n - r.remove);
    last = r.i + r.n;
  }
  return out + s.slice(last);
}

/** Parse one inline chunk (a paragraph, heading or table row): tokens, links and bare URLs. */
export function parseInline(text, definitions = new Map()) {
  const { tokens: all, masked } = tokenizeInline(text);
  const links = findLinks(text, masked, definitions);
  // a construct inside a link destination (`[a](<b c.md>)`) is part of the destination
  const inDest = (t) => links.some((l) => t.start > l.textEnd && t.end <= l.end);
  const tokens = all.filter((t) => t.type === 'text' || !inDest(t));
  let masked2 = masked;
  for (const l of links) {
    masked2 = masked2.slice(0, l.start) + MASK.repeat(l.end - l.start) + masked2.slice(l.end);
  }
  const bare = findBareUrls(text, masked2);
  return { tokens, links, bare };
}

/** Render the plain text GitHub's heading id is computed from (code, links, escapes, entities). */
export function renderInlineText(text, definitions = new Map()) {
  const { tokens, links } = parseInline(text, definitions);
  const tokenAt = new Map(tokens.filter((t) => t.type !== 'text').map((t) => [t.start, t]));
  const linkAt = new Map(links.map((l) => [l.start, l]));
  const renderRange = (from, to) => {
    let out = '';
    let pending = '';
    const flush = () => { out += stripEmphasis(decodeEntities(pending)); pending = ''; };
    let p = from;
    while (p < to) {
      const link = linkAt.get(p);
      if (link && link.end <= to) {
        flush();
        if (!link.image) out += renderRange(link.textStart, link.textEnd);
        p = link.end;
        continue;
      }
      const t = tokenAt.get(p);
      if (t && t.end <= to) {
        flush();
        if (t.type === 'code') out += t.content;
        else if (t.type === 'escape') out += t.ch;
        else if (t.type === 'autolink') out += text.slice(t.start + 1, t.end - 1);
        // raw HTML contributes no text
        p = t.end;
        continue;
      }
      pending += text[p];
      p++;
    }
    flush();
    return out;
  };
  return renderRange(0, text.length);
}

/* ─────────────────────────────── block scanner ─────────────────────────────── */

const HTML_BLOCK6 = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details '
  + 'dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html '
  + 'iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table '
  + 'tbody td tfoot th thead title tr track ul').split(' '));
const HTML_BLOCK1 = ['script', 'pre', 'style', 'textarea'];

/** Leading indentation in columns (tabs to the next multiple of 4) and the index after it. */
function indentOf(s) {
  let col = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === ' ') col++;
    else if (s[i] === '\t') col += 4 - (col % 4);
    else break;
    i++;
  }
  return { col, idx: i };
}

/** Strip up to `max` blockquote markers; returns the depth found and the rest of the line. */
function stripQuotes(line, max = Infinity) {
  let rest = line;
  let depth = 0;
  while (depth < max) {
    const { col, idx } = indentOf(rest);
    if (col > 3 || rest[idx] !== '>') break;
    rest = rest.slice(idx + 1);
    if (rest[0] === ' ' || rest[0] === '\t') rest = rest.slice(1);
    depth++;
  }
  return { depth, rest };
}

function fenceOpen(content) {
  const c = content[0];
  if (c !== '`' && c !== '~') return null;
  let n = 0;
  while (content[n] === c) n++;
  if (n < 3) return null;
  const info = content.slice(n);
  if (c === '`' && info.includes('`')) return null;
  return { char: c, len: n, info: info.trim() };
}

function isFenceClose(content, fence) {
  let n = 0;
  while (content[n] === fence.char) n++;
  if (n < fence.len) return false;
  return content.slice(n).trim() === '';
}

function isThematic(content) {
  const c = content[0];
  if (c !== '*' && c !== '-' && c !== '_') return false;
  let n = 0;
  for (const ch of content) {
    if (ch === c) n++;
    else if (ch !== ' ' && ch !== '\t') return false;
  }
  return n >= 3;
}

function atxHeading(content) {
  let n = 0;
  while (content[n] === '#') n++;
  if (n < 1 || n > 6) return null;
  const after = content[n];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  let text = content.slice(n).trim();
  // closing sequence: a run of # preceded by a space or tab (or the whole text)
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  if (end === 0) text = '';
  else if (end < text.length && (text[end - 1] === ' ' || text[end - 1] === '\t')) text = text.slice(0, end).trim();
  return { level: n, text };
}

function setextLevel(content) {
  const c = content[0];
  if (c !== '=' && c !== '-') return 0;
  let i = 0;
  while (content[i] === c) i++;
  if (content.slice(i).trim() !== '') return 0;
  return c === '=' ? 1 : 2;
}

function listMarker(content) {
  const c = content[0];
  let w = 0;
  if (c === '-' || c === '+' || c === '*') w = 1;
  else {
    while (w < 9 && isAsciiDigit(content[w])) w++;
    if (w === 0 || (content[w] !== '.' && content[w] !== ')')) return null;
    w++;
  }
  const after = content[w];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  return w;
}

/** HTML block start (CommonMark §4.6): `{ type, end }` where end is a marker or 'blank'. */
function htmlBlockStart(content, paraOpen) {
  if (content[0] !== '<') return null;
  const lower = content.toLowerCase();
  for (const t of HTML_BLOCK1) {
    if (lower.startsWith(`<${t}`)) {
      const after = lower[t.length + 1];
      if (after === undefined || after === ' ' || after === '\t' || after === '>') return { type: 1, end: `</${t}>` };
    }
  }
  if (content.startsWith('<!--')) return { type: 2, end: '-->' };
  if (content.startsWith('<?')) return { type: 3, end: '?>' };
  if (content.startsWith('<![CDATA[')) return { type: 5, end: ']]>' };
  if (content.startsWith('<!') && isAsciiLetter(content[2])) return { type: 4, end: '>' };
  let j = 1;
  if (content[j] === '/') j++;
  const ns = j;
  while (j < content.length && TAG_NAME_CHAR(content[j])) j++;
  const name = lower.slice(ns, j);
  if (name && HTML_BLOCK6.has(name)) {
    const after = content[j];
    if (after === undefined || after === ' ' || after === '\t' || after === '>' || content.startsWith('/>', j)) return { type: 6, end: 'blank' };
  }
  if (!paraOpen) {
    const tag = readHtmlTag(content, 0);
    if (tag && !tag.comment && tag.tag[0] !== '!' && tag.tag !== '?' && content.slice(tag.end).trim() === '' && !HTML_BLOCK1.includes(tag.tag)) {
      return { type: 7, end: 'blank' };
    }
  }
  return null;
}

/** A GFM table delimiter row (`| --- | :-: |`), checked by splitting, not by one regex. */
export function isDelimiterRow(content) {
  const t = content.trim();
  if (!t.includes('-')) return false;
  let cells = t.split('|');
  if (cells[0].trim() === '') cells = cells.slice(1);
  if (cells.length && cells[cells.length - 1].trim() === '') cells = cells.slice(0, -1);
  if (cells.length === 0) return false;
  if (cells.length === 1 && !t.includes('|')) return false;
  return cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

/** Parse a reference definition `[label]: dest "title"` at the start of a line, or null. */
function readDefinition(content) {
  if (content[0] !== '[') return null;
  let j = 1;
  while (j < content.length && content[j] !== ']') {
    if (content[j] === '[') return null;
    if (content[j] === '\\') j++;
    j++;
  }
  if (content[j] !== ']' || content[j + 1] !== ':' || j === 1 || j > 1000) return null;
  const label = content.slice(1, j);
  let k = j + 2;
  while (content[k] === ' ' || content[k] === '\t') k++;
  let dest;
  if (content[k] === '<') {
    const close = content.indexOf('>', k + 1);
    if (close < 0) return null;
    dest = content.slice(k + 1, close);
    k = close + 1;
  } else {
    const s = k;
    while (k < content.length && content[k] !== ' ' && content[k] !== '\t') k++;
    dest = content.slice(s, k);
    if (dest === '') return null;
  }
  const rest = content.slice(k).trim();
  if (rest !== '') {
    const q = rest[0];
    const closer = q === '(' ? ')' : q;
    if (!(q === '"' || q === "'" || q === '(') || rest[rest.length - 1] !== closer || rest.length < 2) return null;
  }
  return { label: normalizeLabel(label), dest: decodeEntities(unescapeMarkdown(dest)) };
}

/**
 * Scan a Markdown document. Returns:
 *   headings:    [{ line, level, raw, text, base, slug, setext }]  (text = rendered, slug deduped)
 *   links:       [{ line, col, kind, image, dest }]  kind ∈ inline | reference | definition | autolink | bare
 *   html:        [{ line, tag, close, comment, raw }]  raw HTML outside code (inline and HTML blocks)
 *   codeSpans:   [{ line, content }]  inline code outside fenced / indented code
 *   paragraphs:  [{ line, text }]  first line of every paragraph (list-item and quote paragraphs too)
 *   tables:      [{ line, rows: [{ line, text }] }]  GFM tables (row 0 header, row 1 delimiter)
 *   fences:      [{ open, close, char, len, info }]  close = null when still open at EOF
 *   unclosedFence: the line of a fence still open at end of file, else null
 *   lineKinds:   per-line kind: blank para heading setext fence-open fence-body fence-close html code hr
 *   lineStarts:  byte-agnostic string offsets of each line start (for slicing sections)
 */
export function scanMarkdown(src) {
  const lines = src.split('\n');
  const lineStarts = [];
  { let off = 0; for (const l of lines) { lineStarts.push(off); off += l.length + 1; } }
  const lineKinds = new Array(lines.length).fill('para');
  const fences = [];
  const blocks = []; // inline chunks: { kind: 'para'|'heading'|'row', text, line, lineMap, level?, setext? }
  const definitions = new Map();
  const defLinks = [];
  const htmlBlockLines = [];
  const paragraphs = [];

  let fence = null; // { char, len, depth, base, open }
  let html = null; // { end, depth }
  let para = null; // { kind: 'para'|'table'|'def', depth, listDepth, lines: [{ text, line }] }
  const lists = [];
  let inCode = false;

  const tables = [];
  const closePara = () => {
    if (!para) return;
    if (para.kind === 'table') {
      tables.push({ line: para.lines[0].line, rows: para.lines.map((l) => ({ line: l.line, text: l.text })) });
      for (const l of para.lines) blocks.push({ kind: 'row', text: l.text.replaceAll('\\|', '|'), line: l.line, lineMap: [l.line] });
    } else if (para.lines.length) {
      blocks.push({ kind: 'para', text: para.lines.map((l) => l.text).join('\n'), line: para.lines[0].line, lineMap: para.lines.map((l) => l.line) });
    }
    para = null;
  };

  for (let n = 0; n < lines.length; n++) {
    const lineNo = n + 1;
    const raw = lines[n];

    if (fence) {
      const q = stripQuotes(raw, fence.depth);
      if (q.depth < fence.depth) {
        fences.at(-1).close = lineNo - 1;
        fence = null;
      } else {
        const { col, idx } = indentOf(q.rest);
        const content = q.rest.slice(idx);
        if (content !== '' && col < fence.base) {
          fences.at(-1).close = lineNo - 1;
          fence = null;
        } else {
          if (col - fence.base <= 3 && isFenceClose(content, fence)) {
            lineKinds[n] = 'fence-close';
            fences.at(-1).close = lineNo;
            fence = null;
          } else {
            lineKinds[n] = 'fence-body';
          }
          continue;
        }
      }
    }

    const { depth, rest } = stripQuotes(raw);

    if (html) {
      if (html.end === 'blank') {
        if (rest.trim() === '') { html = null; lineKinds[n] = 'blank'; continue; }
        lineKinds[n] = 'html';
        htmlBlockLines.push({ text: rest, line: lineNo });
        continue;
      }
      lineKinds[n] = 'html';
      htmlBlockLines.push({ text: rest, line: lineNo });
      if (rest.toLowerCase().includes(html.end)) html = null;
      continue;
    }

    if (rest.trim() === '') {
      closePara();
      lineKinds[n] = inCode ? 'code' : 'blank';
      continue;
    }

    let { col: indent, idx } = indentOf(rest);
    let content = rest.slice(idx);

    // lazy paragraph continuation: an un-indented (or less-quoted) line that starts no block
    const startsBlock = (c) => fenceOpen(c) || atxHeading(c) || isThematic(c) || listMarker(c) !== null
      || htmlBlockStart(c, true) || c[0] === '>';
    if (para && para.kind !== 'table' && (depth < para.depth || indent < (lists.at(-1) ?? 0)) && !startsBlock(content) && indent < 4 + (lists.at(-1) ?? 0)) {
      if (depth <= para.depth) {
        para.lines.push({ text: content, line: lineNo });
        lineKinds[n] = 'para';
        continue;
      }
    }

    if (para && depth !== para.depth) closePara();
    while (lists.length && indent < lists.at(-1)) lists.pop();
    if (para && para.listDepth > lists.length) closePara();

    let base = lists.at(-1) ?? 0;
    inCode = false;
    for (;;) {
      const rel = indent - base;
      if (rel >= 4) {
        if (para && para.kind !== 'table') {
          para.lines.push({ text: content, line: lineNo });
          lineKinds[n] = 'para';
        } else {
          closePara();
          lineKinds[n] = 'code';
          inCode = true;
        }
        break;
      }
      const f = fenceOpen(content);
      if (f) {
        closePara();
        fence = { ...f, depth, base };
        fences.push({ open: lineNo, close: null, char: f.char, len: f.len, info: f.info });
        lineKinds[n] = 'fence-open';
        break;
      }
      const h = atxHeading(content);
      if (h) {
        closePara();
        blocks.push({ kind: 'heading', text: h.text, line: lineNo, lineMap: [lineNo], level: h.level, setext: false });
        lineKinds[n] = 'heading';
        break;
      }
      const sl = setextLevel(content);
      if (sl && para && para.kind === 'para' && para.lines.length && para.depth === depth && para.listDepth === lists.length) {
        const text = para.lines.map((l) => l.text.trim()).join('\n');
        const first = para.lines[0].line;
        for (const l of para.lines) lineKinds[l.line - 1] = 'heading';
        paragraphs.pop();
        para = null;
        blocks.push({ kind: 'heading', text, line: first, lineMap: [first], level: sl, setext: true });
        lineKinds[n] = 'setext';
        break;
      }
      if (isThematic(content)) {
        closePara();
        lineKinds[n] = 'hr';
        break;
      }
      const hb = htmlBlockStart(content, !!para);
      if (hb) {
        closePara();
        lineKinds[n] = 'html';
        htmlBlockLines.push({ text: content, line: lineNo });
        if (hb.end !== 'blank' && !content.toLowerCase().includes(hb.end, hb.type === 2 ? 4 : 1)) html = { end: hb.end, depth };
        else if (hb.end === 'blank') html = { end: 'blank', depth };
        break;
      }
      const lm = listMarker(content);
      // a list item interrupts a paragraph only when it is not empty and, if ordered, starts at 1
      const interrupts = lm !== null && (!para || para.kind === 'table'
        || (content.slice(lm).trim() !== '' && (!isAsciiDigit(content[0]) || Number(content.slice(0, lm - 1)) === 1)));
      if (lm !== null && interrupts) {
        closePara();
        const after = content.slice(lm);
        const sp = indentOf(after);
        const contentIndent = after.trim() === '' || sp.col >= 5 ? indent + lm + 1 : indent + lm + sp.col;
        lists.push(contentIndent);
        base = contentIndent;
        if (after.trim() === '') { lineKinds[n] = 'para'; break; }
        content = after.slice(sp.idx);
        indent = contentIndent;
        continue;
      }
      // paragraph text
      if (para && para.depth === depth && para.kind !== 'def') {
        if (para.kind === 'para' && para.lines.length === 1 && isDelimiterRow(content) && para.lines[0].text.includes('|')) {
          para.kind = 'table';
          if (paragraphs.at(-1)?.line === para.lines[0].line) paragraphs.pop();
        }
        para.lines.push({ text: content, line: lineNo });
        lineKinds[n] = 'para';
        break;
      }
      const def = readDefinition(content);
      if (def && (!para || para.kind === 'def')) {
        if (!definitions.has(def.label)) definitions.set(def.label, def.dest);
        defLinks.push({ line: lineNo, col: 0, kind: 'definition', image: false, dest: def.dest });
        if (!para) para = { kind: 'def', depth, listDepth: lists.length, lines: [] };
        lineKinds[n] = 'para';
        break;
      }
      if (para && para.kind === 'def') para.kind = 'para';
      if (!para) para = { kind: 'para', depth, listDepth: lists.length, lines: [] };
      if (para.lines.length === 0) paragraphs.push({ line: lineNo, text: content });
      para.lines.push({ text: content, line: lineNo });
      lineKinds[n] = 'para';
      break;
    }
  }
  closePara();
  const unclosedFence = fence ? fences.at(-1).open : null;

  // inline pass
  const headings = [];
  const links = [...defLinks];
  const htmlTags = [];
  const codeSpans = [];
  const slug = createSlugger();
  const lineAt = (block, offset) => {
    let nl = 0;
    for (let k = 0; k < offset && k < block.text.length; k++) if (block.text[k] === '\n') nl++;
    return block.lineMap[Math.min(nl, block.lineMap.length - 1)];
  };
  const colAt = (block, offset) => offset - (block.text.lastIndexOf('\n', offset - 1) + 1);
  for (const b of blocks) {
    const { tokens, links: ls, bare } = parseInline(b.text, definitions);
    for (const t of tokens) {
      if (t.type === 'code') codeSpans.push({ line: lineAt(b, t.start), content: t.content });
      else if (t.type === 'html') htmlTags.push({ line: lineAt(b, t.start), tag: t.tag, close: t.close, comment: t.comment, raw: t.raw });
      else if (t.type === 'autolink') links.push({ line: lineAt(b, t.start), col: colAt(b, t.start), kind: 'autolink', image: false, dest: t.url });
    }
    for (const l of ls) links.push({ line: lineAt(b, l.start), col: colAt(b, l.start), kind: l.kind, image: l.image, dest: l.dest });
    for (const u of bare) links.push({ line: lineAt(b, u.start), col: colAt(b, u.start), kind: 'bare', image: false, dest: u.url });
    if (b.kind === 'heading') {
      const text = renderInlineText(b.text, definitions).trim();
      headings.push({ line: b.line, level: b.level, raw: b.text, text, base: githubSlug(text), slug: slug(text), setext: b.setext });
    }
  }
  for (const h of htmlBlockLines) {
    for (let i = h.text.indexOf('<'); i >= 0; i = h.text.indexOf('<', i + 1)) {
      const t = readHtmlTag(h.text, i);
      if (t) htmlTags.push({ line: h.line, tag: t.tag, close: t.close, comment: t.comment, raw: h.text.slice(i, t.end) });
    }
  }
  links.sort((a, b) => a.line - b.line || a.col - b.col);
  htmlTags.sort((a, b) => a.line - b.line);
  return { lines, lineStarts, lineKinds, headings, links, html: htmlTags, codeSpans, paragraphs, fences, unclosedFence, definitions, tables };
}

/** Split a GFM table row into trimmed cells on unescaped pipes (in GFM a code span does not protect a pipe). */
export function splitTableRow(text) {
  const t = text.trim();
  const cells = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' && t[i + 1] === '|') { cur += '\\|'; i++; continue; }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  if (t.startsWith('|')) cells.shift();
  if (cells.length > 1 && t.endsWith('|') && !t.endsWith('\\|')) cells.pop();
  return cells.map((c) => c.trim());
}

/** The GFM tables of a scanned document as `{ line, header: [cell], rows: [{ line, cells }] }`. */
export function readTables(scan) {
  return scan.tables.map((t) => ({
    line: t.line,
    header: splitTableRow(t.rows[0].text),
    rows: t.rows.slice(2).map((r) => ({ line: r.line, cells: splitTableRow(r.text) })),
  }));
}

/**
 * Split a document into sections at every heading (fence-aware). Each section runs from its
 * heading's first line to the next heading's first line; `preamble` is the text before the first
 * heading. `path` is the chain of enclosing headings, e.g. `## 2. X › ### 1. Y`.
 */
export function splitSections(src, scan = scanMarkdown(src)) {
  const { headings, lineStarts } = scan;
  const offsetOf = (line) => lineStarts[line - 1];
  const sections = [];
  const stack = [];
  const firstOffset = headings.length ? offsetOf(headings[0].line) : src.length;
  const preamble = src.slice(0, firstOffset);
  headings.forEach((h, i) => {
    const start = offsetOf(h.line);
    const end = i + 1 < headings.length ? offsetOf(headings[i + 1].line) : src.length;
    while (stack.length && stack.at(-1).level >= h.level) stack.pop();
    stack.push(h);
    sections.push({
      heading: h,
      line: h.line,
      path: stack.map((s) => `${'#'.repeat(s.level)} ${s.raw}`).join(' › '),
      text: src.slice(start, end),
    });
  });
  return { preamble, sections };
}
