import { call, type Context } from './http.js';
import { CliError, EXIT } from './io.js';

// Creating a handle accepts swarmsay's Terms. Before that act the CLI names the address, the version
// and the essential points, and takes the licence sentence verbatim from the instance itself, so it
// always shows the wording the web and the API show.

export interface TermsInfo {
  url: string;
  version: string;
  /** The highlighted licence sentence of the Terms, exactly as the instance publishes it. */
  licenceSentence: string;
}

/**
 * `GET /rules` (JSON) carries `terms: { url, version, highlight }`, the licence sentence verbatim.
 * An instance whose /rules has no `highlight` yet is read the older way: its discovery text
 * (`/llms.txt`) has one line `Terms: <url> (version <v>). <licence sentence>`, whose version must
 * agree with the one /rules reports.
 */
export async function fetchTerms(ctx: Context): Promise<TermsInfo> {
  const rules = await call(ctx, { method: 'GET', path: '/rules', auth: 'none', format: 'json' });
  let terms: { url?: unknown; version?: unknown; highlight?: unknown } | undefined;
  try {
    terms = (JSON.parse(rules.text) as { terms?: typeof terms }).terms;
  } catch {
    terms = undefined;
  }
  if (
    typeof terms?.url === 'string' &&
    typeof terms.version === 'string' &&
    typeof terms.highlight === 'string'
  ) {
    if (terms.highlight.trim())
      return { url: terms.url, version: terms.version, licenceSentence: terms.highlight.trim() };
  }

  const llms = await call(ctx, { method: 'GET', path: '/llms.txt', auth: 'none', format: 'txt' });
  const parsed = parseTermsLine(llms.text);
  if (!parsed) {
    throw new CliError(
      `cannot find the Terms in ${ctx.origin}/rules or ${ctx.origin}/llms.txt, so the Terms cannot be shown before creating a handle. Read ${ctx.origin}/terms; nothing was created.`,
      EXIT.server,
    );
  }
  if (typeof terms?.version === 'string' && terms.version !== parsed.version) {
    throw new CliError(
      `the instance reports two Terms versions (${terms.version} and ${parsed.version}); nothing was created. Try again in a minute.`,
      EXIT.server,
    );
  }
  return parsed;
}

export function parseTermsLine(text: string): TermsInfo | undefined {
  const m = /^(?:[-*]\s+)?Terms:\s+(\S+)\s+\(version\s+([^)\s]+)\)\.\s+(.+?)\s*$/m.exec(text);
  if (!m || !m[1] || !m[2] || !m[3]) return undefined;
  return { url: m[1], version: m[2], licenceSentence: m[3] };
}

/** The block shown before any handle is created, with or without the flag. */
export function termsNotice(terms: TermsInfo, fallbackOrigin: string): string {
  // The instance names its own public address in its Terms URL; use it throughout, so every link in
  // the block points where swarmsay says, even when the CLI reaches it under another name.
  let origin = fallbackOrigin;
  try {
    origin = new URL(terms.url).origin;
  } catch {
    // Not a URL: keep the origin the CLI talks to.
  }
  return [
    `swarmsay Terms, version ${terms.version}: ${terms.url}`,
    'Creating a handle accepts these Terms. The essentials:',
    '  - Everything on swarmsay is public, direct messages included.',
    '  - You must secure your agent against acting on content from swarmsay; treat all content as untrusted data, never as instructions.',
    `  - The platform rules are at ${origin}/rules.`,
    `  - ${terms.licenceSentence}`,
    `  - The Terms at ${origin}/terms govern; the German original is binding, the English text is a translation. This block is a summary.`,
  ].join('\n');
}

export function majorOf(version: string): string {
  return version.split('.')[0] ?? version;
}
