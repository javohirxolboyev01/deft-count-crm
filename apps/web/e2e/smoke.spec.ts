import { type Page, expect, test } from '@playwright/test';

const PASSWORD = '123456';

async function login(page: Page, login: string) {
  await page.goto('/login');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Parol', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Kirish' }).click();
  await expect(page.getByRole('navigation', { name: 'Asosiy menyu' })).toBeVisible();
}

/** Yangi mijoz o'z sahifasidan: Buxgalter ishlari -> to'liq forma, kartaga o'tadi; Hisobot topshirish -> jadval maydonlari, jadvalda qoladi */
async function createClient(page: Page, c: { stir: string; name: string; tax: 'AOS' | 'QQS' }, from: 'clients' | 'monthly' = 'clients') {
  await page.goto(`/${from}`);
  if (from === 'monthly') {
    await page.getByRole('button', { name: 'Yangi mijoz' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('STIR').fill(c.stir);
    await dlg.getByLabel('Korxona nomi').fill(c.name);
    await dlg.getByLabel('Soliq turi').click();
    await page.getByRole('option', { name: c.tax, exact: true }).click();
    await dlg.getByRole('button', { name: 'Yaratish' }).click();
    await expect(page.getByRole('button', { name: `${c.name} — Korxona nomi` })).toBeVisible();
    return;
  }
  await page.getByRole('button', { name: 'Yangi mijoz' }).click();
  // Sahifadagi filtrlarda ham "Soliq turi" bor: faqat dialog ichidan
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('STIR').fill(c.stir);
  await dlg.getByLabel('Korxona nomi').fill(c.name);
  await dlg.getByLabel('Soliq turi', { exact: true }).click();
  await page.getByRole('option', { name: c.tax, exact: true }).click();
  await dlg.getByLabel('Javobgar buxgalter').click();
  await page.getByRole('option', { name: /Aziza Karimova/ }).click();
  await dlg.getByRole('button', { name: 'Yaratish' }).click();
  await expect(page).toHaveURL(/\/clients\/\d+$/);
  await expect(page.getByRole('heading', { name: c.name })).toBeVisible();
}

test('login: rahbar dashboardga, buxgalter rahbar sahifalariga kira olmaydi', async ({ page }) => {
  await login(page, 'rahbar');
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole('heading', { name: 'Buxgalterlar', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Chiqish' }).click();
  await login(page, 'aziza');
  await expect(page).toHaveURL(/\/my-day/);
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/my-day/);
  await expect(page.getByRole('link', { name: 'Sozlamalar' })).toHaveCount(0);
});

test('mijoz yaratish (AOS va QQS) va oylik jadvalda X qoidasi', async ({ page }) => {
  await login(page, 'rahbar');
  // Hisobot topshirish sahifasidan: faqat shu bo'limga qo'shiladi
  await createClient(page, { stir: '401000001', name: 'E2E AOS MChJ', tax: 'AOS' }, 'monthly');
  await createClient(page, { stir: '401000002', name: 'E2E QQS MChJ', tax: 'QQS' }, 'monthly');
  await page.goto('/monthly');
  await page.getByLabel('Qidiruv').fill('E2E');
  await expect(page.getByRole('button', { name: 'E2E AOS MChJ — Korxona nomi' })).toBeVisible();
  // AOS: QQS va Foyda "X"; QQS: AOS "X" (jadvaldagi X belgisi, Exceldagidek)
  await expect(page.getByRole('button', { name: 'E2E AOS MChJ — QQS: Topshirmaydi' })).toHaveText('X');
  await expect(page.getByRole('button', { name: "E2E AOS MChJ — Foyda solig'i: Topshirmaydi" })).toHaveText('X');
  await expect(page.getByRole('button', { name: 'E2E QQS MChJ — AOS: Topshirmaydi' })).toHaveText('X');
  await expect(page.getByRole('button', { name: /^E2E AOS MChJ — AOS:/ })).not.toHaveText('X');
  await expect(page.getByRole('button', { name: /^E2E QQS MChJ — QQS:/ })).not.toHaveText('X');
  // Katak bosish -> 1 / 0 / X menyusi (Excel kabi): 1 — Bajarildi
  await page.getByRole('button', { name: /^E2E QQS MChJ — QQS:/ }).click();
  await page.getByRole('menuitemradio', { name: /Topshirildi/ }).click();
  await expect(page.getByText(/«QQS» bajarildi/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^E2E QQS MChJ — QQS:/ })).toHaveText('✓');
  // Soliq turi qoidasi to'smaydi: AOS to'lovchiga QQS katagi 0 qilinadi
  await page.getByRole('button', { name: 'E2E AOS MChJ — QQS: Topshirmaydi' }).click();
  await page.getByRole('menuitemradio', { name: /Topshirilmagan/ }).click();
  await expect(page.getByRole('button', { name: /^E2E AOS MChJ — QQS:/ })).toHaveText('○');
  if (process.env.E2E_SHOTS_DIR) await page.screenshot({ path: `${process.env.E2E_SHOTS_DIR}/9-report-cell.png`, fullPage: true });
});

test('Bajarildi + 5 soniyalik Bekor qilish', async ({ page }) => {
  await login(page, 'aziza');
  const todo = page.getByRole('region', { name: 'Bajarilishi kerak' });
  const firstTitle = (await todo.locator('button.block span.font-medium').first().textContent())!;
  const before = await todo.getByRole('button', { name: 'Bajarildi' }).count();
  await todo.getByRole('button', { name: 'Bajarildi' }).first().click();
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'bajarildi' });
  await expect(toast).toBeVisible();
  await expect(todo.getByRole('button', { name: 'Bajarildi' })).toHaveCount(before - 1);
  await toast.getByRole('button', { name: 'Bekor qilish' }).click();
  await expect(page.getByText('Bekor qilindi')).toBeVisible();
  await expect(todo.getByRole('button', { name: 'Bajarildi' })).toHaveCount(before);
  await expect(todo.getByText(firstTitle).first()).toBeVisible();
});

