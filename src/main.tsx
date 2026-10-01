import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installAuthFetch } from './auth/session'
import { registerShellWorker } from './pwa/register'

// Before the first render, so no component's first fetch goes out without
// the owner session's bearer token (issue #112).
installAuthFetch()
// #128: a no-op in Tauri and in Vite dev; see register.ts.
registerShellWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
