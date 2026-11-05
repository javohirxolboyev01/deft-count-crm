import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { clientNeeds, useReviewByClient } from '@/components/SheetImport';
import { api, qs } from '@/lib/api';
import { workMonth } from '@/lib/time';
import type { DashboardClients, ReviewItem } from '@/lib/types';

export type DashClient = DashboardClients['clients'][number];
export type ClientIssue = { client: DashClient; problems: string[]; noStir: boolean; noTax: boolean; noAccountant: boolean };

/**
 * Dashboard mijozlar so'rovi: Dashboard va "Kamchiliklar" sahifasi bitta kesh kalitini ishlatadi.
 * Oy — belgilanadigan oy (rahbar qarori): noyabrda oktyabr, jadvallar bilan bir xil.
 */
export function useDashboardClients() {
  const month = workMonth();
  return useQuery({
    queryKey: ['dashboard', 'clients', month],
    queryFn: () => api.get<DashboardClients>(`/dashboard/clients${qs({ month })}`),
    refetchInterval: 60_000,
  });
}

/**
 * Kamchiligi bor mijozlar: STIR yoki soliq turi yo'q (import "boricha"), Buxgalter ishlaridagi mijozga buxgalter
 * biriktirilmagan, importda aniqlangan ochiq kamchiliklar (ikkala bo'lim). Bo'limdan olib tashlanganlar kirmaydi.
 */
export function useClientIssues(data: DashboardClients | undefined): ClientIssue[] {
  // Buxgalter biriktirilmaganlar dashboard hisobiga kirmaydi, lekin kamchilik sifatida shu yerda ko'rinadi
  const clients = data
    ? [...data.clients, ...(data.unassignedClients ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'uz'))
    : undefined;
  const { t } = useTranslation();
  const reports = useReviewByClient('REPORTS');
  const works = useReviewByClient('WORKS');
  const out: ClientIssue[] = [];
  for (const c of clients ?? []) {
    if (!c.inReports && !c.inWorks) continue;
    const review: ReviewItem[] = [...(reports.get(c.clientId) ?? []), ...(works.get(c.clientId) ?? [])];
    // Hisobot topshirish buxgalterga biriktirilmaydi — buxgalter faqat Buxgalter ishlaridagi mijozga kerak
    const noAccountant = c.inWorks && !c.accountantId;
    const problems = [...clientNeeds(c, t), ...(noAccountant ? [t('dashboard.needAccountant')] : []), ...review.map((r) => r.message)];
    if (problems.length) out.push({ client: c, problems, noStir: !c.stir, noTax: !c.taxType, noAccountant });
  }
  return out;
}
