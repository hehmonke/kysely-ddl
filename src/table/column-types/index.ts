/**
 * One file per column type. The shared modifiers live on `ColumnBuilder` in
 * `../columns.ts`; a modifier that applies to some types only lives on a subclass
 * in the type's file, `defaultNow()` in `timestamp.ts`, `generatedAlwaysAsIdentity()`
 * in `integer.ts`. A new type is a new file here plus a line in `columnBuilders`.
 *
 * `columnBuilders` is what arrives in `columns: t => ({ ... })`. Builders are not
 * exported one by one: the only way to declare a column is the callback. So the
 * schema file has no import list to maintain with every new column, and there is
 * exactly one declaration form.
 */
import { bigint } from './bigint.ts';
import { boolean } from './boolean.ts';
import { enumColumn } from './enum.ts';
import { integer } from './integer.ts';
import { jsonb } from './jsonb.ts';
import { numeric } from './numeric.ts';
import { timestamp } from './timestamp.ts';
import { uuid } from './uuid.ts';
import { varchar } from './varchar.ts';

export const columnBuilders = {
  bigint,
  boolean,
  integer,
  jsonb,
  numeric,
  timestamp,
  enum: enumColumn,
  uuid,
  varchar,
} as const;

export type ColumnBuilders = typeof columnBuilders;
