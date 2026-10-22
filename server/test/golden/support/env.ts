/** `undefined` removes the variable; a string sets it. */
export type EnvPatch = Record<string, string | undefined>;

/** Run `fn` with the patch applied to process.env, restoring every touched variable afterwards. */
export async function withEnv<T>(patch: EnvPatch, fn: () => Promise<T> | T): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(patch)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
