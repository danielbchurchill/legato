import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installAuthFetch } from './auth/session'
import { registerShellWorker } from './pwa/register'
import { holdInstallPrompt } from './pwa/installOffer'
import { ErrorBoundary, RenderError } from './ui/ErrorBoundary'
import { takeLinkReturn } from './connect/legatoLinkReturn'
import { Centered } from './shell/Centered'
import { Button } from './ui/Button'

// Before the first render, so no component's first fetch goes out without
// the owner session's bearer token (issue #112).
installAuthFetch()
// #325: legato.fm's one-time link code, out of the address bar before
// anything renders or reads it.
takeLinkReturn()
// #128: both no-ops in Tauri and in Vite dev; see register.ts. The install
// event has to be claimed before Chrome shows its own banner on load.
holdInstallPrompt()
registerShellWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary
      fallback={(error) => (
        <Centered>
          <RenderError
            title="Legato hit an error and stopped drawing the window."
            error={error}
            action={
              <Button variant="secondary" onClick={() => window.location.reload()}>
                Reload
              </Button>
            }
          />
        </Centered>
      )}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
