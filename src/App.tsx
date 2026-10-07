import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';
import { RequireAuth } from './auth/RequireAuth';
import { AppLayout } from './components/layout/AppLayout';
import { homePathForRole } from './config/navigation';
import { Login } from './pages/login/Login';
import { Placeholder } from './pages/common/Placeholder';
import { UsersPage } from './pages/users/UsersPage';
import { CampaignsPage } from './pages/campaigns/CampaignsPage';
import { CampaignFormPage } from './pages/campaigns/CampaignFormPage';
import { AssignmentRulesPage } from './pages/settings/AssignmentRulesPage';
import { SettingsHome } from './pages/settings/SettingsHome';
import { JournalPage } from './pages/journal/JournalPage';
import { LeadsListPage } from './pages/leads/LeadsListPage';
import { LeadFilePage } from './pages/leads/LeadFilePage';

function Home() {
  const { user } = useAuth();
  return <Navigate to={user ? homePathForRole(user.role) : '/login'} replace />;
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
        <Route path="/ma-journee" element={page('Ma journée', 'Votre prochaine action, calculée pour vous.', '§6, §12.1, §25.3', 'Phase 2')} />
        <Route path="/mes-leads" element={<LeadsListPage basePath="/mes-leads" />} />
        <Route path="/mes-leads/:leadId" element={<LeadFilePage listPath="/mes-leads" />} />
        <Route path="/messages" element={page('Messages', 'Chronologie des échanges avec vos clients.', '§24.5', 'Phase 6')} />

        {/* Manager / admin */}
        <Route path="/cockpit" element={page('Cockpit', 'Les urgences et les décisions à prendre.', '§12.2 à §12.13', 'Phase 5')} />
        <Route path="/equipe" element={page('Équipe', 'Statut et charge de chaque télépro en temps réel.', '§12.7', 'Phase 5')} />
        <Route path="/leads" element={<LeadsListPage basePath="/leads" />} />
        <Route path="/leads/:leadId" element={<LeadFilePage listPath="/leads" />} />
        <Route path="/rapports" element={page('Rapports', 'KPI, entonnoir et rentabilité.', '§22', 'Phase 5')} />

        {/* Communs */}
        <Route path="/documents" element={page('Documents', 'À relancer, à contrôler, complets.', '§10, §25.6', 'Phase 3')} />
        <Route path="/ventes" element={page('Ventes', 'À signer, à sécuriser, sécurisées.', '§11, §23, §25.7', 'Phase 4')} />

        {/* Administration */}
        <Route path="/campagnes" element={<CampaignsPage />} />
        <Route path="/campagnes/nouvelle" element={<CampaignFormPage />} />
        <Route path="/campagnes/:campaignId" element={<CampaignFormPage />} />
        <Route path="/utilisateurs" element={<UsersPage />} />
        <Route path="/integrations" element={page('Intégrations', 'Connecteurs, journal et reprises.', '§24', 'Phase 6')} />
        <Route path="/parametres" element={<SettingsHome />} />
        <Route path="/parametres/attribution" element={<AssignmentRulesPage />} />
        <Route path="/parametres/*" element={page('Paramètres', 'SLA, horaires, NR, checklists, motifs — versionnés.', '§14, §21', 'Phase 2 / 5')} />
        <Route path="/journal" element={<JournalPage />} />

        <Route path="*" element={<Home />} />
      </Route>
    </Routes>
  );
}
