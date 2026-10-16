/**
 * dsh-memory-curator — browser half.
 *
 * Registers a left-sidebar entry button and a central management panel that
 * lists, filters, adds, forgets and curates durable memory entries.
 *
 * Data comes from the plugin's own same-origin `/api/memory-curator/*` routes
 * (mounted by lib/panel-api.js), NOT from a Typert Remote namespace. A client
 * half that hard-injects `remote.<namespace>` stays `pending` when the namespace
 * never appears, and the DSH web shell reports a pending client entry as a boot
 * failure — "web boot: 1 entry did not activate" — which stops the whole app
 * from starting. HTTP carries no such risk.
 *
 * Installed-bundle client halves load through `window.__ModuleLoader__.load`:
 * the factory receives a `require` module table (React comes from
 * `require('react')`) and returns `{ inject, apply(ctx) }`. No JSX/TS — plain
 * `React.createElement`. Every colour comes from a theme token so the panel
 * survives a light/dark switch.
 *
 * @module dsh-memory-curator/client
 */

/* eslint-disable */

window.__ModuleLoader__.load({
  id: 'dsh-memory-curator',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo } = React

    const PANEL_ID = 'dsh-memory-curator:panel'
    /**
     * Route prefix, resolved against the page base rather than written
     * origin-absolute. DSH can be served under a reverse-proxy sub-path
     * (`https://host/<prefix>/`), and a leading-slash `/api/...` would drop the
     * `<prefix>` and hit the site root instead of the app — the request 404s at
     * the fronting gateway and the panel reports a backend failure. A relative
     * path follows the page base and is identical under a root deployment.
     * Falls back to the absolute form where there is no document to resolve
     * against, which is no worse than the broken case.
     */
    const API = (() => {
      try { return new URL('api/memory-curator', document.baseURI).pathname } catch { return '/api/memory-curator' }
    })()

    // ── palette ─────────────────────────────────────────────────────────────
    // Real DSH web theme tokens (the `--dsw-alias-*` family, confirmed against
    // the live theme inspect). Every one carries a fallback so the panel stays
    // readable if a token is ever renamed.
    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      muted: 'var(--dsw-alias-label-secondary, #888)',
      bg: 'var(--dsw-alias-bg-base, transparent)',
      bgAlt: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.06))',
      border: 'var(--dsw-alias-border-l1, rgba(128,128,128,0.25))',
      accent: 'var(--dsw-alias-brand-primary, #4f7cff)',
      danger: 'var(--dsw-alias-state-error-primary, #d33)',
    }

    const KIND_COLORS = {
      decision: '#4f7cff', correction: '#e8a317', prohibition: '#d33',
      reference: '#18a558', open: '#9b59b6', fact: '#888',
    }

    // ── host API ────────────────────────────────────────────────────────────
    /**
     * Call one panel route.
     *
     * Every call is deadline-bound. Without a timeout a route that never answers
     * — the backend not mounted, or a request parked behind a dead socket —
     * leaves the panel spinning on "Loading…" forever and holds a same-origin
     * connection open the whole time.
     *
     * @param {string} path - route below the API prefix (e.g. `/stats`)
     * @param {object} [options] - `method`, JSON `body`, and `timeout` in ms
     * @returns {Promise<any>} the decoded JSON payload
     */
    async function call(path, options = {}) {
      const { timeout = 8000, ...rest } = options
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, {
          method: rest.method ?? 'GET',
          headers: rest.body === undefined ? undefined : { 'content-type': 'application/json' },
          body: rest.body === undefined ? undefined : JSON.stringify(rest.body),
          credentials: 'same-origin',
          redirect: 'error',
          signal: ctrl.signal,
        })
        // Read as text first: an error page is not JSON, and a bare
        // `response.json()` would report a parse failure instead of the status.
        const text = await response.text()
        let payload
        try {
          payload = text === '' ? {} : JSON.parse(text)
        } catch {
          payload = { error: text.slice(0, 200) || `HTTP ${response.status}` }
        }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error('the memory backend did not answer in time')
        throw error
      } finally {
        clearTimeout(timer)
      }
    }

    // ── sidebar icon ────────────────────────────────────────────────────────
    // `currentColor` rather than a theme token: the shell already colours the
    // sidebar entry itself (idle vs. selected), and an explicit token would pin
    // the icon to one state — or to nothing at all if the token were renamed.
    function SidebarIcon() {
      return h('svg', {
        width: 20, height: 20, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
        style: { display: 'block' },
      },
        h('path', { d: 'M12 3c-3.9 0-7 1.1-7 2.5v13C5 19.9 8.1 21 12 21s7-1.1 7-2.5v-13C19 4.1 15.9 3 12 3z' }),
        h('path', { d: 'M5 8.5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5' }),
        h('path', { d: 'M5 13.5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5' }),
      )
    }

    // ── small UI helpers ────────────────────────────────────────────────────
    function Badge({ kind }) {
      const color = KIND_COLORS[kind] || '#888'
      return h('span', {
        style: {
          display: 'inline-block', padding: '1px 6px', borderRadius: 9, fontSize: 11,
          fontWeight: 600, color: '#fff', background: color, marginRight: 6, verticalAlign: 'middle',
        },
      }, kind)
    }

    function StatusDot({ status }) {
      const color = status === 'active' ? '#18a558' : status === 'superseded' ? '#d33' : '#888'
      return h('span', {
        title: status,
        style: { display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: color, marginRight: 6, verticalAlign: 'middle' },
      })
    }

    function Button({ onClick, disabled, children, variant }) {
      return h('button', {
        type: 'button', onClick, disabled,
        style: {
          padding: '4px 10px', borderRadius: 6, fontSize: 12,
          cursor: disabled ? 'default' : 'pointer',
          border: `1px solid ${C.border}`,
          background: variant === 'danger' ? 'transparent' : C.bgAlt,
          color: variant === 'danger' ? C.danger : C.text,
          opacity: disabled ? 0.5 : 1,
        },
      }, children)
    }

    // ── entry row ───────────────────────────────────────────────────────────
    function EntryRow({ entry, onForget, onToggle, expanded }) {
      const when = new Date(entry.updatedAt || entry.createdAt || 0)
      const dateStr = Number.isNaN(when.getTime())
        ? ''
        : `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`
      return h('div', {
        style: { padding: '8px 10px', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' },
        onClick: () => onToggle(entry.id),
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 } },
          h(StatusDot, { status: entry.status }),
          h(Badge, { kind: entry.kind }),
          entry.subject ? h('span', {
            style: {
              fontWeight: 600, fontSize: 13, color: C.text, flex: 1,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, entry.subject) : null,
          h('span', { style: { fontSize: 11, color: C.muted, flexShrink: 0 } }, dateStr),
        ),
        h('div', {
          style: {
            fontSize: 12, color: C.muted, lineHeight: 1.4,
            whiteSpace: expanded ? 'pre-wrap' : 'nowrap',
            overflow: expanded ? 'visible' : 'hidden',
            textOverflow: 'ellipsis',
          },
        }, expanded ? entry.text : String(entry.text ?? '').slice(0, 120)),
        expanded ? h('div', { style: { marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' } },
          h('span', { style: { fontSize: 11, color: C.muted } }, `id: ${entry.id}${entry.scope && entry.scope !== 'global' ? ` · ${entry.scope}` : ''}`),
          entry.status === 'active'
            ? h(Button, { variant: 'danger', onClick: (e) => { e.stopPropagation(); onForget(entry.id) } }, 'Forget')
            : null,
        ) : null,
      )
    }

    // ── add form ───────────────────────────────────────────────────────────
    const KINDS = ['fact', 'decision', 'correction', 'prohibition', 'reference', 'open']

    function AddForm({ onAdd }) {
      const [text, setText] = useState('')
      const [kind, setKind] = useState('fact')
      const [subject, setSubject] = useState('')
      const [busy, setBusy] = useState(false)
      const submit = useCallback(async () => {
        if (text.trim() === '') return
        setBusy(true)
        try {
          await onAdd({ text: text.trim(), kind, subject: subject.trim() })
          setText('')
          setSubject('')
        } finally {
          setBusy(false)
        }
      }, [text, kind, subject, onAdd])
      return h('div', { style: { padding: 10, borderBottom: `1px solid ${C.border}`, background: C.bgAlt } },
        h('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 6, color: C.text } }, 'Add memory'),
        h('textarea', {
          value: text, onChange: (e) => setText(e.target.value), rows: 2,
          placeholder: 'One self-contained statement…',
          style: {
            width: '100%', boxSizing: 'border-box', padding: 6, borderRadius: 6,
            border: `1px solid ${C.border}`, background: C.bg, color: C.text,
            fontSize: 12, resize: 'vertical',
          },
        }),
        h('div', { style: { display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' } },
          h('select', {
            value: kind, onChange: (e) => setKind(e.target.value),
            style: { padding: '3px 6px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontSize: 12 },
          }, KINDS.map((k) => h('option', { key: k, value: k }, k))),
          h('input', {
            value: subject, onChange: (e) => setSubject(e.target.value), placeholder: 'subject (optional)',
            style: { flex: 1, padding: '3px 6px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontSize: 12 },
          }),
          h(Button, { onClick: submit, disabled: busy || text.trim() === '' }, busy ? '…' : 'Add'),
        ),
      )
    }

    // ── main panel ─────────────────────────────────────────────────────────
    function MainPanel() {
      const [entries, setEntries] = useState(null)
      const [stats, setStats] = useState(null)
      const [error, setError] = useState(null)
      const [query, setQuery] = useState('')
      const [expanded, setExpanded] = useState(null)
      const [refreshKey, setRefreshKey] = useState(0)

      const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])

      useEffect(() => {
        let alive = true
        setError(null)
        Promise.all([call('/entries'), call('/stats')])
          .then(([list, s]) => {
            if (!alive) return
            setEntries(Array.isArray(list?.entries) ? list.entries : [])
            setStats(s ?? null)
          })
          .catch((e) => {
            if (!alive) return
            setEntries([])
            setError(String(e?.message ?? e))
          })
        return () => { alive = false }
      }, [refreshKey])

      const filtered = useMemo(() => {
        if (entries === null) return null
        const q = query.trim().toLowerCase()
        if (q === '') return entries
        const terms = q.split(/\s+/).filter(Boolean)
        return entries.filter((e) => {
          const hay = `${e.subject} ${e.text} ${(e.tags || []).join(' ')} ${e.kind}`.toLowerCase()
          return terms.every((t) => hay.includes(t))
        })
      }, [entries, query])

      const onForget = useCallback(async (id) => {
        try { await call('/forget', { method: 'POST', body: { id } }); refresh() } catch (e) { setError(String(e?.message ?? e)) }
      }, [refresh])
      const onAdd = useCallback(async (entry) => {
        try { await call('/add', { method: 'POST', body: entry }); refresh() } catch (e) { setError(String(e?.message ?? e)) }
      }, [refresh])
      const onCurate = useCallback(async () => {
        try { await call('/curate', { method: 'POST', body: {} }); refresh() } catch (e) { setError(String(e?.message ?? e)) }
      }, [refresh])
      const onToggle = useCallback((id) => setExpanded((cur) => (cur === id ? null : id)), [])

      const activeCount = stats?.byStatus?.active ?? 0
      const totalCount = stats?.total ?? 0

      return h('div', {
        style: { height: '100%', display: 'flex', flexDirection: 'column', color: C.text, background: C.bg, fontFamily: 'inherit' },
      },
        h('div', {
          style: { padding: '10px 12px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
        },
          h('span', { style: { fontWeight: 700, fontSize: 14 } }, 'Memory Curator'),
          h('span', { style: { fontSize: 12, color: C.muted } }, `${activeCount} active · ${totalCount} total`),
          h('div', { style: { flex: 1 } }),
          h(Button, { onClick: onCurate }, 'Curate'),
        ),
        h('div', {
          style: { padding: '8px 12px', borderBottom: `1px solid ${C.border}`, flexShrink: 0, display: 'flex', gap: 6, alignItems: 'center' },
        },
          h('input', {
            value: query, onChange: (e) => setQuery(e.target.value), placeholder: 'Filter entries…',
            style: { flex: 1, padding: '4px 8px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontSize: 12 },
          }),
        ),
        h(AddForm, { onAdd }),
        error ? h('div', { style: { padding: '8px 12px', color: C.danger, fontSize: 12 } }, `⚠ ${error}`) : null,
        h('div', { style: { flex: 1, overflow: 'auto' } },
          filtered === null
            ? h('div', { style: { padding: 16, color: C.muted, fontSize: 12 } }, 'Loading…')
            : filtered.length === 0
              ? h('div', { style: { padding: 16, color: C.muted, fontSize: 12 } },
                  entries && entries.length === 0 ? 'No memory entries yet.' : 'No matches.')
              : filtered.map((entry) => h(EntryRow, {
                  key: entry.id, entry, onForget, onToggle, expanded: expanded === entry.id,
                })),
        ),
      )
    }

    // ── plugin apply ───────────────────────────────────────────────────────
    // `slots` is the ONLY hard dependency on purpose: a hard client dependency
    // that never arrives leaves this entry `pending`, and the web shell reports
    // a pending entry as a boot failure, which stops the whole app from starting.
    const inject = ['slots']

    function apply(ctx) {
      return ctx.effect(() => {
        const stop = ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
          const stopMain = ctx.slots.register({ name: 'main', key: PANEL_ID }, MainPanel)

          let stopIcon
          try {
            stopIcon = ctx.slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 40,
              label: () => 'Memory',
            }, SidebarIcon)
          } catch (error) {
            stopIcon?.()
            stopMain()
            throw error
          }

          return () => { stopIcon?.(); stopMain() }
        }))
        return stop
      }, 'dsh-memory-curator: panel')
    }

    return { apply, inject }
  },
})
