-- «Nomzod qo'shish» (rahbar so'rovi 2026-11-17): operator boshqa saytlardan topgan yangi firmani qo'lda kiritadi.
-- Bunday firmaning STIR'i ko'pincha noma'lum: STIR ixtiyoriy bo'ladi (UNIQUE saqlanadi, NULL'lar takrorlanishi mumkin).
ALTER TABLE lead ALTER COLUMN stir DROP NOT NULL;
-- Kim qo'shgan: Excel'dan (IMPORT) yoki qo'lda (MANUAL)
ALTER TABLE lead ADD COLUMN source text NOT NULL DEFAULT 'IMPORT' CHECK (source IN ('IMPORT', 'MANUAL'));
