/**
 * A small glob over the filesystem: enough to point at schema files, e.g.
 * `../schema-core/src/lib/tables/**\/*.table.ts`. A dependency of its own for
 * this would be the only runtime dependency of the package, and node's
 * `fs.globSync` arrived in node 22, below the supported floor.
 *
 * Supported: `*` (anything inside one path segment), `**` (any number of
 * directories), `?` (one character), `{a,b}` (alternatives, may span segments)
 * and a leading `!` (exclude). Character classes, `[a-z]`, are not supported and
 * match themselves; a pattern that hits one simply matches nothing, and the
 * caller says so.
 *
 * The rules that are not obvious:
 *
 *   - patterns are resolved against `cwd`, so `..` works and the result is
 *     always an absolute path with `/` separators, on windows too;
 *   - wildcards do not match entries starting with a dot, and `**` does not
 *     descend into `node_modules` or dot-directories: name them explicitly to
 *     reach inside;
 *   - `!` patterns are subtracted from everything the positive ones matched,
 *     whatever the order in the list;
 *   - a directory that cannot be read is skipped, not an error: a missing base
 *     directory is "no match", which the caller reports with the pattern.
 */
import fs from 'node:fs';
import path from 'node:path';

/** `{a,b}` -> a pattern per alternative; nested braces expand recursively. */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');

  if (open === -1) {
    return [pattern];
  }

  let depth = 0;
  let close = -1;

  for (let i = open; i < pattern.length; i += 1) {
    if (pattern[i] === '{') {
      depth += 1;
    } else if (pattern[i] === '}') {
      depth -= 1;

      if (depth === 0) {
        close = i;
        break;
      }
    }
  }

  if (close === -1) {
    // unbalanced: nothing to expand, the brace stays a literal
    return [pattern];
  }

  const before = pattern.slice(0, open);
  const after = pattern.slice(close + 1);
  const alternatives: string[] = [];
  let start = 0;
  depth = 0;

  const body = pattern.slice(open + 1, close);

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      alternatives.push(body.slice(start, i));
      start = i + 1;
    }
  }

  alternatives.push(body.slice(start));

  return alternatives.flatMap(alternative => expandBraces(`${before}${alternative}${after}`));
}

/** One path segment as a regular expression; `*` and `?` stay inside the segment. */
function segmentMatcher(segment: string): RegExp {
  // a wildcard does not match a leading dot: `*` must not pull in `.git`
  let source = segment.startsWith('.') ? '' : '(?!\\.)';

  for (const char of segment) {
    if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }

  return new RegExp(`^${source}$`);
}

const posix = (value: string): string => value.replaceAll('\\', '/');

const join = (dir: string, name: string): string => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`);

type Kind = 'dir' | 'file' | 'other';

/** What an entry is, following symlinks: a symlinked schema directory should work. */
function kindOf(dir: string, entry: fs.Dirent): Kind {
  if (entry.isFile()) {
    return 'file';
  }

  if (entry.isDirectory()) {
    return 'dir';
  }

  if (entry.isSymbolicLink()) {
    const stats = fs.statSync(join(dir, entry.name), { throwIfNoEntry: false });

    if (stats?.isFile() === true) {
      return 'file';
    }

    if (stats?.isDirectory() === true) {
      return 'dir';
    }
  }

  return 'other';
}

/** The real path, for the loop guard; the path itself when it cannot be resolved. */
function realOf(dir: string): string {
  try {
    return posix(fs.realpathSync.native(dir));
  } catch {
    return dir;
  }
}

function readDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // missing, or not a directory, or unreadable: no match, and the caller
    // reports the pattern as a whole
    return [];
  }
}

interface Walk {
  readonly segments: readonly string[];
  readonly out: Set<string>;
  /** Resolved directories already descended into under `**`, so a symlink loop ends. */
  readonly visited: Set<string>;
}

function walk(walker: Walk, dir: string, index: number): void {
  const segment = walker.segments[index];

  if (segment === undefined) {
    return;
  }

  const last = index === walker.segments.length - 1;
  const entries = readDir(dir);

  if (segment === '**') {
    // `**` also matches zero directories
    walk(walker, dir, index + 1);

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.') || kindOf(dir, entry) !== 'dir') {
        continue;
      }

      const child = join(dir, entry.name);
      // by segment as well: the same directory can be reached by two different `**`
      const real = `${index}:${realOf(child)}`;

      if (walker.visited.has(real)) {
        continue;
      }

      walker.visited.add(real);
      walk(walker, child, index);
    }

    return;
  }

  const matches = segmentMatcher(segment);

  for (const entry of entries) {
    if (!matches.test(entry.name)) {
      continue;
    }

    const kind = kindOf(dir, entry);

    if (last) {
      if (kind === 'file') {
        walker.out.add(join(dir, entry.name));
      }
    } else if (kind === 'dir') {
      walk(walker, join(dir, entry.name), index + 1);
    }
  }
}

/** The files one pattern (without the `!`) matches, as absolute `/` paths. */
function matchPattern(pattern: string, cwd: string): Set<string> {
  const out = new Set<string>();

  for (const expanded of expandBraces(pattern)) {
    const absolute = posix(path.resolve(cwd, expanded));
    const root = posix(path.parse(absolute).root);
    const segments = absolute.slice(root.length).split('/').filter(segment => segment !== '');

    if (segments.length === 0) {
      continue;
    }

    // a trailing `**` means everything below, which is `**` followed by a name
    const full = segments.at(-1) === '**' ? [...segments, '*'] : segments;

    walk({ segments: full, out, visited: new Set() }, root, 0);
  }

  return out;
}

/**
 * The files the patterns match: the union of the positive ones minus everything
 * a `!` one matches. Sorted, so that the order does not depend on the
 * filesystem.
 */
export function globFiles(patterns: readonly string[], cwd: string): string[] {
  const found = new Set<string>();
  const excluded = new Set<string>();

  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const matched = matchPattern(negated ? pattern.slice(1) : pattern, cwd);

    for (const file of matched) {
      (negated ? excluded : found).add(file);
    }
  }

  return [...found].filter(file => !excluded.has(file)).toSorted();
}
