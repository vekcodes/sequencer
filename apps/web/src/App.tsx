import { Routes, Route, Navigate } from 'react-router-dom'
import { LoginPage } from './pages/LoginPage'
import { SignupPage } from './pages/SignupPage'
import { DashboardPage } from './pages/DashboardPage'
import { MailboxesPage } from './pages/MailboxesPage'
import { MailboxDetailPage } from './pages/MailboxDetailPage'
import { LeadsPage } from './pages/LeadsPage'
import { LeadImportPage } from './pages/LeadImportPage'
import { LeadListsPage } from './pages/LeadListsPage'
import { LeadListDetailPage } from './pages/LeadListDetailPage'
import { BlocklistsPage } from './pages/BlocklistsPage'
import { CampaignsPage } from './pages/CampaignsPage'
import { CampaignDetailPage } from './pages/CampaignDetailPage'
import { MasterInboxPage } from './pages/MasterInboxPage'
import { RequireAuth } from './components/RequireAuth'

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <DashboardPage />
          </RequireAuth>
        }
      />
      <Route
        path="/mailboxes"
        element={
          <RequireAuth>
            <MailboxesPage />
          </RequireAuth>
        }
      />
      <Route
        path="/mailboxes/:id"
        element={
          <RequireAuth>
            <MailboxDetailPage />
          </RequireAuth>
        }
      />
      <Route
        path="/leads"
        element={
          <RequireAuth>
            <LeadsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/leads/import"
        element={
          <RequireAuth>
            <LeadImportPage />
          </RequireAuth>
        }
      />
      <Route
        path="/lead-lists"
        element={
          <RequireAuth>
            <LeadListsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/lead-lists/:id"
        element={
          <RequireAuth>
            <LeadListDetailPage />
          </RequireAuth>
        }
      />
      <Route
        path="/blocklist"
        element={
          <RequireAuth>
            <BlocklistsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/campaigns"
        element={
          <RequireAuth>
            <CampaignsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/campaigns/:id"
        element={
          <RequireAuth>
            <CampaignDetailPage />
          </RequireAuth>
        }
      />
      <Route
        path="/master-inbox"
        element={
          <RequireAuth>
            <MasterInboxPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
