import { Link } from 'react-router-dom'

export function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="text-center max-w-md">
        <h1 className="text-3xl font-bold text-gray-900">Page not found</h1>
        <p className="mt-3 text-sm text-gray-600">
          The page you’re looking for doesn’t exist or has moved.
        </p>
        <Link
          to="/dashboard"
          className="inline-block mt-6 px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 text-sm font-medium"
        >
          Go to dashboard
        </Link>
      </div>
    </div>
  )
}
