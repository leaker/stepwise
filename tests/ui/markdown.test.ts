// The assistant panel's markdown subset, rendered to HTML.
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../src/editor/AssistantPanel'

const html = (source: string) => renderToStaticMarkup(createElement(Fragment, null, renderMarkdown(source)))

describe('assistant markdown', () => {
  it('keeps a list with blank lines between its items as one numbered list', () => {
    expect(html('The test now:\n\n1. Opens the login page\n\n2. Signs in\n\n3. Checks the title\n\nThe run passed.')).toBe(
      '<p>The test now:</p><ol start="1"><li>Opens the login page</li><li>Signs in</li><li>Checks the title</li></ol><p>The run passed.</p>',
    )
    expect(html('- one\n\n- two')).toBe('<ul><li>one</li><li>two</li></ul>')
  })

  it('continues the numbering of a list that was interrupted, and wraps long items', () => {
    expect(html('1. first\n   continued\n\nA remark.\n\n2. second')).toBe('<ol start="1"><li>first continued</li></ol><p>A remark.</p><ol start="2"><li>second</li></ol>')
    expect(html('1. numbered\n- bullet')).toBe('<ol start="1"><li>numbered</li></ol><ul><li>bullet</li></ul>')
  })

  it('renders code blocks, bold and inline code, and shows links as text', () => {
    expect(html('Run:\n```sh\npnpm test\n  --watch\n```\nDone with **care** and `code`.')).toBe('<p>Run:</p><pre><code>pnpm test\n  --watch</code></pre><p>Done with <strong>care</strong> and <code>code</code>.</p>')
    expect(html('See [the docs](https://example.com/a) or [https://example.com](https://example.com).')).toBe('<p>See the docs (https://example.com/a) or https://example.com.</p>')
    expect(html('```\nnever closed')).toBe('<pre>never closed</pre>')
  })
})
