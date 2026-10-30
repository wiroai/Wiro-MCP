import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// Downloads the file behind a URL that came from a tool call. The URL is chosen
// by the model, and through it by whatever content the model read, so the
// download is limited to public http(s) hosts: no other schemes, and no
// loopback, private, link-local or otherwise non-public addresses. The address
// check runs inside the socket's DNS lookup, so the address that is checked is
// the one that is connected to. Redirects are followed by hand and every hop is
// checked again.

export const MAX_REMOTE_FILE_BYTES = 200 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface RemoteFile {
  data: Buffer;
  contentType?: string;
}

export interface FetchPublicFileOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

function isDisallowedIpv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  const [a = 0, b = 0, c = 0] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224;
}

export function isDisallowedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isDisallowedIpv4(ip);
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (/^fe[89ab]/.test(l) || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('ff')) return true;
    const dotted = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted?.[1]) return isDisallowedIpv4(dotted[1]);
    const hex = l.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex?.[1] && hex[2]) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isDisallowedIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
    }
    return false;
  }
  return true;
}

/** Throws unless the URL is http(s) and, when its host is an IP literal, a public one. */
export function assertPublicHttpUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs can be uploaded, got ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || (net.isIP(host) && isDisallowedIp(host))) {
    throw new Error(`URL host is not a public address: ${url.hostname}`);
  }
}

export const publicOnlyLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 0);
      return;
    }
    if (addresses.length === 0 || addresses.some((a) => isDisallowedIp(a.address))) {
      callback(new Error(`URL host is not a public address: ${hostname}`), '', 0);
      return;
    }
    if (options.all) {
      (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addresses);
      return;
    }
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  });
};

export async function fetchPublicFile(
  rawUrl: string,
  options: FetchPublicFileOptions = {},
): Promise<RemoteFile> {
  const maxBytes = options.maxBytes ?? MAX_REMOTE_FILE_BYTES;
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let url = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertPublicHttpUrl(url);
    const response = await get(url, signal);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;

    if (status >= 300 && status < 400 && location) {
      response.resume();
      url = new URL(location, url);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new Error(`Failed to download file from ${rawUrl}: ${status}`);
    }

    const declared = Number(response.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      response.destroy();
      throw new Error(`File at ${rawUrl} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) {
        response.destroy();
        throw new Error(`File at ${rawUrl} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
      }
      chunks.push(chunk as Buffer);
    }
    const contentType = response.headers['content-type'];
    return { data: Buffer.concat(chunks), ...(contentType ? { contentType } : {}) };
  }
  throw new Error(`Too many redirects while downloading ${rawUrl}`);
}

function get(url: URL, signal: AbortSignal): Promise<http.IncomingMessage> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(url, { lookup: publicOnlyLookup, signal }, resolve);
    request.on('error', reject);
  });
}
