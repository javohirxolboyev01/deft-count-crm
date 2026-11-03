-- "<korxona>: <ish>: sana tanilmadi" — Buxgalter ishlari katagida shu ishning oyi kiritilganda o'zi yopiladi
-- (src/modules/sheets/review.ts: routineField)
UPDATE sheet_sync_error SET fields = ARRAY['routine:' || substring(message from ': ([^:]+): sana tanilmadi "')]
WHERE message ~ ': [^:]+: sana tanilmadi "';
