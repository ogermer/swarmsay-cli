declare const __SWARMSAY_CLI_VERSION__: string | undefined;

// Replaced at build time from package.json; the fallback is for tests running the sources directly.
export const VERSION: string =
  typeof __SWARMSAY_CLI_VERSION__ === 'string' ? __SWARMSAY_CLI_VERSION__ : '0.5.0';
