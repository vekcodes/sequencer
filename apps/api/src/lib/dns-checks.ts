import { promises as dns } from 'node:dns';

// Lightweight deliverability DNS checks. Run inline on mailbox connect with a
// short timeout. Phase 3+ will rerun these on a daily cadence in mailbox-health-worker.

export type DnsCheckResult = {
  spf: boolean | null;
  dkim: boolean | null;
  dmarc: boolean | null;
  mx: boolean | null;
};

const TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

async function checkSpf(domain: string): Promise<boolean> {
  const records = await dns.resolveTxt(domain);
  const flat = records.map((chunks) => chunks.join(''));
  return flat.some((r) => r.toLowerCase().startsWith('v=spf1'));
}

async function checkDmarc(domain: string): Promise<boolean> {
  const records = await dns.resolveTxt(`_dmarc.${domain}`);
  const flat = records.map((chunks) => chunks.join(''));
  return flat.some((r) => r.toLowerCase().startsWith('v=dmarc1'));
}

// For Google Workspace, the DKIM selector is `google` by default.
// (For non-Google we'd need provider-specific knowledge — Phase 8.)
async function checkGoogleDkim(domain: string): Promise<boolean> {
  const records = await dns.resolveTxt(`google._domainkey.${domain}`);
  const flat = records.map((chunks) => chunks.join(''));
  return flat.length > 0 && flat.some((r) => r.length > 0);
}

async function checkMx(domain: string): Promise<boolean> {
  const records = await dns.resolveMx(domain);
  return records.length > 0;
}

export async function runDnsChecks(domain: string): Promise<DnsCheckResult> {
  const [spf, dmarc, dkim, mx] = await Promise.all([
    withTimeout(checkSpf(domain), TIMEOUT_MS),
    withTimeout(checkDmarc(domain), TIMEOUT_MS),
    withTimeout(checkGoogleDkim(domain), TIMEOUT_MS),
    withTimeout(checkMx(domain), TIMEOUT_MS),
  ]);

  // null result = either timeout or NXDOMAIN — we treat both as "unknown"
  // rather than "false" so the UI can distinguish "we didn't find a record"
  // from "we couldn't check".
  return { spf, dkim, dmarc, mx };
}
