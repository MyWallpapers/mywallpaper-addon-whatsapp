import type { CanvasAddonMountContext } from '../generated/mywallpaper-runtime'
import { createNativeClient } from './client'
import { createDemoClient } from './demo'
import { createWidget } from './widget'

export function mount({ layer, runtime }: CanvasAddonMountContext): () => void {
  const thumbnail = runtime.mode === 'thumbnail'
  const client = thumbnail ? createDemoClient() : createNativeClient(layer)
  const widget = createWidget(layer.root, client, {
    settings: layer.settings.get(), deviceSettings: layer.deviceSettings.get(), demo: thumbnail,
  })
  const stopSettings = layer.settings.subscribe(settings => widget.configure({ settings }))
  const stopDevice = layer.deviceSettings.subscribe(deviceSettings => widget.configure({ deviceSettings }))
  let disposed = false
  const cleanup = () => {
    if (disposed) return
    disposed = true
    stopSettings(); stopDevice(); widget.dispose(); client.close()
  }
  const stopDispose = layer.lifecycle.onDispose(cleanup)
  return () => { stopDispose(); cleanup() }
}
