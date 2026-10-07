// Layout du CRM Leads. Sidebar reprise du CRM principal (src/components/layout/layout.tsx) :
// même bleu nuit, même repli à 80 px, même overlay mobile — avec une navigation filtrée par rôle.
import { useEffect, useState, type ComponentType } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  BarChart3,
  Bell,
  CalendarCheck,
  ChevronLeft,
  ChevronRight,
  FileText,
  Gauge,
  LogOut,
  Megaphone,
  MessageSquare,
  PieChart,
  Plug,
  ScrollText,
  Search,
  Settings,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAuth } from '../../auth/AuthProvider';
import { usePresence } from '../../auth/usePresence';
import { getNavigation, type NavIconName, type NavItem } from '../../config/navigation';
import { ROLE_LABELS } from '../../domain/labels';

const ICONS: Record<NavIconName, ComponentType<{ className?: string }>> = {
  'calendar-check': CalendarCheck,
  users: Users,
  'file-text': FileText,
  'bar-chart': BarChart3,
  'message-square': MessageSquare,
  gauge: Gauge,
  'user-cog': UserCog,
  'pie-chart': PieChart,
  megaphone: Megaphone,
  plug: Plug,
  'scroll-text': ScrollText,
  settings: Settings,
};

function useIsDesktopLg() {
  const [isDesktop, setIsDesktop] = useState(() => window.innerWidth >= 1024);
  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 1024);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return isDesktop;
}

export function AppLayout() {
  const location = useLocation();
  const { user, logout } = useAuth();
  const isDesktop = useIsDesktopLg();
  usePresence(user?.uid ?? null);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => setMobileOpen(false), [location.pathname]);

  if (!user) return null; // RequireAuth garantit un utilisateur ; garde-fou de typage.

  const groups = getNavigation(user.role);
  const fullName = user.name;
  const initials = fullName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const renderItem = (item: NavItem) => {
    const Icon = ICONS[item.icon];
    const active = location.pathname === item.href || location.pathname.startsWith(`${item.href}/`);
    return (
      <Link
        key={item.href}
        to={item.href}
        className={cn(
          'group relative my-1 flex items-center rounded-lg px-3 py-3 text-sm font-medium transition-all duration-200',
          active ? 'bg-white/20 text-white shadow-lg shadow-white/10' : 'text-gray-300 hover:bg-white/10 hover:text-white'
        )}
      >
        <Icon className="h-5 w-5 flex-shrink-0" />
        {!collapsed && <span className="ml-3 whitespace-nowrap">{item.name}</span>}
        {collapsed && (
          <span className="pointer-events-none absolute left-full z-50 ml-2 whitespace-nowrap rounded-md bg-slate-800 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
            {item.name}
          </span>
        )}
      </Link>
    );
  };

  const sidebarWidth = collapsed ? 80 : 280;

  return (
    <div className="flex h-screen bg-slate-50">
      <AnimatePresence>
        {!isDesktop && mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => setMobileOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <motion.aside
        initial={false}
        animate={isDesktop ? { width: sidebarWidth, x: 0 } : { width: 280, x: mobileOpen ? 0 : -320 }}
        transition={{ duration: 0.25, ease: 'easeInOut' }}
        className="fixed left-0 top-0 z-50 flex h-full flex-col bg-brand lg:static lg:z-auto"
        style={{ borderRight: '1px solid rgba(255,255,255,0.1)' }}
      >
        <button
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? 'Agrandir la sidebar' : 'Réduire la sidebar'}
          className="absolute -right-3 top-6 z-50 hidden h-6 w-6 items-center justify-center rounded-full bg-white text-brand shadow-lg lg:flex"
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>

        <div
          className="flex h-16 items-center justify-between overflow-hidden px-4"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}
        >
          <img
            src="/Logo_Label_Energie-removebg-preview.png"
            alt="Label Énergie"
            className={cn('h-10 transition-opacity', collapsed && 'opacity-0')}
          />
          <button
            onClick={() => setMobileOpen(false)}
            className="text-white/80 hover:text-white lg:hidden"
            aria-label="Fermer le menu"
          >
            <X size={20} />
          </button>
        </div>

        <nav className="mt-6 flex-1 overflow-y-auto px-3">
          {groups.map((group) =>
            group.label === null ? (
              <div key="main">{group.items.map(renderItem)}</div>
            ) : (
              <div key={group.label} className="mb-3 mt-6">
                {!collapsed && (
                  <p className="mb-1.5 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-white/40">
                    {group.label}
                  </p>
                )}
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-1.5">
                  {group.items.map(renderItem)}
                </div>
              </div>
            )
          )}
        </nav>

        <div className="p-3" style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}>
          <button
            onClick={logout}
            className="flex w-full items-center rounded-lg px-3 py-3 text-sm font-medium text-gray-300 transition-colors hover:bg-red-500/20 hover:text-red-300"
          >
            <LogOut className="h-5 w-5 flex-shrink-0" />
            {!collapsed && <span className="ml-3">Déconnexion</span>}
          </button>
        </div>
      </motion.aside>

      {/* Contenu */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
          <div className="flex flex-1 items-center gap-3">
            <button
              onClick={() => setMobileOpen(true)}
              className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
              aria-label="Ouvrir le menu"
            >
              <ChevronRight size={20} />
            </button>
            {/* Recherche : branchée en Phase 1 (leads, clients, documents) */}
            <div className="flex w-full max-w-md items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-400">
              <Search size={16} />
              <span>Rechercher un lead, un client, un document…</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Cloche : branchée sur cl_notifications en Phase 2 (alertes SLA sonores) */}
            <button className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Notifications">
              <Bell size={20} />
            </button>
            <div className="flex items-center gap-2 rounded-lg p-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 text-sm font-medium text-white">
                {initials || 'U'}
              </div>
              <div className="hidden text-left lg:block">
                <p className="text-sm font-medium text-slate-900">{fullName}</p>
                <p className="text-xs text-slate-500">{ROLE_LABELS[user.role]}</p>
              </div>
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-auto p-3 sm:p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
