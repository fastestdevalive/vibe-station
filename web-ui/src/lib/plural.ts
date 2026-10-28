/** `1 file` / `2 files`: the count with the right noun form. */
export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
