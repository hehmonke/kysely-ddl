/**
 * Postgres object names are limited to `NAMEDATALEN - 1` = **63 bytes**.
 * Anything longer is silently truncated, which is more dangerous than it looks:
 * the snapshot remembers the long name, the database holds the short one, and
 * the next diff keeps trying to create the "missing" index forever.
 *
 * Hence two different behaviours:
 *
 *   explicit name  -> an error, so the author sees the problem and shortens it;
 *   auto-name      -> shortened deterministically with a hash suffix, so that
 *                     two long names do not collapse into one.
 */

export const MAX_IDENTIFIER_BYTES = 63;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** FNV-1a: a stable short hash is all that is needed, cryptography is irrelevant here. */
function hash(value: string): string {
  let h = 0x811c9dc5;

  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }

  return h.toString(16).padStart(8, '0');
}

/**
 * Shortens an auto-name to the postgres limit. The hash suffix is computed from
 * the FULL name, so two different long names with a common prefix do not collapse.
 */
export function fitIdentifier(name: string): string {
  if (byteLength(name) <= MAX_IDENTIFIER_BYTES) {
    return name;
  }

  const suffix = `_${hash(name)}`;
  let head = name;

  while (byteLength(head) + suffix.length > MAX_IDENTIFIER_BYTES) {
    head = head.slice(0, -1);
  }

  return `${head.replace(/_+$/, '')}${suffix}`;
}

/** An explicit name is left alone, but exceeding the limit must not pass silently. */
export function assertIdentifier(name: string, what: string): void {
  const length = byteLength(name);

  if (length > MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `${what}: name "${name}" is ${length} bytes long, postgres would truncate it to ` +
        `${MAX_IDENTIFIER_BYTES}. Shorten it or drop it to have it generated.`,
    );
  }

  if (name.length === 0) {
    throw new Error(`${what}: empty name`);
  }
}

/**
 * An auto-name in the `{table}_{columns}_{suffix}` style:
 * `user_resource_transaction_user_id_resource_idx`.
 */
export function autoName(parts: readonly string[], suffix: string): string {
  return fitIdentifier([...parts, suffix].join('_'));
}
