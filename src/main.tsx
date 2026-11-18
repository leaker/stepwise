import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/base.css'
import './styles/app.css'
import './styles/editor.css'
import App from './App'

// A lazily loaded route whose file is gone means a new version was deployed while this tab was open (only the
// current build's files are served). Load the new version, once, instead of leaving a broken page.
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'stepwise.reloadedAt'
  let recent = true
  try {
    recent = Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < 10_000
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    /* storage unavailable: do not risk a reload loop */
  }
  if (recent) return
  event.preventDefault()
  location.reload()
})

async function start() {
  // Development aid only: `VITE_MOCK=1 vite` serves the API from an in-browser fake.
  if (import.meta.env.VITE_MOCK) {
    const { installMock } = await import('./mock')
    installMock()
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
void start()
