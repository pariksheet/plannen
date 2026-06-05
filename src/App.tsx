import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { SettingsProvider } from './context/SettingsContext'
import { AppRoutes } from './routes/AppRoutes'
import { BackendBadge } from './components/BackendBadge'
import { InstallPrompt } from './components/InstallPrompt'

export default function App() {
  return (
    <AuthProvider>
      <SettingsProvider>
        <BrowserRouter>
          <AppRoutes />
          <BackendBadge />
          <InstallPrompt />
        </BrowserRouter>
      </SettingsProvider>
    </AuthProvider>
  )
}
