import colors from 'tailwindcss/colors';
import defaultTheme from 'tailwindcss/defaultTheme';
import plugin from 'tailwindcss/plugin';

// Dizayn WinPro admin CRM bilan bir xil: teal brend (#37a0ad), to'q ko'k (#1a344d) matn, Inter shrifti,
// och-havorang sahifa foni ustida oq kartalar.
//
// Qorong'i rejim: komponentlarda neytral (gray) va holat ranglari uchun `dark:` yozilmaydi. Palitra CSS
// o'zgaruvchilari orqali beriladi, `.dark` sinfida shkala teskari aylanadi (50↔950, 600→400 ...). Shunda
// bg-white/bg-gray-50 qorong'i fon, text-gray-900 och matn bo'ladi.
// Brend shkalasi (brand-25..950) esa ATAYLAB teskari aylanmaydi — WinPro'dagi kabi `dark:` bilan yoziladi.
const PALETTES = ['gray', 'red', 'green', 'amber', 'yellow', 'orange', 'blue', 'teal', 'indigo'];
const SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};
const ref = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

// WinPro brend shkalasi (src/styles/globals.css, --color-brand-*)
const BRAND = {
  25: '#f0fdfe',
  50: '#e6fafb',
  100: '#ccf4f6',
  200: '#99e9ed',
  300: '#66dee4',
  400: '#4cc4cc',
  500: '#37a0ad',
  600: '#2e8a96',
  700: '#26747f',
  800: '#1e5e68',
  900: '#164851',
  950: '#0e323a',
};

// Yorug' rejim: matn, chegara va holat ranglari (200..800) yarim pog'ona to'qroq — oq fonda aniqroq o'qilsin.
// Fon tonlari (50/100) o'zgarmaydi; qorong'i rejimga ta'sir qilmaydi
const DARKEN = 0.5;
const mix = (a, b, t) => {
  const [x, y] = [a, b].map((h) => parseInt(h.slice(1), 16));
  const ch = (sh) => Math.round(((x >> sh) & 255) * (1 - t) + ((y >> sh) & 255) * t);
  return `${ch(16)} ${ch(8)} ${ch(0)}`;
};

const light = { '--c-white': rgb('#ffffff') };
const dark = { '--c-white': rgb(colors.gray[800]) };
for (const p of PALETTES) {
  SHADES.forEach((s, i) => {
    light[`--c-${p}-${s}`] = +s >= 200 && +s <= 800 ? mix(colors[p][s], colors[p][SHADES[i + 1]], DARKEN) : rgb(colors[p][s]);
    dark[`--c-${p}-${s}`] = rgb(colors[p][SHADES[SHADES.length - 1 - i]]);
  });
}
// gray: WinPro qorong'i rejimi — sahifa gray-900, karta gray-800; hover (100) va chegara (200) ajralib tursin
Object.assign(dark, {
  '--c-gray-50': rgb(colors.gray[900]),
  '--c-gray-100': rgb(colors.gray[700]),
  '--c-gray-200': rgb('#363f4d'),
  '--c-gray-950': rgb('#ffffff'),
});
Object.assign(light, {
  '--c-page': rgb('#e8f0fb'), // WinPro --background (#f1f7ff) biroz to'qroq: oq kartalar ajralib tursin
  '--c-ink': rgb('#1a344d'), // WinPro --text-primary
  '--c-foreground': rgb('#35496d'), // WinPro --foreground (sarlavhalar)
  '--c-brand': rgb(BRAND[500]),
  '--c-brand-light': rgb(BRAND[50]),
  '--c-skeleton': rgb(colors.slate[300]),
});
Object.assign(dark, {
  '--c-page': rgb(colors.gray[900]),
  '--c-ink': rgb('#ffffff'),
  '--c-foreground': rgb('#fafafa'),
  '--c-brand': rgb(BRAND[400]),
  '--c-brand-light': rgb('#193a43'), // brand-500/12 gray-900 ustida
  '--c-skeleton': rgb(colors.gray[800]),
});

