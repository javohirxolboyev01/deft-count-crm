// API javob tiplari (backend DTO'lariga mos)
export type Role = 'LEADER' | 'ACCOUNTANT' | 'OPERATOR';
export type Lang = 'uz' | 'ru';
export type TaxType = 'AOS' | 'QQS' | 'YATT';
// Ochiladigan ro'yxatlar uchun: qiymat -> ko'rinadigan nom (YaTT — yakka tartibdagi tadbirkor)
export const TAX_TYPE_OPTIONS: { value: TaxType; label: string }[] = [{ value: 'AOS', label: 'AOS' }, { value: 'QQS', label: 'QQS' }, { value: 'YATT', label: 'YaTT' }];
export const taxTypeLabel = (t: string) => (t === 'YATT' ? 'YaTT' : t);
export type ClientStatus = 'ACTIVE' | 'ZERO_REPORT' | 'LIQUIDATING' | 'ARCHIVED';
export const CLIENT_STATUSES: ClientStatus[] = ['ACTIVE', 'ZERO_REPORT', 'LIQUIDATING', 'ARCHIVED'];
export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'WAITING_CLIENT' | 'DONE' | 'CANCELLED';
export type TaskKind = 'ROUTINE' | 'REPORT' | 'URGENT' | 'MANUAL';
export type NotificationKind = 'TASK_DONE' | 'TASK_OVERDUE' | 'CLIENTS_OVERDUE' | 'URGENT_TASK' | 'TASK_TRANSFER' | 'TASK_TRANSFER_RESULT' | 'LEAD_WON';
export type TransferReason = 'NOT_MINE' | 'BUSY' | 'OTHER';
export const TRANSFER_REASONS: TransferReason[] = ['NOT_MINE', 'BUSY', 'OTHER'];

/** Vazifani boshqa xodimga o'tkazish so'rovi (qabul qiluvchi rozilik beradi) */
export interface TaskTransfer {
  id: number;
  taskId: number;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED';
  reasonCode: TransferReason;
  reasonText: string | null;
  rejectReason: string | null;
  createdAt: string;
  resolvedAt: string | null;
  fromUserId: number | null;
  fromName: string | null;
  toUserId: number;
  toName: string;
  requestedBy: number;
  requestedByName: string;
}

export interface Me {
  id: number;
  role: Role;
  fullName: string;
  login: string;
  language: Lang;
  active: boolean;
  telegramLinked: boolean;
  notificationPrefs: Partial<Record<NotificationKind, { app?: boolean; telegram?: boolean }>>;
  telegramBotEnabled?: boolean;
  telegramBotUsername?: string | null;
  /** Shu rolga keladigan bildirishnoma turlari (profil sozlamasi uchun) */
  notificationKinds?: NotificationKind[];
}

export interface User {
  id: number;
  role: Role;
  fullName: string;
  login: string;
  language: Lang;
  active: boolean;
  telegramLinked: boolean;
  createdAt: string;
}

export interface AccountantOption {
  id: number;
  fullName: string;
  openCount: number;
}

export interface Client {
  id: number;
  /** null: importda STIR yo'q/noto'g'ri/takroriy (V26), fayldagi matn stirRaw'da */
  stir: string | null;
  stirRaw?: string | null;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  /** null: importda tanilmagan ("to'ldirilmagan"), fayldagi matn taxTypeRaw'da; vazifa chiqmaydi */
  taxType: TaxType | null;
  taxTypeRaw: string | null;
  taxTypeEffectiveFrom: string | null;
  accountantId: number | null;
  accountantName: string | null;
  status: ClientStatus;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  openTasks?: number;
  overdueTasks?: number;
  /** Faqat rahbarga keladi */
  monthlyFee?: number | null;
  /** Buxgalter ulushi (oylik to'lov x foiz), serverda hisoblanadi */
  accountantShare: number | null;
  bankKey: boolean | null;
  employeeCount: number | null;
  mehnatCheckedAt: string | null;
  mehnatLogin: string | null;
  hasMehnatPassword: boolean;
}

