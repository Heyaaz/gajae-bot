/**
 * Set by the Vite config, not by the page.
 *
 * Desktop builds keep the mock backend available as its own chunk so UI work and
 * the unpackaged `--smoke` run can still ask for `?backend=mock`. The web
 * production build sets this false and the chunk is left out of `dist/web`.
 */
declare const __GAJAE_INCLUDE_MOCK__: boolean;
