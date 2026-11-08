// Кадры окна-держателя обновления (R203): заставка в состоянии «Устанавливаем…» без строки текста — её рисует
// сам держатель шрифтом Windows. Пересобрать после смены анимации заставки:
//
//   PLAYWRIGHT=<путь к playwright/index.mjs> node scripts/render-update-holder.mjs "$PWD/src/shell/splash.html" <папка кадров>
//   ffmpeg -framerate 25 -i <папка>/f%03d.png -vf "palettegen=max_colors=255:stats_mode=full" pal.png
//   ffmpeg -framerate 25 -i <папка>/f%03d.png -i pal.png -lavfi "paletteuse=dither=sierra2_4a" -loop 0 src/shell/update-holder.gif
//
// Печатает рамку строки состояния (в CSS-пикселях) — её берёт `update-holder.ps1` (STATUS_*).
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const [, , page_, out] = process.argv;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 300, height: 360 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' });
await ctx.addInitScript(() => {
  window.cordShell = { on: (_n, cb) => setTimeout(() => cb({ stage: 'installing', progress: 1, problem: '' })), emit() {} };
});
const page = await ctx.newPage();
await page.goto('file://' + page_);
await page.waitForTimeout(300);
// Текст рисует держатель шрифтом Windows — в кадрах его нет; полосы нет и так.
const box = await page.evaluate(() => {
  const s = document.getElementById('status');
  const r = s.getBoundingClientRect();
  s.style.visibility = 'hidden';
  return { top: r.top, left: r.left, width: r.width, height: r.height };
});
console.log(JSON.stringify(box));
await page.evaluate(() => document.getAnimations().forEach((a) => a.pause()));
const FPS = 25, LOOP = 2400;
let i = 0;
for (let t = 0; t < LOOP; t += 1000 / FPS) {
  await page.evaluate((t) => {
    for (const a of document.getAnimations()) {
      const name = a.animationName;
      // Наклон и тень — в середине хода: петля GIF — период полосок (2,4 с), без скачка.
      a.currentTime = name === 'bob' ? t : 3000;
    }
  }, t);
  await page.screenshot({ path: `${out}/f${String(i++).padStart(3, '0')}.png` });
}
await browser.close();
