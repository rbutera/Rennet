import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
const dir = "/Users/rai/dev/rennet/spikes/sidebar-lockup-prototypes";
const b = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const p = await b.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 2 });
  await p.goto(pathToFileURL(`${dir}/index.html`).href);
  await p.evaluate((s) => document.documentElement.setAttribute("data-scheme", s), scheme);
  await p.evaluate(() => document.fonts.ready);
  const box = await p.evaluate(() => document.body.scrollHeight);
  console.log(scheme, "height", box);
  await p.screenshot({ path: `${dir}/preview-${scheme}.png`, fullPage: true });
  await p.close();
}
await b.close();
