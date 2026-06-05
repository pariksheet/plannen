import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound, Plus, Copy, CheckCircle, Trash2, AlertCircle, Loader } from 'lucide-react';

type Token = {
  id: string;
  label: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
};

type Props = {
  jwt: string;
  supabaseUrl: string;
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

export function SettingsTokens({ jwt, supabaseUrl }: Props) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [label, setLabel] = useState('');
  const [justMinted, setJustMinted] = useState<{ plaintext: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const endpoint = `${supabaseUrl}/functions/v1/mcp-token`;
  const headers = { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { headers });
      if (!res.ok) throw new Error(`Couldn't load tokens (HTTP ${res.status}).`);
      setTokens(await res.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(endpoint, {
        method: 'POST', headers, body: JSON.stringify({ label }),
      });
      if (!res.ok) throw new Error(`Couldn't mint token (HTTP ${res.status}).`);
      const body = await res.json();
      setJustMinted({ plaintext: body.plaintext, label: body.label });
      setShowCreate(false);
      setLabel('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(id: string, tokenLabel: string) {
    if (!confirm(`Revoke "${tokenLabel}"? This cannot be undone.`)) return;
    setError(null);
    try {
      const res = await fetch(`${endpoint}/${id}`, { method: 'DELETE', headers });
      if (!res.ok && res.status !== 204) throw new Error(`Couldn't revoke token (HTTP ${res.status}).`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function copyPlaintext() {
    if (!justMinted) return;
    try {
      await navigator.clipboard?.writeText(justMinted.plaintext);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable; leave the text visible for manual copy.
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <div className="flex items-center gap-2 mb-1">
        <KeyRound className="h-4 w-4 text-gray-400" />
        <span className="text-sm font-medium text-gray-700">Personal access tokens</span>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Use these to authenticate Claude Code (and other MCP clients) to your Plannen deployment.
        Each token is tied to your account; revoke any time.
      </p>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {justMinted && (
        <div
          role="dialog"
          aria-label="Token created"
          className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-4"
        >
          <p className="text-sm font-medium text-amber-900 mb-2">
            Save this token now — you will not see it again.
          </p>
          <p className="text-xs text-amber-800 mb-3">
            Label: <span className="font-mono">{justMinted.label}</span>
          </p>
          <code className="block w-full break-all rounded border border-amber-200 bg-white px-3 py-2 text-xs font-mono text-gray-800 mb-3">
            {justMinted.plaintext}
          </code>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={copyPlaintext}
              className="inline-flex items-center gap-1 min-h-[44px] px-3 py-2 bg-amber-600 text-white text-sm rounded-md hover:bg-amber-700"
            >
              {copied ? <CheckCircle className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={() => { setJustMinted(null); setCopied(false); }}
              className="min-h-[44px] px-3 py-2 border border-amber-300 text-amber-900 text-sm rounded-md hover:bg-amber-100"
            >
              I&apos;ve saved this token
            </button>
          </div>
        </div>
      )}

      {!showCreate && !justMinted && (
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1 min-h-[44px] px-4 py-2 bg-indigo-600 text-white text-sm rounded-md hover:bg-indigo-700 mb-4"
        >
          <Plus className="h-4 w-4" />
          Generate new token
        </button>
      )}

      {showCreate && (
        <form onSubmit={onCreate} className="mb-4 rounded-md border border-gray-200 bg-gray-50 p-4 space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-gray-600 mb-1">Label</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
              autoFocus
              placeholder='e.g. "MacBook" or "Work laptop"'
              className="w-full px-3 py-2 min-h-[44px] border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={busy || !label.trim()}
              className="inline-flex items-center gap-1 min-h-[44px] px-4 py-2 bg-indigo-600 text-white text-sm rounded-md hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy ? <Loader className="h-3.5 w-3.5 animate-spin" /> : null}
              Create
            </button>
            <button
              type="button"
              onClick={() => { setShowCreate(false); setLabel(''); }}
              disabled={busy}
              className="min-h-[44px] px-4 py-2 border border-gray-300 text-sm text-gray-700 rounded-md hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-4 text-xs text-gray-500">
          <Loader className="h-4 w-4 animate-spin" /> Loading tokens…
        </div>
      ) : tokens.length === 0 ? (
        <p className="py-4 text-xs text-gray-500">
          No tokens yet. Click <span className="font-medium">Generate new token</span> to mint your first one.
        </p>
      ) : (
        <ul className="space-y-2">
          {tokens.map((t) => (
            <li key={t.id} className="rounded-md border border-gray-200 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-800 truncate">{t.label}</p>
                  <code className="block font-mono text-xs text-gray-600 truncate">{t.prefix}</code>
                </div>
                <button
                  type="button"
                  onClick={() => onRevoke(t.id, t.label)}
                  className="flex-shrink-0 inline-flex items-center gap-1 min-h-[44px] px-3 text-sm text-red-600 hover:text-red-800 hover:underline"
                  aria-label={`Revoke ${t.label}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Revoke</span>
                </button>
              </div>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-xs text-gray-500">
                <div>
                  <dt className="text-gray-400">Created</dt>
                  <dd>{fmtDate(t.created_at)}</dd>
                </div>
                <div>
                  <dt className="text-gray-400">Last used</dt>
                  <dd>{fmtDate(t.last_used_at)}</dd>
                </div>
                <div>
                  <dt className="text-gray-400">Expires</dt>
                  <dd>{t.expires_at ? fmtDate(t.expires_at) : 'never'}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
