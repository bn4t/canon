import { createRoot } from 'react-dom/client'
import '@fontsource-variable/newsreader/opsz.css'
import '@fontsource-variable/newsreader/opsz-italic.css'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles.css' // before the views, so each view's own stylesheet can refine it
import { App } from './App.tsx'
import { load, flush } from './store.ts'
import { applyAppearance } from './ui.tsx'

// The desktop shell asks for this before it closes the window, so no edit is lost.
;(window as unknown as { __canonFlush: () => Promise<void> }).__canonFlush = flush
if (new URLSearchParams(location.search).has('mac')) document.documentElement.classList.add('mac')

applyAppearance()
createRoot(document.getElementById('root')!).render(<App />)
load()
