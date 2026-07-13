// Device presets shared by the editor toolbar (MobileSizeControl) and the
// LivePreview device menu. Pure constants — NO store/Vue imports, so the
// live tab's bundle doesn't drag the whole editor store in.
//
// CSS-viewport sizes, portrait for phones/tablets. Values are 2026-current.
export interface MobilePreset {
  id: string
  label: string
  width: number
  height: number
}

export const MOBILE_PRESETS: MobilePreset[] = [
  { id: 'iphone-16-pro-max', label: 'iPhone 16 Pro Max', width: 440, height: 956 },
  { id: 'iphone-16-plus', label: 'iPhone 16 Plus', width: 430, height: 932 },
  { id: 'iphone-16-pro', label: 'iPhone 16 Pro', width: 402, height: 874 },
  { id: 'iphone-16', label: 'iPhone 16 / 15', width: 393, height: 852 },
  { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667 },
  { id: 'galaxy-s24-ultra', label: 'Galaxy S24 Ultra', width: 384, height: 824 },
  { id: 'galaxy-s25', label: 'Galaxy S25', width: 360, height: 800 },
  { id: 'galaxy-a', label: 'Galaxy A', width: 412, height: 915 },
  { id: 'pixel-8', label: 'Pixel 8', width: 412, height: 915 },
]

export const DESKTOP_PRESETS: MobilePreset[] = [
  { id: 'pc-fhd', label: 'PC Full HD', width: 1920, height: 1080 },
  { id: 'pc-hd', label: 'PC HD', width: 1366, height: 768 },
  { id: 'pc-qhd', label: 'PC 2K', width: 2560, height: 1440 },
  { id: 'mac-air', label: 'MacBook Air', width: 1470, height: 956 },
  { id: 'mac-pro-14', label: 'MacBook Pro 14"', width: 1512, height: 982 },
  { id: 'imac', label: 'iMac / Mac', width: 1440, height: 900 },
  { id: 'ipad-pro-13', label: 'iPad Pro 13"', width: 1032, height: 1376 },
  { id: 'ipad-pro-11', label: 'iPad Pro 11"', width: 834, height: 1194 },
  { id: 'ipad', label: 'iPad / iPad Air', width: 820, height: 1180 },
]
