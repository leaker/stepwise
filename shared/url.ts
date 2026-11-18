// How a URL written in a step, in the capture dialog or by the assistant becomes the URL that is opened.
// One rule for all of them: the pre-flight checks, the capture and the run engine must agree on the page.

export function parseHttpUrl(text: string): URL | null {
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** Does the text start with a URL scheme (`https:`, `about:`, ...)? */
export const hasScheme = (text: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(text)

/**
 * Absolute http(s) URLs pass through; anything else is appended to the project's base URL, whether or not
 * it starts with a slash: with the base URL https://example.com/app both `login` and `/login` are
 * https://example.com/app/login. A value that starts with two slashes (or backslashes) would name another
 * host, which is never what a path means, so it is not a URL here.
 */
export function resolveUrl(value: string, baseUrl: string): URL | null {
  const text = value.trim()
  if (text === '') return null
  if (hasScheme(text)) return parseHttpUrl(text)
  if (!baseUrl || /^[/\\]{2}/.test(text)) return null
  return parseHttpUrl(baseUrl.replace(/\/+$/, '') + (text.startsWith('/') ? '' : '/') + text)
}

/** The canonical spelling of a URL (lower-case host, default port dropped, `/` for an empty path), or the text itself when it is not one. */
export function canonicalUrl(text: string): string {
  try {
    return new URL(text).href
  } catch {
    return text
  }
}
