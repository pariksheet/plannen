import { Link } from 'react-router-dom'
import { Shield, ArrowLeft } from 'lucide-react'

export function Privacy() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <Link
          to="/dashboard"
          className="inline-flex items-center gap-1.5 text-sm text-indigo-600 hover:text-indigo-700 mb-6"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Plannen
        </Link>

        <div className="flex items-center gap-2 mb-6">
          <Shield className="h-8 w-8 text-indigo-600" aria-hidden />
          <h1 className="text-2xl font-bold text-gray-900">Privacy &amp; data</h1>
        </div>

        {/* In-app short notice (Option A) */}
        <div className="rounded-lg border border-indigo-200 bg-indigo-50/80 p-4 mb-8">
          <p className="text-sm text-gray-800">
            Your events and memories are visible only to you and the people you share with. Our
            infrastructure providers have technical access to run the service; we do not use your
            content for advertising or anything else.
          </p>
        </div>

        <div className="prose prose-gray max-w-none space-y-6 text-sm text-gray-700">
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-2">Who can see your data</h2>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>You and people you share with.</strong> Events and memories are shown only
                to you and to family, friends, or groups you choose per event. There are no
                in-app &quot;admins&quot; or organizers who can see other users&apos; content.
              </li>
              <li>
                <strong>Infrastructure and operations.</strong> Plannen runs on Supabase. Project
                operators and our backend services (e.g. for reminders and calendar sync) have
                technical access to run the app. This is the same as most web apps: the systems
                that host and serve your data can access it for operational reasons.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-2">What we do not do</h2>
            <ul className="list-disc pl-5 space-y-1">
              <li>We do not use your event or memory content for advertising.</li>
              <li>We do not sell your data.</li>
              <li>We do not give third parties access to your content except as required by law
                (e.g. valid legal process).
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mt-8 mb-2">Technical note</h2>
            <p>
              If you want a guarantee that &quot;even platform admins cannot read my data,&quot;
              that would require end-to-end or client-side encryption (like Signal or WhatsApp
              messages). Plannen today does not use that model; we rely on access controls and
              policy, similar to many social and planning apps. We are transparent about that here.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
