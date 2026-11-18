// A short fingerprint of a test case's stored step list. The editor sends back the one it loaded when it
// saves, so a save that was based on an older list (another tab, an approved repair, the assistant) is
// refused instead of silently replacing the newer steps. Other edits (name, device, data) do not change it.

/** cyrb53 over the stored JSON text: fast, synchronous, and wide enough that two versions of one list do not collide by accident. */
export function stepsRevision(storedSteps: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < storedSteps.length; i++) {
    const ch = storedSteps.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36)
}
