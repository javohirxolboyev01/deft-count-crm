import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Loading } from './components/ui/states';
import { useAuth } from './lib/auth';
import type { Role } from './lib/types';
import Login from './pages/Login';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const MyDay = lazy(() => import('./pages/MyDay'));
const Clients = lazy(() => import('./pages/Clients'));
const ClientCard = lazy(() => import('./pages/ClientCard'));
const Monthly = lazy(() => import('./pages/Monthly'));
const Settings = lazy(() => import('./pages/Settings'));
const Users = lazy(() => import('./pages/Users'));
const Profile = lazy(() => import('./pages/Profile'));
const Audit = lazy(() => import('./pages/Audit'));
const Leads = lazy(() => import('./pages/Leads'));
const ClientIssues = lazy(() => import('./pages/ClientIssues'));

/** UI darajasidagi himoya (qulaylik uchun). Haqiqiy ruxsat tekshiruvi serverda. */
function Protected({ roles, children }: { roles?: Role[]; children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading className="h-screen animate-none" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function Home() {
  const { user } = useAuth();
  const home = { LEADER: '/dashboard', ACCOUNTANT: '/my-day', OPERATOR: '/leads' } as const;
  return <Navigate to={home[user?.role ?? 'ACCOUNTANT']} replace />;
}

const L: Role[] = ['LEADER'];
/** Buxgalteriya bo'limlari: operator faqat "Yangi mijozlar" sahifasini ko'radi */
const S: Role[] = ['LEADER', 'ACCOUNTANT'];

/** Asosiy loader faqat loyiha ochilganda: auth tekshiruvi va birinchi sahifa kodi yuklanguncha */
export default function App() {
  return (
    <Suspense fallback={<Loading className="h-screen animate-none" />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Protected><Layout /></Protected>}>
          <Route index element={<Home />} />
          <Route path="dashboard" element={<Protected roles={L}><Dashboard /></Protected>} />
          {/* Kamchiligi bor mijozlar: import kamchiliklari va tuzatish faqat rahbarga (server ham yopiq) */}
          <Route path="client-issues" element={<Protected roles={L}><ClientIssues /></Protected>} />
          <Route path="my-day" element={<Protected roles={S}><MyDay /></Protected>} />
          <Route path="clients" element={<Protected roles={S}><Clients /></Protected>} />
          <Route path="clients/new" element={<Navigate to="/clients" replace />} />
          <Route path="clients/:id" element={<Protected roles={S}><ClientCard /></Protected>} />
          <Route path="monthly" element={<Protected roles={S}><Monthly /></Protected>} />
          {/* Hisobot topshirish detail: faqat rahbar (buxgalter jadvalni faqat ko'radi) */}
          <Route path="leads" element={<Protected roles={['LEADER', 'OPERATOR']}><Leads /></Protected>} />
          <Route path="settings" element={<Protected roles={L}><Settings /></Protected>} />
          <Route path="users" element={<Protected roles={L}><Users /></Protected>} />
          <Route path="audit" element={<Protected roles={L}><Audit /></Protected>} />
          <Route path="profile" element={<Profile />} />
          <Route path="*" element={<Home />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
