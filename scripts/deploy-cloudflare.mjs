// Deploys dist/ to Cloudflare Pages and wires the custom domain, using ONLY the credentials in the
// environment (see .env.example). No wrangler login session is consulted.
// Usage: node --env-file=.env scripts/deploy-cloudflare.mjs [--skip-build]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const env = process.env;
const required = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_PAGES_PROJECT', 'CLOUDFLARE_ZONE', 'DEPLOY_DOMAIN'];
const missing = required.filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')} (see .env.example)`);
  process.exit(1);
}
const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_PAGES_PROJECT: project, CLOUDFLARE_ZONE: zoneName, DEPLOY_DOMAIN: domain } = env;
const API = 'https://api.cloudflare.com/client/v4';

async function cf(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const msg = (json.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ') || res.statusText;
    const err = new Error(`${method} ${path} → ${res.status} ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json.result;
}

function step(msg) {
  console.log(`\n▸ ${msg}`);
}

// 1. Token sanity check (verifies the token itself, not a logged-in user).
step('Verifying API token');
const verify = await cf('GET', '/user/tokens/verify');
if (verify.status !== 'active') throw new Error(`Token status: ${verify.status}`);
console.log('  token active');

// 2. Build.
if (!process.argv.includes('--skip-build')) {
  step('Building');
  const b = spawnSync('pnpm', ['build'], { stdio: 'inherit' });
  if (b.status !== 0) process.exit(b.status ?? 1);
}
if (!existsSync('dist/index.html')) throw new Error('dist/ is missing; run pnpm build');

// 3. Pages project.
step(`Ensuring Pages project "${project}"`);
let pagesProject;
try {
  pagesProject = await cf('GET', `/accounts/${account}/pages/projects/${project}`);
  console.log('  exists');
} catch (err) {
  if (err.status !== 404) throw err;
  pagesProject = await cf('POST', `/accounts/${account}/pages/projects`, { name: project, production_branch: 'main' });
  console.log('  created');
}
// The *.pages.dev host may carry a suffix when the plain name is taken (e.g. mediabox-abc1.pages.dev).
const pagesHost = pagesProject.subdomain || `${project}.pages.dev`;
console.log(`  host ${pagesHost}`);

// 4. Upload with wrangler, passing credentials explicitly through the environment.
step('Uploading dist/ with wrangler');
const w = spawnSync(
  'pnpm',
  ['exec', 'wrangler', 'pages', 'deploy', 'dist', '--project-name', project, '--branch', 'main', '--commit-dirty=true'],
  {
    stdio: 'inherit',
    env: { ...env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, WRANGLER_SEND_METRICS: 'false', CI: '1' },
  },
);
if (w.status !== 0) process.exit(w.status ?? 1);

// 5. Custom domain on the project.
step(`Attaching custom domain ${domain}`);
const domains = await cf('GET', `/accounts/${account}/pages/projects/${project}/domains`);
if (!domains.some((d) => d.name === domain)) {
  await cf('POST', `/accounts/${account}/pages/projects/${project}/domains`, { name: domain });
  console.log('  added');
} else console.log('  already attached');

// 6. DNS: CNAME <domain> → <project>.pages.dev (proxied).
step(`Ensuring DNS record for ${domain}`);
const zones = await cf('GET', `/zones?name=${encodeURIComponent(zoneName)}`);
if (!zones.length) throw new Error(`Zone ${zoneName} not found for this token`);
const zoneId = zones[0].id;
const target = pagesHost;
const records = await cf('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(domain)}`);
const existing = records.find((r) => r.type === 'CNAME' || r.type === 'A' || r.type === 'AAAA');
if (!existing) {
  await cf('POST', `/zones/${zoneId}/dns_records`, { type: 'CNAME', name: domain, content: target, proxied: true, ttl: 1 });
  console.log(`  created CNAME → ${target}`);
} else if (existing.type !== 'CNAME' || existing.content !== target) {
  await cf('PUT', `/zones/${zoneId}/dns_records/${existing.id}`, { type: 'CNAME', name: domain, content: target, proxied: true, ttl: 1 });
  console.log(`  updated record → ${target}`);
} else console.log('  already correct');

console.log(`\n✓ Deployed. https://${domain}  (also https://${target})`);
