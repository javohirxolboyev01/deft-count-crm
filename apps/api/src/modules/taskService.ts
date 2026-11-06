import { type AuthUser, isLeader } from '../common/auth';
import { audit } from '../common/audit';
import { AppError, forbidden, notFound } from '../common/errors';
import { config } from '../config';
import { type Db, one, q } from '../db';
import { cancelPendingForTask, notifyLeaders } from './notifications';

export const OPEN_STATUSES = ['TODO', 'IN_PROGRESS', 'WAITING_CLIENT'] as const;
export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'WAITING_CLIENT' | 'DONE' | 'CANCELLED';

/** Ruxsat etilgan o'tishlar. DONE'ga o'tish markDone orqali; DONE -> TODO faqat rahbar (qayta ochish). */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  TODO: ['IN_PROGRESS', 'WAITING_CLIENT', 'DONE'],
  IN_PROGRESS: ['TODO', 'WAITING_CLIENT', 'DONE'],
  WAITING_CLIENT: ['TODO', 'IN_PROGRESS', 'DONE'],
  DONE: ['TODO'],
  CANCELLED: [],
};

/** Frontend uchun vazifa DTO: v_task_state hisoblangan flaglari bilan (muddati o'tgan saqlanmaydi) */
export const TASK_SELECT = `
  SELECT t.id, t.client_id AS "clientId", c.name AS "clientName", c.stir AS "clientStir",
         t.kind, t.routine_type_id AS "routineTypeId", t.report_type_id AS "reportTypeId",
         rt.code AS "reportCode", rt.name_ru AS "reportNameRu", rw.name_ru AS "routineNameRu",
         coalesce(rw.is_free_text, false) AS "isFreeText",
         to_char(t.period, 'YYYY-MM') AS period, t.title, t.note,
         t.assignee_id AS "assigneeId", a.full_name AS "assigneeName",
         t.due_at AS "dueAt", t.status, t.done_at AS "doneAt", t.done_by AS "doneBy",
         t.created_by AS "createdBy", cb.full_name AS "createdByName", t.created_at AS "createdAt", t.updated_at AS "updatedAt",
         t.is_overdue AS overdue, t.is_due_soon AS "dueSoon", t.is_waiting_client AS "waitingClient",
         t.on_time AS "onTime",
         (SELECT count(*) FROM task_checklist_item ci WHERE ci.task_id = t.id)::int AS "checklistTotal",
         (SELECT count(*) FROM task_checklist_item ci WHERE ci.task_id = t.id AND ci.done)::int AS "checklistDone",
         (SELECT min(te.started_at) FROM time_entry te WHERE te.task_id = t.id AND te.ended_at IS NULL) AS "timerStartedAt",
         (SELECT coalesce(sum(extract(epoch FROM coalesce(te.ended_at, now()) - te.started_at)), 0)::int
            FROM time_entry te WHERE te.task_id = t.id) AS "spentSec"
  FROM v_task_state t
  JOIN client c ON c.id = t.client_id
  LEFT JOIN report_type rt ON rt.id = t.report_type_id
  LEFT JOIN routine_work_type rw ON rw.id = t.routine_type_id
  LEFT JOIN app_user a ON a.id = t.assignee_id
  LEFT JOIN app_user cb ON cb.id = t.created_by`;

interface TaskRow {
  id: number;
  client_id: number;
  status: TaskStatus;
  prev_status: TaskStatus | null;
  assignee_id: number | null;
  accountant_id: number | null;
  title: string;
  client_name: string;
  done_by: number | null;
  done_at: Date | null;
}

/** Ruxsat: rahbar hammasi; buxgalter o'ziga biriktirilgan yoki o'z mijozining vazifasi */
export async function lockTaskForUser(db: Db, taskId: number, user: AuthUser | null): Promise<TaskRow> {
  const t = await one<TaskRow>(
    db,
    `SELECT t.id, t.client_id, t.status, t.prev_status, t.assignee_id, t.title, t.done_by, t.done_at,
            c.accountant_id, c.name AS client_name
     FROM task t JOIN client c ON c.id = t.client_id WHERE t.id = $1 FOR UPDATE OF t`,
    [taskId],
  );
  if (!t) throw notFound('Vazifa');
  if (user) assertTaskAccess(user, t);
  return t;
}

