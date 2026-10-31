import { createRoot } from 'react-dom/client'
import '@fontsource-variable/newsreader/opsz.css'
import '@fontsource-variable/newsreader/opsz-italic.css'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { App } from './App.tsx'
import { load, flush } from './store.ts'
import { loadSettings } from './ai.ts'
import './styles.css'

// The desktop shell asks for this before it closes the window, so no edit is lost.
;(window as unknown as { __canonFlush: () => Promise<void> }).__canonFlush = flush
if (new URLSearchParams(location.search).has('mac')) document.documentElement.classList.add('mac')

createRoot(document.getElementById('root')!).render(<App />)
load()
loadSettings()
