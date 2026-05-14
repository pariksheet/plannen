import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Menu, X, LogOut, LayoutDashboard, Users, Handshake, UsersRound, Shield, Settings, UserCircle, BookOpen, Puzzle } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { Logo } from './Logo'
import { plugins } from '../plugins'

type View = 'feed' | 'family' | 'friends' | 'groups' | 'stories' | 'settings'

interface NavigationProps {
  currentView: View
  onViewChange: (view: View) => void
  onSignOut: () => void
  onInviteClick: () => void
}

export function Navigation({ currentView, onViewChange, onSignOut, onInviteClick }: NavigationProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const { profile } = useAuth()
  const { hasAiKey } = useSettings()

  useEffect(() => {
    if (mobileMenuOpen) document.body.style.overflow = 'hidden'
    else document.body.style.overflow = 'unset'
    return () => { document.body.style.overflow = 'unset' }
  }, [mobileMenuOpen])

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileMenuOpen(false)
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [])

  const tabs: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
    { id: 'feed', label: 'My Plans', icon: LayoutDashboard },
    { id: 'stories', label: 'My Stories', icon: BookOpen },
    { id: 'family', label: 'My Family', icon: Users },
    { id: 'friends', label: 'My Friends', icon: Handshake },
    { id: 'groups', label: 'My Groups', icon: UsersRound },
  ]

  return (
    <>
      <nav className="bg-white shadow-md h-16 flex items-center justify-between px-4 sm:px-6">
        <Link
          to="/dashboard"
          onClick={() => { onViewChange('feed'); setMobileMenuOpen(false) }}
          className="text-gray-800 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-1 rounded"
          aria-label="Go to home"
        >
          <Logo className="h-7 w-auto" />
        </Link>
        <div className="hidden sm:flex sm:items-center sm:gap-1">
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => onViewChange(id)}
              className={`inline-flex items-center px-3 py-2 rounded-md text-sm font-medium ${
                currentView === id ? 'bg-indigo-100 text-indigo-700' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {label}
            </button>
          ))}
          {plugins.map(plugin => (
            <Link
              key={plugin.route}
              to={plugin.route}
              className="inline-flex items-center px-3 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100"
            >
              {plugin.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {profile && (
            <Link
              to="/profile"
              className="hidden sm:flex items-center gap-2 max-w-[180px] rounded-md px-2 py-1 hover:bg-gray-100"
              title="My Profile"
            >
              <div className="h-9 w-9 rounded-full bg-indigo-50 flex items-center justify-center text-lg">
                <span>{profile.avatar_sticker || '🙂'}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-medium text-gray-900 truncate">
                  {profile.full_name || profile.email || 'You'}
                </span>
              </div>
            </Link>
          )}
          <button
            type="button"
            onClick={() => onViewChange('settings')}
            className={`hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium relative ${
              currentView === 'settings' ? 'bg-indigo-100 text-indigo-700' : 'text-gray-600 hover:bg-gray-100'
            }`}
            title="AI Settings"
          >
            <Settings className="h-3.5 w-3.5" aria-hidden />
            AI
            {!hasAiKey && (
              <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-400" aria-label="API key not configured" />
            )}
          </button>
          <Link
            to="/privacy"
            className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-gray-600 hover:bg-gray-100 text-xs font-medium"
          >
            <Shield className="h-3.5 w-3.5" aria-hidden />
            Privacy
          </Link>
          <button
            type="button"
            onClick={onInviteClick}
            className="hidden sm:inline-flex items-center px-3 py-1.5 rounded-md border border-indigo-600 text-indigo-700 text-xs font-medium hover:bg-indigo-50"
          >
            Invite
          </button>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="sm:hidden p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md text-gray-600 hover:bg-gray-100"
            aria-label="Open menu"
          >
            <Menu className="h-6 w-6" />
          </button>
          <button
            type="button"
            onClick={onSignOut}
            className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md text-gray-600 hover:bg-gray-100"
            aria-label="Sign out"
          >
            <LogOut className="h-5 w-5" />
          </button>
        </div>
      </nav>

      {mobileMenuOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/20 sm:hidden"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden
          />
          <div className="fixed inset-y-0 left-0 z-50 w-full max-w-[85vw] sm:max-w-xs bg-white shadow-xl sm:hidden">
            <div className="flex items-center justify-between h-16 px-4 border-b">
              <span className="font-semibold text-gray-900">Menu</span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-2 rounded-md text-gray-500 hover:bg-gray-100"
                aria-label="Close menu"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="py-2">
              {tabs.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => {
                    onViewChange(id)
                    setMobileMenuOpen(false)
                  }}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left text-sm font-medium ${
                    currentView === id ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <Icon className="h-5 w-5" />
                  {label}
                </button>
              ))}
              {plugins.map(plugin => (
                <Link
                  key={plugin.route}
                  to={plugin.route}
                  onClick={() => setMobileMenuOpen(false)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  <Puzzle className="h-5 w-5" />
                  {plugin.label}
                </Link>
              ))}
              <div className="border-t border-gray-200 mt-2 pt-2 space-y-1">
                <Link
                  to="/profile"
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex items-center gap-3 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  <UserCircle className="h-5 w-5" />
                  My Profile
                </Link>
                <button
                  onClick={() => { onViewChange('settings'); setMobileMenuOpen(false) }}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left text-sm font-medium ${
                    currentView === 'settings' ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <Settings className="h-5 w-5" />
                  AI Settings
                  {!hasAiKey && <span className="ml-auto text-xs text-amber-500">Key not set</span>}
                </button>
                <Link
                  to="/privacy"
                  onClick={() => setMobileMenuOpen(false)}
                  className="flex items-center gap-3 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  <Shield className="h-5 w-5" />
                  Privacy &amp; data
                </Link>
                <button
                  onClick={() => {
                    onInviteClick()
                    setMobileMenuOpen(false)
                  }}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left text-sm font-medium text-indigo-700 hover:bg-indigo-50"
                >
                  Invite to Plannen
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}
