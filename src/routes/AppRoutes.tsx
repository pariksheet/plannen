import { Navigate, Routes, Route } from 'react-router-dom'
import { Dashboard } from '../pages/Dashboard'
import { Login } from '../pages/Login'
import { AuthCallback } from '../pages/AuthCallback'
import { InviteJoin } from '../pages/InviteJoin'
import { Privacy } from '../pages/Privacy'
import { ProtectedRoute } from '../components/ProtectedRoute'
import { Onboarding } from '../pages/Onboarding'
import { Profile } from '../pages/Profile'
import { StoryReader } from '../components/StoryReader'

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/invite/:token" element={<InviteJoin />} />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/onboarding"
        element={
          <ProtectedRoute>
            <Onboarding />
          </ProtectedRoute>
        }
      />
      <Route
        path="/profile"
        element={
          <ProtectedRoute>
            <Profile />
          </ProtectedRoute>
        }
      />
      <Route
        path="/stories/:id"
        element={
          <ProtectedRoute>
            <StoryReader />
          </ProtectedRoute>
        }
      />
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  )
}
