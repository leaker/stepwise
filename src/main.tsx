import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/base.css'
import './styles/app.css'
import './styles/editor.css'
import App from './App'

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