export function assertTaskAccess(user: AuthUser, t: { assignee_id: number | null; accountant_id: number | null }) {
  if (isLeader(user)) return;
  if (t.assignee_id === user.id || t.accountant_id === user.id) return;
  throw forbidden();
}

export async function getTaskDto(db: Db, id: number) {
  return one(db, `${TASK_SELECT} WHERE t.id = $1`, [id]);
}

export async function stopTimersForTask(db: Db, taskId: number) {
  await db.query('UPDATE time_entry SET ended_at = now() WHERE task_id = $1 AND ended_at IS NULL', [taskId]);
}

/** "Jarayonda": taymer o'zi yoqiladi. Foydalanuvchida boshqa ochiq taymer bo'lsa, u to'xtatiladi
 *  (bir vaqtda bitta ish; o'sha vazifa holati o'zgarmaydi, faqat vaqt hisobi to'xtaydi). */
async function startTimer(db: Db, taskId: number, userId: number) {
  await db.query('UPDATE time_entry SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL', [userId]);
  await db.query('INSERT INTO time_entry (task_id, user_id) VALUES ($1, $2)', [taskId, userId]);
}

export async function changeStatus(db: Db, taskId: number, user: AuthUser, next: TaskStatus) {
  if (next === 'DONE') return markDone(db, taskId, user);
  const t = await lockTaskForUser(db, taskId, user);
  if (t.status === next) return getTaskDto(db, taskId);
  if (!TRANSITIONS[t.status].includes(next)) {
    throw new AppError(409, 'INVALID_TRANSITION', `${t.status} -> ${next} o'tishi mumkin emas`, { from: t.status, to: next });
  }
  if (t.status === 'DONE' && !isLeader(user)) {
    throw new AppError(403, 'REOPEN_LEADER_ONLY', 'Bajarilgan vazifani faqat rahbar qayta ochadi');
  }
  if (t.status === 'IN_PROGRESS') await stopTimersForTask(db, taskId);
  await db.query(
    `UPDATE task SET status = $2, done_at = NULL, done_by = NULL, prev_status = NULL WHERE id = $1`,
    [taskId, next],
  );
  if (next === 'IN_PROGRESS') await startTimer(db, taskId, user.id);
  await audit(db, {
    actorId: user.id,
    entity: 'task',
    entityId: taskId,
    clientId: t.client_id,
    action: t.status === 'DONE' ? 'REOPEN' : 'STATUS',
    before: { status: t.status },
    after: { status: next },
  });
  return getTaskDto(db, taskId);
}

export interface MarkDoneOptions {
  /** false: import paytida rahbarlarga xabar yuborilmaydi */
  notify?: boolean;
  source?: 'APP' | 'GRID' | 'WORKS' | 'SHEET' | 'IMPORT';
}

/**
 * "Bajarildi" (6.6): status DONE + done_at; rahbarlarga bildirishnoma kechiktirib navbatga qo'yiladi.
 * Qaror: deliver_at = now() + 5s + 1s zaxira. Undo faqat 5 soniya ichida ruxsat etiladi, dispatcher esa
 * 6-soniyadan keyin yuboradi: shunda undo va yuborish poygasi bo'lmaydi.
 */
