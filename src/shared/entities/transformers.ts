/** Postgres returns `numeric` and `bigint` as strings; expose them as numbers in code. */
export const numberTransformer = {
  to: (value: number) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};
