import { Link, NavLink } from 'react-router-dom'
import { useState, type ReactNode } from 'react'
import { useAuth } from '../lib/auth'

// Inline SVG icons — lightweight, no dependencies
const icons = {
  dashboard: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  ),
  leads: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  campaigns: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2L11 13" />
      <path d="M22 2L15 22L11 13L2 9L22 2Z" />
    </svg>
  ),
  inbox: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  ),
  mailbox: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  ),
  leadLists: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  ),
  blocklist: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </svg>
  ),
  collapse: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  ),
  logout: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  ),
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()
  const [collapsed, setCollapsed] = useState(false)

  const initial = (user?.name || user?.email || '?').charAt(0).toUpperCase()
  const label = user?.name || user?.email?.split('@')[0] || 'Account'

  return (
    <div className={`app-shell${collapsed ? ' app-shell--collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar__top">
          <Link to="/" className="sidebar__brand">
            <span className="sidebar__logo">CE</span>
            {!collapsed && (
              <span className="sidebar__brand-text">
                <span className="sidebar__brand-name">Cold Email</span>
                <span className="sidebar__brand-tag">SEQUENCER</span>
              </span>
            )}
          </Link>
          <button
            type="button"
            className="sidebar__collapse-btn"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {icons.collapse}
          </button>
        </div>

        <nav className="sidebar__nav">
          <NavLink to="/" end className="sidebar__link">
            <span className="sidebar__icon">{icons.dashboard}</span>
            {!collapsed && <span>Dashboard</span>}
          </NavLink>
          <NavLink to="/campaigns" className="sidebar__link">
            <span className="sidebar__icon">{icons.campaigns}</span>
            {!collapsed && <span>Campaigns</span>}
          </NavLink>
          <NavLink to="/leads" className="sidebar__link">
            <span className="sidebar__icon">{icons.leads}</span>
            {!collapsed && <span>Leads</span>}
          </NavLink>
          <NavLink to="/lead-lists" className="sidebar__link">
            <span className="sidebar__icon">{icons.leadLists}</span>
            {!collapsed && <span>Lead Lists</span>}
          </NavLink>
          <NavLink to="/master-inbox" className="sidebar__link">
            <span className="sidebar__icon">{icons.inbox}</span>
            {!collapsed && <span>Master Inbox</span>}
          </NavLink>
          <NavLink to="/mailboxes" className="sidebar__link">
            <span className="sidebar__icon">{icons.mailbox}</span>
            {!collapsed && <span>Sender Emails</span>}
          </NavLink>
          <NavLink to="/blocklist" className="sidebar__link">
            <span className="sidebar__icon">{icons.blocklist}</span>
            {!collapsed && <span>Blocklist</span>}
          </NavLink>
        </nav>

        <div className="sidebar__footer">
          <div className="sidebar__user">
            <span className="sidebar__avatar">{initial}</span>
            {!collapsed && <span className="sidebar__user-label">{label}</span>}
          </div>
          <button
            type="button"
            className="sidebar__link sidebar__link--button"
            onClick={() => logout()}
            title="Sign out"
          >
            <span className="sidebar__icon">{icons.logout}</span>
            {!collapsed && <span>Sign out</span>}
          </button>
        </div>
      </aside>

      <main className="app-main">{children}</main>
    </div>
  )
}