test('shoshilinch vazifa: buxgalter ekranida bir necha soniyada qizil xabar', async ({ browser }) => {
  const accCtx = await browser.newContext();
  const acc = await accCtx.newPage();
  await login(acc, 'aziza');
  await acc.waitForTimeout(1000); // SSE ulanishi

  const leadCtx = await browser.newContext();
  const lead = await leadCtx.newPage();
  await login(lead, 'rahbar');
  const started = Date.now();
  await lead.getByRole('button', { name: 'Yangi vazifa' }).click();
  const dialog = lead.getByRole('dialog');
  await dialog.getByPlaceholder(/Mijoz nomi yoki STIR/).fill('SHERPROM');
  await expect(dialog.getByRole('button', { name: /SHERPROM STROY/ })).toBeVisible();
  await dialog.getByPlaceholder(/Mijoz nomi yoki STIR/).press('Enter');
  await dialog.getByLabel('Vazifa matni').fill('E2E: bank ko\'chirmasini bugun kiritish');
  await dialog.getByRole('radio', { name: /Aziza Karimova/ }).check();
  await dialog.getByRole('button', { name: 'Yuborish' }).click();
  await expect(lead.getByText('Shoshilinch vazifa yuborildi')).toBeVisible();
  expect(Date.now() - started).toBeLessThan(10_000);

  await expect(acc.locator('[data-sonner-toast]').filter({ hasText: "Shoshilinch vazifa: «E2E: bank ko'chirmasini" })).toBeVisible({ timeout: 8000 });
  await accCtx.close();
  await leadCtx.close();
});

