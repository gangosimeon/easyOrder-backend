import { POST as register } from '@/app/api/auth/register/route';

let ipCounter = 0;

/** IP différente à chaque appel, pour ne pas déclencher les limites anti-abus entre tests. */
export function freshIp(): string {
  ipCounter += 1;
  return `10.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

export function jsonRequest(
  url: string,
  body?: unknown,
  opts: { token?: string; ip?: string; method?: string } = {},
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-real-ip': opts.ip ?? freshIp() };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export interface TestShop {
  id: string;
  slug: string;
  token: string;
  password: string;
}

/** Crée un compte-boutique via la vraie route d'inscription. */
export async function createShop(name: string, phone: string, password = 'motdepasse1'): Promise<TestShop> {
  const res = await register(jsonRequest('/api/auth/register', { name, phone, countryCode: '226', password }));
  const body = await res.json();
  if (res.status !== 201) throw new Error(`Inscription échouée : ${JSON.stringify(body)}`);
  return { id: body.data.user._id, slug: body.data.user.slug, token: body.data.token, password };
}
