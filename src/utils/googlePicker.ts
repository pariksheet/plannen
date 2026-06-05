/**
 * Open the legacy Google Picker for Drive image selection.
 * The Photos view in this picker was retired by Google in March 2025;
 * for Photos use the new Photos Picker API via photoPickerService instead.
 */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve()
      return
    }
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.head.appendChild(script)
  })
}

declare global {
  interface Window {
    gapi?: {
      load: (name: string, callback: () => void) => void
    }
    google?: {
      picker: {
        PickerBuilder: new () => {
          addView: (view: unknown) => unknown
          setOAuthToken: (token: string) => unknown
          setDeveloperKey: (key: string) => unknown
          setCallback: (callback: (data: { docs: { id: string; mimeType?: string }[] }) => void) => unknown
          setAppId: (id: string) => unknown
          build: () => { setVisible: (visible: boolean) => void }
        }
        ViewId: { DOCS: string }
        DocsView: new (viewId: string) => { setMimeTypes: (mimes: string) => unknown }
      }
    }
  }
}

const API_SCRIPT = 'https://apis.google.com/js/api.js'
const PICKER_APP_ID = import.meta.env.VITE_GOOGLE_PICKER_APP_ID ?? ''
const DEVELOPER_KEY = import.meta.env.VITE_GOOGLE_API_KEY ?? ''

export async function openGoogleDrivePicker(
  accessToken: string,
  onPick: (items: { id: string; mimeType?: string }[]) => void
): Promise<void> {
  await loadScript(API_SCRIPT)
  const gapi = window.gapi
  if (!gapi) throw new Error('Google API failed to load')
  await new Promise<void>((resolve, reject) => {
    gapi.load('picker', () => {
      if (window.google?.picker) resolve()
      else reject(new Error('Picker failed to load'))
    })
  })
  const picker = window.google?.picker
  if (!picker) throw new Error('Google Picker not available')
  const docsView = new picker.DocsView(picker.ViewId.DOCS)
  ;(docsView as { setMimeTypes?: (m: string) => unknown }).setMimeTypes?.(
    'image/jpeg,image/png,image/gif,image/webp,' +
    'video/mp4,video/quicktime,video/webm,' +
    'audio/mpeg,audio/mp4,audio/x-m4a,audio/wav'
  )
  type PickerBuilderInstance = {
    addView: (v: unknown) => PickerBuilderInstance
    setOAuthToken: (t: string) => PickerBuilderInstance
    setCallback: (cb: (data: { docs: { id: string; mimeType?: string }[] }) => void) => PickerBuilderInstance
    setDeveloperKey: (k: string) => PickerBuilderInstance
    setAppId: (id: string) => PickerBuilderInstance
    build: () => { setVisible: (v: boolean) => void }
  }
  const builder = new picker.PickerBuilder() as unknown as PickerBuilderInstance
  builder
    .addView(docsView)
    .setOAuthToken(accessToken)
    .setCallback((data: { docs: { id: string; mimeType?: string }[] }) => {
      if (data?.docs?.length) onPick(data.docs.map((d) => ({ id: d.id, mimeType: d.mimeType })))
    })
  if (DEVELOPER_KEY) builder.setDeveloperKey(DEVELOPER_KEY)
  if (PICKER_APP_ID) builder.setAppId(PICKER_APP_ID)
  const pickerInstance = builder.build()
  pickerInstance.setVisible(true)
}