export interface ClientCard extends Client {
  taxHistory: { id: number; taxType: TaxType; effectiveFrom: string; createdAt: string; createdByName: string | null }[];
  /** Holat bo'yicha hisobotlar (dividend, norezident): belgilangan holat oylari 'YYYY-MM' */
  events: { reportTypeId: number; code: string; name: string; nameRu: string; dueDay: number | null; applicable: boolean; months: string[] }[];
  reportExclusions: { reportTypeId: number; code: string; name: string; nameRu: string; effectiveFrom: string }[];
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Task {
  id: number;
  clientId: number;
  clientName: string;
  clientStir: string;
  kind: TaskKind;
  routineTypeId: number | null;
  reportTypeId: number | null;
  reportCode: string | null;
  reportNameRu: string | null;
  routineNameRu: string | null;
  isFreeText: boolean;
  period: string;
  title: string;
  note: string | null;
  assigneeId: number | null;
  assigneeName: string | null;
  createdByName?: string | null;
  dueAt: string | null;
  status: TaskStatus;
  doneAt: string | null;
  doneBy: number | null;
  createdAt: string;
  updatedAt: string;
  overdue: boolean;
  dueSoon: boolean;
  waitingClient: boolean;
  onTime: boolean | null;
  checklistTotal: number;
  checklistDone: number;
  timerStartedAt: string | null;
  spentSec: number;
}

export interface TaskDetail extends Task {
  checklist: { id: number; text: string; done: boolean; sortOrder: number }[];
  timeEntries: { id: number; userId: number; userName: string; startedAt: string; endedAt: string | null }[];
  pendingTransfer: TaskTransfer | null;
  transfers: TaskTransfer[];
}

export interface MyDay {
  period: string;
  /** "Bajarildi" ustuni va kartalari qaysi kalendar davri boshidan (Hafta / Oy / Chorak / Yil) */
  range: StatRange;
  groups: { today: Task[]; urgent: Task[]; overdue: Task[] };
  columns: Record<'TODO' | 'IN_PROGRESS' | 'WAITING_CLIENT' | 'DONE', Task[]>;
  /** Tanlangan davr (range) bo'yicha — server /tasks/my-day izohiga qarang */
  stats: {
    /** davrning ochiq vazifalari: muddati davr oxirigacha (qarz ham) yoki muddatsiz */
    open: number; openTodo: number; openInProgress: number; openWaiting: number;
    /** muddati o'tgan: "Bajarilishi kerak" (kechikkan) / Jarayonda / Mijozdan kutilmoqda */
    overdue: number; overdueInProgress: number; overdueWaiting: number;
    /** davrda o'zi bajargan (done_at davr ichida) */
    done: number; doneOnTime: number; doneLate: number; doneNoDue: number; doneToday: number;
  };
}

export type StatRange = 'week' | 'month' | 'quarter' | 'year';

export type CellState = '1' | '0' | '!' | 'X';

export interface GridColumn {
  reportTypeId: number;
  code: string;
  name: string;
  nameRu: string;
  dueDay: number | null;
  dueDate: string | null;
  createsAccountantTask: boolean;
}

export interface GridRow {
  clientId: number;
  /** null: importda STIR yo'q/noto'g'ri/takroriy (V26), fayldagi matn stirRaw'da */
  stir: string | null;
  stirRaw?: string | null;
  name: string;
  taxType: TaxType | null;
  taxTypeRaw: string | null;
  status: ClientStatus;
  note: string | null;
  accountantId: number | null;
  accountantName: string | null;
  /** noEvent: Dividend/Norezident holati belgilanmagan ("0", vazifa yo'q); markable: bosilsa holat belgisi qo'yiladi */
  /** raw: fayldagi qiymat boricha — soliq turi aniqlanmagan mijozda hamma katak, aks holda 1/0/X deb tanilmagan matn */
  cells: Record<number, { state: CellState; taskId: number | null; taskStatus: TaskStatus | null; noEvent?: boolean; markable?: boolean; raw?: string }>;
}

export interface Grid {
  period: string;
  /** Holat belgisi yoziladigan oy (ko'rilayotgan oydan bir oy oldin); belgilab bo'lmaydigan oyda null */
  eventMonth: string | null;
  columns: GridColumn[];
  rows: GridRow[];
}

/** Oylik ishlar ("Бухгалтер ишлари"): katakda tanlangan oy ishining holati (works.ts, ?month=) */
export type WorkState = 'done' | 'open' | 'soon' | 'waiting' | 'overdue' | 'na';

export interface WorkColumn {
  routineTypeId: number;
  name: string;
  nameRu: string;
  reportTypeId: number | null;
  isFreeText: boolean;
  shortName: string | null;
  shortNameRu: string | null;
  group: string | null;
  groupRu: string | null;
  /** Keyingi oyning nechanchi kunigacha (INPS — hisobot muddati); null — keyingi oy oxiri */
  dueDay: number | null;
}

export interface WorkCell {
  state: WorkState;
  /** Shu oy vazifasi (bajarilgani ham) */
  taskId: number | null;
  /** Vazifasi yo'q, tizimgacha bo'lgan oy (rahbar kiritgan nuqtadan) */
  beforeSystem: boolean;
  /** Bosilganda yopiladigan: shu oy vazifasi yoki tizimgacha bo'lgan navbatdagi oy */
  next: { kind: 'TASK'; taskId: number; status: TaskStatus; month: string } | { kind: 'BASELINE'; month: string } | null;
  /** 'YYYY-MM': tizimgacha qaysi oygacha bajarilgan */
  baseline: string | null;
  /** Fayldagi tanilmagan qiymat ("eri"): oy kiritilguncha boricha ko'rsatiladi */
  raw: string | null;
}

export interface WorksRow {
  clientId: number;
  /** null: importda STIR yo'q/noto'g'ri/takroriy (V26), fayldagi matn stirRaw'da */
  stir: string | null;
  stirRaw?: string | null;
  name: string;
  taxType: TaxType | null;
  taxTypeRaw?: string | null;
  status: ClientStatus;
  note: string | null;
  accountantId: number | null;
  accountantName: string | null;
  monthlyFee?: number | null;
  accountantShare: number | null;
  bankKey: boolean | null;
  employeeCount: number | null;
  mehnatCheckedAt: string | null;
  mehnatLogin: string | null;
  hasMehnatPassword: boolean;
  cells: Record<number, WorkCell>;
}

export interface Works extends Paged<WorksRow> {
  columns: WorkColumn[];
  /** Tanlangan oy 'YYYY-MM' */
  month: string;
  sharePercent: number;
}

export type AdvanceResult =
  | { kind: 'TASK'; task: Task }
  | { kind: 'BASELINE'; month: string; workName: string; workNameRu: string; clientName: string };

export interface ReportType {
  id: number;
  code: string;
  name: string;
  nameRu: string;
  frequency: 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
  dueDay: number | null;
  generationMonths: number[] | null;
  appliesToAos: boolean;
  appliesToQqs: boolean;
  appliesToYatt: boolean;
  createsAccountantTask: boolean;
  requiresEventFlag: boolean;
  sheetAliases: string[];
  active: boolean;
  sortOrder: number;
}

export interface RoutineWork {
  id: number;
  name: string;
  nameRu: string;
  sortOrder: number;
  active: boolean;
  reportTypeId: number | null;
  isFreeText: boolean;
  effectiveFrom: string;
  /** Keyingi oyning nechanchi kunigacha; null — keyingi oy oxiri (INPS — hisobot muddati) */
  dueDay: number | null;
}

export interface UrgentTemplate {
  id: string;
  text: string;
}

export interface AppNotification {
  id: number;
  kind: NotificationKind;
  payload: Record<string, any>;
  taskId: number | null;
  deliverAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  createdAt: string;
}

export type ChatAttachmentKind = 'IMAGE' | 'VIDEO' | 'VOICE' | 'VIDEO_NOTE' | 'FILE';

/** Chat fayli (V43): mazmuni Telegram kanalida, `/api/chat/files/:id` orqali olinadi */
export interface ChatAttachment {
  id: number;
  kind: ChatAttachmentKind;
  mime: string;
  fileName: string | null;
  sizeBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  /** Ovozli xabar to'lqini (0..31), V45; eski xabarlarda null */
  waveform: number[] | null;
}

export interface ChatMessage {
  id: number;
  senderId: number;
  recipientId: number;
  /** Faylli xabarda bo'sh bo'lishi mumkin (izoh) */
  body: string;
  createdAt: string;
  readAt: string | null;
  editedAt: string | null;
  attachment: ChatAttachment | null;
}

export interface ChatContact {
  id: number;
  fullName: string;
  role: Role;
  active: boolean;
  unread: number;
  lastMessage: (Omit<ChatMessage, 'recipientId' | 'editedAt' | 'attachment'> & { attachmentKind: ChatAttachmentKind | null }) | null;
}

/** SSE `chat-message`: xabar + yuboruvchi ismi */
export type ChatMessageEvent = ChatMessage & { senderName: string };

export interface AuditItem {
  id: number;
  entity: string;
  entityId: string | null;
  clientId: number | null;
  clientName: string | null;
  action: string;
  before: unknown;
  after: unknown;
  at: string;
  actorId: number | null;
  actorName: string | null;
}

export interface DashboardClients {
  period: string;
  summary: {
    clients: number;
    /** Joriy oyda vazifasi bor yoki kechikkan mijozlar ("Tayyor" foizi maxraji) */
    withTasks: number;
    ready: number;
    inProgress: number;
    overdue: number;
    tasksTotal: number;
    tasksDone: number;
    /** Barcha oylar */
    tasksOverdue: number;
    /** Faqat joriy oy */
    tasksOverdueMonth: number;
    percent: number;
    /** Soliq turi aniqlanmagan mijozlar */
    incomplete: number;
  };
  clients: {
    clientId: number;
    name: string;
    stir: string;
    status: ClientStatus;
    taxType: TaxType | null;
    /** Importda tanilmagan soliq turi matni (fayldagidek) */
    taxTypeRaw: string | null;
    /** STIR'siz mijoz (V26): fayldagi matn */
    stirRaw: string | null;
    inReports: boolean;
    inWorks: boolean;
    accountantId: number | null;
    accountantName: string | null;
    total: number;
    done: number;
    overdue: number;
    waiting: number;
    /** Tanlangan oyda "Bajarilishi kerak" / "Jarayonda" holatidagi vazifalar */
    todo: number;
    inProgress: number;
    percent: number | null;
    state: 'NONE' | 'READY' | 'OVERDUE' | 'IN_PROGRESS';
  }[];
  /** Buxgalter biriktirilmagan mijozlar: dashboard natijalariga kirmaydi, faqat "Kamchiliklar" uchun */
  unassignedClients?: DashboardClients['clients'];
  overdueTasks: {
    id: number;
    title: string;
    kind: TaskKind;
    dueAt: string;
    status: TaskStatus;
    clientId: number;
    clientName: string;
    assigneeId: number | null;
    assigneeName: string | null;
  }[];
}

export interface DashboardAccountants {
  from: string;
  to: string;
  accountants: {
    id: number;
    fullName: string;
    doneToday: number;
    doneWeek: number;
    doneMonth: number;
    done: number;
    onTime: number;
    onTimePercent: number | null;
    overdue: number;
    waiting: number;
    openTasks: number;
    clients: number;
    spentSec: number;
  }[];
}

export interface ImportReport {
  kind: 'REPORTS' | 'WORKS';
  dryRun: boolean;
  period: string;
  columns: { header: string; code: string }[];
  ignoredColumns?: string[];
  summary: { total: number; created: number; updated: number; unchanged: number; skipped: number; review: number; cellsDone: number };
  rows: { row: number; stir: string; name: string; action: 'NEW' | 'UPDATED' | 'UNCHANGED' | 'SKIPPED'; changes: string[]; review: string[] }[];
  csv: string;
  alreadyImported: PreviousImport | null;
}

/** Shu fayl (mazmuni bo'yicha) avval import qilingan bo'lsa */
export interface PreviousImport {
  fileName: string;
  importedAt: string;
  importedBy: string | null;
}

export interface ReviewItem {
  id: number;
  occurredAt: string;
  ref: string;
  stir: string | null;
  message: string;
  clientId: number | null;
}

// ---------- Sotuv operatori: yangi firmalar (lead) ----------
export type LeadStatus = 'NEW' | 'NO_ANSWER' | 'CALL_LATER' | 'MEETING' | 'HAS_ACCOUNTANT' | 'REJECTED' | 'WON' | 'CONVERTED';
export type LeadResult = Exclude<LeadStatus, 'NEW' | 'CONVERTED'>;
export type LeadView = 'today' | 'open' | 'closed' | 'won' | 'converted' | 'all';

export interface Lead {
  id: number;
  stir: string;
  name: string;
  director: string | null;
  phone: string | null;
  address: string | null;
  registeredAt: string | null;
  status: LeadStatus;
  nextCallDate: string | null;
  lastCallAt: string | null;
  transferredAt: string | null;
  convertedClientId: number | null;
  createdAt: string;
  callCount: number;
  lastComment: string | null;
}

export interface LeadCall {
  id: number;
  result: LeadResult;
  comment: string | null;
  nextCallDate: string | null;
  createdAt: string;
  userName: string;
}

export interface LeadCard extends Lead {
  calls: LeadCall[];
}

export interface LeadStats {
  calls: { day: number; week: number; month: number; dayFirms: number };
  byResult: Partial<Record<LeadResult, number>>;
  byStatus: Partial<Record<LeadStatus, number>>;
  dueToday: number;
}

export interface LeadImportReport {
  dryRun: boolean;
  summary: { total: number; created: number; existingLead: number; existingClient: number; duplicateRow: number; invalid: number; withoutPhone: number };
  rows: { row: number; stir: string; name: string; action: 'NEW' | 'EXISTING_LEAD' | 'EXISTING_CLIENT' | 'DUPLICATE_ROW' }[];
  invalid: { row: number; stir: string; name: string; reason: 'BAD_STIR' | 'NO_NAME' }[];
}
