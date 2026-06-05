import { Suspense, lazy } from 'react'
import { Navigate, Routes, Route } from 'react-router-dom'
import { ProtectedRoute } from '../components/ProtectedRoute'

const Dashboard = lazy(() => import('../pages/Dashboard').then((m) => ({ default: m.Dashboard })))
const Login = lazy(() => import('../pages/Login').then((m) => ({ default: m.Login })))
const AuthCallback = lazy(() => import('../pages/AuthCallback').then((m) => ({ default: m.AuthCallback })))
const InviteJoin = lazy(() => import('../pages/InviteJoin').then((m) => ({ default: m.InviteJoin })))
const Privacy = lazy(() => import('../pages/Privacy').then((m) => ({ default: m.Privacy })))
const Onboarding = lazy(() => import('../pages/Onboarding').then((m) => ({ default: m.Onboarding })))
const Profile = lazy(() => import('../pages/Profile').then((m) => ({ default: m.Profile })))
const StoryReader = lazy(() => import('../components/StoryReader').then((m) => ({ default: m.StoryReader })))
const ShareTarget = lazy(() => import('../pages/ShareTarget').then((m) => ({ default: m.ShareTarget })))
const OAuthConsent = lazy(() => import('../pages/OAuthConsent').then((m) => ({ default: m.OAuthConsent })))
const NotFound = lazy(() => import('../pages/NotFound').then((m) => ({ default: m.NotFound })))

function RouteFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center text-gray-500 text-sm">
      Loading…
    </div>
  )
}

export function AppRoutes() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/invite/:token" element={<InviteJoin />} />
        <Route path="/oauth/consent" element={<OAuthConsent />} />
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
        <Route
          path="/share"
          element={
            <ProtectedRoute>
              <ShareTarget />
            </ProtectedRoute>
          }
        />
        <Route path="/" element={<Navigate to={`/dashboard${window.location.search}${window.location.hash}`} replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  )
}
