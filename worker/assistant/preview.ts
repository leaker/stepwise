// The screenshot the assistant's model looks at. Kept free of runtime imports from @cloudflare/playwright
// so the tests can run it on a Node Playwright context.
import type { BrowserContext } from '@cloudflare/playwright'

/** A smaller copy of a captured screenshot, for the assistant's model to look at. */
export interface Preview {
  /** Base64 JPEG. */
  data: string
  width: number
  height: number
  /** The page was taller than the preview shows. */
  cropped: boolean
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/**
 * Downscale a screenshot in the browser itself (a Worker has no image codec): draw it on a canvas of a
 * blank page. Only the top of a very long page is kept, so the text stays legible at the smaller size.
 */
export async function makePreview(context: BrowserContext, jpeg: Uint8Array): Promise<Preview | undefined> {
  const page = await context.newPage()
  try {
    return await page.evaluate(
      async ({ b64, maxWidth, maxHeight, cropHeight }) => {
        const img = new Image()
        img.src = `data:image/jpeg;base64,${b64}`
        await img.decode()
        const sourceHeight = Math.min(img.naturalHeight, cropHeight)
        const scale = Math.min(1, maxWidth / img.naturalWidth, maxHeight / sourceHeight)
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(sourceHeight * scale))
        canvas.getContext('2d')!.drawImage(img, 0, 0, img.naturalWidth, sourceHeight, 0, 0, canvas.width, canvas.height)
        return { data: canvas.toDataURL('image/jpeg', 0.6).split(',')[1], width: canvas.width, height: canvas.height, cropped: img.naturalHeight > cropHeight }
      },
      { b64: toBase64(jpeg), maxWidth: 1024, maxHeight: 1600, cropHeight: 2400 },
    )
  } catch (e) {
    console.warn('screenshot preview failed', e)
    return undefined
  } finally {
    await page.close().catch(() => {})
  }
}
