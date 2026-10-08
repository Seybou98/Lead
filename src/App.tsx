import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';
import { RequireAuth } from './auth/RequireAuth';
import { AppLayout } from './components/layout/AppLayout';
import { homePathForRole } from './config/navigation';
import { Login } from './pages/login/Login';
import { Placeholder } from './pages/common/Placeholder';
import { UsersPage } from './pages/users/UsersPage';
import { UserFormPage } from './pages/users/UserFormPage';
import { ChecklistsPage } from './pages/settings/ChecklistsPage';
import { SlaHoursPage } from './pages/settings/SlaHoursPage';
import { ProductsPage } from './pages/settings/ProductsPage';
import { VersionsPage } from './pages/settings/VersionsPage';
import { RulesPage } from './pages/settings/RulesPage';
import { CockpitPage } from './pages/cockpit/CockpitPage';
import { TeamPage } from './pages/cockpit/TeamPage';
import { TelecallerPage } from './pages/portfolio/TelecallerPage';
import { AbsencePage } from './pages/portfolio/AbsencePage';
import { TransferPage } from './pages/portfolio/TransferPage';
import { DocumentsPage } from './pages/documents/DocumentsPage';
import { CampaignsPage } from './pages/campaigns/CampaignsPage';
import { CampaignFormPage } from './pages/campaigns/CampaignFormPage';
import { AssignmentRulesPage } from './pages/settings/AssignmentRulesPage';
import { SettingsHome } from './pages/settings/SettingsHome';
import { JournalPage } from './pages/journal/JournalPage';
import { LeadsListPage } from './pages/leads/LeadsListPage';
import { LeadFilePage } from './pages/leads/LeadFilePage';
import { MyDayPage } from './pages/myday/MyDayPage';

function Home() {
  const { user } = useAuth();
  return <Navigate to={user ? homePathForRole(user.role) : '/login'} replace />;
}

/** Fiche, absence et transfert d'un télépro : managers et administrateurs seulement (les données restent aussi protégées par les règles). */
function ManagerOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user && user.role === 'telepro') return <Navigate to={homePathForRole(user.role)} replace />;
  return <>{children}</>;
}

// Écrans provisoires : chacun indique la section du cahier des charges et la phase qui le construit.
const page = (title: string, description: string, section: string, phase: string) => (
  <Placeholder title={title} description={description} section={section} phase={phase} />
);

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Home />} />

        {/* Télépro */}
        <Route path="/ma-journee" element={<MyDayPage />} />
        <Route path="/mes-leads" element={<LeadsListPage basePath="/mes-leads" />} />
        <Route path="/mes-leads/:leadId" element={<LeadFilePage listPath="/mes-leads" />} />
        <Route path="/messages" element={page('Messages', 'Chronologie des échanges avec vos clients.', '§24.5', 'Phase 6')} />

        {/* Manager / admin */}
        <Route path="/cockpit" element={<CockpitPage />} />
        <Route path="/equipe" element={<TeamPage />} />
        <Route path="/leads" element={<LeadsListPage basePath="/leads" />} />
        <Route path="/leads/:leadId" element={<LeadFilePage listPath="/leads" />} />
        <Route path="/rapports" element={page('Rapports', 'KPI, entonnoir et rentabilité.', '§22', 'Phase 5')} />

        {/* Communs */}
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/ventes" element={page('Ventes', 'À signer, à sécuriser, sécurisées.', '§11, §23, §25.7', 'Phase 4')} />

        {/* Administration */}
        <Route path="/campagnes" element={<CampaignsPage />} />
        <Route path="/campagnes/nouvelle" element={<CampaignFormPage />} />
        <Route path="/campagnes/:campaignId" element={<CampaignFormPage />} />
        <Route path="/utilisateurs" element={<UsersPage />} />
        <Route path="/utilisateurs/nouveau" element={<UserFormPage />} />
        <Route path="/utilisateurs/:uid" element={<ManagerOnly><TelecallerPage /></ManagerOnly>} />
        <Route path="/utilisateurs/:uid/absence" element={<ManagerOnly><AbsencePage /></ManagerOnly>} />
        <Route path="/utilisateurs/:uid/transfert" element={<ManagerOnly><TransferPage /></ManagerOnly>} />
        <Route path="/integrations" element={page('Intégrations', 'Connecteurs, journal et reprises.', '§24', 'Phase 6')} />
        <Route path="/parametres" element={<SettingsHome />} />
        <Route path="/parametres/attribution" element={<AssignmentRulesPage />} />
        <Route path="/parametres/documents" element={<ChecklistsPage />} />
        <Route path="/parametres/sla" element={<SlaHoursPage />} />
        <Route path="/parametres/produits" element={<ProductsPage />} />
        <Route path="/parametres/versions" element={<VersionsPage />} />
        <Route path="/parametres/cycles" element={<RulesPage />} />
        <Route path="/parametres/*" element={page('Paramètres', 'SLA, horaires, NR, checklists, motifs — versionnés.', '§14, §21', 'Phase 2 / 5')} />
        <Route path="/journal" element={<JournalPage />} />

        <Route path="*" element={<Home />} />
      </Route>
    </Routes>
  );
}
