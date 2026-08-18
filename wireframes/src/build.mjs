// Emit self-contained wireframe HTML frames into src/ (one .html each).
// Badges are assigned by flow position so renumbering never touches frame code.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { doc } from './kit.mjs';
import { frame00 } from './frame00.mjs';
import { frame01, frame02, frame03, frame04 } from './onboarding.mjs';
import { frameProjectsList } from './projectslist.mjs';
import { frame05 } from './frame05.mjs';
import { frame06, frame07, frame08, frame09, frame10, frameNoise } from './review.mjs';
import { frameDeltaReview } from './deltareview.mjs';
import { frame11, frame12, frame13, frame14, frame15, frame16 } from './finalize.mjs';
import { frame18 } from './navmodel.mjs';
import { frameM1, frameM2, frameM3, frameM4, frameM5, frameM6 } from './mobile.mjs';

const __dir = dirname(fileURLToPath(import.meta.url)); // .../src

// flow order (Noise slots in at 10, alongside the other review lenses)
const FRAMES = {
  '00-legend': frame00,
  '01-first-run': frame01,
  '02-add-project': frame02,
  '03-worktree-config': frame03,
  '04-processing': frame04,
  '04a-projects-list': frameProjectsList,
  '05-project-detail': frame05,
  '06-review-heart': frame06,
  '06a-delta-rereview': frameDeltaReview,
  '07-spec-view': frame07,
  '08-decisions': frame08,
  '09-flagged': frame09,
  '10-noise-lens': frameNoise,
  '11-symbol-inspector': frame10,
  '12-collation-draft': frame11,
  '13-paper-sign': frame12,
  '14-questions': frame13,
  '15-settings': frame14,
  '16-command-palette': frame15,
  '17-flow-overview': frame16,
  '18-navigation-model': frame18,
  '19-mobile-pairing': frameM1,
  '20-mobile-review-list': frameM2,
  '21-mobile-review-detail': frameM3,
  '22-mobile-ask': frameM4,
  '23-mobile-publish': frameM5,
  '24-mobile-notifications': frameM6,
};

export const NAMES = Object.keys(FRAMES);

Object.entries(FRAMES).forEach(([name, fn]) => {
  const spec = fn();
  spec.head.badge = name.split('-')[0]; // badge derives from the filename prefix (05, 04a, …)
  const html = doc(spec);
  writeFileSync(resolve(__dir, `${name}.html`), html);
  console.log('wrote', `${name}.html`, `(${Math.round(html.length / 1024)} KB)`);
});
