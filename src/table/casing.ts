/**
 * snake_case and camelCase at the type level and at runtime, following the
 * rules of Kysely's `CamelCasePlugin` with default options. This way the names
 * derived from schema properties and the type keys under the plugin match what
 * the plugin does to identifiers and result rows:
 *
 *   createdAt  -> created_at  -> createdAt
 *   appleID    -> apple_id    -> appleId       consecutive capitals are not split
 *   parseJSONValue -> parse_jsonvalue           the boundary after an acronym is lost
 *   line2Total -> line2_total -> line2Total
 *
 * Names with an underscore before a digit (`field_2` -> `field2`) and with a
 * leading underscore do not round-trip, exactly the plugin's own limitations.
 */

type IsUpper<C extends string> = C extends Uppercase<C> ? (C extends Lowercase<C> ? false : true) : false;

type SnakeInner<S extends string, PrevUpper extends boolean, Acc extends string> = S extends `${infer C}${infer R}`
  ? IsUpper<C> extends true
    ? SnakeInner<R, true, `${Acc}${PrevUpper extends true ? '' : '_'}${Lowercase<C>}`>
    : SnakeInner<R, false, `${Acc}${C}`>
  : Acc;

/** `createdAt` -> `created_at`. The first letter is lowercased without an underscore. */
export type SnakeCase<S extends string> = S extends `${infer C}${infer R}` ? SnakeInner<R, IsUpper<C>, Lowercase<C>> : S;

type CamelInner<S extends string, AfterUnderscore extends boolean, Acc extends string> = S extends `${infer C}${infer R}`
  ? C extends '_'
    ? CamelInner<R, true, Acc>
    : CamelInner<R, false, `${Acc}${AfterUnderscore extends true ? Uppercase<C> : C}`>
  : Acc;

/** `created_at` -> `createdAt`. The first character stays as is, like the plugin does. */
export type CamelCase<S extends string> = S extends `${infer C}${infer R}`
  ? CamelInner<R, C extends '_' ? true : false, C>
  : S;

function isUpper(char: string): boolean {
  return char === char.toUpperCase() && char !== char.toLowerCase();
}

/** Runtime counterpart of `SnakeCase`: the same algorithm as `CamelCasePlugin`. */
export function toSnakeCase(input: string): string {
  let out = input.charAt(0).toLowerCase();

  for (let i = 1; i < input.length; i++) {
    const char = input.charAt(i);

    if (isUpper(char)) {
      out += isUpper(input.charAt(i - 1)) ? char.toLowerCase() : `_${char.toLowerCase()}`;
    } else {
      out += char;
    }
  }

  return out;
}

/** Runtime counterpart of `CamelCase`: this is how the plugin renames result row keys. */
export function toCamelCase(input: string): string {
  let out = input.charAt(0);

  for (let i = 1; i < input.length; i++) {
    const char = input.charAt(i);

    if (char === '_') {
      continue;
    }

    out += input.charAt(i - 1) === '_' ? char.toUpperCase() : char;
  }

  return out;
}