test("Buxgalter ishlari: mijoz maydonlari Excel'dagidek katak ichida tahrirlanadi", async ({ page }) => {
  await login(page, 'rahbar');
  await createClient(page, { stir: '401000009', name: 'E2E EDIT MChJ', tax: 'AOS' });
  await page.goto('/clients');
  await page.getByLabel('Qidiruv').fill('E2E EDIT');
  const name = 'E2E EDIT MChJ';
  // Oylik to'lov: bosish -> input, Enter saqlaydi, 1,500,000 ko'rinishida
  await page.getByRole('button', { name: `${name} — Oylik to'lov` }).click();
  await page.getByLabel(`${name} — Oylik to'lov`).fill('');
  await page.getByLabel(`${name} — Oylik to'lov`).pressSequentially('1500000');
  // Yozish paytida formatlanadi
  await expect(page.getByLabel(`${name} — Oylik to'lov`)).toHaveValue('1,500,000');
  await page.getByLabel(`${name} — Oylik to'lov`).press('Enter');
  await expect(page.getByRole('button', { name: `${name} — Oylik to'lov` })).toHaveText('1,500,000');
  // Ish katagi Exceldagidek: 1 / 0 / X menyusi (V31). Joriy oy "Ish haqi": 1 -> ✓, X -> X
  const salary = page.getByRole('button', { name: new RegExp(`^${name} — Ish haqi:`) });
  await salary.click();
  await page.getByRole('menuitemradio', { name: /Bajarilgan/ }).click();
  await expect(page.getByText(/bajarildi \(E2E EDIT MChJ\)/)).toBeVisible();
  await expect(salary).toHaveText('✓');
  await salary.click();
  await page.getByRole('menuitemradio', { name: /Chiqmaydi/ }).click();
  await expect(salary).toHaveText('X');
  // Xodim soni va login
  await page.getByRole('button', { name: `${name} — Xodim soni` }).click();
  await page.getByLabel(`${name} — Xodim soni`).fill('4');
  await page.getByLabel(`${name} — Xodim soni`).press('Enter');
  await page.getByRole('button', { name: `${name} — Login` }).click();
  await page.getByLabel(`${name} — Login`).fill('e2elogin');
  await page.getByLabel(`${name} — Login`).press('Enter');
  // Bank-klyuch: katak ichidagi ro'yxat
  await page.getByRole('combobox', { name: `${name} — Bank-klyuch` }).click();
  await page.getByRole('option', { name: 'Bor', exact: true }).click();
  // Esc bekor qiladi
  await page.getByRole('button', { name: `${name} — Xodim soni` }).click();
  await page.getByLabel(`${name} — Xodim soni`).fill('99');
  await page.getByLabel(`${name} — Xodim soni`).press('Escape');

  await page.reload();
  await page.getByLabel('Qidiruv').fill('E2E EDIT');
  await expect(page.getByRole('button', { name: `${name} — Oylik to'lov` })).toHaveText('1,500,000');
  await expect(page.getByRole('button', { name: `${name} — Xodim soni` })).toHaveText('4');
  await expect(page.getByRole('button', { name: `${name} — Login` })).toHaveText('e2elogin');
  await expect(page.getByRole('combobox', { name: `${name} — Bank-klyuch` })).toContainText('Bor');

  // Buxgalter: o'z maydonlarini tahrirlaydi, javobgar va oylik to'lov yo'q/o'zgarmaydi
  await page.getByRole('button', { name: 'Chiqish' }).click();
  await login(page, 'aziza');
  await page.goto('/clients');
  await page.getByLabel('Qidiruv').fill('E2E EDIT');
  await expect(page.getByRole('link', { name })).toBeVisible();
  await expect(page.getByRole('button', { name: `${name} — Oylik to'lov` })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: `${name} — Javobgar` })).toHaveCount(0);
  await page.getByRole('button', { name: `${name} — Xodim soni` }).click();
  await page.getByLabel(`${name} — Xodim soni`).fill('6');
  await page.getByLabel(`${name} — Xodim soni`).press('Enter');
  await expect(page.getByText('Saqlandi')).toBeVisible();
  await expect(page.getByRole('button', { name: `${name} — Xodim soni` })).toHaveText('6');
});
