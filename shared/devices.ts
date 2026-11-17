// Device profiles a test case can run on. Phones are emulated in the same Chromium (viewport, user
// agent, touch, pixel ratio); they are not real devices and not native apps.
import type { DeviceId } from './types'

export interface DeviceProfile {
  id: DeviceId
  label: string
  /** CSS pixels. */
  viewport: { width: number; height: number }
  /** Empty: keep the browser's own user agent. */
  userAgent: string
  isMobile: boolean
  hasTouch: boolean
  deviceScaleFactor: number
}

export const DEVICES: Record<DeviceId, DeviceProfile> = {
  desktop: { id: 'desktop', label: 'Desktop', viewport: { width: 1280, height: 800 }, userAgent: '', isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  iphone: {
    id: 'iphone',
    label: 'iPhone 15',
    viewport: { width: 393, height: 852 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  },
  pixel: {
    id: 'pixel',
    label: 'Pixel 8',
    viewport: { width: 412, height: 915 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2.625,
  },
}

export const DEVICE_IDS = Object.keys(DEVICES) as DeviceId[]
export const DEFAULT_DEVICE: DeviceId = 'desktop'

export const isDeviceId = (v: unknown): v is DeviceId => typeof v === 'string' && Object.hasOwn(DEVICES, v)

/** The profile for a stored value; anything unknown (older rows, bad data) is the desktop profile. */
export const deviceOf = (v: unknown): DeviceProfile => DEVICES[isDeviceId(v) ? v : DEFAULT_DEVICE]