const palette = Object.fromEntries(PALETTES.map((p) => [p, Object.fromEntries(SHADES.map((s) => [s, ref(`${p}-${s}`)]))]));
const status = (p) => ({ DEFAULT: ref(`${p}-600`), bg: ref(`${p}-100`), border: ref(`${p}-300`) });

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'Arial', ...defaultTheme.fontFamily.sans] },
      colors: {
        ...palette,
        white: ref('white'),
        // Qat'iy oq: brend/rangli tugma ustidagi matn (mavzuga qarab aylanmaydi)
        'on-brand': '#ffffff',
        navy: '#1a344d', // WinPro --primary
        page: ref('page'),
        ink: ref('ink'),
        foreground: ref('foreground'),
        skeleton: ref('skeleton'),
        // Vazifa holati ranglari (CLAUDE.md 6.5)
        overdue: status('red'),
        soon: status('yellow'),
        waiting: status('orange'),
        done: status('green'),
        brand: { ...BRAND, DEFAULT: ref('brand'), light: ref('brand-light') },
      },
      borderColor: { DEFAULT: ref('gray-200') },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        pop: '0 20px 50px -12px rgb(15 23 42 / 0.35)',
        aesthetic: '0 3px 10px var(--shadow-custom)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' } },
        'pop-in': { from: { opacity: '0', transform: 'scale(0.95)' } },
        'slide-in': { from: { transform: 'translateX(100%)' } },
        'spin-fade': { from: { opacity: '1' }, to: { opacity: '0' } },
        // Qo'ng'iroq: qisqa chayqalish, keyin tinch pauza (infinite bilan davriy "jaranglaydi")
        'bell-ring': {
          '0%, 30%, 100%': { transform: 'rotate(0)' },
          '3%': { transform: 'rotate(18deg)' },
          '7%': { transform: 'rotate(-16deg)' },
          '11%': { transform: 'rotate(12deg)' },
          '15%': { transform: 'rotate(-9deg)' },
          '19%': { transform: 'rotate(5deg)' },
          '23%': { transform: 'rotate(-3deg)' },
        },
        'badge-pop': { '0%': { transform: 'scale(0)' }, '60%': { transform: 'scale(1.25)' }, '100%': { transform: 'scale(1)' } },
        // Sahifa loaderi: belgi sekin "nafas oladi", nuqtalar navbat bilan ko'tariladi
        breathe: { '0%, 100%': { transform: 'scale(0.92)', opacity: '0.85' }, '50%': { transform: 'scale(1)', opacity: '1' } },
        'dot-rise': { '0%, 60%, 100%': { transform: 'translateY(0)', opacity: '0.35' }, '30%': { transform: 'translateY(-4px)', opacity: '1' } },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'pop-in': 'pop-in 200ms ease-out',
        'slide-in': 'slide-in 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        'spin-fade': 'spin-fade 1.2s linear infinite',
        'bell-ring': 'bell-ring 3.5s ease-in-out infinite',
        'badge-pop': 'badge-pop 400ms cubic-bezier(0.34, 1.56, 0.64, 1)',
        breathe: 'breathe 1.8s ease-in-out infinite',
        'dot-rise': 'dot-rise 1.2s ease-in-out infinite',
        'orbit': 'spin 1.4s cubic-bezier(0.5, 0.15, 0.5, 0.85) infinite',
        // Tez yuklansa loader umuman ko'rinmasin (miltillamaslik uchun kechikib chiqadi)
        'fade-in-late': 'fade-in 250ms ease-out 150ms both',
      },
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ':root': { ...light, '--shadow-custom': 'rgb(0 0 0 / 0.2)', colorScheme: 'light' },
        ':root.dark': { ...dark, '--shadow-custom': 'rgb(255 255 255 / 0.1)', colorScheme: 'dark' },
        '*, ::before, ::after': { '--tw-ring-offset-color': 'rgb(var(--c-white))' },
      });
    }),
  ],
};