export async function markDone(db: Db, taskId: number, user: AuthUser | null, opts: MarkDoneOptions = {}) {
  const t = await lockTaskForUser(db, taskId, user);
  if (t.status === 'DONE') throw new AppError(409, 'ALREADY_DONE', 'Vazifa allaqachon bajarilgan');
  if (t.status === 'CANCELLED') throw new AppError(409, 'TASK_CANCELLED', 'Vazifa bekor qilingan');
  await stopTimersForTask(db, taskId);
  await db.query(
    `UPDATE task SET prev_status = status, status = 'DONE', done_at = now(), done_by = $2 WHERE id = $1`,
    [taskId, user?.id ?? null],
  );
  await audit(db, {
    actorId: user?.id ?? null,
    entity: 'task',
    entityId: taskId,
    clientId: t.client_id,
    action: 'DONE',
    before: { status: t.status },
    after: { status: 'DONE', source: opts.source ?? 'APP' },
  });
  if (opts.notify !== false) {
    await notifyLeaders(db, {
      kind: 'TASK_DONE',
      taskId,
      delaySec: config.undoWindowSec + 1,
      exceptUserId: user?.id ?? null,
      payload: { taskId, taskTitle: t.title, clientId: t.client_id, clientName: t.client_name, actorName: user?.fullName ?? null },
    });
  }
  return getTaskDto(db, taskId);
}

/** 5 soniya ichida "Bekor qilish": holat qaytadi, rahbarga ketadigan xabar cancelled_at bilan bekor qilinadi */
export async function undoDone(db: Db, taskId: number, user: AuthUser) {
  const t = await lockTaskForUser(db, taskId, user);
  if (t.status !== 'DONE') throw new AppError(409, 'NOT_DONE', 'Vazifa bajarilgan holatda emas');
  if (!isLeader(user) && t.done_by !== user.id) throw forbidden();
  const w = await one<{ expired: boolean }>(
    db,
    `SELECT now() - done_at > make_interval(secs => $2) AS expired FROM task WHERE id = $1`,
    [taskId, config.undoWindowSec],
  );
  if (w!.expired) throw new AppError(409, 'UNDO_EXPIRED', 'Bekor qilish vaqti (5 soniya) o\'tib ketdi');
  const restored: TaskStatus = t.prev_status && t.prev_status !== 'DONE' ? t.prev_status : 'TODO';
  await db.query(`UPDATE task SET status = $2, done_at = NULL, done_by = NULL, prev_status = NULL WHERE id = $1`, [
    taskId,
    restored,
  ]);
  if (restored === 'IN_PROGRESS') await startTimer(db, taskId, user.id);
  const cancelled = await cancelPendingForTask(db, taskId, 'TASK_DONE');
  await audit(db, {
    actorId: user.id,
    entity: 'task',
    entityId: taskId,
    clientId: t.client_id,
    action: 'UNDO_DONE',
    before: { status: 'DONE' },
    after: { status: restored, cancelledNotifications: cancelled },
  });
  return getTaskDto(db, taskId);
}

/**
 * Qayta ochilgan vazifa muddati joriy qoidadan (fn_task_rule_due_at, V37; `time` — muddat soati parametri).
 * Bajarilgan/bekor qilingan vazifada eski muddat qolishi mumkin (sozlama o'zgargan, V36 surilishi) — 0 tanlanganda
 * sarlavhadagi muddat bilan bir xil bo'lsin. Muddati allaqachon o'tgan bo'lsa "muddat o'tdi" xabari yuborilmaydi.
 */
export const reopenDue = (alias: string, time = '$2') =>
  `due_at = fn_task_rule_due_at(${alias}id, ${time}),
   overdue_notified_at = CASE WHEN fn_task_rule_due_at(${alias}id, ${time}) < now() THEN coalesce(${alias}overdue_notified_at, now()) END`;

/** Tizim tomonidan qayta ochish (masalan Sheet'da 1 -> 0) */
export async function reopenBySystem(db: Db, taskId: number, reason: string) {
  const t = await lockTaskForUser(db, taskId, null);
  if (t.status !== 'DONE') return;
  await db.query(`UPDATE task SET status = 'TODO', done_at = NULL, done_by = NULL, prev_status = NULL WHERE id = $1`, [
    taskId,
  ]);
  await audit(db, {
    actorId: null,
    entity: 'task',
    entityId: taskId,
    clientId: t.client_id,
    action: 'REOPEN',
    before: { status: 'DONE' },
    after: { status: 'TODO', source: reason },
  });
}

export async function listTasks(db: Db, where: string[], params: unknown[], order = 't.due_at NULLS LAST, t.id') {
  return q(db, `${TASK_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order}`, params);
}
