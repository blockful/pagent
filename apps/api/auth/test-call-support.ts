export function firstCallArgument<T>(
  calls: readonly (readonly [T, ...unknown[]])[],
  label: string,
): T {
  const call = calls.at(0);
  if (!call) throw new Error(`expected ${label} to be called`);
  return call[0];
}
